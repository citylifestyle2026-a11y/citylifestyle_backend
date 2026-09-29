// services/eventHistorySync.service.js
//
// Entry Report -> "Add to Event History".
//
// For ONE event (e.g. "Parv 5") this saves, in one go, into
// ContactEventHistory:
//   - every SELECTED scanned person   -> status "Attended"      (green)
//   - every person who BOOKED but was never scanned
//                                      -> status "Not Attended" (red)
//
// Rows point straight at the Event. People are matched by their
// 10-digit mobile number; a Contact is created when the number is new.
// Running it again is safe: an existing (contact, event) row is updated,
// never duplicated. A new number gets a hidden "historyOnly" Contact (the
// history row needs a person to point at) — it is NOT listed in Contact List.
const mongoose = require("mongoose");
const BookingTicket = require("../models/bookingTicket.model");
const Booking = require("../models/booking.model");
const Event = require("../models/event.model");
const Contact = require("../models/contact.model");
const ContactEventHistory = require("../models/contactEventHistory.model");
const AppError = require("../utils/AppError");
const { toLocalMobileNumber } = require("../utils/normalizeMobileNumber");

const SOURCE = "entry-report";

// ================= EVENT =================
const loadEvent = async (eventId) => {
  if (!mongoose.Types.ObjectId.isValid(eventId)) {
    throw new AppError("Invalid Event ID", 400);
  }

  const event = await Event.findOne({ _id: eventId, isDeleted: { $ne: true } })
    .select("title startDateTime venueName")
    .lean();

  if (!event) {
    throw new AppError("Event not found", 404);
  }

  return event;
};

// ================= PEOPLE OF AN EVENT =================
// A ticket's person is its registered attendee when there is one,
// otherwise the booking holder. Identified by 10-digit mobile number.
const loadEventPeople = async (eventId) => {
  const tickets = await BookingTicket.find({
    eventId,
    status: { $ne: "Cancelled" },
  })
    .select("bookingId status attendee.name attendee.mobileNumber")
    .lean();

  const bookingIds = [...new Set(tickets.map((t) => String(t.bookingId)))];

  const bookings = await Booking.find({
    _id: { $in: bookingIds },
    isDeleted: { $ne: true },
    bookingStatus: { $ne: "Cancelled" },
  })
    .select("name mobileNumber")
    .lean();

  const bookingById = new Map(bookings.map((b) => [String(b._id), b]));

  const personByTicket = new Map(); // ticketId -> { key, name, used }
  const registered = new Map(); // key -> name   (everyone who booked)
  const usedKeys = new Set(); // keys with at least one scanned ticket
  let skippedInvalid = 0;

  for (const ticket of tickets) {
    const booking = bookingById.get(String(ticket.bookingId));
    if (!booking) continue;

    const attendeeKey = toLocalMobileNumber(ticket.attendee?.mobileNumber);
    const key = attendeeKey || toLocalMobileNumber(booking.mobileNumber);

    if (!key) {
      skippedInvalid += 1;
      continue;
    }

    const name =
      (attendeeKey ? ticket.attendee?.name : booking.name) || booking.name || "";
    const used = ticket.status === "Used";

    personByTicket.set(String(ticket._id), { key, name, used });

    if (!registered.has(key) || (!registered.get(key) && name)) {
      registered.set(key, name);
    }

    if (used) usedKeys.add(key);
  }

  return { personByTicket, registered, usedKeys, skippedInvalid };
};

// ================= SUMMARY (for the confirmation popup) =================
const getSyncSummary = async (eventId) => {
  const event = await loadEvent(eventId);
  const { registered, usedKeys, skippedInvalid } = await loadEventPeople(event._id);

  return {
    event: { _id: event._id, title: event.title, startDateTime: event.startDateTime },
    registeredCount: registered.size,
    enteredCount: usedKeys.size,
    notEnteredCount: registered.size - [...registered.keys()].filter((k) => usedKeys.has(k)).length,
    skippedInvalid,
  };
};

// ================= SYNC =================
// data: { eventId, ticketIds?: [BookingTicket _id], selectAll?: boolean }
//   - ticketIds : the ticked rows of the Entry Report (scanned tickets)
//   - selectAll : every scanned ticket of the event (the "select all N
//                 entries" option, across all pages)
const syncFromEvent = async (data, adminId) => {
  const { eventId } = data;
  const selectAll = data.selectAll === true || data.selectAll === "true";
  const ticketIds = Array.isArray(data.ticketIds) ? data.ticketIds.map(String) : [];

  if (!selectAll && ticketIds.length === 0) {
    throw new AppError("Please select at least one entry", 400);
  }

  const event = await loadEvent(eventId);
  const { personByTicket, registered, usedKeys, skippedInvalid } =
    await loadEventPeople(event._id);

  // ---- who attended (the selected, scanned tickets) ----
  const attended = new Map(); // key -> name
  let ignoredSelections = 0;

  const addAttended = (person) => {
    if (!attended.has(person.key) || (!attended.get(person.key) && person.name)) {
      attended.set(person.key, person.name);
    }
  };

  if (selectAll) {
    for (const person of personByTicket.values()) {
      if (person.used) addAttended(person);
    }
  } else {
    for (const id of new Set(ticketIds)) {
      const person = personByTicket.get(id);
      if (person && person.used) addAttended(person);
      else ignoredSelections += 1;
    }
  }

  if (attended.size === 0) {
    throw new AppError("None of the selected entries could be added", 400);
  }

  // ---- who did not attend: booked, but no scanned ticket at all ----
  const notAttended = new Map();
  for (const [key, name] of registered) {
    if (!usedKeys.has(key)) notAttended.set(key, name);
  }

  // ---- contacts (matched by mobile number, created when new) ----
  const allKeys = [...attended.keys(), ...notAttended.keys()];

  const loadContacts = async () => {
    const found = await Contact.find({
      isDeleted: { $ne: true },
      whatsappNumber: { $in: [...allKeys, ...allKeys.map((k) => `91${k}`)] },
    })
      .select("_id whatsappNumber")
      .lean();

    const map = new Map();
    for (const contact of found) {
      const key = toLocalMobileNumber(contact.whatsappNumber) || contact.whatsappNumber;
      if (!map.has(key)) map.set(key, contact._id);
    }
    return map;
  };

  let contactByKey = await loadContacts();

  const nameOf = (key) => attended.get(key) || notAttended.get(key) || "";
  const missing = allKeys.filter((key) => !contactByKey.has(key));

  if (missing.length > 0) {
    try {
      await Contact.insertMany(
        missing.map((key) => ({
          fullName: nameOf(key).trim() || key,
          whatsappNumber: key,
          relationship: "Single",
          // History only — must NOT show up in Contact List.
          historyOnly: true,
          createdBy: adminId || null,
        })),
        { ordered: false }
      );
    } catch (error) {
      // A duplicate created in parallel is fine — everything is re-read below.
      if (error.code !== 11000 && !error.writeErrors) throw error;
    }

    contactByKey = await loadContacts();
  }

  // ---- history rows ----
  const contactIds = [...contactByKey.values()];
  const existingRows = await ContactEventHistory.find({
    eventId: event._id,
    contactId: { $in: contactIds },
    isSpouse: { $ne: true },
    isDeleted: { $ne: true },
  })
    .select("contactId status notes")
    .lean();

  const rowByContact = new Map(existingRows.map((r) => [String(r.contactId), r]));

  const toInsert = [];
  const updates = [];
  let attendedAdded = 0;
  let attendedUpdated = 0;
  let attendedUnchanged = 0;
  let notAttendedAdded = 0;
  let notAttendedKept = 0;

  for (const key of attended.keys()) {
    const contactId = contactByKey.get(key);
    if (!contactId) continue;

    const row = rowByContact.get(String(contactId));

    if (!row) {
      toInsert.push({
        contactId,
        eventId: event._id,
        status: "Attended",
        notes: `Attended ${event.title} (added from Entry Report)`,
        source: SOURCE,
        createdBy: adminId || null,
      });
      attendedAdded += 1;
    } else if (row.status !== "Attended") {
      updates.push({
        updateOne: {
          filter: { _id: row._id },
          update: {
            $set: {
              status: "Attended",
              ...(row.notes ? {} : { notes: `Attended ${event.title} (added from Entry Report)` }),
            },
          },
        },
      });
      attendedUpdated += 1;
    } else {
      attendedUnchanged += 1;
    }
  }

  for (const key of notAttended.keys()) {
    const contactId = contactByKey.get(key);
    if (!contactId) continue;

    // An existing row (even a manually edited one) is never overwritten by
    // a "Not Attended" — only an "Attended" may replace it.
    if (rowByContact.has(String(contactId))) {
      notAttendedKept += 1;
      continue;
    }

    toInsert.push({
      contactId,
      eventId: event._id,
      status: "Not Attended",
      notes: `Booked ${event.title} but did not attend (added from Entry Report)`,
      source: SOURCE,
      createdBy: adminId || null,
    });
    notAttendedAdded += 1;
  }

  if (toInsert.length > 0) await ContactEventHistory.insertMany(toInsert);
  if (updates.length > 0) await ContactEventHistory.bulkWrite(updates);

  return {
    event: { _id: event._id, title: event.title },
    registeredCount: registered.size,
    attendedCount: attended.size,
    notAttendedCount: notAttended.size,
    contactsCreated: missing.length,
    attendedAdded,
    attendedUpdated,
    attendedUnchanged,
    notAttendedAdded,
    notAttendedKept,
    ignoredSelections,
    skippedInvalid,
  };
};

module.exports = { getSyncSummary, syncFromEvent };