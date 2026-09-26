const mongoose = require("mongoose");

/**
 * Edition Model — PARV CRM, Phase 1
 *
 * One document per PARV edition (PARV 1, PARV 2, ... PARV 6 and beyond).
 * Every Nomination, GuestEditionHistory row, InvitationParty and
 * Invitation added in later phases is scoped to exactly one Edition —
 * this is the "current active edition" a coordinator/admin is working
 * in (doc section 3, PARV Edition Management).
 *
 * This is intentionally a SEPARATE model from the existing Event model
 * (models/event.model.js). Event represents a City Lifestyle ticketed
 * function; Edition represents one year of the PARV guest list. Sharing
 * one model would force every future PARV field onto Event's schema
 * (and vice versa) even though the two are governed by unrelated
 * business rules (tickets/QR-per-ticket vs. guests/QR-per-party).
 */
const editionSchema = new mongoose.Schema(
  {
    name: {
      // e.g. "PARV 6" — free text so naming never has to match
      // editionNumber exactly (a special/renamed edition stays possible).
      type: String,
      required: true,
      trim: true,
    },

    // Numeric sequence (doc section 3) — used for "PARV 1 + 3 + 5"
    // style cross-edition filtering in later phases, and to sort
    // editions in their natural order regardless of `name` text.
    editionNumber: {
      type: Number,
      required: true,
    },

    year: {
      type: Number,
      required: true,
    },

    eventDateTime: {
      type: Date,
      default: null,
    },

    venue: {
      type: String,
      trim: true,
      default: "",
    },

    // Optional capacity control (doc section 3). Null/0 = no cap.
    guestCapacity: {
      type: Number,
      default: null,
    },

    status: {
      type: String,
      enum: ["Draft", "Active", "Closed", "Archived"],
      default: "Draft",
    },

    // Soft-delete — same convention as every other model in this
    // project. An edition is never hard-removed: every Nomination /
    // GuestEditionHistory / Invitation scoped to it must remain valid.
    isDeleted: {
      type: Boolean,
      default: false,
    },

    deletedAt: {
      type: Date,
      default: null,
    },

    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ================= INDEXES =================
editionSchema.index({ isDeleted: 1 });

// Only one ACTIVE (non-deleted) edition may use a given editionNumber —
// mirrors the mobile/whatsappNumber partial-unique pattern used
// elsewhere, so a soft-deleted edition's number can be reused.
editionSchema.index(
  { editionNumber: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

editionSchema.index({ status: 1 });
editionSchema.index({ year: 1 });

module.exports = mongoose.model("Edition", editionSchema);
