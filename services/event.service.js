const mongoose = require("mongoose");
const Event = require("../models/event.model");
const TicketType = require("../models/ticketType.model");
const Booking = require("../models/booking.model");
const BookingTicket = require("../models/bookingTicket.model");
const ContactEventHistory = require("../models/contactEventHistory.model");
const Contact = require("../models/contact.model");
const uploadImage = require("../utils/localUpload.util");
const deleteLocalFile = require("../utils/deleteLocalFile");
const generateEventCode = require("../utils/generateEventCode");

// ================= EVENT EXPIRY STATUS SYNC (NO CRON) =================
// Persists the derived expiry status onto the Event document itself,
// without any scheduler/cron/background job — it is called inline from
// the existing read/update paths below (getEventById, getAllEvents,
// updateEvent), so the stored `status` field self-heals to the correct
// value the next time the event is touched by the app, and the database
// explicitly reflects "Expired" once endDateTime has passed.
//
// Deliberately independent of `isActive`: `isActive` remains a manual
// admin-controlled flag (changed only via changeEventStatus) and is
// never read or written here.
//
// Only issues a write when the stored value actually needs to change,
// so a normal (non-expired) read path costs zero extra writes. Works on
// both a full Mongoose document and a lean object — either way `event`
// is mutated in place so the caller's already-fetched object reflects
// the corrected value immediately, with no second read required.
const syncEventExpiryStatus = async (event) => {
  const expectedStatus =
    event.endDateTime && new Date(event.endDateTime) < new Date()
      ? "Expired"
      : "Active";

  if (event.status === expectedStatus) {
    return event;
  }

  await Event.updateOne({ _id: event._id }, { $set: { status: expectedStatus } });
  event.status = expectedStatus;

  return event;
};

// Create Event
exports.createEvent = async (data, file, adminId) => {
  let imageUrl = "";
  let imagePublicId = "";

  if (file) {
    const uploadedImage = await uploadImage(
      file,
      "event-management/events"
    );

    imageUrl = uploadedImage.url;
    imagePublicId = uploadedImage.public_id;
  }

  // Assigned once, atomically, and never changed afterward — see
  // eventCode's comment in event.model.js.
  const eventCode = await generateEventCode();

  const event = await Event.create({
    title: data.title,
    edition: data.edition,
    description: data.description,
    startDateTime: data.startDateTime,
    endDateTime: data.endDateTime,
    venueName: data.venueName,
    latitude: data.latitude,
    longitude: data.longitude,
    address: data.address,
    termsConditions: data.termsConditions,
    videoLinks: data.videoLinks ? JSON.parse(data.videoLinks) : [],
    image: imageUrl,
    imagePublicId: imagePublicId,
    createdBy: adminId || null,
    eventCode,
    // Written explicitly (not left to the schema default alone) so every
    // new event is guaranteed to have this field stored in MongoDB from
    // the moment it's created, regardless of the schema default.
    isDeleted: false,
  });

  return event;
};

// ================= GET OR CREATE EVENT CODE (LEGACY BACKFILL) =================
// Only relevant for events created before the eventCode field existed.
// Every event created via createEvent() above already has one. Called
// from bookingService.createBooking right before generating that
// booking's number, so a legacy event's code is assigned lazily, exactly
// once, the first time someone books it after this change is deployed.
//
// Concurrency-safe: if two bookings for the same legacy event are being
// created at the same moment, both may generate a candidate code, but
// only one findOneAndUpdate can match `eventCode: { $exists: false }` and
// actually persist it — the loser simply re-reads whichever code won and
// uses that instead, so the event can never end up stamped with two
// different codes. `eventDoc` is a Mongoose document from within the
// caller's transaction; passing the same `session` keeps this update
// inside that same transaction.
exports.getOrCreateEventCode = async (eventDoc, session) => {
  if (eventDoc.eventCode) {
    return eventDoc.eventCode;
  }

  const candidateCode = await generateEventCode(session);

  const updated = await Event.findOneAndUpdate(
    { _id: eventDoc._id, eventCode: { $exists: false } },
    { $set: { eventCode: candidateCode } },
    { new: true, session }
  );

  if (updated) {
    eventDoc.eventCode = updated.eventCode;
    return updated.eventCode;
  }

  // Someone else won the race between our read and this update — use
  // the code they set instead of the one we generated (which is simply
  // left unused, same as any other rolled-back counter increment).
  const existing = await Event.findById(eventDoc._id)
    .select("eventCode")
    .session(session);

  eventDoc.eventCode = existing.eventCode;
  return existing.eventCode;
};

// Get Event By Id
exports.getEventById = async (id) => {
  const event = await Event.findOne({ _id: id, isDeleted: { $ne: true } })
    .populate("createdBy", "name")
    .lean();

  if (!event) {
    return null;
  }

  await syncEventExpiryStatus(event);

  const tickets = await TicketType.find(
    { eventId: id, isDeleted: false },
    { ticketName: 1, _id: 0 }
  );

  return {
    ...event,
    ticketTypes: tickets.map((ticket) => ticket.ticketName),
  };
};

// Get All Events
exports.getAllEvents = async (query) => {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;
  const search = query.search || "";

  const filter = { isDeleted: { $ne: true } };

  if (search) {
    filter.title = {
      $regex: search,
      $options: "i",
    };
  }

  const total = await Event.countDocuments(filter);

  const events = await Event.find(filter)
    .populate("createdBy", "name")
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);

  // Self-heals each event's persisted `status` before returning — see
  // syncEventExpiryStatus. Does not touch isActive.
  await Promise.all(events.map((event) => syncEventExpiryStatus(event)));

  return {
    success: true,
    message: "Events fetched successfully.",
    data: events,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// Update Event
exports.updateEvent = async (id, data, file) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new Error("Invalid Event ID");
  }

  const event = await Event.findOne({ _id: id, isDeleted: { $ne: true } });

  if (!event) {
    throw new Error("Event not found");
  }

  let imageUrl = event.image;
  let imagePublicId = event.imagePublicId;

  if (file) {
    const uploadedImage = await uploadImage(
      file,
      "event-management/events"
    );

    imageUrl = uploadedImage.url;
    imagePublicId = uploadedImage.public_id;
  }

  // isActive is intentionally left untouched here — it is only ever
  // changed through changeEventStatus. This guarantees that editing an
  // event that is already expired/inactive can never flip it back to
  // Active as a side effect of the update.
  const updatedEvent = await Event.findByIdAndUpdate(
    id,
    {
      title: data.title,
      edition: data.edition !== undefined ? data.edition : event.edition,
      description: data.description,
      startDateTime: data.startDateTime,
      endDateTime: data.endDateTime,
      venueName: data.venueName,
      latitude: data.latitude,
      longitude: data.longitude,
      address: data.address,
      termsConditions: data.termsConditions,
      videoLinks: data.videoLinks
        ? JSON.parse(data.videoLinks)
        : event.videoLinks,
      image: imageUrl,
      imagePublicId: imagePublicId,
    },
    {
      new: true,
      runValidators: true,
    }
  ).populate("createdBy", "name");

  // endDateTime may have just changed (earlier or later), so re-resolve
  // and persist the correct expiry status immediately rather than
  // waiting for the next read.
  await syncEventExpiryStatus(updatedEvent);

  return updatedEvent;
};

// Delete Event
// ================= MANUAL EVENT DELETE (HARD DELETE CASCADE) =================
// This only ever runs when an Admin explicitly deletes an Event (this
// function is only called from eventController.deleteEvent). Everything
// that belongs to the event goes with it:
//
//   Database (one all-or-nothing transaction):
//     - BookingTickets, Bookings, TicketTypes and the Event itself
//       (hard delete)
//     - the event's Event History rows (soft delete, same as the Event
//       History page's own Delete — they could no longer show an edition)
//   Server disk (after the transaction has committed, best-effort):
//     - every ticket's QR image, ticket PDF and attendee/registration photo
//     - the event's banner image
//   Afterwards:
//     - hidden "history only" contacts (created by Add to History) that no
//       longer have any history are soft-deleted too.
//
// Files are removed only AFTER the database commit, so a failed
// transaction can never leave tickets pointing at deleted files. A file that
// can't be removed is logged and skipped — it never fails the delete.
exports.deleteEvent = async (id, adminId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new Error("Invalid Event ID");
  }

  const event = await Event.findOne({ _id: id, isDeleted: { $ne: true } });

  if (!event) {
    throw new Error("Event not found");
  }

  // ---- 1. collect every file this event owns (before the rows vanish) ----
  const tickets = await BookingTicket.find({ eventId: id })
    .select("qrImagePublicId ticketPdfPublicId attendee.profileImagePublicId")
    .lean();

  const filesToDelete = new Set();
  const addFile = (publicId) => {
    if (publicId && typeof publicId === "string") filesToDelete.add(publicId);
  };

  addFile(event.imagePublicId);
  for (const ticket of tickets) {
    addFile(ticket.qrImagePublicId);
    addFile(ticket.ticketPdfPublicId);
    addFile(ticket.attendee?.profileImagePublicId);
  }

  // Contacts that have history rows for this event (to tidy up afterwards).
  const historyContactIds = await ContactEventHistory.distinct("contactId", {
    eventId: id,
    isDeleted: { $ne: true },
  });

  // ---- 2. database cascade, all-or-nothing ----
  const session = await mongoose.startSession();
  let historyRowsRemoved = 0;

  try {
    session.startTransaction();

    await BookingTicket.deleteMany({ eventId: id }, { session });
    await Booking.deleteMany({ eventId: id }, { session });
    await TicketType.deleteMany({ eventId: id }, { session });

    const historyResult = await ContactEventHistory.updateMany(
      { eventId: id, isDeleted: { $ne: true } },
      { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: adminId || null } },
      { session }
    );
    historyRowsRemoved = historyResult.modifiedCount || 0;

    await Event.deleteOne({ _id: id }, { session });

    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }

  // ---- 3. the database is final — now remove the files from disk ----
  let filesRemoved = 0;

  try {
    // Never delete a file another record still points to (safety net —
    // normally every file belongs to exactly one ticket / event).
    const ids = [...filesToDelete];
    if (ids.length > 0) {
      const [stillUsedByTickets, stillUsedByEvents] = await Promise.all([
        BookingTicket.find({
          $or: [
            { qrImagePublicId: { $in: ids } },
            { ticketPdfPublicId: { $in: ids } },
            { "attendee.profileImagePublicId": { $in: ids } },
          ],
        })
          .select("qrImagePublicId ticketPdfPublicId attendee.profileImagePublicId")
          .lean(),
        Event.find({ imagePublicId: { $in: ids } }).select("imagePublicId").lean(),
      ]);

      for (const t of stillUsedByTickets) {
        filesToDelete.delete(t.qrImagePublicId);
        filesToDelete.delete(t.ticketPdfPublicId);
        filesToDelete.delete(t.attendee?.profileImagePublicId);
      }
      for (const e of stillUsedByEvents) filesToDelete.delete(e.imagePublicId);
    }

    const results = await Promise.allSettled(
      [...filesToDelete].map((publicId) => deleteLocalFile(publicId))
    );
    filesRemoved = results.filter((r) => r.status === "fulfilled").length;
  } catch (error) {
    // Best-effort only: the event is already deleted.
    console.error("Event delete: file cleanup failed:", error.message);
  }

  // ---- 4. drop hidden history-only contacts that now have no history ----
  try {
    if (historyContactIds.length > 0) {
      const stillHaveHistory = await ContactEventHistory.distinct("contactId", {
        contactId: { $in: historyContactIds },
        isDeleted: { $ne: true },
      });

      const orphanIds = historyContactIds.filter(
        (cid) => !stillHaveHistory.some((x) => String(x) === String(cid))
      );

      if (orphanIds.length > 0) {
        await Contact.updateMany(
          { _id: { $in: orphanIds }, historyOnly: true, isDeleted: { $ne: true } },
          { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: adminId || null } }
        );
      }
    }
  } catch (error) {
    console.error("Event delete: history contact cleanup failed:", error.message);
  }

  return {
    success: true,
    message: "Event deleted successfully.",
    data: { filesRemoved, historyRowsRemoved },
  };
};

// Change Event Status
exports.changeEventStatus = async (id) => {
  const event = await Event.findOne({ _id: id, isDeleted: { $ne: true } });

  if (!event) {
    throw new Error("Event not found");
  }

  const updatedEvent = await Event.findByIdAndUpdate(
    id,
    {
      isActive: !event.isActive,
    },
    {
      new: true,
      runValidators: false,
    }
  ).populate("createdBy", "name");

  await syncEventExpiryStatus(updatedEvent);

  return {
    success: true,
    message: "Event status updated successfully.",
    data: updatedEvent,
  };
};