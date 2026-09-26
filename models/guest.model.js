const mongoose = require("mongoose");

/**
 * Guest Model — PARV CRM, Phase 1 (Master Guest Database)
 *
 * This is the ONE identity a person has across every PARV edition —
 * never re-created per edition, per nomination, or per invitation.
 * Everything added in later phases (Nomination, InvitationParty,
 * GuestEditionHistory) points BACK to a Guest by guestId; a Guest never
 * points forward to those.
 *
 * Identity / duplicate rule (see utils/normalizeMobileNumber.js, already
 * used by Booking/Contact/Admin/User): `mobile` is the primary match key,
 * stored as the plain 10-digit number, same convention as
 * Contact.whatsappNumber and User.mobile. Two guests can never share one
 * active mobile number — see the partial unique index below. Email/name
 * similarity matching (Phase 3 of the requirement doc) works on TOP of
 * this schema; it does not change how a Guest is stored.
 */
const guestSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },

    // Primary match key. Kept as a bare 10-digit string — same
    // convention as Contact.whatsappNumber/User.mobile — even though a
    // guest's WhatsApp number is usually the same number; a separate
    // `whatsappNumber` field is intentionally NOT added yet, since the
    // requirement doc treats "Mobile / WhatsApp" as one combined match
    // field (see doc section 3, Master Guest Database table) rather
    // than two independently-tracked numbers.
    mobile: {
      type: String,
      required: true,
      trim: true,
    },

    // Secondary identity field (doc section 3 + matching priority #3).
    // Optional: many nominations arrive with only a name + mobile.
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },

    companyName: {
      type: String,
      trim: true,
      default: "",
    },

    designation: {
      type: String,
      trim: true,
      default: "",
    },

    category: {
      type: String,
      enum: [
        "HNI",
        "Entrepreneur",
        "Creator",
        "Business Leader",
        "Professional",
        "Artist",
        "Influencer",
        "Other",
      ],
      default: "Other",
    },

    city: {
      type: String,
      trim: true,
      default: "",
    },

    profileImage: {
      type: String,
      default: "",
      trim: true,
    },

    profileImagePublicId: {
      type: String,
      default: "",
      trim: true,
    },

    // Single / Couple — this is the guest's OWN relationship status as
    // recorded on their master profile (doc section 3). It is NOT the
    // same thing as an InvitationParty (Phase 5): a guest marked
    // "Couple" here still gets exactly one Guest document; their
    // partner is a separate Guest document, linked together only when
    // an actual InvitationParty is created for a specific edition.
    relationship: {
      type: String,
      enum: ["Single", "Couple"],
      default: "Single",
    },

    isVip: {
      type: Boolean,
      default: false,
    },

    tags: {
      type: [String],
      default: [],
    },

    notes: {
      type: String,
      trim: true,
      default: "",
    },

    // Soft-delete fields — same pattern as Event/Booking/Contact
    // (isDeleted / deletedAt / deletedBy). A guest is never hard-removed:
    // their edition history, nominations and invitations must survive.
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
// Common "list active guests" query.
guestSchema.index({ isDeleted: 1 });

// Name search/sort.
guestSchema.index({ fullName: 1 });

// PRIMARY DUPLICATE GUARD: one mobile number can belong to only one
// ACTIVE (non-soft-deleted) guest — mirrors Contact.model.js's
// whatsappNumber index exactly, including the partial filter, so a
// soft-deleted guest's number never blocks reusing that number for a
// new guest, while two active guests can never share one number.
// Phase 3's smarter "match → link, don't duplicate" nomination flow
// relies on this constraint always holding at the database level, not
// just being enforced by application code.
guestSchema.index(
  { mobile: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

// Filter by category / city / VIP (doc section 10, Global search filters).
guestSchema.index({ category: 1 });
guestSchema.index({ city: 1 });
guestSchema.index({ isVip: 1 });

module.exports = mongoose.model("Guest", guestSchema);
