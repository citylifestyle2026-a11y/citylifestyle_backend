const mongoose = require("mongoose");

// One person who gets an invitation card (name written on the fixed design)
// on WhatsApp. Created by "Invitation Cards -> Import CSV".
const inviteGuestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    // Canonical "91XXXXXXXXXX"
    mobileNumber: { type: String, required: true, trim: true, unique: true },

    status: {
      type: String,
      enum: ["pending", "sending", "sent", "failed"],
      default: "pending",
      index: true,
    },

    error: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },

    // Last generated card (kept so WhatsApp can fetch it, and for support).
    cardUrl: { type: String, default: "" },
    cardPublicId: { type: String, default: "" },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("InviteGuest", inviteGuestSchema);