// scripts/migrateHistoryEditionToEvent.js
//
// ONE-TIME migration, run once after deploying the "Edition module removed,
// Event History points to Event" change:
//
//   node scripts/migrateHistoryEditionToEvent.js          (dry run — changes nothing)
//   node scripts/migrateHistoryEditionToEvent.js --apply  (writes the changes)
//
// Old history rows carry `editionId`. For each one this looks up the old
// edition (raw `editions` collection — the Edition model no longer exists),
// finds the Event with the SAME NAME (capitals / spaces ignored: "Parv 6" ==
// "PARV6") and stores it as `eventId`, removing `editionId`. Rows whose event
// cannot be found are listed and left untouched.
require("dotenv").config();
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const norm = (v) => String(v ?? "").toLowerCase().replace(/\s+/g, "");

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const editions = await db.collection("editions").find({}).toArray();
  const events = await db
    .collection("events")
    .find({ isDeleted: { $ne: true } })
    .project({ title: 1 })
    .toArray();

  const eventByName = new Map(events.map((e) => [norm(e.title), e._id]));
  const eventIdByEditionId = new Map();
  const unmatched = [];

  for (const edition of editions) {
    const eventId = eventByName.get(norm(edition.name));
    if (eventId) eventIdByEditionId.set(String(edition._id), eventId);
    else unmatched.push(edition.name);
  }

  const history = db.collection("contacteventhistories");
  const rows = await history
    .find({ editionId: { $exists: true }, eventId: { $exists: false } })
    .toArray();

  let migrated = 0;
  let skipped = 0;

  for (const row of rows) {
    const eventId = eventIdByEditionId.get(String(row.editionId));
    if (!eventId) {
      skipped += 1;
      continue;
    }
    if (APPLY) {
      await history.updateOne(
        { _id: row._id },
        { $set: { eventId }, $unset: { editionId: "" } }
      );
    }
    migrated += 1;
  }

  console.log(APPLY ? "APPLIED" : "DRY RUN (add --apply to write)");
  console.log(`history rows to migrate : ${rows.length}`);
  console.log(`  migrated              : ${migrated}`);
  console.log(`  skipped (no event)    : ${skipped}`);
  if (unmatched.length) {
    console.log(`editions with NO event of the same name: ${unmatched.join(", ")}`);
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});