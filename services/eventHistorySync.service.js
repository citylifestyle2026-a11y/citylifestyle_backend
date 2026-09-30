// services/eventHistorySync.service.js
//
// Entry Report -> "Add to Event History".
//
// For ONE event (e.g. "Parv 5") this saves, in one go, into
// ContactEventHistory:
//   - every SELECTED scanned person   -> status "Attended"      (green)
//   - every person who REGISTERED but was never scanned
//                                      -> status "Not Attended" (red)
// Someone who only has a booking (never completed registration) and was
// not scanned is NOT sent to Event History at all.
//
// Rows point straight at the Event. People are matched by their
// 10-digit mobile number AND their name: a husband and wife who registered
// with the SAME mobile number (different names) are TWO people, so they get
// two rows — the first name on the Contact itself, the second one as the
// contact's spouse (isSpouse = true). A Contact is created when the number is new.
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
const {
  nameSimilarityScore,
  POSSIBLE_DUPLICATE_THRESHOLD,
} = require("../utils/nameSimilarity");

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
// Only REGISTERED tickets (isRegistered) and scanned (Used) tickets count.
// A ticket that is neither registered nor scanned is just a booking, so
// it is skipped. A ticket's person is its registered attendee when there
// is one, otherwise the booking holder. Identified by 10-digit mobile.
const loadEventPeople = async (eventId) => {
  const tickets = await BookingTicket.find({
    eventId,
    status: { $ne: "Cancelled" },
  })
    .select("bookingId status isRegistered attendee.name attendee.mobileNumber")
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

  const personByTicket = new Map(); // ticketId -> { key, mobile, name, used }
  const registered = new Map(); // personKey -> name (everyone who registered or was scanned)
  const usedKeys = new Set(); // personKeys with at least one scanned ticket
  const personMeta = new Map(); // personKey -> { mobile, name, index }
  const peopleByMobile = new Map(); // mobile -> [personKey, ...] in first-seen order
  let skippedInvalid = 0;

  // Same mobile + similar name => same person (typo / "Mr." tolerant).
  // Same mobile + clearly different name => a different person (wife/husband),
  // which gets its own key "<mobile>#<n>".
  const resolvePersonKey = (mobile, name) => {
    const keys = peopleByMobile.get(mobile) || [];

    for (const key of keys) {
      const known = personMeta.get(key).name;
      // A blank name can't be told apart — treat it as the first person.
      if (!name || !known) return key;
      if (nameSimilarityScore(name, known) >= POSSIBLE_DUPLICATE_THRESHOLD) return key;
    }

    const key = `${mobile}#${keys.length}`;
    personMeta.set(key, { mobile, name: name || "", index: keys.length });
    peopleByMobile.set(mobile, [...keys, key]);
    return key;
  };

  for (const ticket of tickets) {
    const booking = bookingById.get(String(ticket.bookingId));
    if (!booking) continue;

    // Booking only (not registered, not scanned) -> not part of history.
    if (!ticket.isRegistered && ticket.status !== "Used") continue;

    const attendeeMobile = toLocalMobileNumber(ticket.attendee?.mobileNumber);
    const mobile = attendeeMobile || toLocalMobileNumber(booking.mobileNumber);

    if (!mobile) {
      skippedInvalid += 1;
      continue;
    }

    const name = (
      (attendeeMobile ? ticket.attendee?.name : booking.name) ||
      booking.name ||
      ""
    ).trim();
    const used = ticket.status === "Used";

    const key = resolvePersonKey(mobile, name);

    // Fill in a blank name if a later ticket of the same person has one.
    if (name && !personMeta.get(key).name) personMeta.get(key).name = name;

    personByTicket.set(String(ticket._id), { key, mobile, name, used });

    if (!registered.has(key) || (!registered.get(key) && name)) {
      registered.set(key, name);
    }

    if (used) usedKeys.add(key);
  }

  return { personByTicket, registered, usedKeys, personMeta, skippedInvalid };
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
  const { personByTicket, registered, usedKeys, personMeta, skippedInvalid } =
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

  // ---- who did not attend: registered, but no scanned ticket at all ----
  const notAttended = new Map();
  for (const [key, name] of registered) {
    if (!usedKeys.has(key)) notAttended.set(key, name);
  }

  // ---- contacts (matched by mobile number, created when new) ----
  // allKeys are PERSON keys ("<mobile>#<n>"); a Contact is per MOBILE, so a
  // wife + husband on one number share ONE contact.
  const allKeys = [...attended.keys(), ...notAttended.keys()];
  const nameOf = (key) => attended.get(key) || notAttended.get(key) || "";

  // mobile -> [personKey...] (only people being saved now, first-seen order)
  const peopleByMobile = new Map();
  for (const key of allKeys) {
    const mobile = personMeta.get(key).mobile;
    if (!peopleByMobile.has(mobile)) peopleByMobile.set(mobile, []);
    peopleByMobile.get(mobile).push(key);
  }
  for (const list of peopleByMobile.values()) {
    list.sort((x, y) => personMeta.get(x).index - personMeta.get(y).index);
  }
  const mobiles = [...peopleByMobile.keys()];

  const loadContacts = async () => {
    const found = await Contact.find({
      isDeleted: { $ne: true },
      whatsappNumber: { $in: [...mobiles, ...mobiles.map((k) => `91${k}`)] },
    })
      .select("_id whatsappNumber fullName relationship spouseName spouseMobile")
      .lean();

    const map = new Map();
    for (const contact of found) {
      const mobile = toLocalMobileNumber(contact.whatsappNumber) || contact.whatsappNumber;
      if (!map.has(mobile)) map.set(mobile, contact);
    }
    return map;
  };

  let contactByMobile = await loadContacts();

  const missing = mobiles.filter((mobile) => !contactByMobile.has(mobile));

  if (missing.length > 0) {
    try {
      await Contact.insertMany(
        missing.map((mobile) => {
          const first = peopleByMobile.get(mobile)[0];
          return {
            fullName: nameOf(first).trim() || mobile,
            whatsappNumber: mobile,
            relationship: "Single",
            // History only — must NOT show up in Contact List.
            historyOnly: true,
            createdBy: adminId || null,
          };
        }),
        { ordered: false }
      );
    } catch (error) {
      // A duplicate created in parallel is fine — everything is re-read below.
      if (error.code !== 11000 && !error.writeErrors) throw error;
    }

    contactByMobile = await loadContacts();
  }

  // ---- decide, per mobile, who is the contact and who is the spouse ----
  const similar = (a, b) =>
    !!a && !!b && nameSimilarityScore(a, b) >= POSSIBLE_DUPLICATE_THRESHOLD;

  // personKey -> { contactId, isSpouse }
  const slotByPerson = new Map();
  const contactUpdates = [];
  let spouseLinked = 0;
  let unresolvedSameMobile = 0;

  for (const [mobile, keys] of peopleByMobile) {
    const contact = contactByMobile.get(mobile);
    if (!contact) continue;

    let mainKey = keys.find((k) => similar(nameOf(k), contact.fullName)) || null;
    let spouseKey =
      keys.find((k) => k !== mainKey && similar(nameOf(k), contact.spouseName)) || null;

    // Names don't match the contact at all (e.g. the contact was typed
    // differently): fall back to first-come = contact, next = spouse.
    if (!mainKey) mainKey = keys.find((k) => k !== spouseKey) || null;

    let newSpouse = null;
    if (!spouseKey && !contact.spouseName) {
      spouseKey = keys.find((k) => k !== mainKey) || null;
      newSpouse = spouseKey;
    }

    if (mainKey) slotByPerson.set(mainKey, { contactId: contact._id, isSpouse: false });
    if (spouseKey) slotByPerson.set(spouseKey, { contactId: contact._id, isSpouse: true });

    // A 3rd different name on one number can't be stored (a contact has
    // only one spouse slot) — counted and reported instead of merged.
    unresolvedSameMobile += keys.filter((k) => !slotByPerson.has(k)).length;

    // Remember the spouse on the contact so the row can show name + number.
    if (newSpouse) {
      contactUpdates.push({
        updateOne: {
          filter: { _id: contact._id },
          update: {
            $set: {
              relationship: "Couple",
              spouseName: nameOf(newSpouse).trim() || mobile,
              spouseMobile: mobile,
            },
          },
        },
      });
      spouseLinked += 1;
    }
  }

  if (contactUpdates.length > 0) await Contact.bulkWrite(contactUpdates);

  // ---- history rows ----
  const contactIds = [...new Set([...slotByPerson.values()].map((s) => s.contactId))];
  const existingRows = await ContactEventHistory.find({
    eventId: event._id,
    contactId: { $in: contactIds },
    isDeleted: { $ne: true },
  })
    .select("contactId isSpouse status notes")
    .lean();

  const rowKeyOf = (contactId, isSpouse) => `${contactId}:${isSpouse ? 1 : 0}`;
  const rowBySlot = new Map(
    existingRows.map((r) => [rowKeyOf(r.contactId, r.isSpouse), r])
  );

  const toInsert = [];
  const updates = [];
  let attendedAdded = 0;
  let attendedUpdated = 0;
  let attendedUnchanged = 0;
  let notAttendedAdded = 0;
  let notAttendedKept = 0;

  for (const key of attended.keys()) {
    const slot = slotByPerson.get(key);
    if (!slot) continue;

    const row = rowBySlot.get(rowKeyOf(slot.contactId, slot.isSpouse));

    if (!row) {
      toInsert.push({
        contactId: slot.contactId,
        eventId: event._id,
        isSpouse: slot.isSpouse,
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
    const slot = slotByPerson.get(key);
    if (!slot) continue;

    // An existing row (even a manually edited one) is never overwritten by
    // a "Not Attended" — only an "Attended" may replace it.
    if (rowBySlot.has(rowKeyOf(slot.contactId, slot.isSpouse))) {
      notAttendedKept += 1;
      continue;
    }

    toInsert.push({
      contactId: slot.contactId,
      eventId: event._id,
      isSpouse: slot.isSpouse,
      status: "Not Attended",
      notes: `Registered for ${event.title} but did not attend (added from Entry Report)`,
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
    spouseLinked,
    unresolvedSameMobile,
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