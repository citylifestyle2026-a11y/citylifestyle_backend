/**
 * One-time script: guests created before events were separated have no event.
 * It puts every Guest List contact WITHOUT an event into one event, so they
 * show up under that event in the dashboard dropdown.
 *
 *   node scripts/assignEventToExistingRecords.js            -> uses the default (active) event
 *   node scripts/assignEventToExistingRecords.js <eventId>  -> uses that event
 *
 * Safe to run again: contacts that already have an event are never touched.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Contact = require("../models/contact.model");
const Event = require("../models/event.model");
const { getDefaultEvent } = require("../utils/defaultEvent");

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const arg = process.argv[2];
  const event = arg ? await Event.findById(arg).lean() : await getDefaultEvent();
  if (!event) throw new Error("No event found. Pass an event id.");

  const res = await Contact.updateMany(
    { editionEventId: null, historyOnly: { $ne: true } },
    { $set: { editionEventId: event._id, editionName: event.edition || event.title } }
  );

  console.log(`Event "${event.edition || event.title}": ${res.modifiedCount} contact(s) assigned.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
