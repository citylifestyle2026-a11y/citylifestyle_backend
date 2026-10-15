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
const contactService = require("./contact.service");
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

const REQUIRED_FIELDS = [
  ["fullName", "fullName"],
  ["whatsappNumber", "whatsappNumber"],
  ["companyName", "companyName"],
  ["designation", "designation"],
  ["companyCategory", "companyCategory"],
  ["area", "area"],
  ["references", "references"],
];

const EMPTY_PLACEHOLDERS = new Set(["", "-", "--", "n/a", "na", "null", "nil"]);

const headerKey = (text) =>
  String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const parseCsvBuffer = async (buffer) => {
  const ExcelJS = require("exceljs");
  const { Readable } = require("stream");

  const workbook = new ExcelJS.Workbook();
  // `map` keeps every cell as exact text so a number like 9.87654E+09 is
  // never silently turned into a valid-looking mobile number.
  const worksheet = await workbook.csv.read(
    Readable.from(buffer.toString("utf-8").replace(/^\uFEFF/, "")),
    { map: (value) => value }
  );

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

const splitReferences = (text) =>
  String(text || "")
    .split(/[|;]/)
    .map((r) => r.trim())
    .filter(Boolean);

// Validates one row and returns { data } ready for createContact, or { error }.
const buildContactFromRow = (raw, resolveCategory) => {
  const fullName = raw.fullName.trim();
  if (!fullName) return { error: "Full Name is required" };

  const whatsappNumber = toLocalMobile(raw.whatsappNumber);
  if (!whatsappNumber) {
    return { error: "Invalid WhatsApp Number (10 digits, with or without 91)", whatsappNumber: raw.whatsappNumber };
  }

  if (!raw.companyName) return { error: "Company Name is required" };
  if (!raw.designation) return { error: "Designation is required" };
  if (!raw.area) return { error: "Area is required" };

  const companyCategory = resolveCategory(raw.companyCategory);
  if (!raw.companyCategory) return { error: "Company Category is required" };
  if (!companyCategory) {
    return { error: `Company Category "${raw.companyCategory}" not found` };
  }

  const references = splitReferences(raw.references);
  if (references.length === 0) {
    return { error: "At least one Reference is required (separate several with | )" };
  }

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
    companyName: raw.companyName,
    designation: raw.designation,
    address: raw.address || "",
    area: raw.area,
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
    if (!raw.spouseName) return { error: "Spouse Name is required for Couple" };

    const spouseMobile = toLocalMobile(raw.spouseMobile);
    if (!raw.spouseMobile) return { error: "Spouse Mobile Number is required for Couple" };
    if (!spouseMobile) {
      return { error: "Invalid Spouse Mobile Number (10 digits, with or without 91)" };
    }

    if (!raw.spouseCategory) return { error: "Spouse Category is required for Couple" };
    const professionCategory = resolveCategory(raw.spouseCategory);
    if (!professionCategory) {
      return { error: `Spouse Category "${raw.spouseCategory}" not found` };
    }

    const spouseInstagramId = normalizeInstagramId(raw.spouseInstagramId);
    if (spouseInstagramId && !isValidInstagramId(spouseInstagramId)) {
      return { error: "Invalid Spouse Instagram ID / link" };
    }

    data.spouseName = raw.spouseName;
    data.spouseMobile = spouseMobile;
    data.spouseInstagramId = spouseInstagramId;
    data.professionCategory = professionCategory;
    // Same as the Create Contact form: profession text = category name.
    data.profession = String(raw.spouseCategory).trim();
  }

  return { data };
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

    // Same number twice in the file, or already saved -> skipped, never merged.
    const existing = seenNumbers.has(data.whatsappNumber)
      ? { fullName: "an earlier row of this file" }
      : await Contact.findOne({
          isDeleted: { $ne: true },
          historyOnly: { $ne: true },
          whatsappNumber: data.whatsappNumber,
        })
          .select("fullName")
          .lean();

    if (existing) {
      results.push({
        ...base,
        success: false,
        duplicate: true,
        error: `Already exists (${existing.fullName})`,
      });
      continue;
    }

    seenNumbers.add(data.whatsappNumber);

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
  const duplicateCount = results.filter((r) => r.duplicate).length;
  const failureCount = results.length - successCount - duplicateCount;

  return {
    dryRun,
    approvalStatus,
    totalRows: results.length,
    successCount,
    duplicateCount,
    failureCount,
    results,
  };
};

module.exports = { importContactsCsv };
