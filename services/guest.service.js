const mongoose = require("mongoose");
const Guest = require("../models/guest.model");
const AppError = require("../utils/AppError");
const { normalizeMobileSearchTerm } = require("../utils/normalizeMobileNumber");

// Fields the List API is allowed to sort by — same allow-list
// convention as contact.service.js's SORTABLE_FIELDS, so an
// unrecognized `sortBy` can never silently become an unindexed sort.
const SORTABLE_FIELDS = ["fullName", "mobile", "category", "city", "createdAt", "updatedAt"];

// ================= CREATE GUEST =================
// `adminId` always comes from the authenticated admin (req.user.id in
// the controller), same convention as contactService.createContact.
//
// PHASE 1 duplicate rule: mobile is the master identity key (see
// Guest.model.js's partial unique index). A create with a mobile number
// that already belongs to an active guest is rejected with a clear
// error naming the existing guest, rather than throwing mongoose's raw
// duplicate-key error — the smarter "match → link automatically, flag
// possible duplicates by name" nomination flow is Phase 3, layered on
// top of this same guard.
const createGuest = async (data, adminId) => {
  const {
    fullName,
    mobile,
    email,
    companyName,
    designation,
    category,
    city,
    relationship,
    isVip,
    tags,
    notes,
  } = data;

  const existingGuest = await Guest.findOne({
    mobile,
    isDeleted: { $ne: true },
  }).select("fullName mobile");

  if (existingGuest) {
    throw new AppError(
      `A guest with this mobile number already exists: "${existingGuest.fullName}" (${existingGuest.mobile}).`,
      409
    );
  }

  const guest = await Guest.create({
    fullName,
    mobile,
    email: email || "",
    companyName: companyName || "",
    designation: designation || "",
    category: category || "Other",
    city: city || "",
    relationship: relationship || "Single",
    isVip: !!isVip,
    tags: Array.isArray(tags) ? tags : [],
    notes: notes || "",
    createdBy: adminId,
  });

  return guest;
};

// ================= SHARED FILTER/SORT BUILDER =================
// Used by both getAllGuests and (a future) exportGuests, same
// convention as contact.service.js's buildContactQuery.
function buildGuestQuery(query) {
  // A full number typed as "+91 98765 43210" / "919876543210" still
  // finds the 10-digit stored mobile.
  const search = normalizeMobileSearchTerm((query.search || "").trim());

  const sortField = SORTABLE_FIELDS.includes(query.sortBy) ? query.sortBy : "createdAt";
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;

  const filter = { isDeleted: { $ne: true } };

  if (search) {
    filter.$or = [
      { fullName: { $regex: search, $options: "i" } },
      { mobile: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { companyName: { $regex: search, $options: "i" } },
      { city: { $regex: search, $options: "i" } },
    ];
  }

  if (query.category) {
    filter.category = query.category;
  }

  if (query.city) {
    filter.city = { $regex: query.city, $options: "i" };
  }

  if (query.isVip === "true" || query.isVip === "false") {
    filter.isVip = query.isVip === "true";
  }

  return { filter, sortField, sortOrder };
}

// ================= GET ALL GUESTS =================
// Supports: search, sorting, pagination, category/city/isVip filters —
// same response shape convention as contactService.getAllContacts.
const getAllGuests = async (query) => {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;

  const { filter, sortField, sortOrder } = buildGuestQuery(query);

  const total = await Guest.countDocuments(filter);

  const guests = await Guest.find(filter)
    .populate("createdBy", "name")
    .sort({ [sortField]: sortOrder })
    .skip((page - 1) * limit)
    .limit(limit);

  return {
    message: guests.length ? "Guests fetched successfully" : "No guests found",
    data: guests,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

// ================= GET GUEST BY ID =================
const getGuestById = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Guest ID", 400);
  }

  const guest = await Guest.findOne({ _id: id, isDeleted: { $ne: true } }).populate(
    "createdBy",
    "name"
  );

  if (!guest) {
    throw new AppError("Guest not found", 404);
  }

  return guest;
};

// ================= UPDATE GUEST =================
// If `mobile` is being changed, the same "must stay unique among active
// guests" rule from createGuest is re-checked here (excluding the guest
// being updated itself).
const updateGuest = async (id, data) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Guest ID", 400);
  }

  const guest = await Guest.findOne({ _id: id, isDeleted: { $ne: true } });

  if (!guest) {
    throw new AppError("Guest not found", 404);
  }

  if (data.mobile && data.mobile !== guest.mobile) {
    const existingGuest = await Guest.findOne({
      mobile: data.mobile,
      isDeleted: { $ne: true },
      _id: { $ne: id },
    }).select("fullName mobile");

    if (existingGuest) {
      throw new AppError(
        `A guest with this mobile number already exists: "${existingGuest.fullName}" (${existingGuest.mobile}).`,
        409
      );
    }
  }

  const allowedFields = [
    "fullName",
    "mobile",
    "email",
    "companyName",
    "designation",
    "category",
    "city",
    "relationship",
    "isVip",
    "tags",
    "notes",
  ];

  for (const field of allowedFields) {
    if (data[field] !== undefined) {
      guest[field] = data[field];
    }
  }

  await guest.save();

  return guest;
};

// ================= DELETE GUEST (SOFT DELETE) =================
// Same convention as contact/event/booking soft delete — never hard
// removed, since Nominations/GuestEditionHistory/Invitations (later
// phases) point at this guest and must stay resolvable.
const deleteGuest = async (id, adminId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Guest ID", 400);
  }

  const guest = await Guest.findOne({ _id: id, isDeleted: { $ne: true } });

  if (!guest) {
    throw new AppError("Guest not found", 404);
  }

  guest.isDeleted = true;
  guest.deletedAt = new Date();
  guest.deletedBy = adminId;

  await guest.save();

  return guest;
};

module.exports = {
  createGuest,
  getAllGuests,
  getGuestById,
  updateGuest,
  deleteGuest,
};
