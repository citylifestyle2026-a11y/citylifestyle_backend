const BookingTicket = require("../models/bookingTicket.model");
const Event = require("../models/event.model");
const User = require("../models/user.model");
const Admin = require("../models/admin.model");
const TicketType = require("../models/ticketType.model");
const AppError = require("../utils/AppError");
const Booking = require("../models/booking.model");
const QRCode = require("qrcode");
const { buildInvitationUrl } = require("../utils/buildInvitationBodyParams");
const {
  normalizeMobileSearchTerm,
  toMobileFilterDigits,
} = require("../utils/normalizeMobileNumber");

// Shared search fields for the toolbar "quick search" — Booking Id, Ticket
// Id, QR Code, Name, Mobile Number, per the Entry Report spec. Used by both
// getAllEntryReports and exportEntryReport so search behaves identically
// in the table and in the exported file.
//
// User-typed text is escaped before it is used as a regex. Without this,
// typing a character such as "(" or "[" in any search box made MongoDB
// throw "Regular expression is invalid" and the page received a raw 500
// error instead of simply finding no match.
const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// NEW single-QR flow: a guest is NOT registered, so attendee.* is empty and
// the person is the BOOKING (name / mobile / company / Invitation ID). Every
// search therefore looks at the attendee fields (old flow) AND the joined
// booking fields (new flow). These run AFTER the $lookup in the pipeline
// built by buildEntryReportPipeline below.
const buildSearchOr = (rawSearch) => {
  // A full number typed with 91 / +91 / spaces is reduced to its 10
  // digits so it matches the stored number.
  const search = escapeRegex(normalizeMobileSearchTerm(rawSearch));

  return [
    { bookingNumber: { $regex: search, $options: "i" } },
    { ticketNumber: { $regex: search, $options: "i" } },
    { qrImage: { $regex: search, $options: "i" } },
    { "attendee.name": { $regex: search, $options: "i" } },
    { "attendee.mobileNumber": { $regex: search, $options: "i" } },
    { "booking.name": { $regex: search, $options: "i" } },
    { "booking.mobileNumber": { $regex: search, $options: "i" } },
    { "booking.companyName": { $regex: search, $options: "i" } },
    { "booking.invitationId": { $regex: search, $options: "i" } },
  ];
};

// Applies the end-of-day boundary in UTC explicitly. setHours() would
// apply the Node process's local timezone, which can shift the boundary
// by that offset and cause off-by-one-day results depending on where the
// server runs. startDate/endDate arrive as "YYYY-MM-DD" (date-only ISO),
// which `new Date(...)` already parses as UTC midnight, so pairing it
// with setUTCHours keeps both ends of the range in the same timezone.
const endOfDayUtc = (dateStr) => {
  const d = new Date(dateStr);
  d.setUTCHours(23, 59, 59, 999);
  return d;
};

// ================= IST DATE BOUNDARIES =================
// BookingTicket.passDate is copied directly from TicketType.allowDates[0]
// at booking time (see booking.service.js) — and allowDates are captured
// by the Ticket Type date picker as IST midnight of the selected calendar
// day. Concretely: selecting "14-08-2026" in that picker stores
// 2026-08-13T18:30:00.000Z (14 Aug 00:00 IST = 13 Aug 18:30 UTC), NOT
// 2026-08-14T00:00:00.000Z. So a naive `new Date(dateStr)` on a
// "YYYY-MM-DD" query param (which parses as UTC midnight of that date)
// would be 5.5 hours later than the actual stored instant for that same
// IST calendar day — enough to miss it entirely in a $gte/$lte compare.
//
// IST is a fixed UTC+5:30 offset with no DST, so a constant offset is
// correct here (not a reason to pull in a timezone library).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// The UTC instant representing 00:00 IST on the given "YYYY-MM-DD" date —
// i.e. exactly what gets stored for that calendar date's passDate.
const istMidnightUtc = (dateStr) =>
  new Date(new Date(dateStr).getTime() - IST_OFFSET_MS);

// The UTC instant one millisecond before the *next* IST calendar day
// begins — i.e. the inclusive upper bound covering every moment of the
// given IST calendar date, mirroring how endOfDayUtc works for the
// (UTC-midnight-based) scannedAt boundary above.
const istEndOfDayUtc = (dateStr) => {
  const nextDayIstMidnight = new Date(
    istMidnightUtc(dateStr).getTime() + 24 * 60 * 60 * 1000
  );
  return new Date(nextDayIstMidnight.getTime() - 1);
};

// ================= PASS DATE HELPERS (TICKET TYPE allowDates) =================
// "Pass Date" on this page means the date(s) a ticket's TicketType allows
// entry on (TicketType.allowDates) — NOT just the single date copied onto
// BookingTicket.passDate at booking time (that is always allowDates[0],
// so a 2-day pass only ever showed its first day).
//
// A stored allowDate is the UTC instant of IST midnight (e.g. 14 Aug IST
// is 2026-08-13T18:30:00.000Z). toIstDateKey converts it back to the IST
// calendar day as a plain "YYYY-MM-DD" string, which is what the frontend
// date picker and the table display work with.
const toIstDateKey = (date) => {
  const time = new Date(date).getTime();
  if (Number.isNaN(time)) return null;
  return new Date(time + IST_OFFSET_MS).toISOString().slice(0, 10);
};

const toSortedUniqueIstDateKeys = (dates = []) =>
  [...new Set(dates.map(toIstDateKey).filter(Boolean))].sort();

// Every date that any TicketType of the given events allows. Feeds the
// Pass Date picker so only dates a ticket type really allows are
// selectable. Soft-deleted ticket types are intentionally included: their
// already-scanned tickets still appear in this report, so their dates
// must stay filterable.
const getAllowedPassDates = async (eventIds) => {
  const ticketTypes = await TicketType.find({ eventId: { $in: eventIds } })
    .select("allowDates")
    .lean();

  return toSortedUniqueIstDateKeys(
    ticketTypes.flatMap((ticketType) => ticketType.allowDates || [])
  );
};

// ticketTypeId -> ["YYYY-MM-DD", ...] for the tickets being displayed.
// One extra query per request (not per row).
const resolvePassDatesByTicketType = async (tickets) => {
  const ticketTypeIds = [
    ...new Set(
      tickets
        .map((t) => t.ticketTypeId)
        .filter(Boolean)
        .map((id) => String(id))
    ),
  ];

  if (ticketTypeIds.length === 0) {
    return {};
  }

  const ticketTypes = await TicketType.find({ _id: { $in: ticketTypeIds } })
    .select("_id allowDates")
    .lean();

  const map = {};
  ticketTypes.forEach((ticketType) => {
    map[String(ticketType._id)] = toSortedUniqueIstDateKeys(
      ticketType.allowDates || []
    );
  });

  return map;
};

// A ticket's pass dates: its ticket type's allowDates; falls back to the
// ticket's own stored passDate only when the ticket type has none (or no
// longer exists).
const getTicketPassDates = (ticket, passDatesByTicketType) => {
  const fromTicketType = passDatesByTicketType[String(ticket.ticketTypeId)];

  if (fromTicketType && fromTicketType.length > 0) {
    return fromTicketType;
  }

  const fallback = ticket.passDate ? toIstDateKey(ticket.passDate) : null;
  return fallback ? [fallback] : [];
};

// ================= BUILD ENTRY REPORT FILTER (SHARED) =================
// Single place that turns the query params into a BookingTicket filter,
// used by BOTH getAllEntryReports and exportEntryReport, so the table and
// the exported file can never disagree about what a filter means.
const buildEntryReportFilter = async (params, eventIds, currentUser) => {
  const {
    bookingId,
    invitationId,
    ticketId,
    mobileNumber,
    name,
    search,
    startDate,
    endDate,
  } = params;

  // `match`     = conditions on the BookingTicket itself (run first).
  // `postMatch` = conditions that need the joined Booking (name / mobile /
  //               Invitation ID) — run after the $lookup, see
  //               buildEntryReportPipeline.
  const match = {
    eventId: { $in: eventIds },
    status: "Used",
  };

  // Checker-scoping — combined with the optional filters below via a
  // normal AND. Admin is unaffected (no-op for admin).
  applyScannerScope(match, currentUser);

  if (ticketId) {
    match.ticketNumber = { $regex: escapeRegex(ticketId), $options: "i" };
  }

  const postMatch = [];

  if (bookingId) {
    postMatch.push({
      bookingNumber: { $regex: escapeRegex(bookingId), $options: "i" },
    });
  }

  // "Invitation Id" box: the 8-digit code printed on the guest's pass.
  if (invitationId) {
    postMatch.push({
      "booking.invitationId": { $regex: escapeRegex(invitationId) },
    });
  }

  if (mobileNumber) {
    // "+91 98765 43210" / "919876543210" -> "9876543210".
    const regex = {
      $regex: escapeRegex(toMobileFilterDigits(mobileNumber)),
      $options: "i",
    };
    postMatch.push({
      $or: [{ "attendee.mobileNumber": regex }, { "booking.mobileNumber": regex }],
    });
  }

  if (name) {
    const regex = { $regex: escapeRegex(name), $options: "i" };
    postMatch.push({
      $or: [{ "attendee.name": regex }, { "booking.name": regex }],
    });
  }

  if (search) {
    postMatch.push({ $or: buildSearchOr(search) });
  }

  // ================= PASS DATE FILTER =================
  // Matches tickets whose TicketType allows ANY date inside the selected
  // range (allowDates is an array, so $elemMatch), plus tickets whose own
  // stored passDate falls in the range (covers a ticket type whose dates
  // were edited after the ticket was booked). Boundaries are IST calendar
  // days — see istMidnightUtc / istEndOfDayUtc above.
  if (startDate || endDate) {
    const range = {};

    if (startDate) {
      range.$gte = istMidnightUtc(startDate);
    }

    if (endDate) {
      range.$lte = istEndOfDayUtc(endDate);
    }

    const matchingTicketTypes = await TicketType.find({
      eventId: { $in: eventIds },
      allowDates: { $elemMatch: range },
    })
      .select("_id")
      .lean();

    match.$and = [
      {
        $or: [
          { ticketTypeId: { $in: matchingTicketTypes.map((t) => t._id) } },
          { passDate: range },
        ],
      },
    ];
  }

  return { match, postMatch };
};

// ================= ENTRY REPORT PIPELINE (SHARED) =================
// NEW single-QR flow: one booking of N guests has N BookingTickets, and
// ONE scan marks all N as "Used" (see qr.service.js#checkInQr). Listing
// BookingTickets directly would therefore show the same booking N times,
// each with an empty name. This pipeline:
//   1. matches the scanned tickets,
//   2. joins each ticket's Booking (name, mobile, company, Invitation ID),
//   3. collapses a single_qr booking to ONE row (its first ticket) —
//      old per-ticket bookings are left exactly as they were (one row per
//      ticket),
//   4. sorts newest scan first.
// Shared by the table and the export so they can never disagree.
const buildEntryReportPipeline = ({ match, postMatch }) => [
  { $match: match },
  {
    $lookup: {
      from: Booking.collection.name,
      localField: "bookingId",
      foreignField: "_id",
      as: "booking",
    },
  },
  { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
  ...(postMatch.length > 0 ? [{ $match: { $and: postMatch } }] : []),
  { $sort: { createdAt: 1, _id: 1 } },
  {
    $group: {
      _id: {
        $cond: [
          { $eq: ["$booking.entryMode", "single_qr"] },
          "$bookingId",
          "$_id",
        ],
      },
      doc: { $first: "$$ROOT" },
    },
  },
  { $replaceRoot: { newRoot: "$doc" } },
  {
    $project: {
      bookingNumber: 1,
      ticketNumber: 1,
      qrImage: 1,
      scannedAt: 1,
      scannedBy: 1,
      passDate: 1,
      ticketTypeId: 1,
      attendee: 1,
      "booking.name": 1,
      "booking.mobileNumber": 1,
      "booking.companyName": 1,
      "booking.invitationId": 1,
      "booking.quantity": 1,
      "booking.entryMode": 1,
    },
  },
  { $sort: { scannedAt: -1, _id: 1 } },
];

// ================= ROW HELPERS (SHARED) =================
const isSingleQrBooking = (ticket) => ticket?.booking?.entryMode === "single_qr";

// Booking mobiles are stored with the 91 prefix; show the 10 digits.
const toTenDigitMobile = (value) =>
  String(value || "").replace(/^91(?=\d{10}$)/, "");

// Public pass link for a single-QR booking. Returns "" (never throws) when
// the frontend base URL env var is not configured.
const safeInviteUrl = (ticket) => {
  if (!isSingleQrBooking(ticket) || !ticket.booking.invitationId) return "";
  try {
    return buildInvitationUrl(ticket.booking.invitationId);
  } catch (error) {
    return "";
  }
};

// The QR shown in the Entry Report for a single-QR booking is the SAME QR
// the guest holds: the short Invitation ID. Inline data URL, so it still
// shows after a server-disk wipe. Old tickets keep their stored qrImage.
const buildRowQrImage = async (ticket) => {
  if (isSingleQrBooking(ticket) && ticket.booking.invitationId) {
    try {
      return await QRCode.toDataURL(ticket.booking.invitationId, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 160,
      });
    } catch (error) {
      // fall through to the stored image
    }
  }
  return ticket.qrImage || "";
};

// ================= ACTIVE EVENT FILTER (SHARED) =================
// Used for (a) the Event dropdown (getActiveEvents) and (b) resolving an
// explicitly-selected eventId in getAllEntryReports/exportEntryReport.
// Step 5: an event's Entry Report data must stay accessible for as long
// as the event itself exists — expiring it must never hide that data,
// only an explicit manual delete may (which removes the Event document
// itself, so it naturally stops matching here and its BookingTickets are
// no longer reachable through it). The endDateTime/expiry condition that
// used to be part of this filter has been removed for that reason;
// isActive (a separate, manually-controlled admin flag, untouched by
// expiry) is preserved exactly as before.
const activeEventFilter = () => ({
  isActive: true,
});

// ================= RESOLVE EVENT SCOPE (SHARED) =================
// Mirrors booking.service.js's resolveEventScope so Booking and Entry
// Report behave identically for "All Events" vs a specific event:
// - requestedEventId supplied: scope is exactly that one event, as long
//   as it's isActive and not deleted. Its own entry-report data stays
//   accessible for as long as the Event document exists, even after it
//   has expired (Step 5) — only a manual delete removes it.
// - requestedEventId omitted ("All Events" — the dropdown's own default):
//   scope is EVERY isActive, non-deleted event combined, not just a
//   single "current" one, so entries from Event A and Event B both show
//   together. Previously this resolved to a single "current" event only,
//   which is why picking "All Events" never actually showed more than
//   one event's rows — that mismatched what the dropdown/table already
//   claimed to do.
const resolveEventScope = async (requestedEventId) => {
  if (requestedEventId) {
    const event = await Event.findOne({
      _id: requestedEventId,
      ...activeEventFilter(),
    })
      .select("_id name title startDateTime endDateTime")
      .lean();

    return event
      ? { eventIds: [event._id], event }
      : { eventIds: [], event: null };
  }

  const events = await Event.find(activeEventFilter())
    .sort({ startDateTime: 1 })
    .select("_id name title startDateTime endDateTime")
    .lean();

  return {
    eventIds: events.map((e) => e._id),
    // Multiple events in scope: there's no single "the event" to return
    // (unchanged from before — callers already handle event: null, e.g.
    // EntryReport.jsx's date-range bounds fall back to null gracefully).
    event: null,
  };
};

// Restricts a query filter to only the records the authenticated user is
// allowed to see. Admin (role "admin", set from the previous auth step)
// is left completely unrestricted — existing behavior. Any other role
// (currently only "checker") only ever sees tickets where
// BookingTicket.scannedBy matches THEIR OWN authenticated _id — sourced
// from currentUser (req.user, resolved server-side by the protect
// middleware), never from any client-supplied query parameter. Shared by
// both getAllEntryReports and exportEntryReport so the table and the
// export can never diverge.
const applyScannerScope = (filter, currentUser) => {
  if (currentUser && currentUser.role !== "admin") {
    filter.scannedBy = currentUser._id;
  }
};

// ================= RESOLVE "SCANNED BY" NAMES (SHARED) =================
// BookingTicket.scannedBy stores the authenticated req.user._id at
// check-in time (see controllers/qr.controller.js) — which can be either
// an Admin document or a User (Checker) document (see
// middlewares/auth.middleware.js's protect), even though the schema's
// `ref` only points at "User". A plain `.populate("scannedBy")` would
// therefore silently come back empty for every ticket an Admin scanned,
// since that id doesn't exist in the User collection. This looks it up
// in BOTH collections instead and returns a single id -> name map, so
// the Entry Report table's new "Scanned By" column is correct regardless
// of whether an Admin or a Checker did the scan. Read-only lookups by
// id — does not touch/rename anything on BookingTicket, User or Admin,
// so no other functionality is affected.
const resolveScannedByNames = async (tickets) => {
  const scannedByIds = [
    ...new Set(
      tickets
        .map((t) => t.scannedBy)
        .filter(Boolean)
        .map((id) => String(id))
    ),
  ];

  if (scannedByIds.length === 0) {
    return {};
  }

  const [users, admins] = await Promise.all([
    User.find({ _id: { $in: scannedByIds } }).select("_id name").lean(),
    Admin.find({ _id: { $in: scannedByIds } }).select("_id name").lean(),
  ]);

  const nameMap = {};
  [...users, ...admins].forEach((person) => {
    nameMap[String(person._id)] = person.name;
  });

  return nameMap;
};

// ================= GET ACTIVE EVENTS (FOR EVENT DROPDOWN) =================
// Backs the Entry Report page's Event dropdown. Reuses activeEventFilter()
// — the exact same condition getAllEntryReports/exportEntryReport already
// use to resolve a single active event — so the dropdown can never list
// (and the report can never be scoped to) an event that condition would
// otherwise reject. Sorted ascending by startDateTime, same ordering
// convention as the rest of this module. Access itself is already gated
// by the same protect + authorize("admin", "checker", { permission:
// "Entry Report" }) middleware as the rest of the Entry Report routes, so
// no separate per-user event visibility filter is needed here.
const getActiveEvents = async () => {
  const events = await Event.find(activeEventFilter())
    .sort({ startDateTime: 1 })
    .select("_id name title eventCode startDateTime endDateTime")
    .lean();

  return events;
};

// ================= GET ALL ENTRY REPORT =================
const getAllEntryReports = async (query, currentUser) => {
  let {
    page = 1,
    limit = 10,
    bookingId = "",
    invitationId = "",
    ticketId = "",
    mobileNumber = "",
    name = "",
    search = "",
    startDate,
    endDate,
    eventId: requestedEventId,
  } = query;

  page = parseInt(page, 10) || 1;
  limit = parseInt(limit, 10) || 10;
  const skip = (page - 1) * limit;

  // ================= EVENT SCOPE =================
  // The frontend selects a specific event (Event dropdown) and sends its
  // id as eventId, or sends no eventId at all for "All Events" — the
  // dropdown's own default. That id is still never trusted blindly — it
  // must also satisfy the same activeEventFilter() every other event
  // lookup in this module uses, so Entry Report can never return records
  // from an inactive/forged eventId. "All Events" combines every isActive
  // event's data (see resolveEventScope above), matching the dropdown's
  // own default and Booking's equivalent behavior.
  const { eventIds, event: activeEvent } = await resolveEventScope(
    requestedEventId
  );

  if (eventIds.length === 0) {
    // No matching event(s): respond gracefully so the UI can show its
    // normal empty state instead of an error.
    return {
      event: null,
      rows: [],
      allowedPassDates: [],
      pagination: { page, limit, total: 0, totalPages: 0 },
    };
  }

  // ================= FILTER =================
  const filter = await buildEntryReportFilter(
    {
      bookingId,
      invitationId,
      ticketId,
      mobileNumber,
      name,
      search,
      startDate,
      endDate,
    },
    eventIds,
    currentUser
  );

  // ================= FETCH DATA =================

  const [aggregated, allowedPassDates] = await Promise.all([
    BookingTicket.aggregate([
      ...buildEntryReportPipeline(filter),
      {
        $facet: {
          rows: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: "count" }],
        },
      },
    ]).allowDiskUse(true),

    // Independent of the filters on purpose: the Pass Date picker must
    // always offer every date the selected event scope allows.
    getAllowedPassDates(eventIds),
  ]);

  const tickets = aggregated[0]?.rows || [];
  const total = aggregated[0]?.total?.[0]?.count || 0;

  // Resolves each ticket's scannedBy id to a display name, checking both
  // the User (Checker) and Admin collections — see
  // resolveScannedByNames above for why a plain populate() isn't enough.
  const [scannedByNameMap, passDatesByTicketType, qrImages] = await Promise.all([
    resolveScannedByNames(tickets),
    resolvePassDatesByTicketType(tickets),
    Promise.all(tickets.map(buildRowQrImage)),
  ]);

  // ================= FORMAT ROWS =================
  // One row per scanned PASS: a single-QR booking is ONE row (guests = its
  // quantity); an old per-ticket booking is one row per ticket (guests 1).

  const rows = tickets.map((ticket, index) => ({
    _id: ticket._id,

    // Old flow only (registered attendee photo). The single-QR flow has no
    // registration step, so this is empty there.
    profileImage: ticket.attendee?.profileImage || "",

    bookingId: ticket.bookingNumber,

    // 8-digit code printed on the guest's pass ("-" for old bookings).
    invitationId: ticket.booking?.invitationId || "",

    ticketId: ticket.ticketNumber,

    qrImage: qrImages[index],

    // Link of the guest's digital pass page ("" for old bookings).
    passUrl: safeInviteUrl(ticket),

    // Registered attendee (old flow) first, otherwise the booking's guest.
    name: ticket.attendee?.name || ticket.booking?.name || "-",

    companyName: ticket.booking?.companyName || "",

    mobileNumber:
      ticket.attendee?.mobileNumber ||
      toTenDigitMobile(ticket.booking?.mobileNumber) ||
      "-",

    // How many people this one scan admitted.
    guests: isSingleQrBooking(ticket) ? ticket.booking.quantity || 1 : 1,

    // Kept for backward compatibility (the ticket's own stored date).
    passDate: ticket.passDate || null,

    // Every date this ticket's TicketType allows, as IST "YYYY-MM-DD".
    passDates: getTicketPassDates(ticket, passDatesByTicketType),

    scannedAt: ticket.scannedAt || null,

    scannedBy: ticket.scannedBy
      ? scannedByNameMap[String(ticket.scannedBy)] || "-"
      : "-",
  }));

  return {
    event: activeEvent,

    rows,

    // IST "YYYY-MM-DD" list of every date the Pass Date picker may offer.
    allowedPassDates,

    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// ================= EXPORT ENTRY REPORT =================

const exportEntryReport = async (query, res, currentUser) => {
  let {
    bookingId = "",
    invitationId = "",
    ticketId = "",
    name = "",
    mobileNumber = "",
    search = "",
    startDate,
    endDate,
    eventId: requestedEventId,
  } = query;

  // ================= EVENT SCOPE =================
  // Same resolution as getAllEntryReports (see resolveEventScope above):
  // a specific eventId if supplied, otherwise every isActive event
  // combined ("All Events") — never just a single default event — so the
  // exported file always matches exactly what the table is showing.
  const { eventIds } = await resolveEventScope(requestedEventId);

  if (eventIds.length === 0) {
    // AppError (not a plain Error) so the client receives a 404 with this
    // exact message, instead of a generic 500.
    throw new AppError("No active event found.", 404);
  }

  // ================= FILTER =================
  // Same shared builder as the table (incl. Checker-scoping) — export
  // must never be a way to bypass the restriction the table enforces.
  const filter = await buildEntryReportFilter(
    {
      bookingId,
      invitationId,
      ticketId,
      mobileNumber,
      name,
      search,
      startDate,
      endDate,
    },
    eventIds,
    currentUser
  );

  // ================= DATA =================

  const rows = await BookingTicket.aggregate(
    buildEntryReportPipeline(filter)
  ).allowDiskUse(true);

  const passDatesByTicketType = await resolvePassDatesByTicketType(rows);

  // ================= WORKBOOK =================

  // exceljs is large (~280 ms to load) — only needed for exports, so it is
  // loaded here on first use instead of at server start.
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();

  workbook.creator = "Event Management CRM";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("Entry Report");

  worksheet.columns = [
    {
      header: "Booking Id",
      key: "bookingId",
      width: 22,
    },
    {
      header: "Invitation ID",
      key: "invitationId",
      width: 16,
    },
    {
      header: "Name",
      key: "name",
      width: 25,
    },
    {
      header: "Company/ Brand",
      key: "companyName",
      width: 25,
    },
    {
      header: "Mobile Number",
      key: "mobile",
      width: 18,
    },
    {
      header: "Guests",
      key: "guests",
      width: 10,
    },
    {
      header: "Pass Date",
      key: "passDate",
      width: 22,
    },
    {
      header: "Scanned At",
      key: "scannedAt",
      width: 24,
    },
    {
      header: "QR / Pass Link",
      key: "qrImage",
      width: 45,
    },
    {
      header: "Profile Image",
      key: "profileImage",
      width: 45,
    },
  ];

  // ================= HEADER STYLE =================

  worksheet.getRow(1).font = {
    bold: true,
    color: {
      argb: "FFFFFFFF",
    },
  };

  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: {
      argb: "1F4E78",
    },
  };

  worksheet.getRow(1).alignment = {
    vertical: "middle",
    horizontal: "center",
  };

  // ================= ROWS =================
  // Pass Date lists every date the ticket's TicketType allows (same as the
  // on-screen table), formatted DD/MM/YYYY from the IST "YYYY-MM-DD" key —
  // no server-timezone conversion involved.

  rows.forEach((item) => {
    const passDates = getTicketPassDates(item, passDatesByTicketType)
      .map((key) => key.split("-").reverse().join("/"))
      .join(", ");

    worksheet.addRow({
      bookingId: item.bookingNumber,

      invitationId: item.booking?.invitationId || "-",

      name: item.attendee?.name || item.booking?.name || "-",

      companyName: item.booking?.companyName || "-",

      mobile:
        item.attendee?.mobileNumber ||
        toTenDigitMobile(item.booking?.mobileNumber) ||
        "-",

      guests: isSingleQrBooking(item) ? item.booking.quantity || 1 : 1,

      passDate: passDates || "-",

      scannedAt: item.scannedAt
        ? new Date(item.scannedAt).toLocaleString("en-GB")
        : "-",

      // Single-QR booking: the guest's pass link. Old ticket: its QR file.
      qrImage: safeInviteUrl(item) || item.qrImage || "-",

      profileImage: item.attendee?.profileImage || "-",
    });
  });

  // ================= DOWNLOAD =================

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename=EntryReport_${Date.now()}.xlsx`
  );

  await workbook.xlsx.write(res);

  res.end();
};

module.exports = {
  getActiveEvents,
  getAllEntryReports,
  exportEntryReport,
};