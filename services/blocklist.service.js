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
  allowedNumbers: b.allowedNumbers || [],
});

// A guest matched only by NAME is still allowed when this number was unblocked
// one-by-one (BlockedPerson.allowedNumbers). Only the guest's main number counts.
const nameAllowed = (flag, numbers) => {
  const first = normalizeMobileNumber((numbers || [])[0]);
  return !!first && (flag?.allowedNumbers || []).includes(first);
};

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

// Unblocking puts the person's Guest List rows back to PENDING (so the team
// can review / approve them again). Rows that already have a pass sent are
// left alone, and a row that is still blocked by ANOTHER Block List entry
// (same number or same name) is skipped. Returns the number of guests moved.
const movePendingAfterUnblock = async (doc, onlyNumber = null) => {
  try {
    const Contact = require("../models/contact.model");
    const canon = normalizeMobileNumber(onlyNumber || doc.mobileNumber);
    const variants = canon ? [canon.slice(2), canon, `+${canon}`] : [String(doc.mobileNumber)];
    const words = usableNameWords(doc.name);
    const or = [{ whatsappNumber: { $in: variants } }, { spouseMobile: { $in: variants } }];
    // One number unblocked by itself: only THAT number's guests move to Pending.
    if (words && !onlyNumber) {
      or.push({ fullName: new RegExp(`^\\s*${words.map(escapeRegex).join("\\s+")}\\s*$`, "i") });
    }

    const candidates = await Contact.find({
      isDeleted: { $ne: true },
      historyOnly: { $ne: true },
      passSentAt: null,
      approvalStatus: { $ne: "pending" },
      $or: or,
    })
      .select("fullName whatsappNumber spouseMobile")
      .lean();
    if (candidates.length === 0) return 0;

    const stillBlocked = await findBlockedRows(candidates, (c) => [c.whatsappNumber, c.spouseMobile], (c) => c.fullName);
    const skip = new Set(stillBlocked.map((h) => String(h.row._id)));
    const ids = candidates.map((c) => c._id).filter((cid) => !skip.has(String(cid)));
    if (ids.length === 0) return 0;

    await Contact.updateMany(
      { _id: { $in: ids } },
      { $set: { approvalStatus: "pending", approvalUpdatedAt: new Date(), approvalUpdatedBy: null } }
    );
    return ids.length;
  } catch (error) {
    console.error("Could not move unblocked guests to Pending:", error.message);
    return 0;
  }
};

// removeBlock(id)         -> the Block List entry is deleted (the blocked number
//                            and every same-name guest are free again).
// removeBlock(id, number) -> `number` is a guest with the SAME NAME but another
//                            number: only that number is unblocked (kept in
//                            allowedNumbers); the entry and the blocked number
//                            stay blocked. When `number` is the blocked number
//                            itself the entry is deleted as above.
const removeBlock = async (id, number = null) => {
  const doc = await BlockedPerson.findById(id);
  if (!doc) throw new AppError("Blocked person not found", 404);

  const canon = number ? normalizeMobileNumber(number) : null;
  if (canon && canon !== doc.mobileNumber) {
    await BlockedPerson.updateOne({ _id: doc._id }, { $addToSet: { allowedNumbers: canon } });
    const movedToPending = await movePendingAfterUnblock(doc, canon);
    return { doc, movedToPending, entryRemoved: false };
  }

  await BlockedPerson.deleteOne({ _id: doc._id });
  const movedToPending = await movePendingAfterUnblock(doc);
  return { doc, movedToPending, entryRemoved: true };
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
const attachBlockedFlag = async (rows, numbersOf, nameOf = null) => {
  try {
    const all = rows.flatMap((r) => numbersOf(r) || []);
    const map = await findBlockedByNumbers(all);
    const nameMap = nameOf ? await findBlockedByNames() : new Map();
    rows.forEach((r) => {
      r.blocked = null;
      for (const n of numbersOf(r) || []) {
        const hit = map.get(normalizeMobileNumber(n));
        if (hit) {
          r.blocked = { ...hit, matchedBy: "number" };
          return;
        }
      }
      // Same name, different number.
      if (nameOf && nameMap.size > 0) {
        const words = usableNameWords(nameOf(r));
        const nameHit = words ? nameMap.get(words.join(" ")) : null;
        if (nameHit && !nameAllowed(nameHit, numbersOf(r))) r.blocked = { ...nameHit, matchedBy: "name" };
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

/**
 * Which of `rows` are blocked - by NUMBER, or by the same FULL NAME with a
 * different number (a blocked person coming back with another phone).
 * Returns [{ row, flag }]. `nameOf` defaults to row.fullName || row.name.
 */
const findBlockedRows = async (rows, numbersOf, nameOf = (r) => r.fullName || r.name) => {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return [];
  const numMap = await findBlockedByNumbers(list.flatMap((r) => numbersOf(r) || []));
  const nameMap = nameOf ? await findBlockedByNames() : new Map();
  if (numMap.size === 0 && nameMap.size === 0) return [];

  const hits = [];
  for (const r of list) {
    let flag = null;
    for (const n of numbersOf(r) || []) {
      const h = numMap.get(normalizeMobileNumber(n));
      if (h) { flag = { ...h, matchedBy: "number" }; break; }
    }
    if (!flag && nameMap.size > 0) {
      const words = usableNameWords(nameOf(r));
      const h = words ? nameMap.get(words.join(" ")) : null;
      if (h && !nameAllowed(h, numbersOf(r))) flag = { ...h, matchedBy: "name" };
    }
    if (flag) hits.push({ row: r, flag });
  }
  return hits;
};

const blockedNamesText = (hits) =>
  hits.map((h) => h.row.fullName || h.row.name).filter(Boolean).slice(0, 5).join(", ");

/**
 * Server-side guard: if any of the given rows has a number on the Block List,
 * the action is refused unless the admin explicitly confirmed (confirmBlocked).
 * `numbersOf(row)` returns the mobile numbers of that row.
 */
const assertBlockedConfirmed = async (rows, confirmBlocked, numbersOf, nameOf) => {
  if (confirmBlocked === true || confirmBlocked === "true") return;
  const hits = await findBlockedRows(rows, numbersOf, nameOf);
  if (hits.length === 0) return;
  const names = blockedNamesText(hits);
  throw new AppError(
    `Blocked guest found${names ? ` (${names})` : ""}. Please confirm to continue.`,
    409
  );
};

/**
 * Every spelling of every blocked number ("98XXXXXXXX", "9198XXXXXXXX",
 * "+9198XXXXXXXX"), because contacts are stored as bare 10-digit numbers
 * while the Block List keeps the canonical "91XXXXXXXXXX" form.
 * Used by the Guest List "Blocked" tab and its count.
 */
const getBlockedNumberVariants = async () => {
  const rows = await BlockedPerson.find({}).select("mobileNumber").lean();
  const out = new Set();
  for (const r of rows) {
    const canon = normalizeMobileNumber(r.mobileNumber);
    if (canon) {
      out.add(canon.slice(2));
      out.add(canon);
      out.add(`+${canon}`);
    } else if (r.mobileNumber) {
      out.add(String(r.mobileNumber));
    }
  }
  return [...out];
};

// ---------- Same NAME, different number ----------
// A blocked person can come back with another phone number. A guest whose
// FULL NAME equals a blocked name (case / extra spaces / punctuation ignored)
// is flagged too, so the team can check it in the Guest List "Blocked" tab.
// The WHOLE name must be equal (a one-word blocked name like "Ncit" only
// matches a guest named exactly "Ncit", never "Ncit Shah" or "Rahul Ncit").
const normalizeName = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const usableNameWords = (value) => {
  const words = normalizeName(value).split(" ").filter(Boolean);
  return words.length >= 1 ? words : null;
};

// Case-insensitive regexes (one per blocked name) for Mongo queries on
// Contact.fullName: ["rahul shah", ...] -> [/^\s*rahul\s+shah\s*$/i, ...]
const getBlockedNameRegexes = async () => {
  const rows = await BlockedPerson.find({}).select("name").lean();
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const words = usableNameWords(r.name);
    if (!words) continue;
    const key = words.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(new RegExp(`^\\s*${words.map(escapeRegex).join("\\s+")}\\s*$`, "i"));
  }
  return out;
};

// One rule per blocked person for Mongo queries: the name regex plus the
// numbers (every spelling) that were unblocked one-by-one and so must NOT match.
const getBlockedNameRules = async () => {
  const rows = await BlockedPerson.find({}).select("name allowedNumbers").lean();
  const out = [];
  for (const r of rows) {
    const words = usableNameWords(r.name);
    if (!words) continue;
    const allowed = [];
    for (const n of r.allowedNumbers || []) {
      const canon = normalizeMobileNumber(n);
      if (canon) allowed.push(canon.slice(2), canon, `+${canon}`);
    }
    out.push({
      regex: new RegExp(`^\\s*${words.map(escapeRegex).join("\\s+")}\\s*$`, "i"),
      allowed,
    });
  }
  return out;
};

// Mongo conditions (to be OR-ed) for "blocked by name": same name, unless the
// number was unblocked one-by-one. [] when nobody is blocked.
const nameBlockedConditions = (rules, nameField, numberField) =>
  (rules || []).map((r) =>
    r.allowed.length
      ? { [nameField]: r.regex, [numberField]: { $nin: r.allowed } }
      : { [nameField]: r.regex }
  );

// normalized blocked name -> flag
const findBlockedByNames = async () => {
  const rows = await BlockedPerson.find({}).lean();
  const map = new Map();
  rows.forEach((b) => {
    const words = usableNameWords(b.name);
    if (words) map.set(words.join(" "), toFlag(b));
  });
  return map;
};

/**
 * HARD stop (no confirmation possible): a pass / booking must never be sent
 * to a number on the Block List. `numbersOf(row)` returns the row's numbers.
 */
const assertNoneBlocked = async (rows, numbersOf, what = "a pass", nameOf) => {
  const hits = await findBlockedRows(rows, numbersOf, nameOf);
  if (hits.length === 0) return;
  const names = blockedNamesText(hits);
  throw new AppError(
    `${what.charAt(0).toUpperCase()}${what.slice(1)} cannot be sent to a blocked guest${names ? ` (${names})` : ""}. Remove them from the Block List first.`,
    403
  );
};

module.exports = {
  createBlock,
  listBlocks,
  updateBlock,
  removeBlock,
  findBlockedByNumbers,
  findBlockedByNumber,
  attachBlockedFlag,
  assertBlockedConfirmed,
  getBlockedNumberVariants,
  getBlockedNameRegexes,
  getBlockedNameRules,
  nameBlockedConditions,
  nameAllowed,
  assertNoneBlocked,
  findBlockedRows,
  findBlockedByNames,
  usableNameWords,
};