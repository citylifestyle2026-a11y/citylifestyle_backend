// services/invite.service.js
//
// "Invitation Cards": import name + mobile from a CSV, then send every guest
// the SAME design with THEIR name written on it, on WhatsApp.
const InviteGuest = require("../models/inviteGuest.model");
const AppError = require("../utils/AppError");
const { normalizeMobileNumber } = require("../utils/normalizeMobileNumber");
const uploadToLocal = require("../utils/localUpload.util");
const whatsappService = require("./whatsapp.service");
const cardService = require("./inviteCard.service");
const { generateCard } = cardService;

const NAME_HEADERS = ["name", "fullname", "guestname"];
const MOBILE_HEADERS = ["mobile", "mobilenumber", "whatsapp", "whatsappnumber", "phone", "number"];
const headerKey = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// ---------------- CSV ----------------
const parseCsv = async (buffer) => {
  const ExcelJS = require("exceljs");
  const { Readable } = require("stream");

  const workbook = new ExcelJS.Workbook();
  // Keep every cell as exact text (so 9.87E+09 is never a "valid" number).
  const sheet = await workbook.csv.read(
    Readable.from(buffer.toString("utf-8").replace(/^\uFEFF/, "")),
    { map: (value) => value }
  );

  let nameCol = null;
  let mobileCol = null;
  const rows = [];

  sheet.eachRow((row, rowNumber) => {
    const cells = row.values; // 1-based

    if (rowNumber === 1) {
      cells.forEach((cell, idx) => {
        const key = headerKey(cell);
        if (nameCol === null && NAME_HEADERS.includes(key)) nameCol = idx;
        if (mobileCol === null && MOBILE_HEADERS.includes(key)) mobileCol = idx;
      });
      return;
    }

    const name = String(cells[nameCol] ?? "").trim();
    const mobile = String(cells[mobileCol] ?? "").trim();
    if (!name && !mobile) return; // blank line
    rows.push({ line: rowNumber, name, mobile });
  });

  if (nameCol === null || mobileCol === null) {
    throw new AppError(
      'CSV must have a header row with "name" and "mobile" columns.',
      400
    );
  }

  return rows;
};

// POST /import-csv  (?dryRun=true only checks the file)
const importCsv = async (buffer, adminId, { dryRun = false } = {}) => {
  if (!buffer) throw new AppError("Please choose a CSV file.", 400);

  const rows = await parseCsv(buffer);
  if (!rows.length) throw new AppError("The CSV has no guest rows.", 400);
  if (rows.length > 5000) throw new AppError("Maximum 5000 rows per CSV.", 400);

  const seen = new Set();
  const valid = [];
  const errors = [];

  for (const r of rows) {
    const mobileNumber = normalizeMobileNumber(r.mobile);

    if (!r.name) {
      errors.push({ line: r.line, message: "Name is missing." });
    } else if (!mobileNumber) {
      errors.push({ line: r.line, message: `Invalid mobile number "${r.mobile}".` });
    } else if (seen.has(mobileNumber)) {
      errors.push({ line: r.line, message: "Duplicate number inside the CSV." });
    } else {
      seen.add(mobileNumber);
      valid.push({ name: r.name.replace(/\s+/g, " "), mobileNumber });
    }
  }

  const existing = new Set(
    (
      await InviteGuest.find({ mobileNumber: { $in: [...seen] } })
        .select("mobileNumber")
        .lean()
    ).map((g) => g.mobileNumber)
  );

  const fresh = valid.filter((g) => !existing.has(g.mobileNumber));
  const alreadyAdded = valid.length - fresh.length;

  if (!dryRun && fresh.length) {
    await InviteGuest.insertMany(
      fresh.map((g) => ({ ...g, createdBy: adminId || undefined })),
      { ordered: false }
    );
  }

  return {
    success: true,
    message: dryRun
      ? `${fresh.length} guests can be imported.`
      : `${fresh.length} guests imported.`,
    data: {
      total: rows.length,
      imported: dryRun ? 0 : fresh.length,
      importable: fresh.length,
      alreadyAdded,
      invalid: errors.length,
      errors: errors.slice(0, 50),
    },
  };
};

// ---------------- add / update one ----------------
const cleanGuestInput = ({ name, mobile }) => {
  const cleanName = String(name || "").replace(/\s+/g, " ").trim();
  if (!cleanName) throw new AppError("Name is required.", 400);
  if (cleanName.length > 60) throw new AppError("Name is too long (max 60 characters).", 400);

  const mobileNumber = normalizeMobileNumber(mobile);
  if (!mobileNumber) {
    throw new AppError("Enter a valid 10-digit mobile number (with or without 91).", 400);
  }
  return { name: cleanName, mobileNumber };
};

const create = async (body, adminId) => {
  const data = cleanGuestInput(body || {});

  if (await InviteGuest.exists({ mobileNumber: data.mobileNumber })) {
    throw new AppError("This mobile number is already in the list.", 409);
  }

  const guest = await InviteGuest.create({ ...data, createdBy: adminId || undefined });
  return { success: true, message: "Guest added.", data: guest };
};

const update = async (id, body) => {
  const guest = await InviteGuest.findById(id);
  if (!guest) throw new AppError("Guest not found.", 404);
  if (guest.status === "sending") {
    throw new AppError("This guest is being sent right now. Try again in a moment.", 409);
  }

  const data = cleanGuestInput(body || {});

  if (data.mobileNumber !== guest.mobileNumber) {
    if (await InviteGuest.exists({ mobileNumber: data.mobileNumber, _id: { $ne: guest._id } })) {
      throw new AppError("This mobile number is already in the list.", 409);
    }
    // New number = a new person to send to.
    guest.mobileNumber = data.mobileNumber;
    guest.status = "pending";
    guest.error = "";
    guest.sentAt = null;
  }

  guest.name = data.name;
  await guest.save();

  return { success: true, message: "Guest updated.", data: guest };
};

// ---------------- list ----------------
const list = async ({ page = 1, limit = 10, search = "", status = "" }) => {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 10));

  const filter = {};
  if (status && ["pending", "sending", "sent", "failed"].includes(status)) {
    filter.status = status;
  }
  if (search && String(search).trim()) {
    const s = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{ name: new RegExp(s, "i") }, { mobileNumber: new RegExp(s) }];
  }

  const [items, total, grouped] = await Promise.all([
    InviteGuest.find(filter).sort({ createdAt: -1, _id: -1 }).skip((p - 1) * l).limit(l).lean(),
    InviteGuest.countDocuments(filter),
    InviteGuest.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);

  const counts = { all: 0, pending: 0, sending: 0, sent: 0, failed: 0 };
  grouped.forEach((g) => {
    counts[g._id] = g.count;
    counts.all += g.count;
  });

  return { success: true, data: { items, total, page: p, limit: l, counts } };
};

// ---------------- sending ----------------
// TWO modes:
//  1) TEXT mode  (CHATBOX_INVITE_TEXT_TEMPLATE_NAME is set)
//     Plain Utility template, NO image. Body has ONE variable: {{1}} = guest name.
//  2) CARD mode  (CHATBOX_INVITE_CARD_TEMPLATE_NAME)
//     Image header (the uploaded card with the name on it) + {{1}} = guest name.
// If both are set, TEXT mode wins. Remove the text variable to go back to cards.
const isTextMode = () => Boolean(String(process.env.CHATBOX_INVITE_TEXT_TEMPLATE_NAME || "").trim());

const getTemplate = () => {
  const textName = String(process.env.CHATBOX_INVITE_TEXT_TEMPLATE_NAME || "").trim();
  if (textName) {
    return {
      name: textName,
      language: String(process.env.CHATBOX_INVITE_TEXT_TEMPLATE_LANGUAGE || "en").trim(),
      textOnly: true,
    };
  }

  const name = String(process.env.CHATBOX_INVITE_CARD_TEMPLATE_NAME || "").trim();
  if (!name) {
    throw new AppError(
      "Set CHATBOX_INVITE_TEXT_TEMPLATE_NAME (text invitation) or CHATBOX_INVITE_CARD_TEMPLATE_NAME (image card) in the backend .env, with an approved WhatsApp template.",
      500
    );
  }
  return {
    name,
    language: String(process.env.CHATBOX_INVITE_CARD_TEMPLATE_LANGUAGE || "en").trim(),
    textOnly: false,
  };
};

// WhatsApp rejects a body variable that is empty, has newlines/tabs, or has
// 4+ consecutive spaces. Always send a clean, non-empty name.
const cleanTemplateName = (name) =>
  String(name || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 60) || "Guest";

// {{1}} = guest name (same for both modes).
const buildBodyParams = (guest) => [cleanTemplateName(guest.name)];

const sendOne = async (guest, template) => {
  // TEXT mode: no card, no image upload - just the approved text template.
  if (template.textOnly) {
    await whatsappService.sendTemplateMessage({
      phone: guest.mobileNumber,
      templateName: template.name,
      languageCode: template.language,
      bodyParams: buildBodyParams(guest),
    });
    return { url: "", public_id: "" };
  }

  // CARD mode: the admin's uploaded design with this guest's name on it (JPG).
  const fullJpg = await generateCard(guest.name);

  // Send the card the SAME way the working QR-code template sends its image:
  // a PNG, saved under the "qr-codes" folder (that folder/format is already
  // known to be fetched fine by WhatsApp). Kept <= 1080px and < ~4 MB
  // (WhatsApp limit is 5 MB).
  const sharp = require("sharp");
  const base = sharp(fullJpg).resize({
    width: 1080,
    height: 1080,
    fit: "inside",
    withoutEnlargement: true,
  });

  let png = await base.clone().png({ compressionLevel: 9 }).toBuffer();
  if (png.length > 4 * 1024 * 1024) {
    png = await base.clone().png({ palette: true, quality: 90, compressionLevel: 9 }).toBuffer();
  }

  const saved = await uploadToLocal(png, "event-management/qr-codes", "image", {
    format: "png",
    public_id: `invite-${guest._id}-${Date.now()}`,
  });

  try {
    await whatsappService.sendMediaTemplateMessage({
      phone: guest.mobileNumber,
      templateName: template.name,
      languageCode: template.language,
      imageUrl: saved.url,
      bodyParams: buildBodyParams(guest),
    });
  } catch (err) {
    // Keep the card URL on the error so the admin can open it and see
    // exactly what WhatsApp tried to download.
    err.cardUrl = saved.url;
    throw err;
  }

  return saved;
};

const processOne = async (id, template) => {
  const guest = await InviteGuest.findById(id);
  if (!guest) return;

  try {
    const saved = await sendOne(guest, template);
    guest.status = "sent";
    guest.error = "";
    guest.sentAt = new Date();
    guest.cardUrl = saved.url;
    guest.cardPublicId = saved.public_id;
  } catch (err) {
    guest.status = "failed";
    const base = String(err?.message || "Failed to send").slice(0, 150);
    guest.error = err?.cardUrl ? `Card URL: ${err.cardUrl} | ${base}` : base;
    if (err?.cardUrl) guest.cardUrl = err.cardUrl;
  }

  guest.attempts += 1;
  await guest.save();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let workerRunning = false;

// Runs in the background so a big list never hits a request timeout.
const runQueue = async (ids, template) => {
  if (workerRunning) return;
  workerRunning = true;
  try {
    for (const id of ids) {
      await processOne(id, template);
      await sleep(250); // gentle pace towards the WhatsApp API
    }
  } finally {
    workerRunning = false;
  }
};

// POST /send  { ids?: [] , all?: true , includeSent?: false }
// all=true  -> every pending + failed guest.
const send = async ({ ids, all, includeSent = false }) => {
  const template = getTemplate(); // fails fast with a clear message

  if (workerRunning) {
    throw new AppError("Invitations are already being sent. Please wait for it to finish.", 409);
  }

  const wanted = includeSent ? ["pending", "failed", "sent"] : ["pending", "failed"];
  const filter = { status: { $in: wanted } };
  if (!all) {
    if (!Array.isArray(ids) || !ids.length) {
      throw new AppError("Select at least one guest.", 400);
    }
    filter._id = { $in: ids };
  }

  const guests = await InviteGuest.find(filter).select("_id").sort({ createdAt: 1 }).lean();
  if (!guests.length) {
    throw new AppError("No guests to send (already sent or nothing selected).", 400);
  }

  const queue = guests.map((g) => g._id);
  await InviteGuest.updateMany({ _id: { $in: queue } }, { $set: { status: "sending", error: "" } });

  runQueue(queue, template).catch((e) => console.error("Invite queue crashed:", e));

  return {
    success: true,
    message: `Sending to ${queue.length} guest${queue.length === 1 ? "" : "s"}...`,
    data: { queued: queue.length },
  };
};

// Guests stuck on "sending" (e.g. server restarted) can be reset to pending.
const resetStuck = async () => {
  if (workerRunning) return { success: true, data: { reset: 0 } };
  const r = await InviteGuest.updateMany({ status: "sending" }, { $set: { status: "pending" } });
  return { success: true, data: { reset: r.modifiedCount || 0 } };
};

const remove = async (ids) => {
  if (!Array.isArray(ids) || !ids.length) throw new AppError("Select at least one guest.", 400);
  const r = await InviteGuest.deleteMany({ _id: { $in: ids }, status: { $ne: "sending" } });
  return { success: true, message: `${r.deletedCount} deleted.`, data: { deleted: r.deletedCount } };
};

module.exports = {
  importCsv,
  create,
  update,
  list,
  send,
  resetStuck,
  remove,
  generateCard,
  designInfo: async (...args) => ({
    ...(await cardService.designInfo(...args)),
    textMode: isTextMode(),
  }),
  saveDesign: cardService.saveDesign,
  saveNameStyle: cardService.saveNameStyle,
  removeDesign: cardService.removeDesign,
};