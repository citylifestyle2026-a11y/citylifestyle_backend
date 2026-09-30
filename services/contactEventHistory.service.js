const mongoose = require("mongoose");
const ContactEventHistory = require("../models/contactEventHistory.model");
const Contact = require("../models/contact.model");
const Event = require("../models/event.model");
const AppError = require("../utils/AppError");
const { normalizeMobileSearchTerm } = require("../utils/normalizeMobileNumber");

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ================= CREATE EVENT HISTORY =================
// `adminId` always comes from the authenticated user (req.user.id in
// the controller), never from req.body — same convention already used
// by contactService.createContact.
const createEventHistory = async (data, adminId) => {
  const { contactId, eventId, status, notes } = data;
  const isSpouse = data.isSpouse === true || data.isSpouse === "true";

  await assertContactExists(contactId);
  await assertEventExists(eventId);

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
    eventId,
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
// eventId populated. Supports optional ?contactId=&eventId=&status=
// &page=&limit=&search= filters.
//
// `search` (case-insensitive, partial) matches the PERSON of a row and the
// edition:
//   - a normal row  -> the contact's fullName / whatsappNumber
//   - a spouse row  -> the contact's spouseName / spouseMobile
//   - any row       -> the event's edition / title (e.g. "Parv 5")
// A full number typed with +91 / spaces ("+91 98765 43210") still matches.
const getAllEventHistory = async (query = {}) => {
  const filter = { isDeleted: { $ne: true } };

  if (query.contactId) {
    if (!mongoose.Types.ObjectId.isValid(query.contactId)) {
      throw new AppError("Invalid Contact ID", 400);
    }
    filter.contactId = query.contactId;
  }

  if (query.eventId) {
    if (!mongoose.Types.ObjectId.isValid(query.eventId)) {
      throw new AppError("Invalid Event ID", 400);
    }
    filter.eventId = query.eventId;
  }

  if (query.status) {
    filter.status = query.status;
  }

  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;

  // One ROW per person (same contact + same isSpouse flag => same mobile
  // number), carrying ALL of that person's events inside `entries`.
  // Grouping happens in the database so pagination counts people, not
  // individual (contact, event) entries.
  const toObjectId = (v) => new mongoose.Types.ObjectId(v);
  const matchStage = { ...filter };
  if (matchStage.contactId) matchStage.contactId = toObjectId(matchStage.contactId);
  if (matchStage.eventId) matchStage.eventId = toObjectId(matchStage.eventId);

  // ---- search ----
  const searchText = String(query.search || "").trim();

  if (searchText) {
    const pattern = new RegExp(
      escapeRegex(normalizeMobileSearchTerm(searchText)),
      "i"
    );

    const [mainContacts, spouseContacts, matchedEvents] = await Promise.all([
      Contact.find({
        isDeleted: { $ne: true },
        $or: [{ fullName: pattern }, { whatsappNumber: pattern }],
      })
        .select("_id")
        .lean(),
      Contact.find({
        isDeleted: { $ne: true },
        $or: [{ spouseName: pattern }, { spouseMobile: pattern }],
      })
        .select("_id")
        .lean(),
      Event.find({
        isDeleted: { $ne: true },
        $or: [{ edition: pattern }, { title: pattern }],
      })
        .select("_id")
        .lean(),
    ]);

    matchStage.$and = [
      {
        $or: [
          {
            contactId: { $in: mainContacts.map((c) => c._id) },
            isSpouse: { $ne: true },
          },
          {
            contactId: { $in: spouseContacts.map((c) => c._id) },
            isSpouse: true,
          },
          { eventId: { $in: matchedEvents.map((e) => e._id) } },
        ],
      },
    ];
  }

  const [agg] = await ContactEventHistory.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: { contactId: "$contactId", isSpouse: { $ifNull: ["$isSpouse", false] } },
        latest: { $max: "$createdAt" },
        entryIds: { $push: "$_id" },
      },
    },
    { $sort: { latest: -1, "_id.contactId": 1 } },
    {
      $facet: {
        meta: [{ $count: "total" }],
        rows: [{ $skip: (page - 1) * limit }, { $limit: limit }],
      },
    },
  ]);

  const total = agg?.meta?.[0]?.total || 0;
  const groups = agg?.rows || [];

  const allIds = groups.flatMap((g) => g.entryIds);
  const entries = allIds.length
    ? await ContactEventHistory.find({ _id: { $in: allIds } })
        .populate("contactId", "fullName whatsappNumber spouseName spouseMobile")
        .populate("eventId", "title edition startDateTime endDateTime venueName status")
    : [];

  const entryById = new Map(entries.map((e) => [String(e._id), e]));

  const history = groups.map((g) => {
    const groupEntries = g.entryIds
      .map((id) => entryById.get(String(id)))
      .filter(Boolean)
      // oldest event first (by event date)
      .sort(
        (x, y) =>
          new Date(x.eventId?.startDateTime || 0) - new Date(y.eventId?.startDateTime || 0) ||
          new Date(x.createdAt) - new Date(y.createdAt)
      );

    const first = groupEntries[0];
    return {
      _id: `${g._id.contactId}:${g._id.isSpouse ? "spouse" : "main"}`,
      contactId: first?.contactId || null,
      isSpouse: g._id.isSpouse,
      createdAt: g.latest,
      entries: groupEntries.map((e) => ({
        _id: e._id,
        eventId: e.eventId,
        status: e.status,
        notes: e.notes,
        source: e.source || "manual",
        createdAt: e.createdAt,
      })),
    };
  });

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
// need" shape as getAllEvents's own page/limit query params.
const getEventHistoryByContact = async (contactId, query = {}) => {
  await assertContactExists(contactId);

  const filter = { contactId, isDeleted: { $ne: true } };

  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 0; // 0 = no pagination applied below

  const baseQuery = ContactEventHistory.find(filter)
    .populate("eventId", "title edition startDateTime endDateTime venueName status")
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
// eventId/status/notes (the form's own fields, per this step's
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

  if (data.eventId) {
    await assertEventExists(data.eventId);
    history.eventId = data.eventId;
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

async function assertEventExists(eventId) {
  if (!mongoose.Types.ObjectId.isValid(eventId)) {
    throw new AppError("Invalid Event ID", 400);
  }

  const event = await Event.findOne({
    _id: eventId,
    isDeleted: { $ne: true },
  }).select("_id");

  if (!event) {
    throw new AppError("Event not found", 404);
  }
}

// Re-fetches with the Event populated the same way the list endpoint
// returns it, so create/update responses match getEventHistoryByContact's
// shape exactly (the frontend can drop either straight into its list
// state without a refetch).
async function populateHistory(history) {
  return ContactEventHistory.findById(history._id).populate(
    "eventId",
    "title edition startDateTime endDateTime venueName status"
  );
}

module.exports = {
  createEventHistory,
  getAllEventHistory,
  getEventHistoryByContact,
  updateEventHistory,
  deleteEventHistory,
};