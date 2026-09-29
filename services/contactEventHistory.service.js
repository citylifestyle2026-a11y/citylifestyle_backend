const mongoose = require("mongoose");
const ContactEventHistory = require("../models/contactEventHistory.model");
const Contact = require("../models/contact.model");
const Edition = require("../models/edition.model");
const AppError = require("../utils/AppError");

// ================= CREATE EVENT HISTORY =================
// `adminId` always comes from the authenticated user (req.user.id in
// the controller), never from req.body — same convention already used
// by contactService.createContact / editionService.createEdition.
const createEventHistory = async (data, adminId) => {
  const { contactId, editionId, status, notes } = data;
  const isSpouse = data.isSpouse === true || data.isSpouse === "true";

  await assertContactExists(contactId);
  await assertEditionExists(editionId);

  // A spouse entry is only valid for a Couple contact that actually has
  // a spouse recorded.
  if (isSpouse) {
    const contact = await Contact.findById(contactId).select(
      "relationship spouseName"
    );
    if (contact.relationship !== "Couple" || !contact.spouseName) {
      throw new AppError("This contact has no spouse recorded", 400);
    }
  }

  const history = await ContactEventHistory.create({
    contactId,
    editionId,
    isSpouse,
    status: status || "Invited",
    notes: notes || "",
    createdBy: adminId,
  });

  return populateHistory(history);
};

// ================= GET ALL EVENT HISTORY (ALL CONTACTS) =================
// Powers the standalone Sidebar "Event History" page (not scoped to one
// contact) — every entry, across every contact, with both contactId and
// editionId populated. Supports optional ?contactId=&editionId=&status=
// &page=&limit= filters.
const getAllEventHistory = async (query = {}) => {
  const filter = { isDeleted: { $ne: true } };

  if (query.contactId) {
    if (!mongoose.Types.ObjectId.isValid(query.contactId)) {
      throw new AppError("Invalid Contact ID", 400);
    }
    filter.contactId = query.contactId;
  }

  if (query.editionId) {
    if (!mongoose.Types.ObjectId.isValid(query.editionId)) {
      throw new AppError("Invalid Edition ID", 400);
    }
    filter.editionId = query.editionId;
  }

  if (query.status) {
    filter.status = query.status;
  }

  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;

  const total = await ContactEventHistory.countDocuments(filter);

  const history = await ContactEventHistory.find(filter)
    .populate("contactId", "fullName whatsappNumber spouseName spouseMobile")
    .populate("editionId", "name editionNumber year status")
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);

  return {
    message: history.length
      ? "Event history fetched successfully"
      : "No event history found",
    data: history,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

// ================= GET EVENT HISTORY BY CONTACT =================
// Supports optional ?page=&limit= — omit both to get the full,
// unpaginated timeline (the page's default view), same "pass what you
// need" shape as getAllEditions's own page/limit query params.
const getEventHistoryByContact = async (contactId, query = {}) => {
  await assertContactExists(contactId);

  const filter = { contactId, isDeleted: { $ne: true } };

  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 0; // 0 = no pagination applied below

  const baseQuery = ContactEventHistory.find(filter)
    .populate("editionId", "name editionNumber year status")
    .sort({ createdAt: -1 });

  const total = await ContactEventHistory.countDocuments(filter);

  const history = limit
    ? await baseQuery.skip((page - 1) * limit).limit(limit)
    : await baseQuery;

  return {
    message: history.length
      ? "Event history fetched successfully"
      : "No event history found",
    data: history,
    pagination: {
      total,
      page,
      limit: limit || total,
      totalPages: limit ? Math.max(1, Math.ceil(total / limit)) : 1,
    },
  };
};

// ================= UPDATE EVENT HISTORY =================
// contactId is intentionally never accepted here — an entry always
// stays attached to the contact it was created under; only
// editionId/status/notes (the form's own fields, per this step's
// spec) are editable.
const updateEventHistory = async (id, data) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Event History ID", 400);
  }

  const history = await ContactEventHistory.findOne({
    _id: id,
    isDeleted: { $ne: true },
  });

  if (!history) {
    throw new AppError("Event history entry not found", 404);
  }

  if (data.editionId) {
    await assertEditionExists(data.editionId);
    history.editionId = data.editionId;
  }

  if (data.status !== undefined) {
    history.status = data.status;
  }

  if (data.notes !== undefined) {
    history.notes = data.notes;
  }

  await history.save();

  return populateHistory(history);
};

// ================= DELETE EVENT HISTORY (SOFT DELETE) =================
const deleteEventHistory = async (id, adminId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Event History ID", 400);
  }

  const history = await ContactEventHistory.findOne({
    _id: id,
    isDeleted: { $ne: true },
  });

  if (!history) {
    throw new AppError("Event history entry not found", 404);
  }

  history.isDeleted = true;
  history.deletedAt = new Date();
  history.deletedBy = adminId || null;

  await history.save();

  return history;
};

// ================= HELPERS =================

async function assertContactExists(contactId) {
  if (!mongoose.Types.ObjectId.isValid(contactId)) {
    throw new AppError("Invalid Contact ID", 400);
  }

  const contact = await Contact.findOne({
    _id: contactId,
    isDeleted: { $ne: true },
  }).select("_id");

  if (!contact) {
    throw new AppError("Contact not found", 404);
  }
}

async function assertEditionExists(editionId) {
  if (!mongoose.Types.ObjectId.isValid(editionId)) {
    throw new AppError("Invalid Edition ID", 400);
  }

  const edition = await Edition.findOne({
    _id: editionId,
    isDeleted: { $ne: true },
  }).select("_id");

  if (!edition) {
    throw new AppError("Edition not found", 404);
  }
}

// Re-fetches with the Edition populated the same way the list endpoint
// returns it, so create/update responses match getEventHistoryByContact's
// shape exactly (the frontend can drop either straight into its list
// state without a refetch).
async function populateHistory(history) {
  return ContactEventHistory.findById(history._id).populate(
    "editionId",
    "name editionNumber year status"
  );
}

module.exports = {
  createEventHistory,
  getAllEventHistory,
  getEventHistoryByContact,
  updateEventHistory,
  deleteEventHistory,
};