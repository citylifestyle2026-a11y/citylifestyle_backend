const mongoose = require("mongoose");

/**
 * ContactEventHistory Model — Contact List, Event History
 *
 * One row per (Contact, Event) interaction — "this Contact's status/notes
 * for this Event" — shown on the Event History page. It points straight at
 * the Event (models/event.model.js); there is no separate Edition master
 * data any more.
 *
 * NOT unique per (contactId, eventId) on purpose: the admin can add an
 * entry manually, and Entry Report -> Add to Event History adds its own.
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

    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
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
    // project (Contact/Event/Booking).
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
    // Contact.createdBy.
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

// "All history rows for this event".
contactEventHistorySchema.index({ eventId: 1 });

// Exposed so the validator (and any future service) reads the exact
// same allowed status values instead of a second hardcoded copy
// drifting out of sync — same pattern as Contact.model.js exposing its
// normalizeReferences statics.
contactEventHistorySchema.statics.STATUS_VALUES = STATUS_VALUES;

module.exports = mongoose.model(
  "ContactEventHistory",
  contactEventHistorySchema
);