// services/contactMerge.service.js
//
// "Merge & Sync": a Guest List row (Contact) and a Contact Book row (Member)
// that have the SAME WhatsApp number are merged and the result is written to
// BOTH rows, so they end up identical.
//
//   - field has a value on one side only  -> that value goes to both
//   - same value on both sides            -> nothing to decide
//   - DIFFERENT values (e.g. name "Karan" vs "Karan Patel")
//        -> the admin picks one in the Merge & Sync popup (choices);
//           without a choice: the longer name for Name, the Guest List value
//           for every other field
//   - References of both are joined (case-insensitive, no duplicates)
//   - Photos: when only one side has a photo, the other gets its own COPY
//   - the Guest List row is linked to the member (memberId) and the member
//     gets "In <edition>" when the guest belongs to an edition
//
// Nothing is created or deleted.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Contact = require("../models/contact.model");
const Member = require("../models/member.model");
const CompanyCategory = require("../models/companycategory.model");
const AppError = require("../utils/AppError");
const { normalizeMobileNumber } = require("../utils/normalizeMobileNumber");
const { UPLOAD_ROOT, PUBLIC_BASE_URL } = require("../config/uploadPaths");

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();
const localMobile = (value) => (normalizeMobileNumber(value) || "").slice(2) || clean(value);

const findMemberForContact = async (contact) => {
  const local = (normalizeMobileNumber(contact.whatsappNumber) || "").slice(2);
  if (!local) return null;
  return Member.findOne({ mobile: local, mobileStatus: "valid" });
};

// Fields that are merged. `c` / `m` read the value from each side.
const FIELDS = [
  { key: "name", label: "Name", c: (x) => x.fullName, m: (x) => x.name, preferLonger: true },
  { key: "companyName", label: "Company Name", c: (x) => x.companyName, m: (x) => x.companyName },
  { key: "designation", label: "Designation", c: (x) => x.designation, m: (x) => x.designation },
  { key: "category", label: "Company Category", c: (x) => x.companyCategory?.name, m: (x) => x.profession },
  { key: "address", label: "Address", c: (x) => x.address, m: (x) => x.address },
  { key: "area", label: "Area", c: (x) => x.area, m: (x) => x.area },
  { key: "instagramId", label: "Instagram", c: (x) => x.instagramId, m: (x) => x.instagramId },
  { key: "email", label: "Email", c: (x) => x.email, m: (x) => x.email },
  { key: "relationship", label: "Relationship", c: (x) => x.relationship, m: (x) => x.relationship },
  { key: "spouseName", label: "Spouse Name", c: (x) => x.spouseName, m: (x) => x.spouseName, spouse: true },
  {
    key: "spouseMobile",
    label: "Spouse WhatsApp",
    c: (x) => localMobile(x.spouseMobile),
    m: (x) => localMobile(x.spouseMobile),
    spouse: true,
  },
  { key: "spouseInstagramId", label: "Spouse Instagram", c: (x) => x.spouseInstagramId, m: (x) => x.spouseInstagramId, spouse: true },
  { key: "spouseCategory", label: "Spouse Profession", c: (x) => x.professionCategory?.name, m: (x) => x.spouseProfession, spouse: true },
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

const loadPair = async (contactId) => {
  if (!contactId || !/^[a-f0-9]{24}$/i.test(String(contactId))) {
    throw new AppError("Invalid Contact ID", 400);
  }

  const contact = await Contact.findOne({
    _id: contactId,
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
  })
    .populate("companyCategory", "name")
    .populate("professionCategory", "name");

  if (!contact) throw new AppError("Guest not found", 404);

  const member = await findMemberForContact(contact);
  if (!member) throw new AppError("This number is not in the Contact Book.", 404);

  return { contact, member };
};

// ---- what the Merge & Sync popup shows ----
const getMergePreview = async (contactId) => {
  const { contact, member } = await loadPair(contactId);

  const fields = FIELDS.map((f) => {
    const c = clean(f.c(contact));
    const m = clean(f.m(member));
    const conflict = !!c && !!m && !same(c, m);
    const suggested = conflict && f.preferLonger && m.length > c.length ? "member" : "contact";
    return { key: f.key, label: f.label, contact: c, member: m, conflict, suggested };
  }).filter((f) => f.contact || f.member);

  return {
    success: true,
    data: {
      contactName: contact.fullName,
      memberName: member.name,
      fields,
      references: {
        contact: contact.references || [],
        member: member.references || [],
        merged: joinReferences(contact.references, member.references),
      },
    },
  };
};

// Gives each side its own copy of a photo, so deleting one never breaks the other.
const copyPhoto = async (sourcePublicId) => {
  if (!sourcePublicId) return null;

  const from = path.join(UPLOAD_ROOT, sourcePublicId);
  if (!from.startsWith(UPLOAD_ROOT) || !fs.existsSync(from)) return null;

  const folder = path.posix.dirname(sourcePublicId);
  const ext = path.extname(sourcePublicId);
  const publicId = path.posix.join(
    folder === "." ? "" : folder,
    `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`
  );

  await fs.promises.copyFile(from, path.join(UPLOAD_ROOT, publicId));
  return { publicId, url: `${PUBLIC_BASE_URL}/uploads/${publicId}` };
};

const categoryByName = async (name) => {
  const text = clean(name);
  if (!text) return null;
  return CompanyCategory.findOne({
    isDeleted: { $ne: true },
    name: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  })
    .select("_id name")
    .lean();
};

// choices: { [fieldKey]: "contact" | "member" } - only needed for conflicts.
const mergeContactWithMember = async (contactId, choices = {}) => {
  const { contact, member } = await loadPair(contactId);

  // ---- final value of every field ----
  const final = {};
  for (const f of FIELDS) {
    const c = clean(f.c(contact));
    const m = clean(f.m(member));

    if (c && m && !same(c, m)) {
      const pickMember =
        choices?.[f.key] === "member" ||
        (choices?.[f.key] === undefined && f.preferLonger && m.length > c.length);
      final[f.key] = pickMember ? m : c;
    } else {
      final[f.key] = c || m;
    }
  }

  const isCouple = final.relationship === "Couple";
  if (!isCouple) {
    for (const f of FIELDS) if (f.spouse) final[f.key] = "";
  }

  const references = joinReferences(contact.references, member.references);
  const category = await categoryByName(final.category);
  const spouseCategory = isCouple ? await categoryByName(final.spouseCategory) : null;

  // ---- photos (copied, so each side owns its file) ----
  const contactSet = {};
  const memberSet = {};
  for (const [urlKey, idKey] of [
    ["profileImage", "profileImagePublicId"],
    ["spouseProfileImage", "spouseProfileImagePublicId"],
  ]) {
    if (urlKey === "spouseProfileImage" && !isCouple) continue;

    const contactHas = clean(contact[urlKey]);
    const memberHas = clean(member[urlKey]);

    if (contactHas && !memberHas) {
      const copy = await copyPhoto(contact[idKey]);
      if (copy) Object.assign(memberSet, { [urlKey]: copy.url, [idKey]: copy.publicId });
    } else if (!contactHas && memberHas) {
      const copy = await copyPhoto(member[idKey]);
      if (copy) Object.assign(contactSet, { [urlKey]: copy.url, [idKey]: copy.publicId });
    }
  }

  // ---- write to the Guest List row ----
  Object.assign(contactSet, {
    fullName: final.name,
    companyName: final.companyName,
    designation: final.designation,
    address: final.address,
    area: final.area,
    instagramId: final.instagramId,
    email: final.email,
    references,
    relationship: final.relationship || contact.relationship,
    spouseName: final.spouseName,
    spouseMobile: final.spouseMobile,
    spouseInstagramId: final.spouseInstagramId,
    companyCategory: category?._id || contact.companyCategory?._id || null,
    professionCategory: isCouple ? spouseCategory?._id || contact.professionCategory?._id || null : null,
    memberId: member._id,
  });
  await Contact.updateOne({ _id: contact._id }, { $set: contactSet });

  // ---- write to the Contact Book row ----
  Object.assign(memberSet, {
    name: final.name,
    companyName: final.companyName,
    designation: final.designation,
    address: final.address,
    area: final.area,
    instagramId: final.instagramId,
    email: final.email,
    references,
    relationship: final.relationship || member.relationship,
    spouseName: final.spouseName,
    spouseMobile: final.spouseMobile,
    spouseInstagramId: final.spouseInstagramId,
    profession: category?.name || final.category || member.profession,
    spouseProfession: isCouple ? spouseCategory?.name || final.spouseCategory : "",
  });
  await Member.updateOne({ _id: member._id }, { $set: memberSet });

  // "In <edition>" on the Contact Book, same as after "Move to Guest List".
  if (contact.editionEventId) {
    const already = (member.movedTo || []).some(
      (x) => String(x.eventId) === String(contact.editionEventId)
    );
    if (!already) {
      await Member.updateOne(
        { _id: member._id },
        {
          $push: {
            movedTo: {
              eventId: contact.editionEventId,
              editionName: contact.editionName || "",
              movedAt: new Date(),
            },
          },
        }
      );
    }
  }

  return {
    success: true,
    message: `Merged and synced with Contact Book (${final.name}).`,
    data: { contactId: contact._id, memberId: member._id },
  };
};

// ---- does this Guest List row + Contact Book row still need "Merge & Sync"? ----
// After a merge both rows hold the same values, so the button is hidden until
// something differs again (a field changed on one side, a new reference, a
// photo on one side only, or the guest is not linked / marked "In <edition>").
// `contact` needs companyCategory / professionCategory populated ({ name }).
const needsMerge = (contact, member) => {
  const isCouple = contact.relationship === "Couple" || member.relationship === "Couple";

  for (const f of FIELDS) {
    if (f.spouse && !isCouple) continue;
    const c = clean(f.c(contact));
    const m = clean(f.m(member));
    if (c.toLowerCase() !== m.toLowerCase()) return true;
  }

  const refKey = (list) =>
    [...new Set((list || []).map((r) => clean(r).toLowerCase()).filter(Boolean))].sort().join("|");
  if (refKey(contact.references) !== refKey(member.references)) return true;

  if (!!clean(contact.profileImage) !== !!clean(member.profileImage)) return true;
  if (isCouple && !!clean(contact.spouseProfileImage) !== !!clean(member.spouseProfileImage)) {
    return true;
  }

  if (String(contact.memberId || "") !== String(member._id)) return true;

  if (contact.editionEventId) {
    const marked = (member.movedTo || []).some(
      (x) => String(x.eventId) === String(contact.editionEventId)
    );
    if (!marked) return true;
  }

  return false;
};

module.exports = {
  mergeContactWithMember,
  getMergePreview,
  findMemberForContact,
  needsMerge,
  MERGE_FIELD_KEYS: FIELDS.map((f) => f.key),
};