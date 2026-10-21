// scripts/cleanupOrphanEventData.js
//
// ONE-TIME cleanup for events that were deleted BEFORE the fix: their Guest List
// contacts and "Past: <edition>" tags (Contact Book) are still there. Contact
// Book, Event History and Form Links are kept. Runs the same cleanup that "Delete Event" now does.
//
//   node scripts/cleanupOrphanEventData.js          (just shows what it would do)
//   node scripts/cleanupOrphanEventData.js --apply  (does it)
require("dotenv").config();
const mongoose = require("mongoose");
const Event = require("../models/event.model");
const Contact = require("../models/contact.model");
const Member = require("../models/member.model");
const deleteLocalFile = require("../utils/deleteLocalFile");
const { cleanupAfterEventDelete } = require("../services/eventCleanup.service");

const apply = process.argv.includes("--apply");

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const liveIds = new Set(
    (await Event.distinct("_id", { isDeleted: { $ne: true } })).map(String)
  );

  // every event id still written on a contact / member
  const used = new Set();
  for (const field of ["editionEventId", "passEventId", "passCancelledEventId"]) {
    (await Contact.distinct(field, { historyOnly: { $ne: true } })).forEach((id) => id && used.add(String(id)));
  }
  (await Member.distinct("movedTo.eventId")).forEach((id) => id && used.add(String(id)));

  const orphanIds = [...used].filter((id) => !liveIds.has(id)).map((id) => new mongoose.Types.ObjectId(id));

  console.log(`Live events: ${liveIds.size}`);
  console.log(`Deleted events still referenced: ${orphanIds.length}`);

  if (!apply) {
    console.log("\nDry run only. Run again with --apply to clean up.");
    await mongoose.disconnect();
    return;
  }

  const result = await cleanupAfterEventDelete({ eventIds: orphanIds });
  await Promise.allSettled(result.filesToDelete.map((p) => deleteLocalFile(p)));

  console.log("\nDone:", { ...result, filesToDelete: result.filesToDelete.length });
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});