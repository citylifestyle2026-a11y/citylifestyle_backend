const mongoose = require("mongoose");

/**
 * BlockedPerson — one person an admin has put on the Block List.
 *
 * Matching is by MOBILE NUMBER (canonical "91XXXXXXXXXX"), because names are
 * spelled differently every time. Whenever the same number shows up in the
 * Guest List, Contact Book, Invitation Cards or comes in through a public
 * form, the row is flagged with this reason + who blocked it.
 */
const blockedPersonSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },

    // Canonical "91XXXXXXXXXX" (see utils/normalizeMobileNumber.js)
    mobileNumber: { type: String, required: true, trim: true, unique: true, index: true },

    // Why this person was blocked — shown in every flag.
    reason: { type: String, required: true, trim: true, maxlength: 500 },

    // Who blocked (name is copied so it survives the admin being renamed/removed).
    blockedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
    blockedByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

blockedPersonSchema.index({ createdAt: -1 });

module.exports = mongoose.model("BlockedPerson", blockedPersonSchema);
