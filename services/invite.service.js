// services/invite.service.js
//
// "Invitation Cards": import name + mobile from a CSV, then send every guest
// the SAME design with THEIR name written on it, on WhatsApp.
const InviteGuest = require("../models/inviteGuest.model");
const AppError = require("../utils/AppError");
const { normalizeMobileNumber } = require("../utils/normalizeMobileNumber");
const { uploadToLocal } = require("../utils/localUpload.util");
const whatsappService = require("./whatsapp.service");
const { generateCard } = require("./inviteCard.service");

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
const getTemplate = () => {
  const name = String(process.env.CHATBOX_INVITE_CARD_TEMPLATE_NAME || "").trim();
  if (!name) {
    throw new AppError(
      "CHATBOX_INVITE_CARD_TEMPLATE_NAME is not set in the backend .env. Create the WhatsApp template (image header + 1 variable for the name), get it approved, then put its name in .env.",
      500
    );
  }
  return {
    name,
    language: String(process.env.CHATBOX_INVITE_CARD_TEMPLATE_LANGUAGE || "en").trim(),
  };
};

const sendOne = async (guest, template) => {
  const png = await generateCard(guest.name);

  const saved = await uploadToLocal(png, "event-management/invite-cards", "image", {
    format: "png",
    public_id: `invite-${guest._id}-${Date.now()}`,
  });

  await whatsappService.sendMediaTemplateMessage({
    phone: guest.mobileNumber,
    templateName: template.name,
    languageCode: template.language,
    imageUrl: saved.url,
    bodyParams: [guest.name],
  });

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
    guest.error = String(err?.message || "Failed to send").slice(0, 300);
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

module.exports = { importCsv, create, update, list, send, resetStuck, remove, generateCard };
