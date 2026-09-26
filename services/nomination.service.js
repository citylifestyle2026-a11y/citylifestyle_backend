const mongoose = require("mongoose");
const Guest = require("../models/guest.model");
const Edition = require("../models/edition.model");
const Nomination = require("../models/nomination.model");
const AppError = require("../utils/AppError");
const { findSimilarGuests } = require("../utils/nameSimilarity");

const SORTABLE_FIELDS = ["createdAt", "status"];

const POPULATE_GUEST = "guestId";
const POPULATE_EDITION = { path: "editionId", select: "name editionNumber year status" };
const POPULATE_COORDINATOR = { path: "coordinatorId", select: "name mobile email" };

// ================= CREATE NOMINATION =================
// `coordinator` is the authenticated req.user (a User document with
// role:"coordinator", or an Admin nominating on a coordinator's behalf).
//
// Phase 3 matching cascade (doc section 4, "Matching priority"), run in
// this exact order — the first one that hits decides the outcome, the
// rest are never checked:
//   1/2. Exact mobile match      -> link to that Guest, status "Nominated"
//     3. Exact email match       -> link to that Guest, status "Nominated"
//     4. Name-similarity match   -> create a NEW Guest, status
//                                   "Possible Duplicate", candidates
//                                   recorded on possibleDuplicateGuestIds
//        No match at all         -> create a NEW Guest, status "Nominated"
//
// A name-similarity hit deliberately still creates a NEW Guest rather
// than auto-linking to the similar one — two different people can share
// a very similar name, so only a human admin should decide whether to
// merge them (Phase 4); the nomination flow's job is only to flag it.
const createNomination = async (coordinator, data) => {
  const {
    editionId,
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

  if (!mongoose.Types.ObjectId.isValid(editionId)) {
    throw new AppError("Invalid Edition ID", 400);
  }

  const edition = await Edition.findOne({ _id: editionId, isDeleted: { $ne: true } });

  if (!edition) {
    throw new AppError("Edition not found", 404);
  }

  const normalizedEmail = email?.trim().toLowerCase() || "";

  // ================= STEP 1/2: EXACT MOBILE MATCH (priority #1/#2) =================
  let guest = await Guest.findOne({ mobile, isDeleted: { $ne: true } });
  let matchType;
  let status = "Nominated";
  let possibleDuplicateGuestIds = [];

  if (guest) {
    matchType = "Existing";
  } else if (
    // ================= STEP 3: EXACT EMAIL MATCH (priority #3) =================
    normalizedEmail &&
    (guest = await Guest.findOne({ email: normalizedEmail, isDeleted: { $ne: true } }))
  ) {
    matchType = "Existing";
  } else {
    // ================= STEP 4: NAME-SIMILARITY MATCH (priority #4) =================
    // Only the fields needed for scoring are fetched — the guest list
    // this scans could be a few thousand rows, so keep each row light.
    const activeGuests = await Guest.find({ isDeleted: { $ne: true } }).select("fullName");

    const similarMatches = findSimilarGuests(fullName, activeGuests);

    if (similarMatches.length > 0) {
      status = "Possible Duplicate";
      possibleDuplicateGuestIds = similarMatches.map((match) => ({
        guestId: match.guest._id,
        score: match.score,
      }));
    }

    // Created via a Coordinator's nomination, not directly by an Admin —
    // Guest.createdBy references the Admin collection specifically, so
    // it is left unset here (same default every admin-less Guest
    // already gets) rather than pointing it at a Coordinator's User
    // document, which Guest.createdBy's `ref: "Admin"` does not cover.
    guest = await Guest.create({
      fullName,
      mobile,
      email: normalizedEmail,
      companyName: companyName || "",
      designation: designation || "",
      category: category || "Other",
      city: city || "",
      relationship: relationship || "Single",
      isVip: !!isVip,
      tags: Array.isArray(tags) ? tags : [],
      notes: notes || "",
    });
    matchType = "New";
  }

  const existingNomination = await Nomination.findOne({
    coordinatorId: coordinator._id,
    guestId: guest._id,
    editionId,
    isDeleted: { $ne: true },
  });

  if (existingNomination) {
    throw new AppError(
      `You have already nominated "${guest.fullName}" for this edition.`,
      409
    );
  }

  const nomination = await Nomination.create({
    guestId: guest._id,
    coordinatorId: coordinator._id,
    editionId,
    matchType,
    status,
    possibleDuplicateGuestIds,
    notes: notes || "",
  });

  return Nomination.findById(nomination._id)
    .populate(POPULATE_GUEST)
    .populate(POPULATE_EDITION)
    .populate(POPULATE_COORDINATOR)
    .populate({ path: "possibleDuplicateGuestIds.guestId", select: "fullName mobile email" });
};

// ================= GET ALL NOMINATIONS =================
// RBAC scoping (doc section 2, Coordinator access): a Coordinator only
// ever sees their OWN nominations, regardless of any coordinatorId
// passed in the query string — the filter is forced server-side, never
// trusted from the request. An Admin sees everything and may optionally
// narrow by coordinatorId/editionId/status.
const getAllNominations = async (query, requestingUser) => {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;

  const sortField = SORTABLE_FIELDS.includes(query.sortBy) ? query.sortBy : "createdAt";
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;

  const filter = { isDeleted: { $ne: true } };

  if (requestingUser.role === "coordinator") {
    filter.coordinatorId = requestingUser._id;
  } else if (query.coordinatorId && mongoose.Types.ObjectId.isValid(query.coordinatorId)) {
    filter.coordinatorId = query.coordinatorId;
  }

  if (query.editionId && mongoose.Types.ObjectId.isValid(query.editionId)) {
    filter.editionId = query.editionId;
  }

  if (query.status) {
    filter.status = query.status;
  }

  const total = await Nomination.countDocuments(filter);

  const nominations = await Nomination.find(filter)
    .populate(POPULATE_GUEST)
    .populate(POPULATE_EDITION)
    .populate(POPULATE_COORDINATOR)
    .populate({ path: "possibleDuplicateGuestIds.guestId", select: "fullName mobile email" })
    .sort({ [sortField]: sortOrder })
    .skip((page - 1) * limit)
    .limit(limit);

  return {
    message: nominations.length ? "Nominations fetched successfully" : "No nominations found",
    data: nominations,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

// ================= GET NOMINATION BY ID =================
// Same ownership rule as getAllNominations, enforced here too since a
// Coordinator could otherwise guess another coordinator's nomination id.
const getNominationById = async (id, requestingUser) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Nomination ID", 400);
  }

  const nomination = await Nomination.findOne({ _id: id, isDeleted: { $ne: true } })
    .populate(POPULATE_GUEST)
    .populate(POPULATE_EDITION)
    .populate(POPULATE_COORDINATOR)
    .populate({ path: "possibleDuplicateGuestIds.guestId", select: "fullName mobile email" });

  if (!nomination) {
    throw new AppError("Nomination not found", 404);
  }

  if (
    requestingUser.role === "coordinator" &&
    String(nomination.coordinatorId._id) !== String(requestingUser._id)
  ) {
    throw new AppError("You are not authorized to view this nomination", 403);
  }

  return nomination;
};

module.exports = {
  createNomination,
  getAllNominations,
  getNominationById,
};
