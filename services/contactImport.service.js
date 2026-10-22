// services/contactImport.service.js
//
// Bulk import of contacts from a CSV file (Contact List -> Import CSV).
// Each row goes through the same contactService.createContact the Create
// Contact form uses, so photos-less contacts are saved exactly like a manual
// one. Rows are processed one at a time; a bad row never stops the others.
const mongoose = require("mongoose");
const Contact = require("../models/contact.model");
const CompanyCategory = require("../models/companycategory.model");
const AppError = require("../utils/AppError");
const { toReferenceList } = require("../utils/splitReferences");
const contactService = require("./contact.service");
const deleteImage = require("../utils/deleteLocalFile");
const {
  normalizeInstagramId,
  isValidInstagramId,
} = require("../utils/normalizeInstagramId");
const { normalizeMobileNumber } = require("../utils/normalizeMobileNumber");

const toLocalMobile = (value) => {
  const canonical = normalizeMobileNumber(value);
  return canonical ? canonical.slice(2) : null;
};

// Header text -> internal field. Headers are matched ignoring case, spaces,
// underscores and dashes ("WhatsApp Number" == "whatsapp_number").
const HEADER_ALIASES = {
  fullName: ["fullname", "name"],
  whatsappNumber: ["whatsappnumber", "whatsapp", "mobile", "mobilenumber", "phone"],
  companyName: ["companyname", "company", "brand"],
  designation: ["designation"],
  companyCategory: ["companycategory", "category"],
  area: ["area"],
  address: ["address"],
  instagramId: ["instagramid", "instagram", "instagramlink"],
  email: ["email"],
  relationship: ["relationship"],
  spouseName: ["spousename"],
  spouseMobile: ["spousemobile", "spousemobilenumber"],
  spouseInstagramId: ["spouseinstagramid", "spouseinstagram", "spouseinstagramlink"],
  spouseCategory: ["spousecategory", "professioncategory", "spouseprofessioncategory"],
  references: ["references", "reference"],
};

// Only these two COLUMNS are needed in the file (same as the row rules below
// and the text shown in the Import popup). Every other column is optional.
const REQUIRED_FIELDS = [
  ["fullName", "Full Name"],
  ["whatsappNumber", "WhatsApp Number"],
];

const EMPTY_PLACEHOLDERS = new Set(["", "-", "--", "n/a", "na", "null", "nil"]);

const headerKey = (text) =>
  String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Excel in some regions saves CSV with ";" (or tab) instead of ",". The
// separator is read from the header line (outside quotes).
const detectDelimiter = (text) => {
  const header = String(text).split(/\r?\n/, 1)[0] || "";
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of header) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ",";
};

const parseCsvBuffer = async (buffer) => {
  const ExcelJS = require("exceljs");
  const { Readable } = require("stream");

  const text = buffer.toString("utf-8").replace(/^\uFEFF/, "");

  const workbook = new ExcelJS.Workbook();
  // `map` keeps every cell as exact text so a number like 9.87654E+09 is
  // never silently turned into a valid-looking mobile number.
  const worksheet = await workbook.csv.read(Readable.from(text), {
    map: (value) => value,
    parserOptions: { delimiter: detectDelimiter(text) },
  });

  const rows = [];
  let columnOf = null;

  worksheet.eachRow((row, rowNumber) => {
    const cells = row.values;

    if (rowNumber === 1) {
      const byHeader = {};
      cells.forEach((cell, idx) => {
        if (cell === null || cell === undefined) return;
        const key = headerKey(cell);
        if (key) byHeader[key] = idx;
      });

      columnOf = {};
      Object.entries(HEADER_ALIASES).forEach(([field, aliases]) => {
        const hit = aliases.find((alias) => alias in byHeader);
        if (hit) columnOf[field] = byHeader[hit];
      });
      return;
    }

    if (!columnOf) return;

    const isBlank = cells
      .slice(1)
      .every((v) => v === null || v === undefined || String(v).trim() === "");
    if (isBlank) return;

    const get = (field) => {
      const idx = columnOf[field];
      if (!idx) return "";
      const value = cells[idx];
      if (value === null || value === undefined) return "";
      const raw =
        typeof value === "object"
          ? value.text ?? value.result ?? value.hyperlink ?? ""
          : value;
      const text = String(raw).trim();
      return EMPTY_PLACEHOLDERS.has(text.toLowerCase()) ? "" : text;
    };

    const data = {};
    Object.keys(HEADER_ALIASES).forEach((field) => {
      data[field] = get(field);
    });

    rows.push({ rowNumber, data });
  });

  if (!columnOf) {
    throw new AppError("CSV file is empty or missing a header row", 400);
  }

  const missing = REQUIRED_FIELDS.filter(([field]) => !columnOf[field]).map(
    ([, label]) => label
  );
  if (missing.length > 0) {
    throw new AppError(
      `CSV is missing required column(s): ${missing.join(", ")}`,
      400
    );
  }

  if (rows.length === 0) {
    throw new AppError("CSV file has no data rows", 400);
  }

  return rows;
};

// Category name (or id) -> CompanyCategory _id string, or null.
const buildCategoryResolver = async () => {
  const categories = await CompanyCategory.find({ isDeleted: { $ne: true } })
    .select("name")
    .lean();

  const byName = new Map(
    categories.map((c) => [String(c.name).trim().toLowerCase(), String(c._id)])
  );
  const ids = new Set(categories.map((c) => String(c._id)));

  return (value) => {
    const text = String(value || "").trim();
    if (!text) return null;
    if (ids.has(text)) return text;
    return byName.get(text.toLowerCase()) || null;
  };
};

// "|" or ";" separate references; "&", "/" and "-" also split one value
// into separate names (see utils/splitReferences.js).
const splitReferences = (text) => toReferenceList(String(text || "").split(/[|;]/));

// Validates one row and returns { data } ready for createContact, or { error }.
const buildContactFromRow = (raw, resolveCategory) => {
  const fullName = raw.fullName.trim();
  if (!fullName) return { error: "Full Name is required" };

  const whatsappNumber = toLocalMobile(raw.whatsappNumber);
  if (!whatsappNumber) {
    return { error: "Invalid WhatsApp Number (10 digits, with or without 91)", whatsappNumber: raw.whatsappNumber };
  }

  // In the import ONLY Full Name + WhatsApp Number are required. Company,
  // Designation, Area, Category, Reference and the rest can stay empty (they
  // can be filled by importing the same number again later).
  let companyCategory = null;
  if (raw.companyCategory) {
    companyCategory = resolveCategory(raw.companyCategory);
    if (!companyCategory) {
      return { error: `Company Category "${raw.companyCategory}" not found` };
    }
  }

  const references = splitReferences(raw.references);

  if (raw.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.email)) {
    return { error: "Invalid email address" };
  }

  let relationship = "Single";
  if (raw.relationship) {
    const r = raw.relationship.trim().toLowerCase();
    if (r === "single") relationship = "Single";
    else if (r === "couple") relationship = "Couple";
    else return { error: 'Relationship must be "Single" or "Couple"' };
  }

  const instagramId = normalizeInstagramId(raw.instagramId);
  if (instagramId && !isValidInstagramId(instagramId)) {
    return { error: "Invalid Instagram ID / link" };
  }

  const data = {
    fullName,
    whatsappNumber,
    companyName: raw.companyName || "",
    designation: raw.designation || "",
    address: raw.address || "",
    area: raw.area || "",
    instagramId,
    email: raw.email || "",
    relationship,
    references,
    companyCategory,
    spouseName: "",
    spouseMobile: "",
    spouseInstagramId: "",
    professionCategory: null,
    profession: "",
  };

  if (relationship === "Couple") {
    // Spouse details are optional in the import; a value that IS given
    // must still be valid.
    const spouseMobile = raw.spouseMobile ? toLocalMobile(raw.spouseMobile) : "";
    if (raw.spouseMobile && !spouseMobile) {
      return { error: "Invalid Spouse Mobile Number (10 digits, with or without 91)" };
    }

    let professionCategory = null;
    if (raw.spouseCategory) {
      professionCategory = resolveCategory(raw.spouseCategory);
      if (!professionCategory) {
        return { error: `Spouse Category "${raw.spouseCategory}" not found` };
      }
    }

    const spouseInstagramId = normalizeInstagramId(raw.spouseInstagramId);
    if (spouseInstagramId && !isValidInstagramId(spouseInstagramId)) {
      return { error: "Invalid Spouse Instagram ID / link" };
    }

    data.spouseName = raw.spouseName || "";
    data.spouseMobile = spouseMobile;
    data.spouseInstagramId = spouseInstagramId;
    data.professionCategory = professionCategory;
    // Same as the Create Contact form: profession text = category name.
    data.profession = raw.spouseCategory ? String(raw.spouseCategory).trim() : "";
  }

  return { data };
};

// Same WhatsApp number again -> the saved contact is UPDATED with this row.
//  - Every cell that has a value in the row is written; an EMPTY cell never
//    wipes what the contact already has.
//  - Relationship + spouse details only change when the row has a
//    Relationship value (Single clears the spouse details and photo).
//  - References are ADDED to the contact's existing ones, never replaced.
//  - Approval status, pass and edition details are left alone.
const updateExistingContact = async (contactId, data, raw) => {
  const contact = await Contact.findById(contactId);
  if (!contact) throw new AppError("Contact not found", 404);

  contact.fullName = data.fullName;
  if (raw.companyName) contact.companyName = data.companyName;
  if (raw.designation) contact.designation = data.designation;
  if (raw.area) contact.area = data.area;
  if (data.companyCategory) contact.companyCategory = data.companyCategory;
  if (raw.address) contact.address = data.address;
  if (raw.instagramId) contact.instagramId = data.instagramId;
  if (raw.email) contact.email = data.email;

  if (raw.relationship) {
    contact.relationship = data.relationship;
    if (data.relationship === "Couple") {
      // Only the spouse cells that have a value are written.
      if (raw.spouseName) contact.spouseName = data.spouseName;
      if (raw.spouseMobile) contact.spouseMobile = data.spouseMobile;
      if (raw.spouseInstagramId) contact.spouseInstagramId = data.spouseInstagramId;
      if (data.professionCategory) {
        contact.professionCategory = data.professionCategory;
        contact.profession = data.profession;
      }
    } else {
      const staleSpousePhoto = contact.spouseProfileImagePublicId;
      contact.spouseName = "";
      contact.spouseMobile = "";
      contact.spouseInstagramId = "";
      contact.professionCategory = null;
      contact.profession = "";
      contact.spouseProfileImage = "";
      contact.spouseProfileImagePublicId = "";
      if (staleSpousePhoto) await deleteImage(staleSpousePhoto);
    }
  }

  contact.references = Contact.normalizeReferences([
    ...(contact.references || []),
    ...data.references,
  ]);

  await contact.save();
};

// ================= IMPORT (OR DRY-RUN CHECK) =================
// dryRun = true validates everything and reports duplicates but creates nothing.
const importContactsCsv = async (
  buffer,
  adminId,
  { approvalStatus = "approved", dryRun = false } = {}
) => {
  if (!["approved", "pending"].includes(approvalStatus)) {
    throw new AppError("Import status must be approved or pending.", 400);
  }

  const rows = await parseCsvBuffer(buffer);
  const resolveCategory = await buildCategoryResolver();

  const results = [];
  const seenNumbers = new Set();

  for (const { rowNumber, data: raw } of rows) {
    const base = {
      row: rowNumber,
      name: raw.fullName || "",
      mobileNumber: raw.whatsappNumber || "",
    };

    const built = buildContactFromRow(raw, resolveCategory);
    if (built.error) {
      results.push({ ...base, success: false, duplicate: false, error: built.error });
      continue;
    }

    const { data } = built;
    base.mobileNumber = data.whatsappNumber;

    // Already saved (or repeated earlier in this file) -> update, not skip.
    const existing = await Contact.findOne({
      isDeleted: { $ne: true },
      historyOnly: { $ne: true },
      whatsappNumber: data.whatsappNumber,
    })
      .select("_id")
      .lean();

    const repeatedInFile = seenNumbers.has(data.whatsappNumber);
    seenNumbers.add(data.whatsappNumber);

    if (existing || repeatedInFile) {
      if (dryRun || !existing) {
        results.push({ ...base, success: true, duplicate: false, updated: true });
        continue;
      }

      try {
        await updateExistingContact(existing._id, data, raw);
        results.push({ ...base, success: true, duplicate: false, updated: true });
      } catch (error) {
        results.push({
          ...base,
          success: false,
          duplicate: false,
          error: error.message || "Failed to update contact",
        });
      }
      continue;
    }

    if (dryRun) {
      results.push({ ...base, success: true, duplicate: false });
      continue;
    }

    try {
      await contactService.createContact(data, adminId, {}, { approvalStatus });
      results.push({ ...base, success: true, duplicate: false });
    } catch (error) {
      results.push({
        ...base,
        success: false,
        duplicate: false,
        error: error.message || "Failed to import row",
      });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const updatedCount = results.filter((r) => r.updated && r.success).length;
  const duplicateCount = results.filter((r) => r.duplicate).length;
  const failureCount = results.length - successCount - duplicateCount;

  return {
    dryRun,
    approvalStatus,
    totalRows: results.length,
    successCount,
    updatedCount,
    duplicateCount,
    failureCount,
    results,
  };
};

module.exports = { importContactsCsv };