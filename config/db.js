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
  } catch (error) {
    console.error("========== FULL ERROR ==========");
    console.error(error);
    console.error("================================");
    process.exit(1);
  }
};

module.exports = connectDB;