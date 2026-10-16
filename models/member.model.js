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
    mobile: { type: String, required: true, trim: true },

    email: { type: String, trim: true, default: "" },
    profession: { type: String, trim: true, default: "" },
    companyName: { type: String, trim: true, default: "" },
    objective: { type: String, trim: true, default: "" },
    area: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },

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

memberSchema.index({ mobile: 1 }, { unique: true });
memberSchema.index({ name: 1 });
memberSchema.index({ profession: 1 });

module.exports = mongoose.model("Member", memberSchema);
