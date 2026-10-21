const mongoose = require("mongoose");

/**
 * FormLink — a shareable link to the PUBLIC contact form (/form) that is
 * limited to a fixed number of people.
 *
 * Example: name "Rahul Shah", quantity 15  ->  the link accepts 15 form
 * submissions. Every person who fills the form gets "Rahul Shah" saved as
 * their Reference automatically. After the 15th submission the link closes.
 *
 * target:
 *   "contact" -> submissions land in Contact List (pending approval, exactly
 *                like the normal public form).
 *   "member"  -> submissions land in Contact Book.
 */
const formLinkSchema = new mongoose.Schema(
  {
    // Becomes the Reference of every person who submits through this link.
    name: { type: String, required: true, trim: true, maxlength: 60 },

    // How many people may submit through this link.
    quantity: { type: Number, required: true, min: 1, max: 1000 },

    // How many have already submitted. Only ever changed with atomic
    // updates (see reserveSlot in services/formLink.service.js).
    usedCount: { type: Number, default: 0, min: 0 },

    // Random, unguessable part of the URL.
    token: { type: String, required: true, unique: true, index: true },

    target: { type: String, enum: ["contact", "member"], default: "contact" },

    // "closed" = stopped by an admin (can be re-opened).
    status: { type: String, enum: ["active", "closed"], default: "active" },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

formLinkSchema.index({ target: 1, createdAt: -1 });

module.exports = mongoose.model("FormLink", formLinkSchema);
