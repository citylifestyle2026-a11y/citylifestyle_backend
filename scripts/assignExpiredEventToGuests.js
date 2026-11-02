/**
 * One-time script: put EVERY existing Guest List contact into the event that
 * was live and has now expired (the last ended event that is switched on).
 *
 *   node scripts/assignExpiredEventToGuests.js --dry-run     -> only shows what would change
 *   node scripts/assignExpiredEventToGuests.js               -> contacts WITHOUT an edition get it
 *   node scripts/assignExpiredEventToGuests.js --all         -> EVERY contact is set to it
 *   node scripts/assignExpiredEventToGuests.js <eventId>     -> use this event instead
 *   (flags and the event id can be combined)
 *
 * Without --all, a contact that already belongs to another edition is left
 * alone, so older events keep their own guests. Form Links with no edition
 * get the same event. Safe to run again.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Contact = require("../models/contact.model");
const Event = require("../models/event.model");
const FormLink = require("../models/formLink.model");

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const eventId = args.find((a) => !a.startsWith("--"));

  const base = { isDeleted: { $ne: true } };
  let event;
  if (eventId) {
    event = await Event.findOne({ ...base, _id: eventId }).lean();
  } else {
    // The live (switched-on) event that has expired: the most recently ended one.
    event = await Event.findOne({ ...base, isActive: true, endDateTime: { $lt: new Date() } })
      .sort({ endDateTime: -1 })
      .lean();
  }
  if (!event) throw new Error("No expired active event found. Pass an event id.");

  // Show every live-but-expired event so a wrong pick is easy to spot.
  if (!eventId) {
    const expiredLive = await Event.find({
      ...base,
      isActive: true,
      endDateTime: { $lt: new Date() },
    })
      .select("title edition endDateTime")
      .sort({ endDateTime: -1 })
      .lean();
    if (expiredLive.length > 1) {
      console.log("More than one live event has expired. Using the latest one. Candidates:");
      expiredLive.forEach((e) =>
        console.log(`  ${e._id}  ${e.edition || e.title}  (ended ${e.endDateTime.toISOString()})`)
      );
      console.log("To use another one, run: node scripts/assignExpiredEventToGuests.js <eventId>");
    }
  }

  const name = event.edition || event.title;
  const contactFilter = { isDeleted: { $ne: true }, historyOnly: { $ne: true } };
  if (!all) contactFilter.editionEventId = null;

  const contactCount = await Contact.countDocuments(contactFilter);
  const linkCount = await FormLink.countDocuments({ editionEventId: null });
  console.log(`Event "${name}" (${event._id}) -> ${contactCount} guest(s), ${linkCount} form link(s).`);

  if (dryRun) {
    console.log("Dry run: nothing was changed.");
  } else {
    const res = await Contact.updateMany(contactFilter, {
      $set: { editionEventId: event._id, editionName: name },
    });
    await FormLink.updateMany(
      { editionEventId: null },
      { $set: { editionEventId: event._id, editionName: name } }
    );
    console.log(`Done: ${res.modifiedCount} guest(s) added to "${name}".`);
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
