const mongoose = require("mongoose");

/**
 * ContactDuplicate Model
 *
 * A public-form submission (open form, or a "Share Form Link") whose WhatsApp
 * number is ALREADY in the Guest List. Guest List cannot hold two rows with the
 * same number, so the submission is parked here instead of being rejected or
 * silently merged. Guest List -> "Duplicate" tab shows these rows; the admin
 * presses "Fix", picks what to keep and the data is synced into the ONE
 * Guest List row (and the Contact Book row with the same number).
 * Nothing here ever creates a guest row or a pass.
 */
const contactDuplicateSchema = new mongoose.Schema(
  {
    fullName: { type: String, trim: true, default: "" },
    whatsappNumber: { type: String, trim: true, default: "" },
    companyName: { type: String, trim: true, default: "" },
    designation: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    area: { type: String, trim: true, default: "" },
    instagramId: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    relationship: { type: String, enum: ["Single", "Couple"], default: "Single" },
    spouseName: { type: String, trim: true, default: "" },
    spouseMobile: { type: String, trim: true, default: "" },
    spouseInstagramId: { type: String, trim: true, default: "" },
    references: { type: [{ type: String, trim: true }], default: [] },

    companyCategory: { type: mongoose.Schema.Types.ObjectId, ref: "CompanyCategory", default: null },
    // Spouse profession category (Couple only), same as Contact.professionCategory.
    professionCategory: { type: mongoose.Schema.Types.ObjectId, ref: "CompanyCategory", default: null },

    profileImage: { type: String, trim: true, default: "" },
    profileImagePublicId: { type: String, trim: true, default: "" },
    spouseProfileImage: { type: String, trim: true, default: "" },
    spouseProfileImagePublicId: { type: String, trim: true, default: "" },

    // The Guest List row that already has this number.
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },

    // How many times this number was submitted (one row per guest, latest data wins).
    submissionCount: { type: Number, default: 1 },

    // "form" = open public form, "link" = Share Form Link.
    source: { type: String, enum: ["form", "link"], default: "form" },
    formLinkId: { type: mongoose.Schema.Types.ObjectId, ref: "FormLink", default: null },
  },
  { timestamps: true }
);

contactDuplicateSchema.index({ createdAt: -1 });
contactDuplicateSchema.index({ contactId: 1 });

module.exports = mongoose.model("ContactDuplicate", contactDuplicateSchema);
