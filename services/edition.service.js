const mongoose = require("mongoose");
const Edition = require("../models/edition.model");
const AppError = require("../utils/AppError");
const {
  normalizeEditionName,
  assertEditionMatchesEvent,
} = require("../utils/editionEventMatch");

const SORTABLE_FIELDS = ["editionNumber", "year", "name", "status", "createdAt"];

// ================= CREATE EDITION =================
const createEdition = async (data, adminId) => {
  const { name, editionNumber, year, eventDateTime, venue, guestCapacity, status } = data;

  const existingEdition = await Edition.findOne({
    editionNumber,
    isDeleted: { $ne: true },
  }).select("name editionNumber");

  if (existingEdition) {
    throw new AppError(
      `Edition number ${editionNumber} already exists: "${existingEdition.name}".`,
      409
    );
  }

  // Same name (ignoring capitals / spaces) as an existing edition is a duplicate.
  const sameName = await Edition.find({ isDeleted: { $ne: true } })
    .select("name")
    .lean();

  if (sameName.some((e) => normalizeEditionName(e.name) === normalizeEditionName(name))) {
    throw new AppError(`An edition named "${String(name).trim()}" already exists.`, 409);
  }

  // A NEW edition must belong to an event that already exists (same name)
  // and carry that event's date & time.
  await assertEditionMatchesEvent({ name, eventDateTime });

  const edition = await Edition.create({
    name,
    editionNumber,
    year,
    eventDateTime: eventDateTime || null,
    venue: venue || "",
    guestCapacity: guestCapacity || null,
    status: status || "Draft",
    createdBy: adminId,
  });

  return edition;
};

// ================= GET ALL EDITIONS =================
const getAllEditions = async (query) => {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;

  const sortField = SORTABLE_FIELDS.includes(query.sortBy) ? query.sortBy : "editionNumber";
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;

  const filter = { isDeleted: { $ne: true } };
  const search = (query.search || "").trim();

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { venue: { $regex: search, $options: "i" } },
    ];
  }

  if (query.status) {
    filter.status = query.status;
  }

  if (query.year) {
    filter.year = Number(query.year);
  }

  const total = await Edition.countDocuments(filter);

  const editions = await Edition.find(filter)
    .populate("createdBy", "name")
    .sort({ [sortField]: sortOrder })
    .skip((page - 1) * limit)
    .limit(limit);

  return {
    message: editions.length ? "Editions fetched successfully" : "No editions found",
    data: editions,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

// ================= GET EDITION BY ID =================
const getEditionById = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Edition ID", 400);
  }

  const edition = await Edition.findOne({ _id: id, isDeleted: { $ne: true } }).populate(
    "createdBy",
    "name"
  );

  if (!edition) {
    throw new AppError("Edition not found", 404);
  }

  return edition;
};

// ================= UPDATE EDITION =================
const updateEdition = async (id, data) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Edition ID", 400);
  }

  const edition = await Edition.findOne({ _id: id, isDeleted: { $ne: true } });

  if (!edition) {
    throw new AppError("Edition not found", 404);
  }

  if (data.editionNumber && data.editionNumber !== edition.editionNumber) {
    const existingEdition = await Edition.findOne({
      editionNumber: data.editionNumber,
      isDeleted: { $ne: true },
      _id: { $ne: id },
    }).select("name editionNumber");

    if (existingEdition) {
      throw new AppError(
        `Edition number ${data.editionNumber} already exists: "${existingEdition.name}".`,
        409
      );
    }
  }

  const allowedFields = [
    "name",
    "editionNumber",
    "year",
    "eventDateTime",
    "venue",
    "guestCapacity",
    "status",
  ];

  for (const field of allowedFields) {
    if (data[field] !== undefined) {
      edition[field] = data[field];
    }
  }

  await edition.save();

  return edition;
};

// ================= DELETE EDITION (SOFT DELETE) =================
const deleteEdition = async (id, adminId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Edition ID", 400);
  }

  const edition = await Edition.findOne({ _id: id, isDeleted: { $ne: true } });

  if (!edition) {
    throw new AppError("Edition not found", 404);
  }

  edition.isDeleted = true;
  edition.deletedAt = new Date();
  edition.deletedBy = adminId;

  await edition.save();

  return edition;
};

module.exports = {
  createEdition,
  getAllEditions,
  getEditionById,
  updateEdition,
  deleteEdition,
};
