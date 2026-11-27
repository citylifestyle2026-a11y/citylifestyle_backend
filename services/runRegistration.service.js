// services/runRegistration.service.js
//
// "Run Registration" module (5 KM / 10 KM).
//
//   Admin  : Add Data (name + mobile)  -> WhatsApp link
//   Person : opens link, picks 5 KM / 10 KM, confirms name + email
//            -> QR is created and sent on WhatsApp + email
//   Gate   : the normal QR scanner scans the QR  (hooked in qr.service.js)
//   Reports: Registered / Scanned / Registered-not-scanned / Not registered
//
// EDITION: every row belongs to one Event. All admin reads only show the rows
// of the event picked in the header dropdown (`eventId`), default = the active
// event (utils/defaultEvent.js) - the same rule every other module follows.
const crypto = require("crypto");
const mongoose = require("mongoose");

const RunRegistration = require("../models/runRegistration.model");
const Event = require("../models/event.model");
const Counter = require("../models/counters.model");
const Booking = require("../models/booking.model");

const AppError = require("../utils/AppError");
const generateQrCode = require("../utils/generateQrCode");
const uploadImage = require("../utils/localUpload.util");
const deleteLocalFile = require("../utils/deleteLocalFile");
const { normalizeMobileNumber, MOBILE_ERROR_MESSAGE } = require("../utils/normalizeMobileNumber");
const { getDefaultRunEvent } = require("../utils/defaultEvent");
const { onlyRunEvent } = require("../utils/runEvent");
const { LETS_RUN_NAME, getRunSchedule, getRunSettings, editionKeyOf, istDay, istDayRange } = require("../utils/letsRunConfig");
const whatsappService = require("./whatsapp.service");
const {
  formatEventDate,
  formatEventTime,
  buildVenueLocationUrl,
  buildInvitationUrl,
} = require("../utils/buildInvitationBodyParams");

const DISTANCES = [5, 10];
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The QR of a run person is an 8-digit Invitation ID - the SAME kind of ID a
// booking pass has, so the pass page (/ticket?qr=<id>), its QR and the scanner
// all work like they do for a booking. (Old test entries used "RUN-XXXXXXXX";
// those still scan.)
const LEGACY_QR_REGEX = /^RUN-[A-Z0-9]{8}$/i;
const EIGHT_DIGITS = /^\d{8}$/;

/* =========================================================
   small helpers
   ========================================================= */

const cleanName = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toObjectId = (value) =>
  value && mongoose.Types.ObjectId.isValid(String(value)) ? new mongoose.Types.ObjectId(String(value)) : null;

const randomToken = () => crypto.randomBytes(24).toString("base64url");

// Unique 8-digit Invitation ID, checked against bookings AND run people so
// the scanner / pass page can never mix the two up.
const generateRunInvitationId = async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = String(crypto.randomInt(10000000, 100000000));
    const [run, booking] = await Promise.all([
      RunRegistration.exists({ qrValue: candidate }),
      Booking.exists({ invitationId: candidate }),
    ]);
    if (!run && !booking) return candidate;
  }
  throw new AppError("Could not generate a unique invitation ID. Please retry.", 500);
};

// notRegistered | notScanned (registered, not yet scanned) | scanned
const stateOf = (item) =>
  item.status !== "registered" ? "notRegistered" : item.scannedAt ? "scanned" : "notScanned";

// Does this scanned value belong to a run person? (async: an 8-digit value is
// only theirs when a run registration has it.)
const isRunQr = async (value) => {
  const v = String(value || "").trim();
  if (LEGACY_QR_REGEX.test(v)) return true;
  if (!EIGHT_DIGITS.test(v)) return false;
  return Boolean(await RunRegistration.exists({ qrValue: v }));
};

const buildRunLink = (token) => {
  // Same base the digital invite link uses (PUBLIC_INVITE_URL_BASE), so
  // moving from Vercel to the live domain is one .env change.
  const base = String(process.env.PUBLIC_INVITE_URL_BASE || process.env.PUBLIC_FRONTEND_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) {
    throw new AppError(
      "PUBLIC_INVITE_URL_BASE (or PUBLIC_FRONTEND_URL) is not configured. Cannot build the registration link.",
      500
    );
  }
  return `${base}/run/${token}`;
};

// Messages never carry an event name: it is always "Let's Run".
const eventLabel = () => LETS_RUN_NAME;

// "5 KM Run" / "10 KM Run" for the link flow, "Let's Run" for the public form
// (which has no distance).
const ticketNameOf = (run) => (run.distance ? `${run.distance} KM Run` : "Let's Run");

// DTO sent to the admin pages.
const serialize = (doc, event) => {
  const item = doc.toObject ? doc.toObject() : doc;
  return {
    _id: item._id,
    eventId: item.eventId,
    eventTitle: event?.title || undefined,
    name: item.name,
    mobileNumber: item.mobileNumber,
    email: item.email || "",
    distance: item.distance || null,
    status: item.status,
    state: stateOf(item),
    token: item.token,
    registrationNumber: item.registrationNumber || "",
    // 8-digit Invitation ID: what the QR contains and what is printed on the pass.
    qrNumber: item.qrValue || "",
    qrImage: item.qrImage || "",
    registeredAt: item.registeredAt || null,
    scannedAt: item.scannedAt || null,
    linkSentAt: item.linkSentAt || null,
    linkError: item.linkError || "",
    qrSentAt: item.qrSentAt || null,
    qrError: item.qrError || "",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
};

// The event the Run Report is looking at: the picked one, else the current
// active event (the first one when several are active) - the same event the
// public /lets-run form registers people for. Returns null when no event exists.
// WHICH run the report / Add Data looks at (`eventId` from the select):
//   <event id>      a Let's Run event
//   "ed:<ISO date>" a run made without an event (its start date-time)
//   nothing         the run that is open now: the active event, else the current
//                   no-event run (date in Run date & time settings)
// Returns { event, eventId, editionKey }. Nothing here ever creates or moves rows.
const resolveScope = async (eventId) => {
  const value = String(eventId || "");
  if (value.startsWith("ed:")) {
    // a no-event run = a date. No / invalid date -> the one open now.
    const key = value.slice(3);
    return istDay(key) ? { event: null, eventId: null, editionKey: key } : currentRunScope();
  }

  const picked = toObjectId(value);
  if (picked) {
    const event = await Event.findOne({ _id: picked, isDeleted: { $ne: true }, ...onlyRunEvent() }).lean();
    if (event) return { event, eventId: event._id, editionKey: "" };
  }
  return currentRunScope();
};

// The run the form registers for right now. A Let's Run event that has not ended
// takes over; otherwise the no-event run of the saved date. NEVER "closed".
const currentRunScope = async () => {
  const event = await getDefaultRunEvent();
  if (event && !(event.endDateTime && new Date() > new Date(event.endDateTime))) {
    return { event, eventId: event._id, editionKey: "" };
  }
  const settings = await getRunSettings();
  return { event: null, eventId: null, editionKey: editionKeyOf(settings.startDateTime) };
};

// The Run Report / summary / Excel show EVERY entry (all runs) unless an
// explicit eventId is sent. Add Data and the public form use resolveScope (the
// run that is open now).
const viewScope = async (eventId) =>
  eventId ? resolveScope(eventId) : { all: true, event: null, eventId: null, editionKey: "" };

// A no-event run = one DATE: every row whose start falls on that day (India time), so a
// change of TIME only never splits a run. A different DATE is a different run.
const scopeMatch = (scope) => {
  if (scope.all) return {};
  if (scope.eventId) return { eventId: scope.eventId };
  const range = istDayRange(scope.editionKey);
  return range ? { eventId: null, editionKey: range } : { eventId: null };
};

// What a NEW row is saved with (scopeMatch is a filter: a date range for no-event runs).
const scopeFields = (scope) => ({
  eventId: scope.eventId || null,
  editionKey: scope.eventId ? "" : scope.editionKey || "",
});

// Events for the select in the Run Report header: EVERY "Let's Run" event -
// active and expired (ended) ones - so the report of an old event can still be
// opened. Newest first; plus the one the report opens with by default.
const listRunEvents = async () => {
  const [events, current, settings, editions] = await Promise.all([
    Event.find({ isDeleted: { $ne: true }, ...onlyRunEvent() })
      .sort({ startDateTime: -1 })
      .select("_id title startDateTime endDateTime isActive")
      .lean(),
    currentRunScope(),
    getRunSettings(),
    RunRegistration.aggregate([
      { $match: { eventId: null, editionKey: { $ne: "" } } },
      { $group: { _id: "$editionKey" } },
    ]),
  ]);
  const now = Date.now();
  const options = [
    ...events.map((e) => ({
      value: String(e._id),
      kind: "event",
      title: e.title,
      date: e.startDateTime || null,
      expired: Boolean(e.endDateTime) && new Date(e.endDateTime).getTime() < now,
    })),
    // runs made without an event: ONE per DATE, newest first (the date in .env now is always
    // there, with its current time; earlier dates show the start they were registered with)
    ...(() => {
      const byDay = new Map();
      editions.map((x) => x._id).filter((key) => istDay(key)).forEach((key) => {
        const day = istDay(key);
        if (!byDay.has(day) || key > byDay.get(day)) byDay.set(day, key);
      });
      byDay.set(istDay(settings.startDateTime), editionKeyOf(settings.startDateTime));
      return [...byDay.values()]
        .sort((a, b) => new Date(b) - new Date(a))
        .map((key) => ({
          value: `ed:${key}`,
          kind: "edition",
          title: LETS_RUN_NAME,
          date: key,
          expired: new Date(key).getTime() + 24 * 60 * 60 * 1000 < now,
        }));
    })(),
  ];
  const defaultValue = current.event ? String(current.event._id) : `ed:${current.editionKey}`;
  return { options, defaultValue };
};

const emptySummary = () => ({
  total: 0,
  registered: 0,
  scanned: 0,
  notScanned: 0,
  notRegistered: 0,
  distance: { 5: { registered: 0, scanned: 0 }, 10: { registered: 0, scanned: 0 } },
});

/* =========================================================
   WhatsApp / email (never allowed to break the main request)
   ========================================================= */

// Registration link. Uses the approved link template when
// CHATBOX_RUN_LINK_TEMPLATE_NAME is set. The FULL link goes in as a body
// variable (no URL button), like the digital invite link, so the template
// never contains a domain and a domain change needs no re-approval:
//   {{1}} name   {{2}} event   {{3}} registration link
// Without a template it falls back to a plain text message (only delivered
// inside WhatsApp's 24-hour window).
const sendLinkWhatsapp = async (run, event) => {
  const templateName = process.env.CHATBOX_RUN_LINK_TEMPLATE_NAME;
  const languageCode = process.env.CHATBOX_RUN_LINK_TEMPLATE_LANGUAGE || "en";
  const link = buildRunLink(run.token);

  if (templateName) {
    await whatsappService.sendTemplateMessage({
      phone: run.mobileNumber,
      templateName,
      languageCode,
      bodyParams: [run.name, LETS_RUN_NAME, link],
    });
    return;
  }

  await whatsappService.sendTextMessage({
    phone: run.mobileNumber,
    message:
      `Hello ${run.name},\n` +
      `Please complete your 5 KM / 10 KM run registration for ${LETS_RUN_NAME}:\n` +
      link,
  });
};

// Pass on WhatsApp - EXACTLY like the booking pass: the same body-only
// invitation template (CHATBOX_INVITE_TEMPLATE_NAME / _LANGUAGE, e.g.
// "parv_invitation_pass"), the same 11 body values and the same digital pass
// page <base>/ticket?qr=<Invitation ID> (GuestPass), which shows the QR.
//   {{1}} name  {{2}} event  {{3}} name  {{4}} guests (1)  {{5}} date
//   {{6}} time  {{7}} venue  {{8}} dress code  {{9}} Invitation ID
//   {{10}} digital invite link  {{11}} venue location
const sendQrWhatsapp = async (run, event) => {
  const templateName = process.env.CHATBOX_INVITE_TEMPLATE_NAME || "parv_invitation_confirmed";
  const languageCode = process.env.CHATBOX_INVITE_TEMPLATE_LANGUAGE || "en";
  const sched = await getRunSchedule(event, run.editionKey); // works with or without an event

  await whatsappService.sendTemplateMessage({
    phone: run.mobileNumber,
    templateName,
    languageCode,
    bodyParams: [
      run.name,
      LETS_RUN_NAME,
      run.name,
      1,
      formatEventDate(sched.startDateTime),
      formatEventTime(sched.startDateTime),
      sched.venueName || "-",
      sched.dressCode,
      run.qrValue,
      buildInvitationUrl(run.qrValue),
      buildVenueLocationUrl(sched) || sched.address || "-",
    ],
  });
};

// Sends the registration link and records the result on the row.
// Returns true when WhatsApp accepted the message.
const deliverLink = async (run, event) => {
  try {
    await sendLinkWhatsapp(run, event);
    await RunRegistration.updateOne({ _id: run._id }, { $set: { linkSentAt: new Date(), linkError: "" } });
    return true;
  } catch (error) {
    console.error(`[run-registration] link WhatsApp failed for ${run.mobileNumber}:`, error.message);
    await RunRegistration.updateOne(
      { _id: run._id },
      { $set: { linkError: String(error.message || "WhatsApp failed").slice(0, 300) } }
    ).catch(() => {});
    return false;
  }
};

// Sends the QR on WhatsApp AND by email. Each channel is independent: one
// failing never stops the other. Returns { whatsapp, email } booleans.
// useLetsRunTemplate = true (admin "Resend QR"): the WhatsApp message is the SAME
// one the /lets-run form sends (CHATBOX_LETS_RUN_TEMPLATE_NAME, e.g.
// lets_run_registration_confirmed) instead of the invitation-pass template.
const deliverQr = async (run, event, qrBuffer, { useLetsRunTemplate = false } = {}) => {
  const result = { whatsapp: false, email: false };
  const errors = [];

  try {
    if (useLetsRunTemplate) await sendLetsRunWhatsapp(run);
    else await sendQrWhatsapp(run, event);
    result.whatsapp = true;
  } catch (error) {
    console.error(`[run-registration] QR WhatsApp failed for ${run.mobileNumber}:`, error.message);
    errors.push(`WhatsApp: ${error.message}`);
  }

  if (run.email) {
    try {
      const { sendRunQrEmail } = require("../utils/email.util");
      await sendRunQrEmail({
        to: run.email,
        name: run.name,
        distance: run.distance,
        registrationNumber: run.registrationNumber,
        eventTitle: LETS_RUN_NAME,
        qrBuffer,
      });
      result.email = true;
    } catch (error) {
      console.error(`[run-registration] QR email failed for ${run.email}:`, error.message);
      errors.push(`Email: ${error.message}`);
    }
  }

  await RunRegistration.updateOne(
    { _id: run._id },
    {
      $set: {
        qrSentAt: result.whatsapp || result.email ? new Date() : null,
        qrError: errors.join(" | ").slice(0, 300),
      },
    }
  ).catch(() => {});

  return result;
};

/* =========================================================
   ADMIN
   ========================================================= */

const buildFilter = (scope, { search, status, distance } = {}) => {
  const filter = { ...scopeMatch(scope) };

  switch (status) {
    case "registered":
      filter.status = "registered";
      break;
    case "scanned":
      filter.status = "registered";
      filter.scannedAt = { $ne: null };
      break;
    case "notScanned":
      filter.status = "registered";
      filter.scannedAt = null;
      break;
    case "notRegistered":
      filter.status = "invited";
      break;
    default:
      break;
  }

  if (DISTANCES.includes(Number(distance))) filter.distance = Number(distance);

  const term = String(search || "").trim();
  if (term) {
    const rx = new RegExp(escapeRegex(term), "i");
    const digits = term.replace(/\D/g, "");
    const or = [{ name: rx }, { email: rx }, { registrationNumber: rx }];
    // A phone number may be typed with 91 / +91 / spaces: match on its digits.
    if (digits.length >= 3) {
      const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
      or.push({ mobileNumber: new RegExp(escapeRegex(local)) });
    }
    filter.$or = or;
  }

  return filter;
};

const getSummary = async (eventId) => {
  const scope = await viewScope(eventId);
  const event = scope.event;

  const rows = await RunRegistration.aggregate([
    // no event -> the rows that belong to Let's Run without an event
    { $match: scopeMatch(scope) },
    {
      $group: {
        _id: { status: "$status", distance: "$distance", scanned: { $cond: [{ $ne: ["$scannedAt", null] }, 1, 0] } },
        count: { $sum: 1 },
      },
    },
  ]);

  const summary = emptySummary();
  rows.forEach(({ _id, count }) => {
    summary.total += count;
    if (_id.status !== "registered") {
      summary.notRegistered += count;
      return;
    }
    summary.registered += count;
    if (_id.scanned) summary.scanned += count;
    else summary.notScanned += count;

    const bucket = summary.distance[_id.distance];
    if (bucket) {
      bucket.registered += count;
      if (_id.scanned) bucket.scanned += count;
    }
  });

  return {
    ...summary,
    event: event ? { _id: event._id, title: event.title, edition: event.edition || "" } : null,
    editionKey: scope.editionKey,
  };
};

// params: page, limit, search, status, distance, eventId
const listRuns = async (query = {}) => {
  const scope = await viewScope(query.eventId);
  const event = scope.event;

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limitRaw = parseInt(query.limit, 10);
  // limit=0 (or "All") returns everything.
  // The "All" choice of the rows select is sent as 100000 (ALL_ROWS): never cap it.
  const all = limitRaw === 0 || limitRaw >= 100000 || String(query.limit).toLowerCase() === "all";
  const limit = all ? 0 : Math.min(Math.max(limitRaw || 10, 1), 500);

  const filter = buildFilter(scope, query);
  const total = await RunRegistration.countDocuments(filter);

  let cursor = RunRegistration.find(filter).sort({ createdAt: -1, _id: -1 });
  if (limit) cursor = cursor.skip((page - 1) * limit).limit(limit);

  const [docs, summary] = await Promise.all([cursor, getSummary(query.eventId)]);

  return {
    items: docs.map((doc) => serialize(doc, event)),
    total,
    totalPages: limit ? Math.max(1, Math.ceil(total / limit)) : 1,
    page: limit ? page : 1,
    summary,
    event: event ? { _id: event._id, title: event.title, edition: event.edition || "" } : null,
  };
};

const validateName = (value) => {
  const name = cleanName(value);
  if (!name) throw new AppError("Name is required.", 400);
  if (name.length > 60) throw new AppError("Name is too long (max 60 characters).", 400);
  return name;
};

const validateMobile = (value) => {
  const mobile = normalizeMobileNumber(value);
  if (!mobile) throw new AppError(MOBILE_ERROR_MESSAGE, 400);
  return mobile;
};

// body: { name, mobile, eventId? }  -> { run, whatsappSent }
const createRun = async (body = {}, adminId = null) => {
  const name = validateName(body.name);
  const mobileNumber = validateMobile(body.mobile ?? body.mobileNumber);

  const scope = await resolveScope(body.eventId); // no event needed
  const event = scope.event;

  if (await RunRegistration.exists({ ...scopeMatch(scope), mobileNumber })) {
    throw new AppError("This mobile number is already added for this event.", 409);
  }

  let run;
  try {
    run = await RunRegistration.create({
      ...scopeFields(scope),
      name,
      mobileNumber,
      token: randomToken(),
      createdBy: adminId || null,
    });
  } catch (error) {
    if (error.code === 11000) throw new AppError("This mobile number is already added for this event.", 409);
    throw error;
  }

  const whatsappSent = await deliverLink(run, event);
  const fresh = await RunRegistration.findById(run._id);

  return { run: serialize(fresh, event), whatsappSent };
};

// Edit: name + mobile always. Email + distance only once the person has
// registered (until then they fill those in themselves on the link page).
// body: { name?, mobile?, email?, distance? }
const updateRun = async (id, body = {}) => {
  if (!toObjectId(id)) throw new AppError("Invalid ID.", 400);

  const run = await RunRegistration.findById(id);
  if (!run) throw new AppError("Entry not found.", 404);

  const event = run.eventId ? await Event.findById(run.eventId).lean() : null;

  if (body.name !== undefined) run.name = validateName(body.name);

  let mobileChanged = false;
  const incomingMobile = body.mobile ?? body.mobileNumber;
  if (incomingMobile !== undefined) {
    const mobileNumber = validateMobile(incomingMobile);
    if (mobileNumber !== run.mobileNumber) {
      const clash = await RunRegistration.exists({
        ...scopeMatch({ eventId: run.eventId || null, editionKey: run.editionKey || "" }),
        mobileNumber,
        _id: { $ne: run._id },
      });
      if (clash) throw new AppError("This mobile number is already added for this event.", 409);
      run.mobileNumber = mobileNumber;
      mobileChanged = true;
    }
  }

  if (run.status === "registered") {
    if (body.email !== undefined) {
      // Optional: empty clears it.
      const email = String(body.email || "").trim().toLowerCase();
      if (email && !EMAIL_RX.test(email)) throw new AppError("Enter a valid email address.", 400);
      run.email = email;
    }
    if (body.distance !== undefined && body.distance !== null && body.distance !== "") {
      if (!DISTANCES.includes(Number(body.distance))) throw new AppError("Please select 5 KM or 10 KM.", 400);
      run.distance = Number(body.distance);
    }
  }

  try {
    await run.save();
  } catch (error) {
    if (error.code === 11000) throw new AppError("This mobile number is already added for this event.", 409);
    throw error;
  }

  // Link was sent to the OLD number: send it to the new one.
  let whatsappSent = null;
  if (mobileChanged && run.status !== "registered") {
    whatsappSent = await deliverLink(run, event);
  }

  const fresh = await RunRegistration.findById(run._id);
  return { run: serialize(fresh, event), whatsappSent };
};

const deleteRun = async (id) => {
  if (!toObjectId(id)) throw new AppError("Invalid ID.", 400);

  const run = await RunRegistration.findByIdAndDelete(id);
  if (!run) throw new AppError("Entry not found.", 404);

  // The QR file is no longer needed (the QR itself stops working: no row).
  await deleteLocalFile(run.qrImagePublicId);
  return true;
};

// Run Report: delete the ticked rows. body: { ids: [...] } (max 5000 at once).
// Same as deleteRun for each row: the row goes, so its QR stops working, and
// the QR image file is removed. Returns how many rows were deleted.
const deleteRuns = async (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) throw new AppError("Select at least one entry.", 400);
  if (ids.length > 5000) throw new AppError("Too many entries selected at once.", 400);

  const objectIds = [...new Set(ids.map((id) => String(id)))].map(toObjectId).filter(Boolean);
  if (objectIds.length === 0) throw new AppError("Invalid selection.", 400);

  const runs = await RunRegistration.find({ _id: { $in: objectIds } }).select("qrImagePublicId").lean();
  if (runs.length === 0) throw new AppError("Entries not found.", 404);

  const result = await RunRegistration.deleteMany({ _id: { $in: runs.map((run) => run._id) } });

  for (const run of runs) {
    await deleteLocalFile(run.qrImagePublicId);
  }
  return { deleted: result.deletedCount || 0 };
};

// Run Report checkboxes -> send the QR again to every ticked person who has
// registered (WhatsApp + email, same QR). body: { ids: [...] } (max 500 at once).
const resendRuns = async (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) throw new AppError("Select at least one entry.", 400);
  if (ids.length > 500) throw new AppError("Too many entries selected at once (max 500).", 400);

  const objectIds = [...new Set(ids.map((id) => String(id)))].map(toObjectId).filter(Boolean);
  if (objectIds.length === 0) throw new AppError("Invalid selection.", 400);

  const runs = await RunRegistration.find({ _id: { $in: objectIds }, status: "registered" });
  if (runs.length === 0) throw new AppError("None of the selected entries has a QR to send.", 400);

  let sent = 0;
  let failed = 0;
  for (const run of runs) {
    const event = run.eventId ? await Event.findById(run.eventId).lean() : null;
    const result = await deliverQr(run, event, null, { useLetsRunTemplate: true });
    if (result.whatsapp || result.email) sent += 1;
    else failed += 1;
  }
  return { sent, failed, skipped: objectIds.length - runs.length };
};

// Not registered yet -> link again. Registered -> QR again.
const resendRun = async (id) => {
  if (!toObjectId(id)) throw new AppError("Invalid ID.", 400);

  const run = await RunRegistration.findById(id);
  if (!run) throw new AppError("Entry not found.", 404);

  const event = run.eventId ? await Event.findById(run.eventId).lean() : null;

  if (run.status !== "registered") {
    const sent = await deliverLink(run, event);
    if (!sent) {
      const fresh = await RunRegistration.findById(run._id);
      throw new AppError(fresh?.linkError || "Unable to send the WhatsApp message.", 502);
    }
    return { kind: "link" };
  }

  const result = await deliverQr(run, event, null, { useLetsRunTemplate: true });
  if (!result.whatsapp && !result.email) {
    const fresh = await RunRegistration.findById(run._id);
    throw new AppError(fresh?.qrError || "Unable to send the QR.", 502);
  }
  return { kind: "qr", ...result };
};

const STATE_LABEL = { notRegistered: "Not Registered", notScanned: "Registered, Not Scanned", scanned: "Scanned" };

// Excel of the current tab / distance / search for the selected event.
const exportRuns = async (query, res) => {
  const scope = await viewScope(query.eventId);

  const rows = await RunRegistration.find(buildFilter(scope, query))
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Event Management CRM";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Run Registrations");
  sheet.columns = [
    { header: "No.", key: "no", width: 6 },
    { header: "Name", key: "name", width: 26 },
    { header: "Mobile", key: "mobile", width: 18 },
    { header: "Email", key: "email", width: 30 },
    { header: "Distance", key: "distance", width: 10 },
    { header: "Registration No", key: "reg", width: 16 },
    { header: "QR Number", key: "qrNumber", width: 14 },
    { header: "Status", key: "status", width: 24 },
    { header: "Registered On", key: "registeredAt", width: 22 },
    { header: "Scanned On", key: "scannedAt", width: 22 },
  ];

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "1F4E78" } };
  header.alignment = { vertical: "middle", horizontal: "center" };

  const stamp = (date) => (date ? new Date(date).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "-");

  rows.forEach((item, index) => {
    sheet.addRow({
      no: index + 1,
      name: item.name,
      // text, so a long number is never shown as 9.9E+11
      mobile: String(item.mobileNumber || "").replace(/^91(?=\d{10}$)/, ""),
      email: item.email || "-",
      distance: item.distance ? `${item.distance} KM` : "-",
      reg: item.registrationNumber || "-",
      // text, so the 8 digits are never turned into a number / scientific format
      qrNumber: item.qrValue ? String(item.qrValue) : "-",
      status: STATE_LABEL[stateOf(item)],
      registeredAt: stamp(item.registeredAt),
      scannedAt: stamp(item.scannedAt),
    });
  });
  sheet.getColumn("mobile").numFmt = "@";
  sheet.getColumn("qrNumber").numFmt = "@";

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", 'attachment; filename="Run_Registrations.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
};

/* =========================================================
   PUBLIC (the /run/:token page, no login)
   ========================================================= */

const publicView = (run, event) => ({
  name: run.name,
  mobileNumber: run.mobileNumber,
  email: run.email || "",
  distance: run.distance || null,
  status: run.status,
  registrationNumber: run.registrationNumber || "",
  qrImage: run.qrImage || "",
  registeredAt: run.registeredAt || null,
  eventTitle: LETS_RUN_NAME,
});

const findByToken = async (token) => {
  const value = String(token || "").trim();
  const run = value ? await RunRegistration.findOne({ token: value }) : null;
  if (!run) throw new AppError("This registration link is not valid.", 404);
  // No event is fine (Let's Run without an event); a DELETED event is not.
  const event = run.eventId ? await Event.findById(run.eventId).lean() : null;
  if (run.eventId && (!event || event.isDeleted)) throw new AppError("This registration link is not valid.", 404);
  return { run, event };
};

const getPublicRun = async (token) => {
  const { run, event } = await findByToken(token);
  return publicView(run, event);
};

// REGISTRATION NUMBER  =  RUN + <run no. 2 digits> + <serial 4 digits>
//   1st run  -> RUN010001, RUN010002, ...
//   2nd run  -> RUN020001, RUN020002, ...
// A "run" is ONE Let's Run event, or ONE DATE of the run without an event
// (LETS_RUN_START in .env). Changing only the TIME keeps the run and its numbering;
// a new DATE (or a new event) is a new run and takes the next run no. (RUN02..., RUN03...),
// so a number never repeats across runs in the Run Report. Both counters are atomic
// ($inc), safe for parallel submits.
const runScopeKey = (scope) => (scope.eventId ? `evt:${scope.eventId}` : `ed:${istDay(scope.editionKey) || "default"}`);

// Run no. of a run: given once (the next free one) the first time it gets a registration.
const getRunSeriesNo = async (scope) => {
  const name = `RUN_SERIES_OF:${runScopeKey(scope)}`;

  const existing = await Counter.findOne({ name }).lean();
  if (existing) return existing.sequence;

  // This date already has registrations (made before this counter existed):
  // carry on from the highest number given, e.g. RUN010063 -> next is RUN010064.
  if (!scope.eventId) {
    const top = await RunRegistration.findOne({ ...scopeMatch(scope), registrationNumber: /^RUN\d{6}$/ })
      .sort({ registrationNumber: -1 })
      .select("registrationNumber")
      .lean();
    if (top) {
      const seriesNo = parseInt(top.registrationNumber.slice(3, 5), 10);
      const lastSerial = parseInt(top.registrationNumber.slice(5), 10);
      // keep the global run no. at least this high, so a new event never reuses it
      await Counter.updateOne({ name: "RUN_SERIES" }, { $max: { sequence: seriesNo } }, { upsert: true });
      for (const [counterName, value] of [[name, seriesNo], [`RUN_SEQ:${runScopeKey(scope)}`, lastSerial]]) {
        try {
          await Counter.updateOne({ name: counterName }, { $setOnInsert: { sequence: value } }, { upsert: true });
        } catch (error) {
          if (error.code !== 11000) throw error; // another request seeded it first
        }
      }
      const seeded = await Counter.findOne({ name }).lean();
      if (seeded) return seeded.sequence;
    }
  }

  const global = await Counter.findOneAndUpdate(
    { name: "RUN_SERIES" },
    { $inc: { sequence: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  try {
    await Counter.updateOne({ name }, { $setOnInsert: { sequence: global.sequence } }, { upsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error; // two first registrations at once: the other one won
  }
  // Re-read: if another request saved first, ITS run no. is the one that counts.
  const saved = await Counter.findOne({ name }).lean();
  return saved ? saved.sequence : global.sequence;
};

const nextRegistrationNumber = async (scope) => {
  const series = await getRunSeriesNo(scope);
  const prefix = `RUN${String(series).padStart(2, "0")}`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const counter = await Counter.findOneAndUpdate(
      { name: `RUN_SEQ:${runScopeKey(scope)}` },
      { $inc: { sequence: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    const candidate = `${prefix}${String(counter.sequence).padStart(4, "0")}`;
    // Safety net: never hand out a number that already exists.
    if (!(await RunRegistration.exists({ registrationNumber: candidate }))) return candidate;
  }
  throw new AppError("Could not generate a unique registration number. Please retry.", 500);
};

// body: { distance: 5 | 10, name, email, mobile? }.  The mobile number starts as
// the number the link was sent to; the person may change it on the form and the
// QR then goes to the number they submit (still one number per event).
const submitPublicRun = async (token, body = {}) => {
  const { run, event } = await findByToken(token);

  if (run.status === "registered") throw new AppError("You are already registered.", 409);

  // Registration closes when the event is over.
  if (event.endDateTime && new Date() > new Date(event.endDateTime)) {
    throw new AppError("Registration is closed because this event has ended.", 400);
  }

  const distance = Number(body.distance);
  if (!DISTANCES.includes(distance)) throw new AppError("Please select 5 KM or 10 KM.", 400);

  const name = validateName(body.name);

  // Email is optional; when given it must be valid (the QR is mailed to it).
  const email = String(body.email || "").trim().toLowerCase();
  if (email && !EMAIL_RX.test(email)) throw new AppError("Enter a valid email address.", 400);

  const mobileNumber =
    body.mobile !== undefined && body.mobile !== null && body.mobile !== ""
      ? validateMobile(body.mobile)
      : run.mobileNumber;
  if (
    mobileNumber !== run.mobileNumber &&
    (await RunRegistration.exists({ ...scopeMatch({ eventId: run.eventId || null, editionKey: run.editionKey || "" }), mobileNumber, _id: { $ne: run._id } }))
  ) {
    throw new AppError("This mobile number is already registered for this event.", 409);
  }

  const registrationNumber = await nextRegistrationNumber({ eventId: run.eventId || null, editionKey: run.editionKey || "" });

  // The 8-digit Invitation ID: printed on the pass and encoded in the QR.
  const qrValue = await generateRunInvitationId();

  const qrBuffer = await generateQrCode(qrValue);
  const qrUpload = await uploadImage(qrBuffer, "event-management/qr-codes", "image", { format: "png" });

  // ONE atomic update: if two phones submit the same link at once, only one wins.
  let updated;
  try {
    updated = await RunRegistration.findOneAndUpdate(
      { _id: run._id, status: "invited" },
      {
        $set: {
          name,
          mobileNumber,
          email,
          distance,
          status: "registered",
          registrationNumber,
          qrValue,
          qrImage: qrUpload.url,
          qrImagePublicId: qrUpload.public_id,
          registeredAt: new Date(),
        },
      },
      { new: true }
    );
  } catch (error) {
    await deleteLocalFile(qrUpload.public_id);
    // The new number was taken by someone else in the meantime.
    if (error.code === 11000) {
      throw new AppError("This mobile number is already registered for this event.", 409);
    }
    throw error;
  }

  if (!updated) {
    await deleteLocalFile(qrUpload.public_id);
    throw new AppError("You are already registered.", 409);
  }

  // WhatsApp + email in the background: the person already sees the QR on the page.
  deliverQr(updated, event, qrBuffer).catch((error) =>
    console.error("[run-registration] QR delivery failed:", error.message)
  );

  return publicView(updated, event);
};

/* =========================================================
   PUBLIC "LET'S RUN" FORM  (/lets-run, no login)
   Name + mobile -> registered at once, ticket link on WhatsApp.
   The ticket belongs to the CURRENT ACTIVE EVENT; when several are
   active, the one that starts first (same rule as the dashboard).
   ========================================================= */

// Approved WhatsApp template (body only, 3 variables):
//   Hello {{1}}, Your registration for {{2}} is confirmed. ... Entry QR: {{3}}
//   {{1}} name   {{2}} event name (the current active event's title)
//   {{3}} ticket link  <site>/ticket?qr=<Invitation ID>
// Set CHATBOX_LETS_RUN_TEMPLATE_NAME (+ _LANGUAGE) in .env. Without it a plain
// text message with the same words is sent (only delivered inside WhatsApp's
// 24-hour window).
const sendLetsRunWhatsapp = async (run) => {
  const link = buildInvitationUrl(run.qrValue);
  // The message never uses event data: it always says "Let's Run", so it works
  // the same with or without an event.
  const eventName = LETS_RUN_NAME;
  const templateName = process.env.CHATBOX_LETS_RUN_TEMPLATE_NAME;
  const languageCode = process.env.CHATBOX_LETS_RUN_TEMPLATE_LANGUAGE || "en";

  if (templateName) {
    await whatsappService.sendTemplateMessage({
      phone: run.mobileNumber,
      templateName,
      languageCode,
      bodyParams: [run.name, eventName, link],
    });
    return;
  }

  await whatsappService.sendTextMessage({
    phone: run.mobileNumber,
    message:
      `Hello ${run.name},\n\n` +
      `Your registration for ${eventName} is confirmed.\n\n` +
      "Your entry QR code is available at the link below. Please show it at the venue entrance.\n\n" +
      `Entry QR: ${link}\n\n` +
      "Thank you for registering.",
  });
};

// The run the public form registers for. The form is ALWAYS open: an active
// Let's Run event (not ended) takes over, otherwise it is the no-event run of the
// date saved in Run Report -> Run date & time. Change that date and the next
// registrations belong to the new run; earlier ones stay where they are.
const getOpenLetsRun = async () => {
  const scope = await currentRunScope();
  const sched = await getRunSchedule(scope.event, scope.editionKey);
  return { scope, event: scope.event, sched };
};

// GET /api/public/lets-run -> what the form header shows.
const getLetsRunInfo = async () => {
  const { sched } = await getOpenLetsRun();
  return {
    eventTitle: LETS_RUN_NAME,
    date: formatEventDate(sched.startDateTime),
    time: formatEventTime(sched.startDateTime),
    venueName: sched.venueName || "",
  };
};

// body: { name, mobile } -> { name, qrNumber, whatsappSent, alreadyRegistered }
// ONE number = ONE ticket PER RUN (event or no-event date): if the number is
// already registered there, the SAME QR is sent again and the name is updated to
// the one typed now. The same number
// registering for a NEW event is a new registration with a new QR.
const submitLetsRun = async (body = {}) => {
  const name = validateName(body.name);
  const mobileNumber = validateMobile(body.mobile ?? body.mobileNumber);
  const { scope } = await getOpenLetsRun();
  const match = scopeMatch(scope);

  let run = await RunRegistration.findOne({ ...match, mobileNumber });
  let alreadyRegistered = false;

  // Same number, different name: the QR stays the same, the NAME follows the
  // latest form (so the pass and the WhatsApp message show the new name).
  const renameIfChanged = async (existing, newName) => {
    if (existing.name === newName) return existing;
    return (await RunRegistration.findByIdAndUpdate(existing._id, { $set: { name: newName } }, { new: true })) || existing;
  };

  const guardResend = (existing) => {
    // 30 s gap so the form cannot be used to spam a number with messages.
    if (existing.qrSentAt && Date.now() - new Date(existing.qrSentAt).getTime() < 30 * 1000) {
      throw new AppError("Your ticket was just sent on WhatsApp. Please check your messages.", 429);
    }
  };

  if (run && run.status === "registered") {
    alreadyRegistered = true;
    guardResend(run);
    run = await renameIfChanged(run, name);
  } else {
    const registrationNumber = await nextRegistrationNumber(scope);
    const qrValue = await generateRunInvitationId();
    const qrBuffer = await generateQrCode(qrValue);
    const qrUpload = await uploadImage(qrBuffer, "event-management/qr-codes", "image", { format: "png" });

    const fields = {
      name,
      status: "registered",
      registrationNumber,
      qrValue,
      qrImage: qrUpload.url,
      qrImagePublicId: qrUpload.public_id,
      registeredAt: new Date(),
      source: "lets-run",
    };

    try {
      if (run) {
        // An admin had added this number (link not used yet): complete that row.
        run = await RunRegistration.findOneAndUpdate(
          { _id: run._id, status: "invited" },
          { $set: fields },
          { new: true }
        );
      } else {
        run = await RunRegistration.create({
          ...scopeFields(scope),
          mobileNumber,
          token: randomToken(),
          ...fields,
        });
      }
    } catch (error) {
      await deleteLocalFile(qrUpload.public_id);
      if (error.code === 11000) {
        // Two taps at the same moment: the other one won - give back ITS ticket.
        const existing = await RunRegistration.findOne({ ...match, mobileNumber, status: "registered" });
        if (!existing) throw new AppError("This mobile number is already registered.", 409);
        run = existing;
        alreadyRegistered = true;
        guardResend(run);
        run = await renameIfChanged(run, name);
      } else {
        throw error;
      }
    }

    if (!run) {
      await deleteLocalFile(qrUpload.public_id);
      const existing = await RunRegistration.findOne({ ...match, mobileNumber, status: "registered" });
      if (!existing) throw new AppError("You are already registered.", 409);
      run = await renameIfChanged(existing, name);
      alreadyRegistered = true;
    }
  }

  let whatsappSent = false;
  try {
    await sendLetsRunWhatsapp(run);
    whatsappSent = true;
    await RunRegistration.updateOne({ _id: run._id }, { $set: { qrSentAt: new Date(), qrError: "" } });
  } catch (error) {
    console.error(`[lets-run] WhatsApp failed for ${run.mobileNumber}:`, error.message);
    await RunRegistration.updateOne(
      { _id: run._id },
      { $set: { qrError: String(error.message || "WhatsApp failed").slice(0, 300) } }
    ).catch(() => {});
  }

  return { name: run.name, qrNumber: run.qrValue, whatsappSent, alreadyRegistered };
};

/* =========================================================
   PASS PAGE  (/ticket?qr=<Invitation ID>  ->  GET /api/public/invitation/:id)
   Same payload as a booking pass, so the same GuestPass page shows it.
   Returns null when no run person has this ID.
   ========================================================= */

const getRunInvitation = async (invitationId) => {
  const run = await RunRegistration.findOne({ qrValue: String(invitationId), status: "registered" });
  if (!run) return null;

  // No event is fine: the date / time come from the Let's Run settings.
  const linked = run.eventId ? await Event.findById(run.eventId).lean() : null;
  if (run.eventId && (!linked || linked.isDeleted)) return null;
  const event = await getRunSchedule(linked, run.editionKey);

  // Sent inline (not a link under /uploads) so the pass keeps working even if
  // the server disk is wiped - same as the booking pass.
  let qrImage = run.qrImage;
  try {
    qrImage = `data:image/png;base64,${(await generateQrCode(run.qrValue)).toString("base64")}`;
  } catch (error) {
    console.error("Run pass QR regeneration failed, using stored image:", error.message);
  }

  const scanned = Boolean(run.scannedAt);
  return {
    invitationId: run.qrValue,
    guestName: run.name,
    companyName: "",
    mobileNumber: String(run.mobileNumber || "").replace(/^91(?=\d{10}$)/, ""),
    contact: {
      name: process.env.EVENT_CONTACT_NAME || "Aniket Patel",
      number: process.env.EVENT_CONTACT_NUMBER || "7016851932",
    },
    numberOfGuests: 1,
    references: [],
    qrImage,
    enteredGuests: scanned ? 1 : 0,
    remainingGuests: scanned ? 0 : 1,
    isPartiallyUsed: false,
    isUsed: scanned,
    isCancelled: false,
    ticketName: ticketNameOf(run),
    isRunRegistration: true,
    registrationNumber: run.registrationNumber || "",
    purchasedAt: run.registeredAt || run.createdAt || null,
    event: {
      title: LETS_RUN_NAME,
      image: event.image,
      date: formatEventDate(event.startDateTime),
      time: formatEventTime(event.startDateTime),
      endTime: event.endDateTime ? formatEventTime(event.endDateTime) : "",
      startDateTime: event.startDateTime,
      endDateTime: event.endDateTime || null,
      venueName: event.venueName,
      address: event.address,
      dressCode: event.dressCode || "Sportswear",
      locationUrl: buildVenueLocationUrl(event),
      // The Let's Run pass has no Terms & Conditions.
      termsConditions: "",
    },
  };
};

/* =========================================================
   QR SCANNER (called from qr.service.js)
   ========================================================= */

const loadScannable = async (qrValue) => {
  const run = await RunRegistration.findOne({ qrValue: String(qrValue).trim().toUpperCase() });
  if (!run || run.status !== "registered") throw new AppError("QR ticket not found.", 404);

  // NO event = the pass scans fine (Let's Run without an event). Event checks
  // (inactive / ended) only apply when the person is linked to a real event.
  let event = null;
  if (run.eventId) {
    event = await Event.findById(run.eventId).lean();
    if (!event || event.isDeleted) throw new AppError("Event not found.", 404);

    // Same test switch the booking scanner uses.
    const testMode = String(process.env.QR_TEST_MODE || "").toLowerCase() === "true";
    if (!testMode && !event.isActive) throw new AppError("This event is inactive.", 400);
    if (!testMode && event.endDateTime && new Date() > new Date(event.endDateTime)) {
      throw new AppError("This event has ended.", 400);
    }
  }

  return { run, event: await getRunSchedule(event, run.editionKey) };
};

// Same shape the scanner already understands for a booking ticket.
const scannerDto = (run, event, { status, scannedAt }) => ({
  bookingId: null,
  bookingNumber: run.registrationNumber,
  ticketId: run._id,
  ticketNumber: run.registrationNumber,
  status,
  isRegistered: true,
  scannedAt: scannedAt || null,
  qrToken: run.qrValue,
  attendee: { name: run.name, mobileNumber: run.mobileNumber, email: run.email, profileImage: "" },
  isRunRegistration: true,
  isGroupEntry: false,
  guests: 1,
  remaining: status === "Used" ? 0 : 1,
  alreadyEntered: 0,
  totalGuests: 1,
  booking: {
    name: run.name,
    mobileNumber: run.mobileNumber,
    invitationId: null,
    quantity: 1,
    amount: 0,
    discount: 0,
  },
  event: {
    id: event._id || null,
    title: LETS_RUN_NAME,
    venueName: event.venueName,
    address: event.address,
    startDateTime: event.startDateTime,
    endDateTime: event.endDateTime,
  },
  ticketType: { id: null, ticketName: ticketNameOf(run), amount: 0 },
});

const ALREADY_SCANNED = "This ticket has already been checked in.";

const verifyRunQr = async (qrValue) => {
  const { run, event } = await loadScannable(qrValue);
  if (run.scannedAt) throw new AppError(ALREADY_SCANNED, 400);
  return scannerDto(run, event, { status: "Active" });
};

const checkInRunQr = async (qrValue, scannedBy) => {
  const { run, event } = await loadScannable(qrValue);

  const scannedAt = new Date();
  // Atomic: two phones scanning the same QR at the same moment - only one gets in.
  const marked = await RunRegistration.findOneAndUpdate(
    { _id: run._id, scannedAt: null },
    { $set: { scannedAt, scannedBy: scannedBy || null } },
    { new: true }
  );
  if (!marked) throw new AppError(ALREADY_SCANNED, 400);

  return scannerDto(marked, event, { status: "Used", scannedAt });
};

// Staff scanned by mistake: put the person back to "not scanned".
const undoRunCheckIn = async (qrValue) => {
  const run = await RunRegistration.findOneAndUpdate(
    { qrValue: String(qrValue).trim().toUpperCase(), scannedAt: { $ne: null } },
    { $set: { scannedAt: null, scannedBy: null } },
    { new: true }
  );
  if (!run) throw new AppError("This ticket is not checked in.", 400);
  return { undone: 1, remaining: 1, alreadyEntered: 0, totalGuests: 1, isGroupEntry: false };
};

// AUTOMATIC "new time" message. Runs once when the server starts (server.js).
// The run without an event: when the TIME of LETS_RUN_START (same date) is different from
// the time people registered with, every registered person of that date gets the Let's
// Run message again (same QR, new time). Each time value is claimed once in the
// database, so restarts / several servers never send it twice. Turn off with
// LETS_RUN_AUTO_NOTIFY=false. A run with an event is skipped (its time is read live).
const notifyRunTimeChange = async () => {
  if (String(process.env.LETS_RUN_AUTO_NOTIFY || "").toLowerCase() === "false") return { skipped: "off" };

  const scope = await currentRunScope();
  if (scope.event) return { skipped: "event" };

  const settings = await getRunSettings();
  const start = settings.startDateTime.getTime();
  const key = editionKeyOf(settings.startDateTime);

  // Claim this time. Already claimed (nothing changed since the last start) -> E11000 -> stop.
  try {
    await Counter.findOneAndUpdate(
      { name: `RUN_TIME_NOTIFIED:${istDay(key)}`, sequence: { $ne: start } },
      { $set: { sequence: start } },
      { upsert: true }
    );
  } catch (error) {
    if (error.code === 11000) return { skipped: "unchanged" };
    throw error;
  }

  // Registered with an earlier time of this date = has the old time in the message.
  // (People who registered after the change already carry the new time: left alone.)
  const match = scopeMatch(scope);
  const runs = await RunRegistration.find({
    ...match,
    status: "registered",
    editionKey: { ...match.editionKey, $ne: key },
  });

  let sent = 0;
  let failed = 0;
  for (const run of runs) {
    const result = await deliverQr(run, null, null, { useLetsRunTemplate: true });
    if (result.whatsapp || result.email) sent += 1;
    else failed += 1;
  }
  return { time: key, total: runs.length, sent, failed };
};

module.exports = {
  // admin
  notifyRunTimeChange,
  listRuns,
  listRunEvents,
  getSummary,
  createRun,
  updateRun,
  deleteRun,
  deleteRuns,
  resendRun,
  resendRuns,
  exportRuns,
  // public
  getPublicRun,
  submitPublicRun,
  getLetsRunInfo,
  submitLetsRun,
  // pass page + scanner
  getRunInvitation,
  isRunQr,
  verifyRunQr,
  checkInRunQr,
  undoRunCheckIn,
  // for tests
  _internal: { stateOf, buildFilter, buildRunLink },
};