// services/contactDuplicate.service.js
//
// Duplicate WhatsApp numbers coming from the PUBLIC form / form links.
//
//   captureIfDuplicate - called by the public routes: if the number is already
//                        in the Guest List the submission is saved as a
//                        ContactDuplicate (no new guest row, no pass).
//   listDuplicates     - rows of the Guest List "Duplicate" tab.
//   getDuplicatePreview- existing guest vs new submission, field by field.
//   fixDuplicate       - writes the chosen values into the ONE Guest List row
//                        and syncs the Contact Book row with the same number.
//   ignoreDuplicate    - throws the submission away.
const Contact = require("../models/contact.model");
const ContactDuplicate = require("../models/contactDuplicate.model");
const Member = require("../models/member.model");
const CompanyCategory = require("../models/companycategory.model");
const AppError = require("../utils/AppError");
const uploadImage = require("../utils/localUpload.util");
const deleteImage = require("../utils/deleteLocalFile");
const { normalizeMobileNumber } = require("../utils/normalizeMobileNumber");
const { toReferenceList } = require("../utils/splitReferences");
const contactMerge = require("./contactMerge.service");

const IMAGE_FOLDER = "event-management/contacts";

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const firstFile = (files, field) => (files && files[field] && files[field][0]) || null;

// "9876543210", "919876543210" and what was typed.
const numberVariants = (value) => {
  const raw = String(value || "").trim();
  const canonical = normalizeMobileNumber(raw);
  return [...new Set([raw, canonical, canonical ? canonical.slice(2) : null].filter(Boolean))];
};

const findGuestByNumber = async (whatsappNumber) => {
  const variants = numberVariants(whatsappNumber);
  if (!variants.length) return null;

  return Contact.findOne({
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
    whatsappNumber: { $in: variants },
  }).select("_id");
};

const uploadOne = async (file) => {
  if (!file) return null;
  const result = await uploadImage(file, IMAGE_FOLDER, "image");
  return { url: result.url, publicId: result.public_id };
};

// ================= SAVE (called by the public form) =================
const saveDuplicate = async (existing, data, files = {}, { source = "form", formLinkId = null } = {}) => {
  const isCouple = data.relationship === "Couple";

  const profile = await uploadOne(firstFile(files, "profileImage"));
  let spouse = null;
  try {
    spouse = isCouple ? await uploadOne(firstFile(files, "spouseProfileImage")) : null;
  } catch (error) {
    if (profile) await deleteImage(profile.publicId);
    throw error;
  }

  const payload = {
      fullName: data.fullName,
      whatsappNumber: String(data.whatsappNumber || "").trim(),
      companyName: data.companyName,
      designation: data.designation,
      address: data.address,
      area: data.area,
      instagramId: data.instagramId,
      email: data.email,
      relationship: data.relationship || "Single",
      spouseName: isCouple ? data.spouseName : "",
      spouseMobile: isCouple ? data.spouseMobile : "",
      spouseInstagramId: isCouple ? data.spouseInstagramId : "",
      references: Array.isArray(data.references) ? toReferenceList(data.references) : [],
      companyCategory: data.companyCategory || null,
      professionCategory: isCouple ? data.professionCategory || null : null,
      profileImage: profile?.url || "",
      profileImagePublicId: profile?.publicId || "",
      spouseProfileImage: spouse?.url || "",
      spouseProfileImagePublicId: spouse?.publicId || "",
      contactId: existing._id,
      source,
      formLinkId,
  };

  try {
    // ONE row per guest: the same number submitted again (the same person
    // pressing Submit twice, or someone spamming the form) updates that row
    // instead of piling up thousands of rows. Latest details win, references
    // are joined, and the older photo files are removed.
    const previous = await ContactDuplicate.findOne({ contactId: existing._id });
    if (previous) {
      const oldFiles = [];
      const pick = (next, old) => (clean(next) ? next : old);

      for (const key of ["fullName", "companyName", "designation", "address", "area", "instagramId", "email",
        "spouseName", "spouseMobile", "spouseInstagramId"]) {
        previous[key] = pick(payload[key], previous[key]);
      }
      previous.whatsappNumber = payload.whatsappNumber || previous.whatsappNumber;
      previous.relationship = payload.relationship || previous.relationship;
      previous.companyCategory = payload.companyCategory || previous.companyCategory;
      previous.professionCategory = payload.professionCategory || previous.professionCategory;
      previous.references = joinReferences(previous.references, payload.references);

      if (payload.profileImage) {
        if (previous.profileImagePublicId) oldFiles.push(previous.profileImagePublicId);
        previous.profileImage = payload.profileImage;
        previous.profileImagePublicId = payload.profileImagePublicId;
      }
      if (payload.spouseProfileImage) {
        if (previous.spouseProfileImagePublicId) oldFiles.push(previous.spouseProfileImagePublicId);
        previous.spouseProfileImage = payload.spouseProfileImage;
        previous.spouseProfileImagePublicId = payload.spouseProfileImagePublicId;
      }
      previous.submissionCount = (previous.submissionCount || 1) + 1;
      previous.source = source;
      previous.formLinkId = formLinkId || previous.formLinkId;

      await previous.save();
      for (const publicId of oldFiles) await deleteImage(publicId);
      return previous;
    }

    return await ContactDuplicate.create(payload);
  } catch (error) {
    if (profile) await deleteImage(profile.publicId);
    if (spouse) await deleteImage(spouse.publicId);
    throw error;
  }
};

// Returns the saved ContactDuplicate, or null when the number is NOT a
// duplicate (the caller then creates the guest as usual).
const captureIfDuplicate = async (data, files, options) => {
  const existing = await findGuestByNumber(data.whatsappNumber);
  if (!existing) return null;
  return saveDuplicate(existing, data, files, options);
};

// ================= WHEN THE GUEST IS DELETED =================
// A Duplicate row only makes sense while the guest with that number exists.
// When that guest is deleted from the Guest List, the person who filled the
// form is NOT lost: the submission is turned into a normal guest again (it
// shows in "All" with the status the deleted guest had; Pending when unknown)
// and leaves the Duplicate tab.
const promoteDuplicateToGuest = async (duplicate, { status = "pending", source = null } = {}) => {
  // Someone already added this number again meanwhile: stay a duplicate of
  // that guest instead of creating a second row with the same number.
  const current = await findGuestByNumber(duplicate.whatsappNumber);
  if (current) {
    await ContactDuplicate.updateOne({ _id: duplicate._id }, { contactId: current._id });
    return null;
  }

  const isCouple = duplicate.relationship === "Couple";

  const guest = await Contact.create({
    fullName: duplicate.fullName,
    whatsappNumber: duplicate.whatsappNumber,
    companyName: duplicate.companyName,
    designation: duplicate.designation,
    address: duplicate.address,
    area: duplicate.area,
    instagramId: duplicate.instagramId,
    email: duplicate.email,
    relationship: duplicate.relationship || "Single",
    spouseName: isCouple ? duplicate.spouseName : "",
    spouseMobile: isCouple ? duplicate.spouseMobile : "",
    spouseInstagramId: isCouple ? duplicate.spouseInstagramId : "",
    references: duplicate.references || [],
    companyCategory: duplicate.companyCategory || null,
    professionCategory: isCouple ? duplicate.professionCategory || null : null,
    // The photo files move over to the new guest (nothing is deleted).
    profileImage: duplicate.profileImage,
    profileImagePublicId: duplicate.profileImagePublicId,
    spouseProfileImage: isCouple ? duplicate.spouseProfileImage : "",
    spouseProfileImagePublicId: isCouple ? duplicate.spouseProfileImagePublicId : "",
    editionEventId: source?.editionEventId || null,
    editionName: source?.editionName || "",
    memberId: source?.memberId || null,
    approvalStatus: status,
    approvalUpdatedAt: new Date(),
    createdBy: source?.createdBy || null,
  });

  await ContactDuplicate.deleteOne({ _id: duplicate._id });
  return guest;
};

// Called right after guests are deleted. `contacts` = the deleted documents.
const promoteDuplicatesForContacts = async (contacts = []) => {
  let promoted = 0;
  for (const contact of contacts) {
    const rows = await ContactDuplicate.find({ contactId: contact._id });
    for (const row of rows) {
      try {
        const guest = await promoteDuplicateToGuest(row, {
          status: contact.approvalStatus || "pending",
          source: contact,
        });
        if (guest) promoted += 1;
      } catch (error) {
        console.error("Could not turn duplicate into a guest:", error.message);
      }
    }
  }
  return promoted;
};

// Rows whose guest was deleted earlier (before the rule above existed) or is
// now only a history record. Deleted guests -> the submission becomes a
// Pending guest; history-only ones cannot hold a second row, so they are dropped.
const purgeOrphanDuplicates = async () => {
  const contactIds = await ContactDuplicate.distinct("contactId");
  if (!contactIds.length) return 0;

  const existing = await Contact.find({ _id: { $in: contactIds } })
    .select("_id isDeleted historyOnly")
    .lean();
  const byId = new Map(existing.map((c) => [String(c._id), c]));

  let fixed = 0;
  for (const id of contactIds) {
    const guest = byId.get(String(id));
    if (guest && !guest.isDeleted && !guest.historyOnly) continue; // still a real duplicate

    const rows = await ContactDuplicate.find({ contactId: id });
    for (const row of rows) {
      try {
        if (guest) {
          // history-only / soft-deleted record: nothing to merge into
          await ContactDuplicate.deleteOne({ _id: row._id });
        } else {
          await promoteDuplicateToGuest(row, { status: "pending" });
        }
        fixed += 1;
      } catch (error) {
        console.error("Could not clean orphan duplicate:", error.message);
      }
    }
  }
  return fixed;
};

// ================= LIST =================
const getDuplicateCount = async () => {
  await purgeOrphanDuplicates();
  return ContactDuplicate.countDocuments({});
};

const listDuplicates = async (query = {}) => {
  await purgeOrphanDuplicates();
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 10));
  const search = clean(query.search);

  const filter = {};
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: "i" };
    filter.$or = [{ fullName: rx }, { whatsappNumber: rx }, { companyName: rx }, { area: rx }];
  }

  const [rows, total] = await Promise.all([
    ContactDuplicate.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("companyCategory", "name")
      .populate("contactId", "fullName whatsappNumber approvalStatus")
      .lean(),
    ContactDuplicate.countDocuments(filter),
  ]);

  return {
    success: true,
    data: rows,
    pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
};

// ================= FIELDS =================
// Same keys as contactMerge.service FIELDS, so the same names are used everywhere.
const FIELDS = [
  { key: "name", label: "Name", c: (x) => x.fullName, d: (x) => x.fullName, preferLonger: true },
  { key: "companyName", label: "Company Name", c: (x) => x.companyName, d: (x) => x.companyName },
  { key: "designation", label: "Designation", c: (x) => x.designation, d: (x) => x.designation },
  { key: "category", label: "Company Category", c: (x) => x.companyCategory?.name, d: (x) => x.companyCategory?.name },
  { key: "address", label: "Address", c: (x) => x.address, d: (x) => x.address },
  { key: "area", label: "Area", c: (x) => x.area, d: (x) => x.area },
  { key: "instagramId", label: "Instagram", c: (x) => x.instagramId, d: (x) => x.instagramId },
  { key: "email", label: "Email", c: (x) => x.email, d: (x) => x.email },
  { key: "relationship", label: "Relationship", c: (x) => x.relationship, d: (x) => x.relationship },
  { key: "spouseName", label: "Spouse Name", c: (x) => x.spouseName, d: (x) => x.spouseName, spouse: true },
  { key: "spouseMobile", label: "Spouse WhatsApp", c: (x) => x.spouseMobile, d: (x) => x.spouseMobile, spouse: true },
  { key: "spouseInstagramId", label: "Spouse Instagram", c: (x) => x.spouseInstagramId, d: (x) => x.spouseInstagramId, spouse: true },
  { key: "spouseCategory", label: "Spouse Profession", c: (x) => x.professionCategory?.name, d: (x) => x.professionCategory?.name, spouse: true },
];

const joinReferences = (a = [], b = []) => {
  const seen = new Set();
  const out = [];
  for (const value of [...(a || []), ...(b || [])]) {
    const text = clean(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
};

const loadPair = async (duplicateId) => {
  if (!duplicateId || !/^[a-f0-9]{24}$/i.test(String(duplicateId))) {
    throw new AppError("Invalid Duplicate ID", 400);
  }

  const duplicate = await ContactDuplicate.findById(duplicateId)
    .populate("companyCategory", "name")
    .populate("professionCategory", "name");
  if (!duplicate) throw new AppError("This duplicate was not found (maybe already fixed).", 404);

  const contact = await Contact.findOne({
    _id: duplicate.contactId,
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
  })
    .populate("companyCategory", "name")
    .populate("professionCategory", "name");

  // The guest was deleted meanwhile: nothing to merge into.
  if (!contact) {
    throw new AppError("The guest with this number no longer exists. Ignore this duplicate.", 404);
  }

  return { duplicate, contact };
};

// Value that will be kept for one field.
const decide = (field, contactValue, newValue, choice) => {
  const c = clean(contactValue);
  const n = clean(newValue);
  if (c && n && !same(c, n)) {
    const pickNew = choice === "new" || (choice === undefined && field.preferLonger && n.length > c.length);
    return pickNew ? n : c;
  }
  return c || n;
};

// ================= PREVIEW =================
const getDuplicatePreview = async (duplicateId) => {
  const { duplicate, contact } = await loadPair(duplicateId);
  const member = await contactMerge.findMemberForContact(contact);

  const fields = FIELDS.map((f) => {
    const existing = clean(f.c(contact));
    const incoming = clean(f.d(duplicate));
    const conflict = !!existing && !!incoming && !same(existing, incoming);
    const suggested = conflict && f.preferLonger && incoming.length > existing.length ? "new" : "existing";
    return { key: f.key, label: f.label, existing, new: incoming, conflict, suggested };
  }).filter((f) => f.existing || f.new);

  return {
    success: true,
    data: {
      whatsappNumber: duplicate.whatsappNumber,
      submittedAt: duplicate.createdAt,
      existingName: contact.fullName,
      newName: duplicate.fullName,
      hasContactBook: !!member,
      fields,
      references: {
        existing: contact.references || [],
        new: duplicate.references || [],
        merged: joinReferences(contact.references, duplicate.references),
      },
      photos: {
        existing: contact.profileImage || "",
        new: duplicate.profileImage || "",
      },
    },
  };
};

const categoryByName = async (name) => {
  const text = clean(name);
  if (!text) return null;
  return CompanyCategory.findOne({
    isDeleted: { $ne: true },
    name: new RegExp(`^${escapeRegex(text)}$`, "i"),
  })
    .select("_id name")
    .lean();
};

// ================= FIX =================
// choices: { [fieldKey]: "existing" | "new" } - only needed for fields that differ.
const fixDuplicate = async (duplicateId, choices = {}) => {
  const { duplicate, contact } = await loadPair(duplicateId);

  const final = {};
  for (const f of FIELDS) {
    final[f.key] = decide(f, f.c(contact), f.d(duplicate), choices?.[f.key]);
  }

  const isCouple = final.relationship === "Couple";
  if (!isCouple) {
    for (const f of FIELDS) if (f.spouse) final[f.key] = "";
  }

  const category = await categoryByName(final.category);
  const spouseCategory = isCouple ? await categoryByName(final.spouseCategory) : null;

  const set = {
    fullName: final.name,
    companyName: final.companyName,
    designation: final.designation,
    address: final.address,
    area: final.area,
    instagramId: final.instagramId,
    email: final.email,
    relationship: final.relationship || contact.relationship,
    spouseName: final.spouseName,
    spouseMobile: final.spouseMobile,
    spouseInstagramId: final.spouseInstagramId,
    references: joinReferences(contact.references, duplicate.references),
    companyCategory: category?._id || contact.companyCategory?._id || null,
    professionCategory: isCouple ? spouseCategory?._id || contact.professionCategory?._id || null : null,
  };

  // Photos: a new photo is only used where the guest has none (an existing
  // photo is never replaced); the unused file is removed.
  const unusedFiles = [];
  for (const [urlKey, idKey] of [
    ["profileImage", "profileImagePublicId"],
    ["spouseProfileImage", "spouseProfileImagePublicId"],
  ]) {
    if (!duplicate[urlKey]) continue;
    const useIt = !contact[urlKey] && (urlKey === "profileImage" || isCouple);
    if (useIt) {
      set[urlKey] = duplicate[urlKey];
      set[idKey] = duplicate[idKey];
    } else if (duplicate[idKey]) {
      unusedFiles.push(duplicate[idKey]);
    }
  }

  await Contact.updateOne({ _id: contact._id }, { $set: set });
  await ContactDuplicate.deleteOne({ _id: duplicate._id });
  for (const publicId of unusedFiles) await deleteImage(publicId);

  // ---- sync the Contact Book row with the same number (if there is one) ----
  // The Guest List row now holds the chosen values, so every differing field
  // is resolved in favour of it.
  let synced = false;
  try {
    const keepGuestList = Object.fromEntries(contactMerge.MERGE_FIELD_KEYS.map((k) => [k, "contact"]));
    await contactMerge.mergeContactWithMember(contact._id, keepGuestList);
    synced = true;
  } catch (error) {
    // 404 = this number is not in the Contact Book: nothing to sync.
    if (error?.statusCode !== 404 && error?.status !== 404) {
      console.error("Duplicate fix: Contact Book sync failed:", error.message);
    }
  }

  return {
    success: true,
    message: synced
      ? "Fixed. Guest List and Contact Book now hold the same data."
      : "Fixed. Guest List updated (this number is not in the Contact Book).",
    data: { contactId: contact._id, synced },
  };
};

// ================= IGNORE =================
const ignoreDuplicate = async (duplicateId) => {
  if (!duplicateId || !/^[a-f0-9]{24}$/i.test(String(duplicateId))) {
    throw new AppError("Invalid Duplicate ID", 400);
  }
  const duplicate = await ContactDuplicate.findByIdAndDelete(duplicateId);
  if (!duplicate) throw new AppError("This duplicate was not found.", 404);

  if (duplicate.profileImagePublicId) await deleteImage(duplicate.profileImagePublicId);
  if (duplicate.spouseProfileImagePublicId) await deleteImage(duplicate.spouseProfileImagePublicId);

  return { success: true, message: "Duplicate removed." };
};

// ================= BULK (for hundreds of duplicates) =================
const BULK_LIMIT = 5000;

// ids: explicit list, or all:true = every duplicate matching `search`.
const collectIds = async ({ ids, all, search } = {}) => {
  if (all) {
    const text = clean(search);
    const filter = {};
    if (text) {
      const rx = { $regex: escapeRegex(text), $options: "i" };
      filter.$or = [{ fullName: rx }, { whatsappNumber: rx }, { companyName: rx }, { area: rx }];
    }
    const rows = await ContactDuplicate.find(filter).select("_id").limit(BULK_LIMIT).lean();
    return rows.map((r) => String(r._id));
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError("Please select at least one duplicate.", 400);
  }
  return [...new Set(ids.map(String))]
    .filter((id) => /^[a-f0-9]{24}$/i.test(id))
    .slice(0, BULK_LIMIT);
};

// Fix many at once WITHOUT asking field by field: every field that differs
// keeps the Guest List value (a longer name wins), empty fields are filled
// from the form, references are joined, then Guest List + Contact Book are synced.
const bulkFixDuplicates = async (body) => {
  const ids = await collectIds(body);
  let fixed = 0;
  let synced = 0;
  const failed = [];

  for (const id of ids) {
    try {
      const res = await fixDuplicate(id, {});
      fixed += 1;
      if (res.data?.synced) synced += 1;
    } catch (error) {
      failed.push({ id, reason: error.message });
    }
  }

  return {
    success: true,
    message: `${fixed} fixed${synced ? ` (${synced} also synced to Contact Book)` : ""}${
      failed.length ? `, ${failed.length} failed` : ""
    }.`,
    data: { fixed, synced, failed: failed.length, errors: failed.slice(0, 5) },
  };
};

const bulkIgnoreDuplicates = async (body) => {
  const ids = await collectIds(body);
  let removed = 0;
  for (const id of ids) {
    try {
      await ignoreDuplicate(id);
      removed += 1;
    } catch (error) {
      // already gone - nothing to do
    }
  }
  return { success: true, message: `${removed} duplicate${removed === 1 ? "" : "s"} removed.`, data: { removed } };
};

module.exports = {
  bulkFixDuplicates,
  bulkIgnoreDuplicates,
  findGuestByNumber,
  saveDuplicate,
  captureIfDuplicate,
  getDuplicateCount,
  promoteDuplicatesForContacts,
  purgeOrphanDuplicates,
  listDuplicates,
  getDuplicatePreview,
  fixDuplicate,
  ignoreDuplicate,
};