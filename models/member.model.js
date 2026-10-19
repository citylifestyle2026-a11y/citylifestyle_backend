const mongoose = require("mongoose");

/**
 * Member Model — Member List
 *
 * The master directory of people (imported from the Members Excel / CSV).
 * A Member is NOT a guest yet: from Member List the admin selects members and
 * moves them to the Guest List for one edition (event) — that creates the
 * Contact rows shown in Guest List, where they are approved / rejected.
 */
const memberSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    // 10-digit local mobile number (91 prefix / spaces removed on import).
    // Only required for a "valid" member: a row imported with "Import all"
    // can have a missing / wrong number until it is fixed by editing.
    mobile: {
      type: String,
      trim: true,
      default: "",
      required: function () {
        return (this.mobileStatus || "valid") === "valid";
      },
    },

    // "valid"     - normal member (number is unique in Member List).
    // "invalid"   - imported with "Import all" but name / number was wrong.
    // "duplicate" - imported with "Import all" but the number already exists.
    // Flagged members show a "Needs Fix" tag, cannot be moved to the Guest
    // List until edited, and turn "valid" again once the details are fixed.
    mobileStatus: {
      type: String,
      enum: ["valid", "invalid", "duplicate"],
      default: "valid",
    },

    // Why the row was flagged (e.g. "Invalid mobile number").
    importNote: { type: String, trim: true, default: "" },

    email: { type: String, trim: true, default: "" },
    profession: { type: String, trim: true, default: "" },
    companyName: { type: String, trim: true, default: "" },
    area: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },

    // ---- Same extra details the Guest List (Contact) holds, so they are
    // kept on the member and carried over when the member is moved. ----
    designation: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    // Bare Instagram username (no "@"), same as Contact.instagramId.
    instagramId: { type: String, trim: true, default: "" },
    relationship: { type: String, enum: ["Single", "Couple"], default: "Single" },
    spouseName: { type: String, trim: true, default: "" },
    spouseMobile: { type: String, trim: true, default: "" },
    spouseInstagramId: { type: String, trim: true, default: "" },
    // Spouse profession = a Company Category name (like Member.profession).
    spouseProfession: { type: String, trim: true, default: "" },

    // ---- Profile photos (Add / Edit Member form). `*Image` is the public URL,
    // `*PublicId` is the relative path under uploads/ that
    // utils/deleteLocalFile.js needs to remove the file later - same pair of
    // fields Contact.model.js uses. ----
    profileImage: { type: String, trim: true, default: "" },
    profileImagePublicId: { type: String, trim: true, default: "" },
    spouseProfileImage: { type: String, trim: true, default: "" },
    spouseProfileImagePublicId: { type: String, trim: true, default: "" },

    // Reference, Reference 2, Reference 3 columns of the sheet.
    references: { type: [{ type: String, trim: true }], default: [] },

    source: { type: String, trim: true, default: "" },
    remark: { type: String, trim: true, default: "" },

    // "Status" column of the sheet (e.g. Active).
    memberStatus: { type: String, trim: true, default: "Active" },

    // Editions this member has already been moved to (Guest List).
    movedTo: {
      type: [
        {
          eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Event" },
          editionName: { type: String, trim: true, default: "" },
          movedAt: { type: Date, default: Date.now },
          _id: false,
        },
      ],
      default: [],
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
  },
  { timestamps: true }
);

// Unique only among valid members, so duplicate / invalid rows imported with
// "Import all" never clash with the real ones.
memberSchema.index(
  { mobile: 1 },
  { unique: true, partialFilterExpression: { mobileStatus: "valid" } }
);
memberSchema.index({ name: 1 });
memberSchema.index({ profession: 1 });

module.exports = mongoose.model("Member", memberSchema);