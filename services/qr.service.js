const jwt = require("jsonwebtoken");

const BookingTicket = require("../models/bookingTicket.model");
const Booking = require("../models/booking.model");
const AppError = require("../utils/AppError");

// ================= WHAT A SCANNED QR CAN CONTAIN =================
// NEW single-QR pass (public /ticket?qr=<id> page): the QR encodes ONLY the
// short 8-digit Invitation ID. That keeps the QR a small, low-density
// (21x21) code that scans instantly from any phone screen, instead of the
// long signed token, which produced a dense, hard-to-scan QR.
// OLD tickets (and the per-ticket flow): the QR encodes the signed JWT.
//
// Both resolve to a ticketNumber. For an Invitation ID that is the
// booking's primary (first) ticket - the same ticket the pass page
// represents. Everything after this (status checks, group check-in of all
// guests, the response DTO) is unchanged, and the DTO still returns that
// ticket's qrToken, so the scanner's automatic check-in call keeps working.
const INVITATION_ID_REGEX = /^\d{8}$/;

const resolveTicketNumber = async (qrValue) => {
  const value = String(qrValue || "").trim();

  if (INVITATION_ID_REGEX.test(value)) {
    const booking = await Booking.findOne({ invitationId: value }).select("_id");

    if (!booking) {
      // Valid-looking Invitation ID, but this server has no pass with it
      // (deleted pass, or the pass was sent from a different server /
      // database than the one this scanner is connected to).
      throw new AppError(
        `Pass not found for Invitation ID ${value}. It may be deleted, or sent from a different server.`,
        404
      );
    }

    const primaryTicket = await BookingTicket.findOne({ bookingId: booking._id })
      .sort({ createdAt: 1, _id: 1 })
      .select("ticketNumber");

    if (!primaryTicket) {
      throw new AppError("QR ticket not found.", 404);
    }

    return primaryTicket.ticketNumber;
  }

  try {
    return jwt.verify(value, process.env.JWT_SECRET).ticketNumber;
  } catch (error) {
    throw new AppError("Invalid or expired QR code.", 401);
  }
};
 // verfiy qr
const verifyQr = async ({ qrToken }) => {
  // ==========================
  // 1. Verify QR (Invitation ID or signed token)
  // ==========================
  const payload = { ticketNumber: await resolveTicketNumber(qrToken) };

  // ==========================
  // 2. Find Ticket
  // ==========================
  const ticket = await BookingTicket.findOne({
    ticketNumber: payload.ticketNumber,
  })
    .populate({
      path: "bookingId",
      select:
        "bookingNumber name mobileNumber email quantity amount discount isDeleted entryMode invitationId",
    })
    .populate({
      path: "eventId",
      select:
        "title venueName address startDateTime endDateTime isActive",
    })
    .populate({
      path: "ticketTypeId",
      select: "ticketName amount",
    });

  if (!ticket) {
    throw new AppError("QR ticket not found.", 404);
  }

  // ==========================
  // 3. Booking Validation
  // ==========================
  if (!ticket.bookingId) {
    throw new AppError("Booking not found.", 404);
  }

  if (ticket.bookingId.isDeleted) {
    throw new AppError("This booking has been cancelled.", 400);
  }

  // ==========================
  // 4. Ticket Validation
  // ==========================
  if (ticket.status === "Cancelled") {
    throw new AppError("This ticket has been cancelled.", 400);
  }

  if (ticket.status === "Used") {
    throw new AppError("This ticket has already been used.", 400);
  }

  // ==========================
  // 5. Event Validation
  // ==========================
  if (!ticket.eventId) {
    throw new AppError("Event not found.", 404);
  }

  if (!ticket.eventId.isActive) {
    throw new AppError("This event is inactive.", 400);
  }

  if (new Date() > new Date(ticket.eventId.endDateTime)) {
    throw new AppError("This event has already ended.", 400);
  }

  // ==========================
  // 6. Return Response DTO
  // ==========================
  return {
    bookingId: ticket.bookingId._id,
    bookingNumber: ticket.bookingNumber,
    ticketId: ticket._id,
    ticketNumber: ticket.ticketNumber,
    status: ticket.status,
    isRegistered: ticket.isRegistered,
     qrToken: ticket.qrToken, 
    attendee: ticket.attendee,

    // NEW single-QR flow: this one QR admits the WHOLE booking.
    isGroupEntry: ticket.bookingId.entryMode === "single_qr",
    guests: ticket.bookingId.quantity,

    booking: {
      name: ticket.bookingId.name,
      mobileNumber: ticket.bookingId.mobileNumber,
      invitationId: ticket.bookingId.invitationId || null,
      quantity: ticket.bookingId.quantity,
      amount: ticket.bookingId.amount,
      discount: ticket.bookingId.discount,
    },

    event: {
      id: ticket.eventId._id,
      title: ticket.eventId.title,
      venueName: ticket.eventId.venueName,
      address: ticket.eventId.address,
      startDateTime: ticket.eventId.startDateTime,
      endDateTime: ticket.eventId.endDateTime,
    },

    ticketType: {
      id: ticket.ticketTypeId._id,
      ticketName: ticket.ticketTypeId.ticketName,
      amount: ticket.ticketTypeId.amount,
    },
  };
};
// ================= CHECK-IN QR =================
const checkInQr = async ({ qrToken, scannedBy }) => {
  // 1. Verify QR (Invitation ID or signed token)
  const payload = { ticketNumber: await resolveTicketNumber(qrToken) };

  // 2. Find Ticket
  // The frontend now calls check-in automatically right after verify (no
  // "Allow Entry" click in between), so this response needs to be
  // self-sufficient — populated the same way verifyQr does — instead of
  // only returning the bare ticketId/status it used to. This does not
  // add any new validation; it only fetches the related documents needed
  // to build a complete response DTO.
  const ticket = await BookingTicket.findOne({
    ticketNumber: payload.ticketNumber,
  })
    .populate({
      path: "bookingId",
      select:
        "bookingNumber name mobileNumber email quantity amount discount isDeleted entryMode invitationId",
    })
    .populate({
      path: "eventId",
      select:
        "title venueName address startDateTime endDateTime isActive",
    })
    .populate({
      path: "ticketTypeId",
      select: "ticketName amount",
    });

  if (!ticket) {
    throw new AppError("Ticket not found.", 404);
  }

  // 3. Validation - the same rules verifyQr applies. The scanner app only
  // calls check-in, so without these a cancelled booking, an inactive event
  // or an event that is already over would still be let in.
  if (!ticket.bookingId) {
    throw new AppError("Booking not found.", 404);
  }

  if (ticket.bookingId.isDeleted) {
    throw new AppError("This booking has been cancelled.", 400);
  }

  if (ticket.status === "Used") {
    throw new AppError("This ticket has already been checked in.", 400);
  }

  if (ticket.status === "Cancelled") {
    throw new AppError("This ticket has been cancelled.", 400);
  }

  if (!ticket.eventId) {
    throw new AppError("Event not found.", 404);
  }

  if (!ticket.eventId.isActive) {
    throw new AppError("This event is inactive.", 400);
  }

  // (worded without "already" so the app does not show it as "ticket used")
  if (ticket.eventId.endDateTime && new Date() > new Date(ticket.eventId.endDateTime)) {
    throw new AppError("This event has ended.", 400);
  }

  // 4. Update Ticket(s)
  const isGroupEntry = ticket.bookingId?.entryMode === "single_qr";
  let guestsCheckedIn = 1;

  if (isGroupEntry) {
    // NEW single-QR flow: ONE scan = every guest of this booking is
    // marked as entered (quantity 2 -> 2 guests, 5 -> 5 guests, ...).
    // The filter on status "Active" makes this safe against a double scan:
    // a second scan updates 0 tickets and is rejected below.
    const scannedAt = new Date();
    const result = await BookingTicket.updateMany(
      { bookingId: ticket.bookingId._id, status: "Active" },
      { $set: { status: "Used", scannedAt, scannedBy } }
    );

    if (result.modifiedCount === 0) {
      throw new AppError("This ticket has already been checked in.", 400);
    }

    guestsCheckedIn = result.modifiedCount;
    ticket.status = "Used";
    ticket.scannedAt = scannedAt;
    ticket.scannedBy = scannedBy;
  } else {
    // OLD flow (one ticket = one QR = one scan) -- unchanged.
    ticket.status = "Used";
    ticket.scannedAt = new Date();
    ticket.scannedBy = scannedBy;

    await ticket.save();
  }

  // 5. Return Response DTO
  // Mirrors verifyQr's DTO shape below so the frontend gets the same
  // complete attendee/ticket/event/booking details — including
  // attendee.profileImage (already stored on BookingTicket, not
  // generated here) — straight from the automatic check-in call.
  return {
    bookingId: ticket.bookingId?._id ?? null,
    bookingNumber: ticket.bookingNumber,
    ticketId: ticket._id,
    ticketNumber: ticket.ticketNumber,
    status: ticket.status,
    isRegistered: ticket.isRegistered,
    scannedAt: ticket.scannedAt,
    attendee: ticket.attendee,
    isGroupEntry,
    guests: isGroupEntry ? guestsCheckedIn : 1,

    booking: ticket.bookingId
      ? {
          name: ticket.bookingId.name,
          mobileNumber: ticket.bookingId.mobileNumber,
          invitationId: ticket.bookingId.invitationId || null,
          quantity: ticket.bookingId.quantity,
          amount: ticket.bookingId.amount,
          discount: ticket.bookingId.discount,
        }
      : null,

    event: ticket.eventId
      ? {
          id: ticket.eventId._id,
          title: ticket.eventId.title,
          venueName: ticket.eventId.venueName,
          address: ticket.eventId.address,
          startDateTime: ticket.eventId.startDateTime,
          endDateTime: ticket.eventId.endDateTime,
        }
      : null,

    ticketType: ticket.ticketTypeId
      ? {
          id: ticket.ticketTypeId._id,
          ticketName: ticket.ticketTypeId.ticketName,
          amount: ticket.ticketTypeId.amount,
        }
      : null,
  };
};
module.exports = {
  verifyQr,
  checkInQr,
};