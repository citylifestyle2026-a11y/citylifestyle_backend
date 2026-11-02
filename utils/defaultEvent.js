const Event = require("../models/event.model");

// The "Active Event (Default)" of the dashboard: the running event that
// starts first, otherwise the most recently ended one. Deleted / switched-off
// events are never picked. Same rule as the dashboard.
const getDefaultEvent = async () => {
  const now = new Date();
  const base = { isActive: true, isDeleted: { $ne: true } };

  const running = await Event.findOne({ ...base, endDateTime: { $gte: now } })
    .sort({ startDateTime: 1 })
    .lean();
  if (running) return running;

  return Event.findOne({ ...base, endDateTime: { $lt: now } })
    .sort({ endDateTime: -1 })
    .lean();
};

// The event a new record belongs to: the event picked in the dashboard
// dropdown (sent as `eventId`), otherwise the default event. Null if none.
const resolveEventForNewRecord = async (eventId) => {
  const mongoose = require("mongoose");
  if (eventId && mongoose.Types.ObjectId.isValid(String(eventId))) {
    const picked = await Event.findOne({ _id: eventId, isDeleted: { $ne: true } }).lean();
    if (picked) return picked;
  }
  return getDefaultEvent();
};

module.exports = { getDefaultEvent, resolveEventForNewRecord };
