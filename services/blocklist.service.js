const BlockedPerson = require("../models/blockedPerson.model");
const AppError = require("../utils/AppError");
const { normalizeMobileNumber, MOBILE_ERROR_MESSAGE } = require("../utils/normalizeMobileNumber");

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What the rest of the app gets to see for a flagged row.
const toFlag = (b) => ({
  _id: b._id,
  name: b.name,
  mobileNumber: b.mobileNumber,
  reason: b.reason,
  blockedByName: b.blockedByName || "",
  blockedAt: b.createdAt,
});

// ---------- CRUD (admin Block List page) ----------

const createBlock = async ({ name, mobileNumber, reason }, admin) => {
  const mobile = normalizeMobileNumber(mobileNumber);
  if (!mobile) throw new AppError(MOBILE_ERROR_MESSAGE || "Invalid mobile number", 400);

  const cleanName = String(name || "").trim();
  const cleanReason = String(reason || "").trim();
  if (!cleanName) throw new AppError("Name is required", 400);
  if (!cleanReason) throw new AppError("Reason (remarks) is required", 400);

  const existing = await BlockedPerson.findOne({ mobileNumber: mobile }).lean();
  if (existing) {
    throw new AppError(
      `This number is already blocked (${existing.name}) — reason: ${existing.reason}`,
      409
    );
  }

  const doc = await BlockedPerson.create({
    name: cleanName,
    mobileNumber: mobile,
    reason: cleanReason,
    blockedBy: admin?._id || admin?.id || null,
    blockedByName: admin?.name || "",
  });
  return doc;
};

const listBlocks = async ({ page = 1, limit = 10, search = "" } = {}) => {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100000, Math.max(1, Number(limit) || 10));

  const filter = {};
  const s = String(search || "").trim();
  if (s) {
    const rx = new RegExp(escapeRegex(s), "i");
    filter.$or = [{ name: rx }, { mobileNumber: rx }, { reason: rx }, { blockedByName: rx }];
  }

  const [items, total] = await Promise.all([
    BlockedPerson.find(filter).sort({ createdAt: -1, _id: -1 }).skip((p - 1) * l).limit(l).lean(),
    BlockedPerson.countDocuments(filter),
  ]);

  return {
    items,
    pagination: { total, page: p, limit: l, totalPages: Math.max(1, Math.ceil(total / l)) },
  };
};

const updateBlock = async (id, { name, reason }) => {
  const update = {};
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n) throw new AppError("Name is required", 400);
    update.name = n;
  }
  if (reason !== undefined) {
    const r = String(reason).trim();
    if (!r) throw new AppError("Reason (remarks) is required", 400);
    update.reason = r;
  }
  const doc = await BlockedPerson.findByIdAndUpdate(id, update, { new: true });
  if (!doc) throw new AppError("Blocked person not found", 404);
  return doc;
};

const removeBlock = async (id) => {
  const doc = await BlockedPerson.findByIdAndDelete(id);
  if (!doc) throw new AppError("Blocked person not found", 404);
  return doc;
};

// ---------- Flagging helpers (used by Contact / Member / Invite / public form) ----------

// Accepts any mobile format; returns { "91XXXXXXXXXX": flag } for the blocked ones.
const findBlockedByNumbers = async (numbers = []) => {
  const canon = [
    ...new Set(numbers.map((n) => normalizeMobileNumber(n)).filter(Boolean)),
  ];
  if (canon.length === 0) return new Map();
  const rows = await BlockedPerson.find({ mobileNumber: { $in: canon } }).lean();
  return new Map(rows.map((b) => [b.mobileNumber, toFlag(b)]));
};

const findBlockedByNumber = async (number) => {
  const map = await findBlockedByNumbers([number]);
  return map.get(normalizeMobileNumber(number)) || null;
};

/**
 * Adds `blocked` (null or flag) to every row. `numbersOf(row)` returns the
 * mobile numbers of that row (e.g. [whatsappNumber, spouseMobile]); the first
 * blocked one wins and `blockedWho` says which number matched.
 * Never throws — a flag lookup must never break a list page.
 */
const attachBlockedFlag = async (rows, numbersOf) => {
  try {
    const all = rows.flatMap((r) => numbersOf(r) || []);
    const map = await findBlockedByNumbers(all);
    rows.forEach((r) => {
      r.blocked = null;
      if (map.size === 0) return;
      for (const n of numbersOf(r) || []) {
        const hit = map.get(normalizeMobileNumber(n));
        if (hit) {
          r.blocked = hit;
          break;
        }
      }
    });
  } catch (error) {
    console.error("Could not check Block List:", error.message);
    rows.forEach((r) => {
      if (r.blocked === undefined) r.blocked = null;
    });
  }
  return rows;
};

module.exports = {
  createBlock,
  listBlocks,
  updateBlock,
  removeBlock,
  findBlockedByNumbers,
  findBlockedByNumber,
  attachBlockedFlag,
};
