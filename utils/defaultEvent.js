const Event = require("../models/event.model");
const { notRunEvent } = require("./runEvent");

// The "Active Event (Default)" of the dashboard: the running event that
// starts first, otherwise the most recently ended one. Deleted / switched-off
// events are never picked. Same rule as the dashboard.
// "Let's Run" events are NOT picked here - their report is the Run Report
// (see getDefaultEventAnyTitle below).
const pickDefault = async (extra) => {
  const now = new Date();
  const base = { isActive: true, isDeleted: { $ne: true }, ...extra };

  const running = await Event.findOne({ ...base, endDateTime: { $gte: now } })
    .sort({ startDateTime: 1 })
    .lean();
  if (running) return running;

  return Event.findOne({ ...base, endDateTime: { $lt: now } })
    .sort({ endDateTime: -1 })
    .lean();
};

const getDefaultEvent = () => pickDefault(notRunEvent());

// Same rule but NO title restriction: the current active event whatever it is
// called ("Let's Run" included). Used by the public /lets-run form and the Run
// Report. When several events are active, the one that starts first.
const getDefaultEventAnyTitle = () => pickDefault({});

// The event a new record belongs to: the event picked in the dashboard
// dropdown (sent as `eventId`), otherwise the default event. Null if none.
const resolveEventForNewRecord = async (eventId) => {
  const mongoose = require("mongoose");
  if (eventId && mongoose.Types.ObjectId.isValid(String(eventId))) {
    const picked = await Event.findOne({ _id: eventId, isDeleted: { $ne: true }, ...notRunEvent() }).lean();
    if (picked) return picked;
  }
  return getDefaultEvent();
};

module.exports = { getDefaultEvent, getDefaultEventAnyTitle, resolveEventForNewRecord };
