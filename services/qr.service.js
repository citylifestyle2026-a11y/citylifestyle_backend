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
    // Single-QR pass: the first ticket may be "Used" (some guests already
    // entered) while other guests are still to come - that is still valid.
    const guestsLeft =
      ticket.bookingId.entryMode === "single_qr"
        ? await BookingTicket.countDocuments({
            bookingId: ticket.bookingId._id,
            status: "Active",
          })
        : 0;

    if (guestsLeft === 0) {
      throw new AppError("This ticket has already been used.", 400);
    }
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
// `guests` (optional): how many people are entering NOW on a single-QR pass.
//  - pass with 1 guest left            -> that guest is checked in, no question
//  - pass with 2+ guests left, no count -> NOTHING is checked in; the response
//    has needsGuestCount:true so the scanner can ask "how many came?"
//  - pass with 2+ guests left, count given -> exactly that many are checked in;
//    the rest stay "Active", so the SAME QR works again later for them.
const checkInQr = async ({ qrToken, scannedBy, guests }) => {
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

  const isGroupEntry = ticket.bookingId?.entryMode === "single_qr";
  let activeCount = 0;
  let usedCount = 0;

  if (isGroupEntry) {
    // Single-QR pass: the pass is valid as long as ANY guest is still
    // "Active" - the QR's own (first) ticket may already be "Used".
    [activeCount, usedCount] = await Promise.all([
      BookingTicket.countDocuments({ bookingId: ticket.bookingId._id, status: "Active" }),
      BookingTicket.countDocuments({ bookingId: ticket.bookingId._id, status: "Used" }),
    ]);

    if (activeCount === 0) {
      throw new AppError(
        usedCount > 0
          ? `This ticket has already been checked in. All ${usedCount} guest${usedCount === 1 ? "" : "s"} have entered.`
          : "This ticket has been cancelled.",
        400
      );
    }
  } else {
    if (ticket.status === "Used") {
      throw new AppError("This ticket has already been checked in.", 400);
    }

    if (ticket.status === "Cancelled") {
      throw new AppError("This ticket has been cancelled.", 400);
    }
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
  let guestsCheckedIn = 1;
  let guestsLeft = 0;

  if (isGroupEntry) {
    // Single-QR flow with PARTIAL entry: the scanner says how many people
    // are entering now (`guests`); only that many tickets become "Used".
    const requested = Number(guests);
    const hasCount = Number.isInteger(requested) && requested >= 1;

    // 2+ guests still to enter and nobody said how many -> ask, change nothing.
    if (activeCount > 1 && !hasCount) {
      return {
        needsGuestCount: true,
        isGroupEntry: true,
        remaining: activeCount,
        alreadyEntered: usedCount,
        totalGuests: activeCount + usedCount,
        guests: 0,
        booking: {
          name: ticket.bookingId.name,
          mobileNumber: ticket.bookingId.mobileNumber,
          invitationId: ticket.bookingId.invitationId || null,
          quantity: ticket.bookingId.quantity,
        },
        attendee: ticket.attendee,
      };
    }

    // Only one guest left -> that one guest is checked in, no question.
    const toCheckIn = activeCount === 1 ? 1 : requested;

    if (!Number.isInteger(toCheckIn) || toCheckIn < 1 || toCheckIn > activeCount) {
      throw new AppError(
        `Only ${activeCount} guest${activeCount === 1 ? " is" : "s are"} left on this pass. Choose between 1 and ${activeCount}.`,
        400
      );
    }

    // One atomic update per guest, so two phones scanning the same pass at
    // the same moment can never admit more people than the pass has.
    const scannedAt = new Date();
    let done = 0;
    for (let i = 0; i < toCheckIn; i += 1) {
      const marked = await BookingTicket.findOneAndUpdate(
        { bookingId: ticket.bookingId._id, status: "Active" },
        { $set: { status: "Used", scannedAt, scannedBy } },
        { sort: { createdAt: 1, _id: 1 } }
      );
      if (!marked) break;
      done += 1;
    }

    if (done === 0) {
      throw new AppError("This ticket has already been checked in.", 400);
    }

    guestsCheckedIn = done;
    guestsLeft = Math.max(activeCount - done, 0);
    ticket.status = guestsLeft === 0 ? "Used" : "Active";
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
    // Single-QR pass: how many are still to come on this same QR.
    remaining: isGroupEntry ? guestsLeft : 0,
    alreadyEntered: isGroupEntry ? usedCount : 0,
    totalGuests: isGroupEntry ? activeCount + usedCount : 1,

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