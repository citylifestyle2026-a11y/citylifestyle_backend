const mongoose = require("mongoose");

/**
 * Crew Model
 * People who work at the event (not guests): organisers, hosts, security,
 * photographers ... Each crew member belongs to a Crew Category and can be
 * sent an entry pass on WhatsApp, exactly like a Guest List contact.
 */
const crewSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },

    // Stored in the one canonical form "91XXXXXXXXXX" (see
    // utils/normalizeMobileNumber.js).
    whatsappNumber: { type: String, required: true, trim: true },

    email: { type: String, trim: true, default: "" },

    crewCategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CrewCategory",
      default: null,
    },

    // Role of the person in the crew (e.g. "Stage Manager").
    designation: { type: String, trim: true, default: "" },
    area: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    remark: { type: String, trim: true, default: "" },

    // ================= APPROVAL =================
    // Same idea as Guest List: a rejected crew member (or one whose pass was
    // cancelled) can be approved again. Missing field = approved.
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "approved",
    },
    approvalUpdatedAt: { type: Date, default: null },
    approvalUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },

    // ================= PASS (WHATSAPP) =================
    passSentAt: { type: Date, default: null },
    passEventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", default: null },
    passBookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },
    passQuantity: { type: Number, default: 0 },

    // Set by "Cancel Pass": when the pass was cancelled and when the
    // "pass cancelled" WhatsApp message was delivered. The cancelled booking
    // is remembered so "Approve Pass" brings back the SAME pass (same QR).
    passCancelledAt: { type: Date, default: null },
    passCancelMessageSentAt: { type: Date, default: null },
    passCancelledBookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },
    passCancelledEventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", default: null },

    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

// One live crew member per WhatsApp number.
crewSchema.index(
  { whatsappNumber: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
crewSchema.index({ isDeleted: 1, crewCategory: 1 });

module.exports = mongoose.model("Crew", crewSchema);
