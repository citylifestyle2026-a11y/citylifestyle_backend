const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    bookingNumber: {
      type: String,
      unique: true,
      trim: true,
    },

    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      required: true,
    },

    ticketTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TicketType",
      required: true,
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    mobileNumber: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      trim: true,
      default: "",
    },

    // Company / Brand of the guest (shown on the invitation pass).
    companyName: {
      type: String,
      trim: true,
      default: "",
    },

    discount: {
      type: Number,
      default: 0,
    },

    remark: {
      type: String,
      trim: true,
      default: "",
    },

    // ================= SINGLE QR INVITATION (NEW FLOW) =================
    // Set only when BOOKING_NOTIFICATION_MODE=qr_invite (see
    // services/invitation.service.js). Bookings made with the OLD flow
    // keep entryMode "per_ticket" and invitationId unset, so they keep
    // working exactly as before.
    //   invitationId : 8-digit id shown in WhatsApp + used in /ticket?qr=<id>
    //   entryMode    : "single_qr"  -> ONE QR for the whole booking; scanning it
    //                                  checks in ALL guests (quantity) at once
    //                  "per_ticket" -> OLD: each ticket has its own QR / scan
    invitationId: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },

    entryMode: {
      type: String,
      enum: ["per_ticket", "single_qr"],
      default: "per_ticket",
    },

    // true = pass sent from the Crew page. Crew is never added to Event
    // History (see services/eventHistorySync.service.js).
    isCrew: {
      type: Boolean,
      default: false,
    },

    bookingStatus: {
      type: String,
      enum: ["Confirmed", "Cancelled"],
      default: "Confirmed",
    },

    // Tracks which Admin created this booking (req.user.id from the
    // authenticated admin — see booking.controller.js's createBooking).
    // Must ref "Admin", matching Event.createdBy and
    // TicketType.createdBy, so populate("createdBy", "name") actually
    // resolves to that admin's name instead of silently matching nothing.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
   

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

module.exports = mongoose.model("Booking", bookingSchema);