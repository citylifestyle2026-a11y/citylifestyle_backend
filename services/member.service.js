// services/member.service.js
//
// Member List: import members from an Excel (.xlsx) / CSV file, list &
// filter them, and move selected members to the Guest List for an edition.
const mongoose = require("mongoose");
const { Readable } = require("stream");
const Member = require("../models/member.model");
const Contact = require("../models/contact.model");
const CompanyCategory = require("../models/companycategory.model");
const Event = require("../models/event.model");
const AppError = require("../utils/AppError");
const { normalizeMobileNumber } = require("../utils/normalizeMobileNumber");

const toLocalMobile = (value) => {
  const canonical = normalizeMobileNumber(value);
  return canonical ? canonical.slice(2) : null;
};

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ================= FILE PARSING =================
const HEADER_ALIASES = {
  name: ["name", "fullname", "membername"],
  mobile: ["contact", "contactnumber", "mobile", "mobilenumber", "whatsapp", "whatsappnumber", "phone"],
  email: ["email", "emailid"],
  profession: ["profession", "category"],
  companyName: ["companybrand", "company", "companyname", "brand"],
  objective: ["objective"],
  area: ["area"],
  city: ["city"],
  state: ["state"],
  reference1: ["reference", "reference1"],
  reference2: ["reference2"],
  reference3: ["reference3"],
  source: ["source"],
  remark: ["remark", "remarks"],
  memberStatus: ["status"],
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

  return workbook.csv.read(
    Readable.from(buffer.toString("utf-8").replace(/^\uFEFF/, "")),
    { map: (value) => value }
  );
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

  const existing = await Member.find({ mobileStatus: "valid" }, { mobile: 1 }).lean();
  const seen = new Set(existing.map((m) => m.mobile));

  const problems = [];
  const toInsert = [];
  const flaggedToInsert = [];
  let duplicateCount = 0;
  let failureCount = 0;

  const baseFields = (data) => {
    const references = [];
    [data.reference1, data.reference2, data.reference3].forEach((ref) => {
      const text = String(ref || "").trim();
      if (text && !references.some((r) => r.toLowerCase() === text.toLowerCase())) {
        references.push(text);
      }
    });

    return {
      name: data.name,
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) ? data.email : "",
      profession: data.profession,
      companyName: data.companyName,
      objective: data.objective,
      area: data.area,
      city: data.city,
      state: data.state,
      references,
      source: data.source,
      remark: data.remark,
      memberStatus: data.memberStatus || "Active",
      createdBy: adminId || null,
    };
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

    if (seen.has(mobile)) {
      addProblem(rowNumber, data, mobile, "Mobile number already in Member List", true);
      continue;
    }
    seen.add(mobile);

    toInsert.push({ ...baseFields(data), mobile });
  }

  let successCount = toInsert.length;
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
    successCount = toInsert.length ? await insertAll(toInsert) : 0;
    flaggedCount = flaggedToInsert.length ? await insertAll(flaggedToInsert) : 0;
  }

  return {
    dryRun,
    mode: importAll ? "all" : "valid",
    totalRows: rows.length,
    successCount,
    flaggedCount,
    duplicateCount,
    failureCount,
    problems,
    problemsTruncated: duplicateCount + failureCount > problems.length,
  };
};

// ================= LIST =================
const MOVED_FILTERS = ["inGuestList", "notInGuestList"];
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
  if (query.reference) {
    filter.references = new RegExp(
      `^${escapeRegex(String(query.reference).trim())}$`,
      "i"
    );
  }

  if (query.memberStatus) {
    filter.memberStatus = new RegExp(`^${escapeRegex(String(query.memberStatus).trim())}$`, "i");
  }

  if (query.moved === "needsFix") {
    filter.mobileStatus = { $in: ["invalid", "duplicate"] };
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
  const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 200);
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
  const [all, inGuestList, needsFix] = await Promise.all([
    Member.countDocuments({}),
    Member.countDocuments({ "movedTo.eventId": { $in: activeEventIds } }),
    Member.countDocuments({ mobileStatus: { $in: ["invalid", "duplicate"] } }),
  ]);

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
    counts: { all, inGuestList, notInGuestList: all - inGuestList, needsFix },
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
    .map((r) => String(r || "").trim())
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
          designation: member.objective || "",
          area: member.area || "",
          address: [member.city, member.state].filter(Boolean).join(", "),
          references: member.references || [],
          companyCategory,
          relationship: "Single",
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
      `${done} member${done === 1 ? "" : "s"} moved to Guest List (${editionName})` +
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
  "objective",
  "area",
  "city",
  "state",
  "source",
  "remark",
  "memberStatus",
];

const updateMember = async (id, body = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new AppError("Invalid Member ID", 400);

  const member = await Member.findById(id);
  if (!member) throw new AppError("Member not found", 404);

  const name = body.name !== undefined ? String(body.name).trim() : member.name;
  if (!name) throw new AppError("Name is required", 400);

  if (body.mobile !== undefined) {
    const mobile = toLocalMobile(body.mobile);
    if (!mobile) {
      throw new AppError("Mobile Number must be a valid 10-digit number", 400);
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
        throw new AppError(`This mobile number already belongs to ${clash.name}`, 409);
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

  UPDATABLE_TEXT_FIELDS.forEach((field) => {
    if (body[field] !== undefined) {
      member[field] = String(body[field]).replace(/\s+/g, " ").trim();
    }
  });
  member.name = name;

  if (body.references !== undefined) {
    const raw = Array.isArray(body.references)
      ? body.references
      : String(body.references).split(/[,|;]/);
    const refs = [];
    raw.forEach((ref) => {
      const text = String(ref || "").trim();
      if (text && !refs.some((r) => r.toLowerCase() === text.toLowerCase())) {
        refs.push(text);
      }
    });
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

  await member.save();
  return member;
};

// ================= CREATE (ONE MEMBER) =================
// POST /api/members - add a single member by hand (the Excel / CSV import
// is still there for bulk). Same rules as import and edit: name and a valid
// 10-digit mobile are required, the mobile must be unique, email is optional.
const createMember = async (body = {}, adminId = null) => {
  const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

  const name = text(body.name);
  if (!name) throw new AppError("Name is required", 400);

  const mobile = toLocalMobile(body.mobile);
  if (!mobile) {
    throw new AppError("Mobile Number must be a valid 10-digit number", 400);
  }

  const clash = await Member.findOne({ mobile, mobileStatus: "valid" }).select("name").lean();
  if (clash) {
    throw new AppError(`This mobile number already belongs to ${clash.name}`, 409);
  }

  const email = text(body.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError("Invalid email address", 400);
  }

  const rawRefs = Array.isArray(body.references)
    ? body.references
    : String(body.references || "").split(/[,|;]/);
  const references = [];
  rawRefs.forEach((ref) => {
    const value = text(ref);
    if (value && !references.some((r) => r.toLowerCase() === value.toLowerCase())) {
      references.push(value);
    }
  });

  return Member.create({
    name,
    mobile,
    email,
    profession: text(body.profession),
    companyName: text(body.companyName),
    objective: text(body.objective),
    area: text(body.area),
    city: text(body.city),
    state: text(body.state),
    references,
    source: text(body.source),
    remark: text(body.remark),
    memberStatus: text(body.memberStatus) || "Active",
    createdBy: adminId || null,
  });
};

// ================= DELETE (HARD) =================
const deleteMember = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new AppError("Invalid Member ID", 400);
  const member = await Member.findByIdAndDelete(id);
  if (!member) throw new AppError("Member not found", 404);
  return member;
};

module.exports = {
  importMembers,
  getAllMembers,
  getMemberProfessions,
  getMemberReferences,
  moveMembersToGuestList,
  createMember,
  updateMember,
  deleteMember,
};
