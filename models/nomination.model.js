const mongoose = require("mongoose");

/**
 * Nomination Model — PARV CRM, Phase 2
 *
 * One row per (Guest, Coordinator, Edition) — "Coordinator X submitted
 * Guest Y for Edition Z" (doc section 4, Guest Nomination & Duplicate
 * Detection). This is the join between Phase 1's Guest/Edition master
 * data and a Coordinator's own submissions; it never stores guest
 * fields itself — those always live on the one master Guest document
 * (guestId), same "Guest is the one identity, everything else points
 * back to it" rule Guest.model.js already documents.
 *
 * `status` mirrors the front half of the lifecycle from the doc
 * (section 6): Nominated -> Duplicate Check -> Review -> Approved ->
 * Invited -> RSVP -> Checked-In / No Show. Phase 2 only ever sets/reads
 * "Nominated" — the enum already lists the fuller lifecycle now (same
 * convention as GuestEditionHistory.attendanceStatus in Phase 1) so the
 * schema needs no migration when Phase 3 (fuzzy duplicate detection)
 * and Phase 4 (review/approval) start writing the later values.
 *
 * `matchType` records what nomination.service.js's createNomination did
 * against the Guest master database: "Existing" when the submitted
 * mobile OR email exactly matched an already-active Guest (doc section
 * 4, matching priority #1/#2/#3) and this nomination was linked to it;
 * "New" when no exact match was found and a Guest record was created —
 * this covers both an ordinary new guest AND a "Possible Duplicate"
 * (priority #4, name-similarity match found but not exact, see
 * `possibleDuplicateGuestIds` below) — in both cases a NEW Guest
 * document is created, since only an admin should decide whether to
 * merge two similarly-named people, never the nomination flow itself.
 */
const nominationSchema = new mongoose.Schema(
  {
    guestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guest",
      required: true,
    },

    // The Coordinator who submitted this nomination — a User document
    // with role:"coordinator" (see models/user.model.js). Referencing
    // "User" (not a separate Coordinator collection) since Coordinators
    // are stored in the existing User collection, per the Phase 2 role
    // resolution.
    coordinatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    editionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Edition",
      required: true,
    },

    status: {
      type: String,
      enum: [
        "Nominated",
        "Possible Duplicate",
        "Under Review",
        "Approved",
        "Rejected",
      ],
      default: "Nominated",
    },

    matchType: {
      type: String,
      enum: ["New", "Existing"],
      required: true,
    },

    // ================= PHASE 3: NAME-SIMILARITY CANDIDATES =================
    // Populated ONLY when matchType is "New" AND the submitted name came
    // back similar (see utils/nameSimilarity.js) to one or more existing
    // Guests, but no exact mobile/email match was found — i.e. status is
    // "Possible Duplicate". These are the candidates an admin reviews
    // before deciding whether to merge this nomination's (newly created)
    // guest into one of them (merge itself is Phase 4). Left empty for
    // every ordinary "New"/"Existing" nomination.
    possibleDuplicateGuestIds: {
      type: [
        {
          guestId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Guest",
            required: true,
          },
          // 0-1 similarity score at the time of nomination, kept as a
          // point-in-time record — it is NOT re-computed later, since
          // either guest's name could change after this nomination was
          // reviewed.
          score: {
            type: Number,
            required: true,
          },
        },
      ],
      default: [],
    },

    notes: {
      type: String,
      trim: true,
      default: "",
    },

    // Soft-delete — same convention as Guest/Edition. A withdrawn/
    // superseded nomination is never hard-removed so audit history
    // (doc section 12, Audit Logs) stays intact.
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
  },
  {
    timestamps: true,
  }
);

// ================= INDEXES =================
// One ACTIVE nomination per (coordinator, guest, edition) — the same
// coordinator re-submitting the same guest for the same edition is
// rejected as a duplicate nomination rather than silently creating a
// second row (see nomination.service.js's createNomination).
nominationSchema.index(
  { coordinatorId: 1, guestId: 1, editionId: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

// "All nominations in this edition, by status" (doc section 6/10).
nominationSchema.index({ editionId: 1, status: 1 });

// "All nominations for this guest across editions/coordinators" (doc
// section 4, common/overlapping guest view — surfaced fully in a later
// phase, but the index is needed from the start).
nominationSchema.index({ guestId: 1 });

// Coordinator's own "my nominations" listing (doc section 2, RBAC).
nominationSchema.index({ coordinatorId: 1, isDeleted: 1 });

module.exports = mongoose.model("Nomination", nominationSchema);
