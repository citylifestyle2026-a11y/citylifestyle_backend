// scripts/splitExistingReferences.js
//
// ONE-TIME cleanup for references saved BEFORE the "& / -" split rule:
// "Ramesh & Suresh" becomes two references, "Ramesh" and "Suresh", on every
// Member and every Guest List contact.
//
//   node scripts/splitExistingReferences.js --dry   (only shows what would change)
//   node scripts/splitExistingReferences.js         (applies the change)
require("dotenv").config();
const mongoose = require("mongoose");
const Member = require("../models/member.model");
const Contact = require("../models/contact.model");
const { toReferenceList } = require("../utils/splitReferences");

const dry = process.argv.includes("--dry");

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const run = async (Model, label) => {
  const docs = await Model.find({ "references.0": { $exists: true } }).select("references").lean();
  let changed = 0;

  for (const doc of docs) {
    const before = doc.references || [];
    const after = toReferenceList(before);
    if (sameList(before, after)) continue;

    changed += 1;
    console.log(`${label} ${doc._id}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

    // updateOne skips the model hooks on purpose: `after` is already clean.
    if (!dry && after.length > 0) {
      await Model.updateOne({ _id: doc._id }, { $set: { references: after } });
    }
  }

  console.log(`${label}: ${changed} of ${docs.length} changed${dry ? " (dry run - nothing saved)" : ""}.`);
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  await run(Member, "Member");
  await run(Contact, "Contact");
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
