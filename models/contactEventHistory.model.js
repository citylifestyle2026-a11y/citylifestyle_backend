const mongoose = require("mongoose");

/**
 * ContactEventHistory Model — Contact List, Event History (Step 4)
 *
 * One row per (Contact, Edition) interaction — "this Contact's
 * status/notes for this Edition" — surfaced on the Contact List's
 * Event History page (Contact List -> Event History -> per-contact
 * timeline). This is intentionally its own model, NOT a reuse of
 * GuestEditionHistory: that model is scoped to Guest (PARV CRM) and is
 * off-limits per this step's instructions ("Do NOT touch
 * Guest/Edition/Nomination/Coordinator backend"). Contact and Guest are
 * separate identities in this system, so their event/edition history
 * needs its own separate collection rather than overloading Guest's.
 *
 * Referencing "Edition" (not the older "Event" model) since Event
 * History here is being modeled on the same existing Edition master
 * data already used elsewhere (see the Nomination/GuestEditionHistory
 * models) — the requirement explicitly calls for "Edition dropdown
 * using existing Edition API".
 *
 * NOT unique per (contactId, editionId) on purpose — the page lets an
 * admin "Add Details" as a fresh history entry, so a contact can have
 * more than one dated entry against the same edition over time (e.g.
 * an initial "Invited" row and a later "Attended" row), same as how a
 * running log/timeline works elsewhere in this app (Entry Report).
 */
const STATUS_VALUES = [
  "Invited",
  "Confirmed",
  "Attended",
  "Not Attended",
  "Cancelled",
];

const contactEventHistorySchema = new mongoose.Schema(
  {
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      required: true,
    },

    editionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Edition",
      required: true,
    },

    // true = this entry is for the contact's SPOUSE (Couple contacts
    // only). The entry stays attached to the same Contact document
    // (contactId) — the spouse's name/mobile are read from that
    // contact's spouseName / spouseMobile.
    isSpouse: {
      type: Boolean,
      default: false,
    },

    status: {
      type: String,
      enum: STATUS_VALUES,
      default: "Invited",
    },

    notes: {
      type: String,
      trim: true,
      default: "",
    },

    // "manual" = added through the Event History page's Add Details form;
    // "entry-report" = added automatically by Entry Report -> Add to Event
    // History (services/eventHistorySync.service.js).
    source: {
      type: String,
      enum: ["manual", "entry-report"],
      default: "manual",
    },

    // Soft-delete — same convention as every other model in this
    // project (Contact/Edition/Nomination/GuestEditionHistory).
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

    // Tracks which Admin/User created this entry, same convention as
    // Contact.createdBy / Edition.createdBy.
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
// "This contact's event history, newest first" — the page's main query.
contactEventHistorySchema.index({ contactId: 1, isDeleted: 1, createdAt: -1 });

// "All history rows for this edition" — kept for symmetry with
// GuestEditionHistory's own editionId index, useful for any future
// cross-contact-by-edition view.
contactEventHistorySchema.index({ editionId: 1 });

// Exposed so the validator (and any future service) reads the exact
// same allowed status values instead of a second hardcoded copy
// drifting out of sync — same pattern as Contact.model.js exposing its
// normalizeReferences statics.
contactEventHistorySchema.statics.STATUS_VALUES = STATUS_VALUES;

module.exports = mongoose.model(
  "ContactEventHistory",
  contactEventHistorySchema
);