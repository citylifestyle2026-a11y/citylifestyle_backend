const mongoose = require("mongoose");

/**
 * RunRegistration - one person of the "Run Registration" module (5 KM / 10 KM).
 *
 * FLOW
 *   1. Admin: Add Data (name + mobile)  -> row is created as "invited" and the
 *      registration link  <site>/run/<token>  is sent on WhatsApp.
 *   2. Person opens the link, picks 5 KM / 10 KM, confirms name + email
 *      -> status becomes "registered", a QR is created and sent on WhatsApp
 *      and by email.
 *   3. At the gate the normal QR scanner scans the QR -> scannedAt is set.
 *
 * EDITION: every row belongs to ONE event (edition). The admin pages only show
 * the rows of the event picked in the header dropdown (default = active event).
 */
const runRegistrationSchema = new mongoose.Schema(
  {
    // null = Let's Run without an event (linked to the event automatically when one is created).
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event", default: null, index: true },

    // Only for a run WITHOUT an event: the ISO start date-time of that run. The
    // admin changing the Let's Run date starts a new run; old rows keep theirs.
    // "" when the row belongs to an event.
    editionKey: { type: String, default: "", index: true },

    name: { type: String, required: true, trim: true, maxlength: 60 },

    // Canonical "91XXXXXXXXXX" (see utils/normalizeMobileNumber.js).
    mobileNumber: { type: String, required: true, trim: true },

    email: { type: String, trim: true, lowercase: true, default: "" },

    // 5 or 10. null until the person registers.
    distance: { type: Number, enum: [5, 10], default: null },

    // invited = link sent, form not filled yet. registered = form filled, QR created.
    status: { type: String, enum: ["invited", "registered"], default: "invited" },

    // Random, unguessable part of the WhatsApp link.
    token: { type: String, required: true, unique: true, index: true },

    // "RUN0001" - shown to the person and in the reports (per event).
    registrationNumber: { type: String, default: "" },

    // What the QR contains ("RUN-XXXXXXXX"). Random, so it cannot be guessed.
    qrValue: { type: String, default: undefined },
    qrImage: { type: String, default: "" },
    qrImagePublicId: { type: String, default: "" },

    registeredAt: { type: Date, default: null },
    scannedAt: { type: Date, default: null },
    scannedBy: { type: mongoose.Schema.Types.ObjectId, default: null },

    // WhatsApp / email bookkeeping (so the admin can see what failed).
    linkSentAt: { type: Date, default: null },
    linkError: { type: String, default: "" },
    qrSentAt: { type: Date, default: null },
    qrError: { type: String, default: "" },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },

    // admin   = added by an admin (WhatsApp link flow, /run/<token>)
    // lets-run = filled the public form at /lets-run (name + mobile -> ticket)
    source: { type: String, enum: ["admin", "lets-run"], default: "admin" },
  },
  { timestamps: true }
);

// A mobile number can be added only once per event / per no-event run.
runRegistrationSchema.index({ eventId: 1, editionKey: 1, mobileNumber: 1 }, { unique: true });
// The QR value is unique across everything (sparse: invited rows have none).
runRegistrationSchema.index({ qrValue: 1 }, { unique: true, sparse: true });
runRegistrationSchema.index({ eventId: 1, status: 1, scannedAt: 1 });
runRegistrationSchema.index({ eventId: 1, createdAt: -1 });

const RunRegistration = mongoose.model("RunRegistration", runRegistrationSchema);

// The old unique index (eventId + mobile) would stop the same number registering
// for the next run: drop it once, then make sure the new one exists. Idempotent.
mongoose.connection.once("open", () => {
  RunRegistration.collection
    .dropIndex("eventId_1_mobileNumber_1")
    .catch(() => {})
    .then(() => RunRegistration.createIndexes())
    .catch((error) => console.error("[run-registration] index update failed:", error.message));
});

module.exports = RunRegistration;
