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

const AppError = require("../utils/AppError");
const generateQrCode = require("../utils/generateQrCode");
const uploadImage = require("../utils/localUpload.util");
const deleteLocalFile = require("../utils/deleteLocalFile");
const { normalizeMobileNumber, MOBILE_ERROR_MESSAGE } = require("../utils/normalizeMobileNumber");
const { getDefaultEvent, resolveEventForNewRecord } = require("../utils/defaultEvent");
const whatsappService = require("./whatsapp.service");
const buildQrNotificationBodyParams = require("../utils/buildQrNotificationBodyParams");

const DISTANCES = [5, 10];
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const QR_PREFIX = "RUN-";
const QR_REGEX = /^RUN-[A-Z0-9]{8}$/i;
const QR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0 / O / 1 / I

/* =========================================================
   small helpers
   ========================================================= */

const cleanName = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toObjectId = (value) =>
  value && mongoose.Types.ObjectId.isValid(String(value)) ? new mongoose.Types.ObjectId(String(value)) : null;

const randomToken = () => crypto.randomBytes(24).toString("base64url");

const randomQrValue = () => {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) out += QR_ALPHABET[bytes[i] % QR_ALPHABET.length];
  return `${QR_PREFIX}${out}`;
};

// notRegistered | notScanned (registered, not yet scanned) | scanned
const stateOf = (item) =>
  item.status !== "registered" ? "notRegistered" : item.scannedAt ? "scanned" : "notScanned";

const isRunQr = (value) => QR_REGEX.test(String(value || "").trim());

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

const eventLabel = (event) => event?.edition || event?.title || "";

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

// The event the admin screen is looking at: the picked one, else the default.
// Returns null when no event exists at all.
const resolveViewEvent = async (eventId) => {
  const picked = toObjectId(eventId);
  if (picked) {
    const event = await Event.findOne({ _id: picked, isDeleted: { $ne: true } }).lean();
    if (event) return event;
  }
  return getDefaultEvent();
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
      bodyParams: [run.name, eventLabel(event) || "City Lifestyle Run", link],
    });
    return;
  }

  await whatsappService.sendTextMessage({
    phone: run.mobileNumber,
    message:
      `Hello ${run.name},\n` +
      `Please complete your 5 KM / 10 KM run registration${eventLabel(event) ? ` for ${eventLabel(event)}` : ""}:\n` +
      link,
  });
};

// QR on WhatsApp - sent EXACTLY like the booking QR pass: the same approved
// template (CHATBOX_QR_TEMPLATE_NAME / CHATBOX_QR_TEMPLATE_LANGUAGE, image
// header = the QR) and the same 5 body values, built by the same helper
// (utils/buildQrNotificationBodyParams.js):
//   {{1}} name  {{2}} event  {{3}} booking no  {{4}} ticket no  {{5}} ticket type
// For a run: booking no = ticket no = registration number (RUN0001) and the
// ticket type is "5 KM Run" / "10 KM Run".
const sendQrWhatsapp = async (run, event) => {
  if (!run.qrImage) throw new AppError("QR image is missing.", 500);

  const templateName = process.env.CHATBOX_QR_TEMPLATE_NAME;
  const languageCode = process.env.CHATBOX_QR_TEMPLATE_LANGUAGE;
  if (!templateName || !languageCode) {
    throw new AppError("CHATBOX_QR_TEMPLATE_NAME / CHATBOX_QR_TEMPLATE_LANGUAGE is not configured.", 500);
  }

  await whatsappService.sendMediaTemplateMessage({
    phone: run.mobileNumber,
    templateName,
    languageCode,
    imageUrl: run.qrImage,
    bodyParams: buildQrNotificationBodyParams({
      booking: { name: run.name, bookingNumber: run.registrationNumber },
      event: { title: event?.title || "" },
      ticketType: { ticketName: `${run.distance} KM Run` },
      ticket: { ticketNumber: run.registrationNumber },
    }),
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
const deliverQr = async (run, event, qrBuffer) => {
  const result = { whatsapp: false, email: false };
  const errors = [];

  try {
    await sendQrWhatsapp(run, event);
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
        eventTitle: eventLabel(event),
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

const buildFilter = (eventObjectId, { search, status, distance } = {}) => {
  const filter = { eventId: eventObjectId };

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
  const event = await resolveViewEvent(eventId);
  if (!event) return { ...emptySummary(), event: null };

  const rows = await RunRegistration.aggregate([
    { $match: { eventId: event._id } },
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

  return { ...summary, event: { _id: event._id, title: event.title, edition: event.edition || "" } };
};

// params: page, limit, search, status, distance, eventId
const listRuns = async (query = {}) => {
  const event = await resolveViewEvent(query.eventId);

  if (!event) {
    return { items: [], total: 0, totalPages: 1, page: 1, summary: emptySummary(), event: null };
  }

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limitRaw = parseInt(query.limit, 10);
  // limit=0 (or "All") returns everything.
  const all = limitRaw === 0 || String(query.limit).toLowerCase() === "all";
  const limit = all ? 0 : Math.min(Math.max(limitRaw || 10, 1), 500);

  const filter = buildFilter(event._id, query);
  const total = await RunRegistration.countDocuments(filter);

  let cursor = RunRegistration.find(filter).sort({ createdAt: -1, _id: -1 });
  if (limit) cursor = cursor.skip((page - 1) * limit).limit(limit);

  const [docs, summary] = await Promise.all([cursor, getSummary(event._id)]);

  return {
    items: docs.map((doc) => serialize(doc, event)),
    total,
    totalPages: limit ? Math.max(1, Math.ceil(total / limit)) : 1,
    page: limit ? page : 1,
    summary,
    event: { _id: event._id, title: event.title, edition: event.edition || "" },
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

  const event = await resolveEventForNewRecord(body.eventId);
  if (!event) throw new AppError("No event found. Please create an event first.", 400);

  if (await RunRegistration.exists({ eventId: event._id, mobileNumber })) {
    throw new AppError("This mobile number is already added for this event.", 409);
  }

  let run;
  try {
    run = await RunRegistration.create({
      eventId: event._id,
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

  const event = await Event.findById(run.eventId).lean();

  if (body.name !== undefined) run.name = validateName(body.name);

  let mobileChanged = false;
  const incomingMobile = body.mobile ?? body.mobileNumber;
  if (incomingMobile !== undefined) {
    const mobileNumber = validateMobile(incomingMobile);
    if (mobileNumber !== run.mobileNumber) {
      const clash = await RunRegistration.exists({
        eventId: run.eventId,
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
      const email = String(body.email || "").trim().toLowerCase();
      if (!EMAIL_RX.test(email)) throw new AppError("Enter a valid email address.", 400);
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

// Not registered yet -> link again. Registered -> QR again.
const resendRun = async (id) => {
  if (!toObjectId(id)) throw new AppError("Invalid ID.", 400);

  const run = await RunRegistration.findById(id);
  if (!run) throw new AppError("Entry not found.", 404);

  const event = await Event.findById(run.eventId).lean();

  if (run.status !== "registered") {
    const sent = await deliverLink(run, event);
    if (!sent) {
      const fresh = await RunRegistration.findById(run._id);
      throw new AppError(fresh?.linkError || "Unable to send the WhatsApp message.", 502);
    }
    return { kind: "link" };
  }

  const result = await deliverQr(run, event, null);
  if (!result.whatsapp && !result.email) {
    const fresh = await RunRegistration.findById(run._id);
    throw new AppError(fresh?.qrError || "Unable to send the QR.", 502);
  }
  return { kind: "qr", ...result };
};

const STATE_LABEL = { notRegistered: "Not Registered", notScanned: "Registered, Not Scanned", scanned: "Scanned" };

// Excel of the current tab / distance / search for the selected event.
const exportRuns = async (query, res) => {
  const event = await resolveViewEvent(query.eventId);
  if (!event) throw new AppError("No event found.", 404);

  const rows = await RunRegistration.find(buildFilter(event._id, query))
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
      mobile: String(item.mobileNumber || ""),
      email: item.email || "-",
      distance: item.distance ? `${item.distance} KM` : "-",
      reg: item.registrationNumber || "-",
      status: STATE_LABEL[stateOf(item)],
      registeredAt: stamp(item.registeredAt),
      scannedAt: stamp(item.scannedAt),
    });
  });
  sheet.getColumn("mobile").numFmt = "@";

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
  eventTitle: event?.title || "",
});

const findByToken = async (token) => {
  const value = String(token || "").trim();
  const run = value ? await RunRegistration.findOne({ token: value }) : null;
  if (!run) throw new AppError("This registration link is not valid.", 404);
  const event = await Event.findById(run.eventId).lean();
  if (!event || event.isDeleted) throw new AppError("This registration link is not valid.", 404);
  return { run, event };
};

const getPublicRun = async (token) => {
  const { run, event } = await findByToken(token);
  return publicView(run, event);
};

const nextRegistrationNumber = async (eventId) => {
  const counter = await Counter.findOneAndUpdate(
    { name: `RUN_${eventId}` },
    { $inc: { sequence: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return `RUN${String(counter.sequence).padStart(4, "0")}`;
};

// body: { distance: 5 | 10, name, email }.  The mobile number is NOT taken from
// the request - it is the number the link was sent to.
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

  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RX.test(email)) throw new AppError("Enter a valid email address.", 400);

  const registrationNumber = await nextRegistrationNumber(event._id);

  // Random QR value; a clash is practically impossible, retry just in case.
  let qrValue = randomQrValue();
  for (let i = 0; i < 3 && (await RunRegistration.exists({ qrValue })); i += 1) qrValue = randomQrValue();

  const qrBuffer = await generateQrCode(qrValue);
  const qrUpload = await uploadImage(qrBuffer, "event-management/qr-codes", "image", { format: "png" });

  // ONE atomic update: if two phones submit the same link at once, only one wins.
  const updated = await RunRegistration.findOneAndUpdate(
    { _id: run._id, status: "invited" },
    {
      $set: {
        name,
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
   QR SCANNER (called from qr.service.js)
   ========================================================= */

const loadScannable = async (qrValue) => {
  const run = await RunRegistration.findOne({ qrValue: String(qrValue).trim().toUpperCase() });
  if (!run || run.status !== "registered") throw new AppError("QR ticket not found.", 404);

  const event = await Event.findById(run.eventId).lean();
  if (!event || event.isDeleted) throw new AppError("Event not found.", 404);

  // Same test switch the booking scanner uses.
  const testMode = String(process.env.QR_TEST_MODE || "").toLowerCase() === "true";
  if (!testMode && !event.isActive) throw new AppError("This event is inactive.", 400);
  if (!testMode && event.endDateTime && new Date() > new Date(event.endDateTime)) {
    throw new AppError("This event has ended.", 400);
  }

  return { run, event };
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
    id: event._id,
    title: event.title,
    venueName: event.venueName,
    address: event.address,
    startDateTime: event.startDateTime,
    endDateTime: event.endDateTime,
  },
  ticketType: { id: null, ticketName: `${run.distance} KM Run`, amount: 0 },
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

module.exports = {
  // admin
  listRuns,
  getSummary,
  createRun,
  updateRun,
  deleteRun,
  resendRun,
  exportRuns,
  // public
  getPublicRun,
  submitPublicRun,
  // scanner
  isRunQr,
  verifyRunQr,
  checkInRunQr,
  undoRunCheckIn,
  // for tests
  _internal: { stateOf, buildFilter, randomQrValue, buildRunLink },
};
