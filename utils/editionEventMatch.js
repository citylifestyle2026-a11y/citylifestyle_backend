// utils/editionEventMatch.js
//
// One rule ties an Edition to an Event: the Edition carries the SAME NAME
// as the Event ("Parv 5" event -> "Parv 5" edition), and the same start
// date & time. Names are compared without caring about capital letters or
// spaces, so "Parv 5", "PARV5" and "parv  5" are all the same name.
//
// Used by:
//   - edition.service.js        -> a NEW edition may only be created for an
//                                  event that already exists, with the same
//                                  date & time as that event.
//   - eventHistorySync.service.js -> the Entry Report "Add to Event History"
//                                  action finds (or creates) the edition of
//                                  the selected event.
const Event = require("../models/event.model");
const AppError = require("./AppError");

// "Parv 5" / "PARV5" / " parv   5 " -> "parv5"
const normalizeEditionName = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");

// Compared to the minute — the Edition form only captures minutes, while an
// Event start time may carry seconds.
const isSameDateTime = (a, b) => {
  const first = new Date(a).getTime();
  const second = new Date(b).getTime();
  if (Number.isNaN(first) || Number.isNaN(second)) return false;
  return Math.floor(first / 60000) === Math.floor(second / 60000);
};

const formatIst = (value) =>
  new Date(value).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

// The (non-deleted) Event whose title matches the given edition name, or null.
const findEventByEditionName = async (name) => {
  const key = normalizeEditionName(name);
  if (!key) return null;

  const events = await Event.find({ isDeleted: { $ne: true } })
    .select("title startDateTime endDateTime venueName")
    .lean();

  return events.find((event) => normalizeEditionName(event.title) === key) || null;
};

// Throws a clear error when a NEW edition has no matching event, or its
// date & time differs from that event's start. Returns the matched event.
const assertEditionMatchesEvent = async ({ name, eventDateTime }) => {
  const event = await findEventByEditionName(name);

  if (!event) {
    throw new AppError(
      `No event named "${String(name).trim()}" exists. Please create the event first, then add its edition.`,
      400
    );
  }

  if (!eventDateTime || !isSameDateTime(eventDateTime, event.startDateTime)) {
    throw new AppError(
      `Edition "${String(name).trim()}" must have the same date & time as the event "${event.title}" (${formatIst(
        event.startDateTime
      )}).`,
      400
    );
  }

  return event;
};

module.exports = {
  normalizeEditionName,
  isSameDateTime,
  formatIst,
  findEventByEditionName,
  assertEditionMatchesEvent,
};
