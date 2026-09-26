const mongoose = require("mongoose");

/**
 * GuestEditionHistory Model — PARV CRM, Phase 1
 *
 * One row per (Guest, Edition) pair — "was this guest invited/attended
 * in this particular PARV edition, and what was the outcome" (doc
 * section 5: "PARV 1 - Attended, PARV 2 - Attended, PARV 3 - Not
 * Invited..."). This is what makes "show guests appearing in 2, 3, 4 or
 * 5 editions" and "filter by PARV 1 + 3 + 5" possible later — those are
 * just queries over this collection, never a re-scan of Guest itself.
 *
 * Populated two ways in later phases:
 *   1. Historical import (doc section 5) — PARV 1-5 spreadsheets are
 *      mapped onto existing/newly-created Guests, one row per edition
 *      each guest appears in.
 *   2. Automatically going forward — whenever an Invitation (Phase 5/6)
 *      for a guest reaches a final state (Checked-In / No Show /
 *      Not Invited) for an edition, a row here is written/updated so
 *      the guest's edition history is always in sync without a
 *      separate manual step.
 *
 * NOT created directly through its own CRUD endpoints in Phase 1 — only
 * the Guest and Edition documents it references need to exist yet. It
 * is defined now (rather than in a later phase) so the Guest/Edition
 * foreign keys and the one-row-per-pair constraint are fixed from the
 * start, before any data is imported against them.
 */
const guestEditionHistorySchema = new mongoose.Schema(
  {
    guestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guest",
      required: true,
    },

    editionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Edition",
      required: true,
    },

    // Mirrors the Invitation status lifecycle (doc section 8) at the
    // point this edition closed for this guest. "Not Invited" is its
    // own explicit value (not just the absence of a row) so "guest was
    // considered for this edition but not invited" stays distinguishable
    // from "guest didn't exist yet in this edition" (no row at all).
    attendanceStatus: {
      type: String,
      enum: [
        "Not Invited",
        "Invited",
        "Accepted",
        "Declined",
        "Attended",
        "No Show",
      ],
      default: "Not Invited",
    },

    // Original values as they appeared in the imported PARV 1-5 source
    // file (doc section 5: "Preserve source edition and original data
    // fields") — kept verbatim for audit/reference even after the row's
    // guestId/editionId have been resolved to master records.
    sourceData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    notes: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

// One history row per (guest, edition) pair — re-importing the same
// edition for the same guest updates this row rather than creating a
// duplicate.
guestEditionHistorySchema.index({ guestId: 1, editionId: 1 }, { unique: true });

// "All guests in edition X with status Y" (cross-edition filtering, doc
// section 5).
guestEditionHistorySchema.index({ editionId: 1, attendanceStatus: 1 });

module.exports = mongoose.model(
  "GuestEditionHistory",
  guestEditionHistorySchema
);
