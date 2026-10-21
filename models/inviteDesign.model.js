const mongoose = require("mongoose");

// The ONE invitation-card design (the JPG/PNG the admin uploads from
// Invitation Cards -> "Upload card design") plus where the guest's name is
// written on it. Only a single document ever exists (key: "default").
//
// The picture itself is stored in MongoDB (not on disk) so it survives a
// server restart / redeploy that wipes the uploads folder.
const inviteDesignSchema = new mongoose.Schema(
  {
    key: { type: String, default: "default", unique: true },

    image: { type: Buffer, default: null }, // normalised JPEG
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    originalName: { type: String, default: "" },

    // Where / how the guest's name is written (all values in % of the design).
    nameStyle: {
      centerXPct: { type: Number, default: null },
      topPct: { type: Number, default: null },
      fontSizePct: { type: Number, default: null },
      color: { type: String, default: null },
    },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("InviteDesign", inviteDesignSchema);
