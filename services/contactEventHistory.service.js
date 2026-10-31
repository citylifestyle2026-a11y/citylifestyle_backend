const mongoose = require("mongoose");
const ContactEventHistory = require("../models/contactEventHistory.model");
const Contact = require("../models/contact.model");
const Event = require("../models/event.model");
const AppError = require("../utils/AppError");
const { normalizeMobileSearchTerm } = require("../utils/normalizeMobileNumber");

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ================= CREATE EVENT HISTORY =================
// `adminId` always comes from the authenticated user (req.user.id in
// the controller), never from req.body — same convention already used
// by contactService.createContact.
const createEventHistory = async (data, adminId) => {
  const { contactId, eventId, status, notes } = data;
  const isSpouse = data.isSpouse === true || data.isSpouse === "true";

  await assertContactExists(contactId);
  await assertEventExists(eventId);

  // A spouse entry is only valid for a Couple contact that actually has
  // a spouse recorded.
  if (isSpouse) {
    const contact = await Contact.findById(contactId).select(
      "relationship spouseName"
    );
    if (contact.relationship !== "Couple" || !contact.spouseName) {
      throw new AppError("This contact has no spouse recorded", 400);
    }
  }

  const history = await ContactEventHistory.create({
    contactId,
    eventId,
    isSpouse,
    status: status || "Invited",
    notes: notes || "",
    createdBy: adminId,
  });

  return populateHistory(history);
};

// Builds the Mongo $match used by the list AND the counts, so both always
// agree on which entries are "in view" (edition filter + search box).
const buildHistoryMatch = async (query = {}) => {
  const filter = { isDeleted: { $ne: true } };

  if (query.contactId) {
    if (!mongoose.Types.ObjectId.isValid(query.contactId)) {
      throw new AppError("Invalid Contact ID", 400);
    }
    filter.contactId = query.contactId;
  }

  if (query.eventId) {
    if (!mongoose.Types.ObjectId.isValid(query.eventId)) {
      throw new AppError("Invalid Event ID", 400);
    }
    filter.eventId = query.eventId;
  }

  if (query.status) {
    filter.status = query.status;
  }

  // One ROW per person (same contact + same isSpouse flag => same mobile
  // number), carrying ALL of that person's events inside `entries`.
  // Grouping happens in the database so pagination counts people, not
  // individual (contact, event) entries.
  const toObjectId = (v) => new mongoose.Types.ObjectId(v);
  const matchStage = { ...filter };
  if (matchStage.contactId) matchStage.contactId = toObjectId(matchStage.contactId);
  if (matchStage.eventId) matchStage.eventId = toObjectId(matchStage.eventId);

  // ---- search ----
  const searchText = String(query.search || "").trim();

  if (searchText) {
    const pattern = new RegExp(
      escapeRegex(normalizeMobileSearchTerm(searchText)),
      "i"
    );

    const [mainContacts, spouseContacts, matchedEvents] = await Promise.all([
      Contact.find({
        isDeleted: { $ne: true },
        $or: [{ fullName: pattern }, { whatsappNumber: pattern }],
      })
        .select("_id")
        .lean(),
      Contact.find({
        isDeleted: { $ne: true },
        $or: [{ spouseName: pattern }, { spouseMobile: pattern }],
      })
        .select("_id")
        .lean(),
      Event.find({
        isDeleted: { $ne: true },
        $or: [{ edition: pattern }, { title: pattern }],
      })
        .select("_id")
        .lean(),
    ]);

    matchStage.$and = [
      {
        $or: [
          {
            contactId: { $in: mainContacts.map((c) => c._id) },
            isSpouse: { $ne: true },
          },
          {
            contactId: { $in: spouseContacts.map((c) => c._id) },
            isSpouse: true,
          },
          { eventId: { $in: matchedEvents.map((e) => e._id) } },
          { "eventSnapshot.edition": pattern },
          { "eventSnapshot.title": pattern },
        ],
      },
    ];
  }

  return matchStage;
};

// ================= GET ALL EVENT HISTORY (ALL CONTACTS) =================
// Powers the standalone Sidebar "Event History" page (not scoped to one
// contact) — every entry, across every contact, with both contactId and
// eventId populated. Supports optional ?contactId=&eventId=&status=
// &page=&limit=&search= filters.
//
// `search` (case-insensitive, partial) matches the PERSON of a row and the
// edition:
//   - a normal row  -> the contact's fullName / whatsappNumber
//   - a spouse row  -> the contact's spouseName / spouseMobile
//   - any row       -> the event's edition / title (e.g. "Parv 5")
// A full number typed with +91 / spaces ("+91 98765 43210") still matches.
const getAllEventHistory = async (query = {}) => {
  const matchStage = await buildHistoryMatch(query);

  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;

  const [agg] = await ContactEventHistory.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: { contactId: "$contactId", isSpouse: { $ifNull: ["$isSpouse", false] } },
        latest: { $max: "$createdAt" },
        entryIds: { $push: "$_id" },
      },
    },
    { $sort: { latest: -1, "_id.contactId": 1 } },
    {
      $facet: {
        meta: [{ $count: "total" }],
        rows: [{ $skip: (page - 1) * limit }, { $limit: limit }],
      },
    },
  ]);

  const total = agg?.meta?.[0]?.total || 0;
  const groups = agg?.rows || [];

  const allIds = groups.flatMap((g) => g.entryIds);
  const entries = allIds.length
    ? await ContactEventHistory.find({ _id: { $in: allIds } })
        .populate("contactId", "fullName whatsappNumber spouseName spouseMobile")
        .populate("eventId", "title edition startDateTime endDateTime venueName status")
    : [];

  const entryById = new Map(entries.map((e) => [String(e._id), withEventFallback(e)]));

  const history = groups.map((g) => {
    const groupEntries = g.entryIds
      .map((id) => entryById.get(String(id)))
      .filter(Boolean)
      // oldest event first (by event date)
      .sort(
        (x, y) =>
          new Date(x.eventId?.startDateTime || 0) - new Date(y.eventId?.startDateTime || 0) ||
          new Date(x.createdAt) - new Date(y.createdAt)
      );

    const first = groupEntries[0];
    return {
      _id: `${g._id.contactId}:${g._id.isSpouse ? "spouse" : "main"}`,
      contactId: first?.contactId || null,
      // Saved copy of the person (see model) - used when the live Contact
      // no longer has these details.
      contactSnapshot: groupEntries.find((e) => e.contactSnapshot)?.contactSnapshot || null,
      isSpouse: g._id.isSpouse,
      createdAt: g.latest,
      entries: groupEntries.map((e) => ({
        _id: e._id,
        eventId: e.eventId,
        status: e.status,
        notes: e.notes,
        source: e.source || "manual",
        markedManually: !!e.markedManually,
        createdAt: e.createdAt,
      })),
    };
  });

  return {
    message: history.length
      ? "Event history fetched successfully"
      : "No event history found",
    data: history,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

// ================= ATTENDANCE COUNTS =================
// GET /stats — how many entries are Attended / Not Attended for the same
// view as the table (edition filter + search). One entry = one person at one
// edition, so a person who came to 3 editions counts 3 times.
const getHistoryStats = async (query = {}) => {
  const matchStage = await buildHistoryMatch({
    eventId: query.eventId,
    search: query.search,
  });

  const groups = await ContactEventHistory.aggregate([
    { $match: matchStage },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const countOf = (status) => groups.find((g) => g._id === status)?.count || 0;
  const total = groups.reduce((sum, g) => sum + g.count, 0);
  const attended = countOf("Attended");
  const notAttended = countOf("Not Attended");

  return {
    total,
    attended,
    notAttended,
    other: total - attended - notAttended,
  };
};

// ================= MARK ATTENDANCE BY HAND =================
// For a guest whose pass was never scanned but who did come. attended=true
// turns the entry green (Attended); attended=false puts a MANUALLY marked
// entry back to Not Attended (an entry that really was scanned is not
// touched by the undo).
const markAttendance = async (id, attended, adminId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Event History ID", 400);
  }

  const history = await ContactEventHistory.findOne({
    _id: id,
    isDeleted: { $ne: true },
  });

  if (!history) {
    throw new AppError("Event history entry not found", 404);
  }

  if (attended) {
    // Already Attended (e.g. really scanned) - nothing to do, and it must not
    // be relabelled as "manual".
    if (history.status === "Attended") return populateHistory(history);

    history.status = "Attended";
    history.markedManually = true;
    history.markedBy = adminId || null;
    history.markedAt = new Date();
  } else {
    if (!history.markedManually) {
      throw new AppError(
        "Only an entry marked manually can be changed back to Not Attended",
        400
      );
    }
    history.status = "Not Attended";
    history.markedManually = false;
    history.markedBy = adminId || null;
    history.markedAt = new Date();
  }

  await history.save();

  return populateHistory(history);
};

// ================= EXPORT TO EXCEL =================
// GET /export?eventId=&search=&status= - streams an .xlsx of EXACTLY what the
// page is filtered to (edition + search), not just the current page. One row
// per entry (person + edition), plus a "Summary" sheet with Attended / Not
// Attended counts per edition.
const exportEventHistory = async (query, res) => {
  const ExcelJS = require("exceljs");

  const matchStage = await buildHistoryMatch({
    eventId: query.eventId,
    search: query.search,
    status: query.status,
  });

  const rawEntries = await ContactEventHistory.find(matchStage)
    .populate("contactId", "fullName whatsappNumber spouseName spouseMobile")
    .populate("eventId", "title edition startDateTime")
    .sort({ createdAt: -1 });

  const entries = rawEntries.map(withEventFallback);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Event Management CRM";
  workbook.created = new Date();

  const fmt = (value) => (value ? new Date(value).toLocaleString("en-GB") : "-");

  const styleHeader = (sheet) => {
    const row = sheet.getRow(1);
    row.font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "1F4E78" } };
    row.alignment = { vertical: "middle", horizontal: "center" };
  };

  // ---------- sheet 1: every entry ----------
  const sheet = workbook.addWorksheet("Event History");
  sheet.columns = [
    { header: "Name", key: "name", width: 28 },
    { header: "WhatsApp Number", key: "mobile", width: 20 },
    { header: "Guest Type", key: "type", width: 14 },
    { header: "Spouse Of", key: "spouseOf", width: 26 },
    { header: "Edition", key: "edition", width: 18 },
    { header: "Event Date", key: "eventDate", width: 22 },
    { header: "Status", key: "status", width: 16 },
    { header: "Marked Manually", key: "manual", width: 16 },
    { header: "Notes", key: "notes", width: 40 },
    { header: "Added From", key: "source", width: 16 },
    { header: "Added On", key: "createdAt", width: 22 },
  ];
  styleHeader(sheet);

  const perEdition = new Map();

  entries.forEach((entry) => {
    const live = entry.contactId || {};
    const saved = entry.contactSnapshot || {};
    const pick = (key) => live[key] || saved[key] || "";
    const isSpouse = entry.isSpouse === true;

    const name = isSpouse ? pick("spouseName") : pick("fullName");
    const mobile = isSpouse ? pick("spouseMobile") : pick("whatsappNumber");
    const edition = entry.eventId?.edition || entry.eventId?.title || "-";
    const status = entry.status || "-";

    const row = sheet.addRow({
      name: name || (entry.contactId ? "-" : "Deleted guest"),
      mobile: mobile || "-",
      type: isSpouse ? "Spouse" : "Guest",
      spouseOf: isSpouse ? pick("fullName") || "-" : "-",
      edition,
      eventDate: fmt(entry.eventId?.startDateTime),
      status,
      manual: entry.markedManually ? "Yes" : "No",
      notes: entry.notes || "-",
      source: entry.source === "entry-report" ? "Entry Report" : "Manual",
      createdAt: fmt(entry.createdAt),
    });

    // Green / red status cell - same colours as the page.
    const statusCell = row.getCell("status");
    if (status === "Attended") {
      statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9F2E0" } };
      statusCell.font = { bold: true, color: { argb: "FF1E7B3A" } };
    } else if (status === "Not Attended") {
      statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFBE1E1" } };
      statusCell.font = { bold: true, color: { argb: "FFB42323" } };
    }

    const counts = perEdition.get(edition) || { attended: 0, notAttended: 0, other: 0 };
    if (status === "Attended") counts.attended += 1;
    else if (status === "Not Attended") counts.notAttended += 1;
    else counts.other += 1;
    perEdition.set(edition, counts);
  });

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  if (entries.length > 0) {
    sheet.autoFilter = { from: "A1", to: "K1" };
  }

  // ---------- sheet 2: counts per edition ----------
  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Edition", key: "edition", width: 24 },
    { header: "Attended", key: "attended", width: 14 },
    { header: "Not Attended", key: "notAttended", width: 16 },
    { header: "Other", key: "other", width: 12 },
    { header: "Total", key: "total", width: 12 },
  ];
  styleHeader(summary);

  const totals = { attended: 0, notAttended: 0, other: 0 };
  [...perEdition.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }))
    .forEach(([edition, c]) => {
      summary.addRow({
        edition,
        attended: c.attended,
        notAttended: c.notAttended,
        other: c.other,
        total: c.attended + c.notAttended + c.other,
      });
      totals.attended += c.attended;
      totals.notAttended += c.notAttended;
      totals.other += c.other;
    });

  const totalRow = summary.addRow({
    edition: "Total",
    attended: totals.attended,
    notAttended: totals.notAttended,
    other: totals.other,
    total: totals.attended + totals.notAttended + totals.other,
  });
  totalRow.font = { bold: true };

  // ---------- download ----------
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=EventHistory_${Date.now()}.xlsx`
  );

  await workbook.xlsx.write(res);
  res.end();
};

// ================= EDITIONS THAT HAVE HISTORY =================
// Options for the Event History "All Editions" filter. Built from the
// history itself, so an edition stays in the list (and stays filterable)
// even after its Event was deleted - for those the name comes from the
// eventSnapshot saved at delete time.
const getHistoryEditions = async () => {
  const groups = await ContactEventHistory.aggregate([
    { $match: { isDeleted: { $ne: true } } },
    { $group: { _id: "$eventId", snapshot: { $max: "$eventSnapshot" } } },
  ]);

  const liveEvents = await Event.find({ _id: { $in: groups.map((g) => g._id) } })
    .select("title edition startDateTime")
    .lean();
  const liveById = new Map(liveEvents.map((e) => [String(e._id), e]));

  return groups
    .map((g) => {
      const source = liveById.get(String(g._id)) || g.snapshot;
      if (!source) return null;
      return {
        value: String(g._id),
        label: source.edition || source.title || "-",
        startDateTime: source.startDateTime || null,
        isEventDeleted: !liveById.has(String(g._id)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.startDateTime || 0) - new Date(a.startDateTime || 0));
};

// ================= GET EVENT HISTORY BY CONTACT =================
// Supports optional ?page=&limit= — omit both to get the full,
// unpaginated timeline (the page's default view), same "pass what you
// need" shape as getAllEvents's own page/limit query params.
const getEventHistoryByContact = async (contactId, query = {}) => {
  await assertContactExists(contactId);

  const filter = { contactId, isDeleted: { $ne: true } };

  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 0; // 0 = no pagination applied below

  const baseQuery = ContactEventHistory.find(filter)
    .populate("eventId", "title edition startDateTime endDateTime venueName status")
    .sort({ createdAt: -1 });

  const total = await ContactEventHistory.countDocuments(filter);

  const rawHistory = limit
    ? await baseQuery.skip((page - 1) * limit).limit(limit)
    : await baseQuery;
  const history = rawHistory.map(withEventFallback);

  return {
    message: history.length
      ? "Event history fetched successfully"
      : "No event history found",
    data: history,
    pagination: {
      total,
      page,
      limit: limit || total,
      totalPages: limit ? Math.max(1, Math.ceil(total / limit)) : 1,
    },
  };
};

// ================= UPDATE EVENT HISTORY =================
// contactId is intentionally never accepted here — an entry always
// stays attached to the contact it was created under; only
// eventId/status/notes (the form's own fields, per this step's
// spec) are editable.
const updateEventHistory = async (id, data) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Event History ID", 400);
  }

  const history = await ContactEventHistory.findOne({
    _id: id,
    isDeleted: { $ne: true },
  });

  if (!history) {
    throw new AppError("Event history entry not found", 404);
  }

  // Unchanged event (e.g. only status/notes edited) needs no lookup, so a
  // row whose Event was deleted can still be edited.
  if (data.eventId && String(data.eventId) !== String(history.eventId)) {
    await assertEventExists(data.eventId);
    history.eventId = data.eventId;
    history.eventSnapshot = null;
  }

  if (data.status !== undefined) {
    history.status = data.status;
  }

  if (data.notes !== undefined) {
    history.notes = data.notes;
  }

  await history.save();

  return populateHistory(history);
};

// ================= DELETE EVENT HISTORY (SOFT DELETE) =================
const deleteEventHistory = async (id, adminId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Event History ID", 400);
  }

  const history = await ContactEventHistory.findOne({
    _id: id,
    isDeleted: { $ne: true },
  });

  if (!history) {
    throw new AppError("Event history entry not found", 404);
  }

  history.isDeleted = true;
  history.deletedAt = new Date();
  history.deletedBy = adminId || null;

  await history.save();

  return history;
};

// ================= HELPERS =================

async function assertContactExists(contactId) {
  if (!mongoose.Types.ObjectId.isValid(contactId)) {
    throw new AppError("Invalid Contact ID", 400);
  }

  const contact = await Contact.findOne({
    _id: contactId,
    isDeleted: { $ne: true },
  }).select("_id");

  if (!contact) {
    throw new AppError("Contact not found", 404);
  }
}

async function assertEventExists(eventId) {
  if (!mongoose.Types.ObjectId.isValid(eventId)) {
    throw new AppError("Invalid Event ID", 400);
  }

  const event = await Event.findOne({
    _id: eventId,
    isDeleted: { $ne: true },
  }).select("_id");

  if (!event) {
    throw new AppError("Event not found", 404);
  }
}

// Re-fetches with the Event populated the same way the list endpoint
// returns it, so create/update responses match getEventHistoryByContact's
// shape exactly (the frontend can drop either straight into its list
// state without a refetch).
async function populateHistory(history) {
  const doc = await ContactEventHistory.findById(history._id).populate(
    "eventId",
    "title edition startDateTime endDateTime venueName status"
  );
  return withEventFallback(doc);
}

// When the Event was deleted, populate() returns null for eventId. Rebuild
// it from the snapshot saved at delete time so the response keeps the same
// shape (eventId.title / edition / startDateTime ...) the frontend reads.
function withEventFallback(doc) {
  if (!doc) return doc;
  const obj = typeof doc.toObject === "function" ? doc.toObject() : doc;
  if (!obj.eventId && obj.eventSnapshot) {
    obj.eventId = { ...obj.eventSnapshot };
  }
  return obj;
}

module.exports = {
  createEventHistory,
  getAllEventHistory,
  getHistoryStats,
  markAttendance,
  exportEventHistory,
  getHistoryEditions,
  getEventHistoryByContact,
  updateEventHistory,
  deleteEventHistory,
};