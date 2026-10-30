// services/member.service.js
//
// Member List: import members from an Excel (.xlsx) / CSV file, list &
// filter them, and move selected members to the Guest List for an edition.
const mongoose = require("mongoose");
const ExcelJS = require("exceljs");
const { Readable } = require("stream");
const Member = require("../models/member.model");
const Contact = require("../models/contact.model");
const CompanyCategory = require("../models/companycategory.model");
const Event = require("../models/event.model");
const AppError = require("../utils/AppError");
const { toReferenceList } = require("../utils/splitReferences");
const { normalizeInstagramId, isValidInstagramId, parseInstagramLink } = require("../utils/normalizeInstagramId");
const { normalizeMobileNumber } = require("../utils/normalizeMobileNumber");
const uploadImage = require("../utils/localUpload.util");
const deleteImage = require("../utils/deleteLocalFile");

// ================= MEMBER PHOTO HELPERS =================
// Profile photo + spouse profile photo arrive as multer files
// (req.files.profileImage[0] / req.files.spouseProfileImage[0]) and are
// re-encoded to WEBP under uploads/contacts (same folder as Guest List photos).
const MEMBER_IMAGE_FOLDER = "event-management/contacts";
const isTrue = (value) => value === true || value === "true";
const firstFile = (files, field) =>
  files && files[field] && files[field][0] ? files[field][0] : null;

const uploadOne = async (file) => {
  if (!file) return null;
  const result = await uploadImage(file, MEMBER_IMAGE_FOLDER, "image");
  return { url: result.url, publicId: result.public_id };
};

// Best-effort delete: a missing file must never fail a save / delete.
const removeFiles = async (publicIds = []) => {
  for (const publicId of publicIds) {
    if (!publicId) continue;
    try {
      await deleteImage(publicId);
    } catch (error) {
      console.error("Could not delete member photo:", error.message);
    }
  }
};

const toLocalMobile = (value) => {
  const canonical = normalizeMobileNumber(value);
  return canonical ? canonical.slice(2) : null;
};

// Member status is only ever "Active" or "Inactive".
const normalizeMemberStatus = (value) =>
  String(value ?? "").trim().toLowerCase() === "inactive" ? "Inactive" : "Active";

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Invisible / odd characters that can hide inside imported text
// (zero-width space, BOM, non-breaking space ...).
// NOTE: these are the REAL characters (not the text "\u200B"): MongoDB runs
// regexes with PCRE, which does not understand \uXXXX and rejects the whole
// query ("PCRE does not support \L, \l, \N{name}, \U, or \u"), which made
// every Reference filter fail with "Failed to load contacts".
const INVISIBLE = "\u200B\u200C\u200D\u2060\uFEFF";
const stripInvisible = (text) =>
  String(text || "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
// Regex source for one reference: ignores case, invisible characters and
// the kind / amount of whitespace between words.
const looseRefSource = (ref) =>
  Array.from(stripInvisible(ref))
    .map((ch) => (/\s/.test(ch) ? `[\\s${INVISIBLE}]+` : `${escapeRegex(ch)}[${INVISIBLE}]*`))
    .join("");

// ================= EXTRA (GUEST LIST) FIELDS =================
// designation, address, instagram, relationship and the spouse details.
// Lenient reader used by the import (bad values are dropped, never fatal).
const looseExtraFields = (data = {}) => {
  const text = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const insta = (v) => {
    const id = normalizeInstagramId(v);
    return id && isValidInstagramId(id) ? id : "";
  };
  // Relationship column blank but spouse details given -> Couple.
  const isCouple =
    text(data.relationship).toLowerCase() === "couple" ||
    (!text(data.relationship) && Boolean(text(data.spouseName) || text(data.spouseMobile)));

  return {
    designation: text(data.designation),
    address: text(data.address),
    instagramId: insta(data.instagramId),
    relationship: isCouple ? "Couple" : "Single",
    spouseName: isCouple ? text(data.spouseName) : "",
    spouseMobile: isCouple ? toLocalMobile(data.spouseMobile) || "" : "",
    spouseInstagramId: isCouple ? insta(data.spouseInstagramId) : "",
    spouseProfession: isCouple ? text(data.spouseProfession) : "",
  };
};

// Strict reader for Add / Edit Member (throws a clear message).
// Only the keys present in `body` are returned, so a partial update never
// wipes the other fields.
const strictExtraFields = (body = {}, current = {}) => {
  const text = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const out = {};

  ["designation", "address", "spouseName", "spouseProfession"].forEach((f) => {
    if (body[f] !== undefined) out[f] = text(body[f]);
  });

  const instagram = (field, label) => {
    if (body[field] === undefined) return;
    const raw = text(body[field]);
    if (!raw) {
      out[field] = "";
      return;
    }
    const id = parseInstagramLink(raw) || (isValidInstagramId(normalizeInstagramId(raw)) ? normalizeInstagramId(raw) : null);
    if (!id) throw new AppError(`${label}: please enter a valid Instagram profile link`, 400);
    out[field] = id;
  };
  instagram("instagramId", "Instagram Link");
  instagram("spouseInstagramId", "Spouse Instagram Link");

  if (body.relationship !== undefined) {
    out.relationship = text(body.relationship).toLowerCase() === "couple" ? "Couple" : "Single";
  }

  if (body.spouseMobile !== undefined) {
    const raw = text(body.spouseMobile);
    if (!raw) out.spouseMobile = "";
    else {
      const local = toLocalMobile(raw);
      if (!local) throw new AppError("Spouse Mobile Number must be a valid 10-digit number", 400);
      out.spouseMobile = local;
    }
  }

  // Single = no spouse details.
  const relationship = out.relationship || current.relationship || "Single";
  if (relationship !== "Couple") {
    out.spouseName = "";
    out.spouseMobile = "";
    out.spouseInstagramId = "";
    out.spouseProfession = "";
  }

  return out;
};

// ================= FILE PARSING =================
const HEADER_ALIASES = {
  name: ["name", "fullname", "membername"],
  mobile: ["contact", "contactnumber", "mobile", "mobilenumber", "whatsapp", "whatsappnumber", "phone"],
  email: ["email", "emailid"],
  profession: ["profession", "category"],
  companyName: ["companybrand", "company", "companyname", "brand"],
  area: ["area"],
  city: ["city"],
  state: ["state"],
  reference1: ["reference", "reference1"],
  reference2: ["reference2"],
  reference3: ["reference3"],
  source: ["source"],
  remark: ["remark", "remarks"],
  memberStatus: ["status"],
  designation: ["designation", "companydesignation"],
  address: ["address"],
  instagramId: ["instagram", "instagramid", "instagramlink"],
  relationship: ["relationship", "relation"],
  spouseName: ["spousename"],
  spouseMobile: ["spousemobile", "spousenumber", "spousecontact"],
  spouseInstagramId: ["spouseinstagram", "spouseinstagramid", "spouseinstagramlink"],
  spouseProfession: ["spouseprofession", "spousecategory"],
};

const headerKey = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const cellToText = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join("");
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    return "";
  }
  return String(value);
};

const readWorksheet = async (buffer, fileName = "") => {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();

  if (String(fileName).toLowerCase().endsWith(".xlsx")) {
    await workbook.xlsx.load(buffer);
    return workbook.worksheets[0];
  }

  const text = buffer.toString("utf-8").replace(/^\uFEFF/, "");

  // Excel in some regions saves CSV with ";" (or tab) instead of ",".
  // The separator is read from the header line (outside quotes).
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of text.split(/\r?\n/, 1)[0] || "") {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const delimiter = best[1] > 0 ? best[0] : ",";

  return workbook.csv.read(Readable.from(text), {
    map: (value) => value,
    parserOptions: { delimiter },
  });
};

const parseMembersFile = async (buffer, fileName) => {
  const worksheet = await readWorksheet(buffer, fileName);

  if (!worksheet) throw new AppError("The file is empty.", 400);

  const rows = [];
  let columnOf = null;

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells = row.values;

    if (!columnOf) {
      const byHeader = {};
      cells.forEach((cell, idx) => {
        const key = headerKey(cellToText(cell));
        if (key) byHeader[key] = idx;
      });

      columnOf = {};
      Object.entries(HEADER_ALIASES).forEach(([field, aliases]) => {
        const hit = aliases.find((alias) => alias in byHeader);
        if (hit) columnOf[field] = byHeader[hit];
      });
      return;
    }

    const get = (field) => {
      const idx = columnOf[field];
      return idx ? cellToText(cells[idx]).replace(/\s+/g, " ").trim() : "";
    };

    const data = {};
    Object.keys(HEADER_ALIASES).forEach((field) => {
      data[field] = get(field);
    });

    if (Object.values(data).every((v) => !v)) return;

    rows.push({ rowNumber, data });
  });

  if (!columnOf) throw new AppError("The file is empty or has no header row.", 400);

  const missing = ["name", "mobile"].filter((f) => !columnOf[f]);
  if (missing.length) {
    throw new AppError(
      `Missing required column(s): ${missing
        .map((f) => (f === "mobile" ? "Contact (mobile number)" : "Name"))
        .join(", ")}`,
      400
    );
  }

  if (rows.length === 0) throw new AppError("The file has no data rows.", 400);

  return rows;
};

const MAX_PROBLEM_ROWS = 300;

// ================= IMPORT (OR DRY-RUN CHECK) =================
// Every problem row of a file is returned (the report needs all of them).
const MAX_IMPORT_PROBLEM_ROWS = 5000;

// mode "valid" (default): only good rows are saved; duplicates and invalid
//   rows are skipped and listed.
// mode "all": every row is saved. Duplicate / invalid rows are saved too,
//   flagged (mobileStatus + importNote) so they can be found under the
//   "Needs Fix" tab and corrected by editing.
const importMembers = async (
  buffer,
  fileName,
  adminId,
  { dryRun = false, mode = "valid" } = {}
) => {
  const importAll = mode === "all";
  const rows = await parseMembersFile(buffer, fileName);

  // Same mobile number again (already saved, or repeated in the file) is no
  // longer a duplicate: that member is UPDATED with the new row's details.
  const existing = await Member.find({ mobileStatus: "valid" }, { mobile: 1, references: 1 }).lean();
  const existingIdByMobile = new Map(existing.map((m) => [m.mobile, m._id]));
  // Current references per member, so a re-import ADDS new ones to them.
  const refsById = new Map(existing.map((m) => [String(m._id), m.references || []]));

  // Old references first, then the new ones that are not there yet
  // (compared case-insensitively, original spelling kept).
  const mergeRefs = (oldRefs = [], newRefs = []) => {
    // Also splits older saved values like "A & B" into A and B.
    return toReferenceList([...oldRefs, ...newRefs]);
  };
  const insertIndexByMobile = new Map();
  const updates = []; // { id, set }
  let mergedInFileCount = 0;

  const problems = [];
  const toInsert = [];
  const flaggedToInsert = [];
  let duplicateCount = 0;
  let failureCount = 0;

  const baseFields = (data) => {
    // "A & B" / "A/B" / "A-B" in a Reference cell = separate references.
    const references = toReferenceList([data.reference1, data.reference2, data.reference3]);

    return {
      name: data.name,
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) ? data.email : "",
      profession: data.profession,
      companyName: data.companyName,
      area: data.area,
      city: data.city,
      state: data.state,
      references,
      source: data.source,
      remark: data.remark,
      ...looseExtraFields(data),
      memberStatus: normalizeMemberStatus(data.memberStatus),
      createdBy: adminId || null,
    };
  };

  // Only the cells that are filled in the file are written, so an empty
  // cell never wipes what the member already has.
  const buildUpdate = (data) => {
    const base = baseFields(data);
    const set = {};
    [
      "name", "email", "profession", "companyName", "area", "city",
      "state", "references", "source", "remark", "designation", "address",
      "instagramId", "spouseName", "spouseMobile", "spouseInstagramId", "spouseProfession",
    ].forEach((key) => {
      const value = base[key];
      if (Array.isArray(value) ? value.length > 0 : Boolean(value)) set[key] = value;
    });
    if (data.memberStatus) set.memberStatus = base.memberStatus;
    if (data.relationship || set.spouseName || set.spouseMobile) {
      set.relationship = base.relationship;
      if (base.relationship !== "Couple") {
        set.spouseName = "";
        set.spouseMobile = "";
        set.spouseInstagramId = "";
        set.spouseProfession = "";
      }
    }
    return set;
  };

  const addProblem = (rowNumber, data, mobileText, error, duplicate) => {
    if (duplicate) duplicateCount += 1;
    else failureCount += 1;

    if (problems.length < MAX_IMPORT_PROBLEM_ROWS) {
      problems.push({
        row: rowNumber,
        name: data.name || "",
        mobileNumber: mobileText,
        error,
        duplicate,
        data,
      });
    }

    if (importAll) {
      flaggedToInsert.push({
        ...baseFields(data),
        name: data.name || "(No name)",
        mobile: mobileText || "",
        mobileStatus: duplicate ? "duplicate" : "invalid",
        importNote: error,
      });
    }
  };

  for (const { rowNumber, data } of rows) {
    if (!data.name) {
      addProblem(rowNumber, data, toLocalMobile(data.mobile) || data.mobile, "Name is required", false);
      continue;
    }

    if (!data.mobile) {
      addProblem(rowNumber, data, "", "Contact (mobile) is missing", false);
      continue;
    }

    const mobile = toLocalMobile(data.mobile);
    if (!mobile) {
      addProblem(rowNumber, data, data.mobile, "Invalid mobile number", false);
      continue;
    }

    // Already in Member List -> update that member.
    if (existingIdByMobile.has(mobile)) {
      const id = existingIdByMobile.get(mobile);
      const set = buildUpdate(data);
      // New references are added to the member's existing ones, never replace them.
      if (set.references) {
        set.references = mergeRefs(refsById.get(String(id)), set.references);
        refsById.set(String(id), set.references);
      }
      updates.push({ id, set });
      continue;
    }

    // Repeated inside the same file -> later row fills / changes the earlier one.
    if (insertIndexByMobile.has(mobile)) {
      const target = toInsert[insertIndexByMobile.get(mobile)];
      const set = buildUpdate(data);
      if (set.references) set.references = mergeRefs(target.references, set.references);
      Object.assign(target, set);
      mergedInFileCount += 1;
      continue;
    }

    insertIndexByMobile.set(mobile, toInsert.length);
    toInsert.push({ ...baseFields(data), mobile });
  }

  let updatedCount = updates.length;
  let successCount = toInsert.length + updates.length + mergedInFileCount;
  let flaggedCount = importAll ? flaggedToInsert.length : 0;

  const insertAll = async (docs) => {
    let saved = 0;
    for (let i = 0; i < docs.length; i += 500) {
      const chunk = docs.slice(i, i + 500);
      try {
        const inserted = await Member.insertMany(chunk, { ordered: false });
        saved += inserted.length;
      } catch (error) {
        // ordered:false -> the rest of the chunk is still saved.
        const savedCount = error?.insertedDocs?.length ?? 0;
        saved += savedCount;
        failureCount += chunk.length - savedCount;
      }
    }
    return saved;
  };

  if (!dryRun) {
    const inserted = toInsert.length ? await insertAll(toInsert) : 0;

    // Several rows for one existing member are applied in file order.
    updatedCount = 0;
    const ops = updates.filter((u) => Object.keys(u.set).length > 0);
    for (let i = 0; i < ops.length; i += 500) {
      const chunk = ops.slice(i, i + 500);
      try {
        const res = await Member.bulkWrite(
          chunk.map((u) => ({ updateOne: { filter: { _id: u.id }, update: { $set: u.set } } })),
          { ordered: true }
        );
        updatedCount += res.matchedCount ?? chunk.length;
      } catch (error) {
        failureCount += chunk.length;
      }
    }

    successCount = inserted + updatedCount + mergedInFileCount;
    flaggedCount = flaggedToInsert.length ? await insertAll(flaggedToInsert) : 0;
  }

  return {
    dryRun,
    mode: importAll ? "all" : "valid",
    totalRows: rows.length,
    successCount,
    updatedCount,
    flaggedCount,
    duplicateCount,
    failureCount,
    problems,
    problemsTruncated: duplicateCount + failureCount > problems.length,
  };
};

// ================= LIST =================
const MOVED_FILTERS = ["inGuestList", "notInGuestList"];
const FIX_TYPES = ["invalid", "duplicate"];
const SORTABLE = ["name", "mobile", "profession", "companyName", "city", "createdAt"];

// An edition is "current" while its event still exists, is switched on and
// has not ended - the same rule the frontend uses for the active-edition
// list (hooks/useEditionOptions). Members stay in the directory for good;
// this only decides whether they count as "In Guest List" RIGHT NOW, so
// after an event ends or is deleted its members become selectable again
// for the next edition.
const getActiveEventIds = async () =>
  Event.distinct("_id", {
    isDeleted: { $ne: true },
    isActive: { $ne: false },
    status: { $ne: "Expired" },
    $or: [
      { endDateTime: null },
      { endDateTime: { $exists: false } },
      { endDateTime: { $gte: new Date() } },
    ],
  });

const buildMemberQuery = (query = {}, activeEventIds = []) => {
  const filter = {};
  const and = [];

  const search = String(query.search || "").trim();
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    and.push({
      $or: [
        { name: regex },
        { mobile: regex },
        { companyName: regex },
        { profession: regex },
        { area: regex },
        { city: regex },
        { references: regex },
      ],
    });
  }

  if (query.profession) {
    filter.profession = new RegExp(`^${escapeRegex(String(query.profession).trim())}$`, "i");
  }

  // Reference (case-insensitive) - matches any of the member's references.
  // Accepts an array, or one string where several references are joined
  // with "|" (the importer splits on , | ; so a reference never contains
  // "|"). A member matches when ANY selected reference is theirs.
  const referenceList = (
    Array.isArray(query.reference)
      ? query.reference
      : query.reference
      ? [query.reference]
      : []
  )
    .flatMap((ref) => String(ref).split("|"))
    .map((ref) => ref.trim())
    .filter(Boolean);

  // ONE combined regex (not one per reference) so selecting many
  // references stays fast. \s* tolerates stray spaces stored in the DB.
  if (referenceList.length > 0) {
    const pattern = referenceList.map(looseRefSource).join("|");
    and.push({
      references: new RegExp(`^[\\s${INVISIBLE}]*(?:${pattern})[\\s${INVISIBLE}]*$`, "i"),
    });
  }

  if (query.memberStatus) {
    filter.memberStatus = new RegExp(`^${escapeRegex(String(query.memberStatus).trim())}$`, "i");
  }

  if (query.moved === "needsFix") {
    // Needs Fix can be narrowed to only "invalid" or only "duplicate" rows.
    const fixType = String(query.fixType || "").toLowerCase();
    filter.mobileStatus = FIX_TYPES.includes(fixType)
      ? fixType
      : { $in: FIX_TYPES };
  }

  if (MOVED_FILTERS.includes(query.moved)) {
    and.push(
      query.moved === "inGuestList"
        ? { "movedTo.eventId": { $in: activeEventIds } }
        : { "movedTo.eventId": { $nin: activeEventIds } }
    );
  }

  if (and.length) filter.$and = and;

  return filter;
};

const getAllMembers = async (query = {}) => {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100000);
  const sortBy = SORTABLE.includes(query.sortBy) ? query.sortBy : "name";
  const sortOrder = query.sortOrder === "desc" ? -1 : 1;

  const activeEventIds = await getActiveEventIds();
  const activeSet = new Set(activeEventIds.map(String));
  const filter = buildMemberQuery(query, activeEventIds);

  const [rows, total] = await Promise.all([
    Member.find(filter)
      .sort({ [sortBy]: sortOrder, _id: 1 })
      .collation({ locale: "en", strength: 2 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Member.countDocuments(filter),
  ]);

  // Numbers on the All / Not in Guest List / In Guest List tabs (whole
  // directory, independent of search and other filters).
  const [all, inGuestList, invalidCount, duplicateCount] = await Promise.all([
    Member.countDocuments({}),
    Member.countDocuments({ "movedTo.eventId": { $in: activeEventIds } }),
    Member.countDocuments({ mobileStatus: "invalid" }),
    Member.countDocuments({ mobileStatus: "duplicate" }),
  ]);
  const needsFix = invalidCount + duplicateCount;

  // movedTo is the permanent record of every edition a member went to
  // (kept even after that event ends or is deleted); currentMovedTo is only
  // the editions that are still running.
  const data = rows.map((m) => ({
    ...m,
    currentMovedTo: (m.movedTo || []).filter((x) => activeSet.has(String(x.eventId))),
  }));

  return {
    success: true,
    message: "Members fetched successfully",
    data,
    counts: {
      all,
      inGuestList,
      notInGuestList: all - inGuestList,
      needsFix,
      invalid: invalidCount,
      duplicate: duplicateCount,
    },
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    },
  };
};

const getMemberProfessions = async () => {
  const rows = await Member.distinct("profession");
  const seen = new Set();
  const list = [];
  rows
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .forEach((p) => {
      if (!seen.has(p.toLowerCase())) {
        seen.add(p.toLowerCase());
        list.push(p);
      }
    });
  list.sort((a, b) => a.localeCompare(b));
  return list;
};

const getMemberReferences = async () => {
  const rows = await Member.distinct("references");
  const seen = new Set();
  const list = [];
  rows
    .map((r) => stripInvisible(r))
    .filter(Boolean)
    .forEach((r) => {
      if (!seen.has(r.toLowerCase())) {
        seen.add(r.toLowerCase());
        list.push(r);
      }
    });
  list.sort((a, b) => a.localeCompare(b));
  return list;
};

// ids -> those members; selectAll -> every member matching `filters`.
const resolveMembers = async ({ ids, selectAll, filters }) => {
  if (selectAll) {
    return Member.find(buildMemberQuery(filters || {}, await getActiveEventIds()));
  }

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError("Please select at least one member.", 400);
  }

  const unique = [...new Set(ids.map(String))];
  if (unique.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw new AppError("Invalid member selection.", 400);
  }

  return Member.find({ _id: { $in: unique } });
};

// ================= MOVE TO GUEST LIST =================
// POST /api/members/move-to-guest-list
// { ids | selectAll + filters, eventId }
// Creates a Guest List contact (status Pending) for every member in the
// chosen edition. A person already in the Guest List for THIS edition is
// skipped; a person already in the Guest List from another edition is moved
// to this edition and set back to Pending.
const moveMembersToGuestList = async (body, adminId) => {
  const { eventId } = body;

  if (!mongoose.Types.ObjectId.isValid(eventId)) {
    throw new AppError("Please select an edition.", 400);
  }

  const event = await Event.findById(eventId);
  if (!event) throw new AppError("Edition not found.", 404);

  const editionName = event.edition || event.title;
  const members = await resolveMembers(body);

  if (members.length === 0) {
    throw new AppError("No members found to move.", 404);
  }

  // Profession -> Company Category (created when it does not exist yet).
  const categoryCache = new Map();
  const resolveCategoryId = async (profession) => {
    const name = String(profession || "").trim();
    if (!name) return null;

    const key = name.toLowerCase();
    if (categoryCache.has(key)) return categoryCache.get(key);

    let category = await CompanyCategory.findOne({
      name,
      isDeleted: { $ne: true },
    }).collation({ locale: "en", strength: 2 });

    if (!category) {
      category = await CompanyCategory.create({ name, createdBy: adminId });
    }

    categoryCache.set(key, category._id);
    return category._id;
  };

  const counts = { moved: 0, alreadyThere: 0, updated: 0, failed: 0 };
  const problems = [];
  const note = (member, status, message) => {
    if (problems.length < MAX_PROBLEM_ROWS) {
      problems.push({ id: String(member._id), name: member.name, status, message });
    }
  };

  for (const member of members) {
    try {
      // A member imported with a wrong / repeated number must be fixed first.
      if ((member.mobileStatus || "valid") !== "valid") {
        counts.failed += 1;
        note(member, "failed", "Fix the mobile number first (Needs Fix) - edit this member");
        continue;
      }

      const companyCategory = await resolveCategoryId(member.profession);
      const professionCategory =
        member.relationship === "Couple" ? await resolveCategoryId(member.spouseProfession) : null;

      const existing = await Contact.findOne({
        isDeleted: { $ne: true },
        whatsappNumber: member.mobile,
      });

      if (existing && String(existing.editionEventId) === String(event._id) && !existing.historyOnly) {
        counts.alreadyThere += 1;
        note(member, "skipped", `Already in Guest List for ${editionName}`);
      } else if (existing) {
        existing.editionEventId = event._id;
        existing.editionName = editionName;
        existing.memberId = member._id;
        existing.historyOnly = false;
        if (!existing.profileImage && member.profileImage) existing.profileImage = member.profileImage;
        if (!existing.spouseProfileImage && member.relationship === "Couple" && member.spouseProfileImage) {
          existing.spouseProfileImage = member.spouseProfileImage;
        }
        existing.approvalStatus = "pending";
        existing.approvalUpdatedAt = new Date();
        if (String(existing.passEventId || "") !== String(event._id)) {
          existing.passSentAt = null;
          existing.passEventId = null;
          existing.passBookingId = null;
        }
        await existing.save();
        counts.updated += 1;
        note(member, "updated", `Already a guest - moved to ${editionName} (Pending)`);
      } else {
        await Contact.create({
          fullName: member.name,
          whatsappNumber: member.mobile,
          email: member.email || "",
          companyName: member.companyName || "",
          designation: member.designation || "",
          area: member.area || "",
          address: member.address || [member.city, member.state].filter(Boolean).join(", "),
          instagramId: member.instagramId || "",
          references: member.references || [],
          companyCategory,
          relationship: member.relationship === "Couple" ? "Couple" : "Single",
          // Entry Type is filled from the Contact Book relationship too.
          entryType: member.relationship === "Couple" ? "Couple" : "Single",
          spouseName: member.relationship === "Couple" ? member.spouseName || "" : "",
          spouseMobile: member.relationship === "Couple" ? member.spouseMobile || "" : "",
          spouseInstagramId: member.relationship === "Couple" ? member.spouseInstagramId || "" : "",
          // Photos are shared by URL only. PublicId is left empty on purpose, so
          // deleting the guest never deletes the file the Contact Book entry owns.
          profileImage: member.profileImage || "",
          spouseProfileImage: member.relationship === "Couple" ? member.spouseProfileImage || "" : "",
          professionCategory,
          editionEventId: event._id,
          editionName,
          memberId: member._id,
          approvalStatus: "pending",
          createdBy: adminId,
        });
        counts.moved += 1;
      }

      const alreadyLogged = (member.movedTo || []).some(
        (m) => String(m.eventId) === String(event._id)
      );
      if (!alreadyLogged) {
        await Member.updateOne(
          { _id: member._id },
          { $push: { movedTo: { eventId: event._id, editionName, movedAt: new Date() } } }
        );
      }
    } catch (error) {
      counts.failed += 1;
      note(member, "failed", error.message || "Failed to move");
    }
  }

  const done = counts.moved + counts.updated;

  return {
    success: done > 0 || counts.alreadyThere > 0,
    message:
      `${done} contact${done === 1 ? "" : "s"} moved to Guest List (${editionName})` +
      (counts.alreadyThere ? `, ${counts.alreadyThere} already there` : "") +
      (counts.failed ? `, ${counts.failed} failed` : ""),
    data: { editionName, total: members.length, ...counts, problems },
  };
};

// ================= UPDATE =================
// PUT /api/members/:id - edit one member's details.
const UPDATABLE_TEXT_FIELDS = [
  "name",
  "email",
  "profession",
  "companyName",
  "area",
  "city",
  "state",
  "source",
  "remark",
  "memberStatus",
];

const updateMember = async (id, body = {}, files = null) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new AppError("Invalid Contact ID", 400);

  const member = await Member.findById(id);
  if (!member) throw new AppError("Contact not found", 404);

  const name = body.name !== undefined ? String(body.name).trim() : member.name;
  if (!name) throw new AppError("Full Name is required", 400);

  if (body.mobile !== undefined) {
    const mobile = toLocalMobile(body.mobile);
    if (!mobile) {
      throw new AppError("WhatsApp Number must be a valid 10-digit number", 400);
    }

    if (mobile !== member.mobile || member.mobileStatus === "duplicate") {
      const clash = await Member.findOne({
        mobile,
        mobileStatus: "valid",
        _id: { $ne: member._id },
      })
        .select("name")
        .lean();
      if (clash) {
        throw new AppError(`This WhatsApp number already belongs to ${clash.name}`, 409);
      }
      member.mobile = mobile;
      // The number is now valid and unique -> no longer "Needs Fix".
      member.mobileStatus = "valid";
      member.importNote = "";
    }
  }

  if (body.email !== undefined) {
    const email = String(body.email).trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new AppError("Invalid email address", 400);
    }
  }

  // The edit form always sends these, so they cannot be saved empty.
  [
    ["companyName", "Company Name"],
    ["profession", "Company Category"],
  ].forEach(([field, label]) => {
    if (body[field] !== undefined && !String(body[field]).trim()) {
      throw new AppError(`${label} is required`, 400);
    }
  });

  UPDATABLE_TEXT_FIELDS.forEach((field) => {
    if (body[field] !== undefined) {
      member[field] = String(body[field]).replace(/\s+/g, " ").trim();
    }
  });
  Object.assign(member, strictExtraFields(body, member));
  member.name = name;
  if (body.memberStatus !== undefined) {
    member.memberStatus = normalizeMemberStatus(body.memberStatus);
  }

  if (body.references !== undefined) {
    const refs = toReferenceList(body.references, { splitLists: true });
    if (refs.length === 0) throw new AppError("At least one Reference is required", 400);
    member.references = refs;
  }

  // Flagged only because the name was missing: valid number + a name now.
  if (member.mobileStatus === "invalid" && member.name && toLocalMobile(member.mobile)) {
    const local = toLocalMobile(member.mobile);
    const taken = await Member.findOne({
      mobile: local,
      mobileStatus: "valid",
      _id: { $ne: member._id },
    })
      .select("_id")
      .lean();
    if (!taken) {
      member.mobile = local;
      member.mobileStatus = "valid";
      member.importNote = "";
    }
  }

  // ---------- Photos ----------
  // New upload replaces the saved one; "remove" clears it; Single has no spouse photo.
  const isCoupleNow = member.relationship === "Couple";
  const staleImageIds = []; // old files are deleted only AFTER the save succeeds
  const uploaded = [];

  try {
    const profileUpload = await uploadOne(firstFile(files, "profileImage"));
    if (profileUpload) {
      uploaded.push(profileUpload.publicId);
      staleImageIds.push(member.profileImagePublicId);
      member.profileImage = profileUpload.url;
      member.profileImagePublicId = profileUpload.publicId;
    } else if (isTrue(body.removeProfileImage) && member.profileImage) {
      staleImageIds.push(member.profileImagePublicId);
      member.profileImage = "";
      member.profileImagePublicId = "";
    }

    if (!isCoupleNow) {
      if (member.spouseProfileImage) {
        staleImageIds.push(member.spouseProfileImagePublicId);
        member.spouseProfileImage = "";
        member.spouseProfileImagePublicId = "";
      }
    } else {
      const spouseUpload = await uploadOne(firstFile(files, "spouseProfileImage"));
      if (spouseUpload) {
        uploaded.push(spouseUpload.publicId);
        staleImageIds.push(member.spouseProfileImagePublicId);
        member.spouseProfileImage = spouseUpload.url;
        member.spouseProfileImagePublicId = spouseUpload.publicId;
      } else if (isTrue(body.removeSpouseProfileImage) && member.spouseProfileImage) {
        staleImageIds.push(member.spouseProfileImagePublicId);
        member.spouseProfileImage = "";
        member.spouseProfileImagePublicId = "";
      }
    }

    await member.save();
  } catch (error) {
    await removeFiles(uploaded); // the save failed - do not leave orphan files
    throw error;
  }

  await removeFiles(staleImageIds);
  return member;
};

// ================= CREATE (ONE MEMBER) =================
// POST /api/members - add a single member by hand (the Excel / CSV import
// is still there for bulk). Same rules as import and edit: name and a valid
// 10-digit mobile are required, the mobile must be unique, email is optional.
const createMember = async (body = {}, adminId = null, files = null) => {
  const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

  const name = text(body.name);
  if (!name) throw new AppError("Full Name is required", 400);

  const mobile = toLocalMobile(body.mobile);
  if (!mobile) {
    throw new AppError("WhatsApp Number must be a valid 10-digit number", 400);
  }

  const clash = await Member.findOne({ mobile, mobileStatus: "valid" }).select("name").lean();
  if (clash) {
    throw new AppError(`This WhatsApp number already belongs to ${clash.name}`, 409);
  }

  const companyName = text(body.companyName);
  const profession = text(body.profession);

  const email = text(body.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError("Invalid email address", 400);
  }

  const references = toReferenceList(body.references, { splitLists: true });

  if (references.length === 0) throw new AppError("At least one Reference is required", 400);

  const extra = strictExtraFields(body);
  const isCouple = extra.relationship === "Couple";

  // Photos: profile always, spouse only for Couple.
  const uploaded = [];
  const photoFields = {};
  try {
    const profileUpload = await uploadOne(firstFile(files, "profileImage"));
    if (profileUpload) {
      uploaded.push(profileUpload.publicId);
      photoFields.profileImage = profileUpload.url;
      photoFields.profileImagePublicId = profileUpload.publicId;
    }

    if (isCouple) {
      const spouseUpload = await uploadOne(firstFile(files, "spouseProfileImage"));
      if (spouseUpload) {
        uploaded.push(spouseUpload.publicId);
        photoFields.spouseProfileImage = spouseUpload.url;
        photoFields.spouseProfileImagePublicId = spouseUpload.publicId;
      }
    }

    return await Member.create({
      name,
      mobile,
      email,
      profession,
      companyName,
      area: text(body.area),
      city: text(body.city),
      state: text(body.state),
      references,
      source: text(body.source),
      remark: text(body.remark),
      ...extra,
      ...photoFields,
      memberStatus: normalizeMemberStatus(body.memberStatus),
      createdBy: adminId || null,
    });
  } catch (error) {
    await removeFiles(uploaded); // the save failed - do not leave orphan files
    throw error;
  }
};

// ================= DELETE (HARD) =================
// ================= KEEP "IN GUEST LIST" IN SYNC =================
// "In Guest List" on Member List comes from Member.movedTo. Deleting the
// contact from Guest List used to leave movedTo behind, so the member kept
// showing "In Guest List" (and never came back to "Not in Guest List").
//
// For the given members (by id and/or mobile): when NO live Guest List
// contact is left for them, drop their movedTo entries for the running
// editions so they show as "Not in Guest List" again and can be moved again.
// Entries for ended / deleted editions stay (permanent history).
const releaseMembersWithoutContact = async ({ memberIds = [], mobiles = [] } = {}) => {
  const ids = memberIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
  const phones = [...new Set(mobiles.map((m) => String(m || "").trim()).filter(Boolean))];
  if (!ids.length && !phones.length) return 0;

  const members = await Member.find({
    $or: [
      ...(ids.length ? [{ _id: { $in: ids } }] : []),
      ...(phones.length ? [{ mobile: { $in: phones } }] : []),
    ],
    "movedTo.0": { $exists: true },
  })
    .select("_id mobile")
    .lean();
  if (!members.length) return 0;

  const memberObjectIds = members.map((m) => m._id);
  const memberMobiles = members.flatMap((m) => [m.mobile, `91${m.mobile}`]);

  // A contact still counts only if it is really in the Guest List.
  const live = await Contact.find({
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
    $or: [{ memberId: { $in: memberObjectIds } }, { whatsappNumber: { $in: memberMobiles } }],
  })
    .select("memberId whatsappNumber")
    .lean();

  const liveIds = new Set(live.map((c) => String(c.memberId || "")));
  const liveMobiles = new Set(live.map((c) => String(c.whatsappNumber || "")));

  const toRelease = members.filter(
    (m) =>
      !liveIds.has(String(m._id)) && !liveMobiles.has(m.mobile) && !liveMobiles.has(`91${m.mobile}`)
  );
  if (!toRelease.length) return 0;

  const activeEventIds = await getActiveEventIds();
  await Member.updateMany(
    { _id: { $in: toRelease.map((m) => m._id) } },
    { $pull: { movedTo: { eventId: { $in: activeEventIds } } } }
  );

  return toRelease.length;
};

const deleteMember = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new AppError("Invalid Contact ID", 400);
  const member = await Member.findByIdAndDelete(id);
  if (!member) throw new AppError("Contact not found", 404);
  await removeFiles([member.profileImagePublicId, member.spouseProfileImagePublicId]);
  return member;
};

// ================= BULK DELETE (NEEDS FIX ONLY) =================
// body: { ids: string[] }  or  { selectAll: true, filters: {...} }
// Only members that are in "Needs Fix" (invalid / duplicate number) can be
// deleted this way, so a wrong request can never wipe valid members.
const deleteNeedsFixMembers = async (body = {}) => {
  const base = { mobileStatus: { $in: FIX_TYPES } };
  let filter;

  if (body.selectAll) {
    const activeEventIds = await getActiveEventIds();
    filter = buildMemberQuery({ ...(body.filters || {}), moved: "needsFix" }, activeEventIds);
  } else {
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => mongoose.Types.ObjectId.isValid(id)) : [];
    if (ids.length === 0) throw new AppError("Select at least one member", 400);
    filter = { ...base, _id: { $in: ids } };
  }

  const result = await Member.deleteMany(filter);
  return { success: true, message: `${result.deletedCount} contact(s) deleted`, deletedCount: result.deletedCount };
};

// ================= EXPORT (CSV) =================
// Same filters as the list (tab, fixType, search, profession, reference).
// Columns use the SAME headers as the import file, so an exported Needs Fix
// file can be corrected and imported again. "Problem" is the extra column.
const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

const EXPORT_HEADERS = [
  "#", "Name", "Contact", "Email", "Profession", "Company / Brand", "Objective",
  "Area", "City", "State", "Reference", "Reference 2", "Reference 3", "Source",
  "Remark", "Status", "Company Designation", "Address", "Instagram Link",
  "Relationship", "Spouse Name", "Spouse Mobile", "Spouse Instagram Link",
  "Spouse Profession", "Problem", "Problem Type",
];

// Finds the members for an export and turns each one into a row (same
// order as EXPORT_HEADERS). Shared by the CSV and the Excel export.
// Optional `ids` (comma separated) = export only those ticked rows, still
// limited by the other filters.
const buildExportRows = async (query = {}) => {
  const activeEventIds = await getActiveEventIds();
  const filter = buildMemberQuery(query, activeEventIds);

  const ids = String(query.ids || "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (ids.length > 0) filter._id = { $in: ids };

  const members = await Member.find(filter)
    .sort({ name: 1, _id: 1 })
    .collation({ locale: "en", strength: 2 })
    .lean();

  const rows = members.map((m, index) => {
    const refs = m.references || [];
    const typeLabel =
      m.mobileStatus === "duplicate" ? "Duplicate" : m.mobileStatus === "invalid" ? "Invalid" : "";
    return [
      index + 1,
      m.name === "(No name)" ? "" : m.name,
      m.mobile,
      m.email,
      m.profession,
      m.companyName,
      m.objective,
      m.area,
      m.city,
      m.state,
      refs[0] || "",
      refs[1] || "",
      // More than 3 references: the rest go in the 3rd column joined with "&"
      // (the importer splits "A & B" into two references again).
      refs.slice(2).join(" & "),
      m.source,
      m.remark,
      m.memberStatus,
      m.designation,
      m.address,
      m.instagramId ? `https://instagram.com/${m.instagramId}` : "",
      m.relationship,
      m.spouseName,
      m.spouseMobile,
      m.spouseInstagramId ? `https://instagram.com/${m.spouseInstagramId}` : "",
      m.spouseProfession,
      m.importNote,
      typeLabel,
    ];
  });

  return { rows, count: rows.length };
};

const exportMembersCsv = async (query = {}) => {
  const { rows, count } = await buildExportRows(query);
  const lines = [EXPORT_HEADERS.map(csvCell).join(",")];
  rows.forEach((row) => lines.push(row.map(csvCell).join(",")));

  // BOM so Excel reads Gujarati / Hindi names correctly.
  return { csv: "\uFEFF" + lines.join("\r\n"), count };
};

// ================= EXPORT (EXCEL .xlsx) =================
// Same filters as the list (tab, fixType, search, profession, reference) +
// optional ticked ids. Phone numbers are written as text so Excel never
// turns them into 9.9E+09 or drops a leading 0.
const exportMembersXlsx = async (query = {}) => {
  const { rows, count } = await buildExportRows(query);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Contact Book", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = EXPORT_HEADERS.map((header) => ({
    header,
    key: header,
    width: Math.min(Math.max(header.length + 4, 14), 28),
  }));
  sheet.getColumn(1).width = 6;
  sheet.getColumn("Address").width = 34;
  sheet.getColumn("Remark").width = 30;
  sheet.getColumn("Problem").width = 34;

  const textColumns = ["Contact", "Spouse Mobile"].map((h) => EXPORT_HEADERS.indexOf(h) + 1);
  textColumns.forEach((col) => {
    sheet.getColumn(col).numFmt = "@";
  });

  rows.forEach((row) => {
    sheet.addRow(row.map((value, i) => (textColumns.includes(i + 1) ? String(value ?? "") : value ?? "")));
  });

  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3B82C4" } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: EXPORT_HEADERS.length } };

  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer, count };
};

module.exports = {
  deleteNeedsFixMembers,
  exportMembersCsv,
  exportMembersXlsx,
  importMembers,
  getAllMembers,
  getMemberProfessions,
  getMemberReferences,
  moveMembersToGuestList,
  releaseMembersWithoutContact,
  createMember,
  updateMember,
  deleteMember,
};