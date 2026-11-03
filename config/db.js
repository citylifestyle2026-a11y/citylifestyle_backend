const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);

    // ================= FIX: STALE COMPANY CATEGORY NAME INDEX =================
    // CompanyCategory.model.js's unique index on `name` is defined with
    // `partialFilterExpression: { isDeleted: false }` so a soft-deleted
    // category's name never blocks that same name being reused (see that
    // file). However, this collection's `name` unique index was originally
    // created WITHOUT that partial filter, and Mongoose's default
    // `autoIndex` behavior on connect only ever ADDS indexes that are
    // missing — it never drops/rebuilds an existing index whose options
    // changed. That left the OLD, non-partial index still live and still
    // enforcing uniqueness against soft-deleted categories too, which is
    // exactly why re-creating a deleted category's name (e.g. "Wedding")
    // kept failing with "Category name already exists" even though the
    // schema and service-layer duplicate check were already correct.
    //
    // `syncIndexes()` reconciles the collection's actual indexes with the
    // schema: it drops any index that doesn't match the schema (the stale
    // non-partial `name` index) and (re)builds the ones that do. Scoped to
    // the CompanyCategory model only, so no other collection's indexes
    // (Contact's included) are touched.
    const CompanyCategory = require("../models/companycategory.model");
    await CompanyCategory.syncIndexes();

    // ================= MEMBER LIST: UNIQUE MOBILE INDEX =================
    // The unique index on Member.mobile is now partial (only members with
    // mobileStatus "valid"), so rows imported with "Import all" can be kept
    // even when their number is wrong or repeated. Members saved before this
    // change have no mobileStatus yet, so they are marked "valid" first, then
    // syncIndexes() swaps the old full unique index for the partial one.
    // Safe to run on every start.
    const Member = require("../models/member.model");
    await Member.updateMany(
      { mobileStatus: { $exists: false } },
      { $set: { mobileStatus: "valid" } }
    );
    await Member.syncIndexes();

    // ================= GUEST LIST: NUMBER UNIQUE PER EDITION =================
    // Contact.whatsappNumber used to be unique on its own, so a number that was
    // a guest in Parv 6 could not be a guest in the next event (it showed up in
    // the Duplicate tab instead). The index is now (whatsappNumber + edition).
    // Only the old single-field index is dropped here (nothing else on Contact
    // is touched), then the new one is built. Safe to run on every start.
    const Contact = require("../models/contact.model");
    try {
      const existingIndexes = await Contact.collection.indexes();
      const old = existingIndexes.find(
        (index) =>
          index.name === "whatsappNumber_1" &&
          index.unique &&
          Object.keys(index.key).length === 1
      );
      if (old) {
        await Contact.collection.dropIndex("whatsappNumber_1");
        console.log("Dropped old Contact index whatsappNumber_1");
      }
      // Built directly (not Contact.createIndexes()): if some OTHER Contact index
      // ever conflicts, that must not stop this one from being created.
      await Contact.collection.createIndex(
        { whatsappNumber: 1, editionEventId: 1 },
        { unique: true, partialFilterExpression: { isDeleted: false } }
      );
    } catch (indexError) {
      console.error("Could not update Contact indexes:", indexError.message);
    }
  } catch (error) {
    console.error("========== FULL ERROR ==========");
    console.error(error);
    console.error("================================");
    process.exit(1);
  }
};

module.exports = connectDB;