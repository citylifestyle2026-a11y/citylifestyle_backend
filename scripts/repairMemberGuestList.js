// scripts/repairMemberGuestList.js
//
// ONE-TIME repair for guests that were deleted from Guest List BEFORE the fix:
// their member still shows "In Guest List". This clears that flag for every
// member who has no live Guest List contact left.
//
//   node scripts/repairMemberGuestList.js     (run once)
require("dotenv").config();
const mongoose = require("mongoose");
const Member = require("../models/member.model");
const { releaseMembersWithoutContact } = require("../services/member.service");

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const members = await Member.find({ "movedTo.0": { $exists: true } }).select("_id").lean();
  const released = await releaseMembersWithoutContact({ memberIds: members.map((m) => m._id) });

  console.log(`Checked ${members.length} member(s); ${released} moved back to "Not in Guest List".`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
