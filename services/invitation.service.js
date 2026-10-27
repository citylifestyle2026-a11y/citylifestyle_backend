// services/invitation.service.js
//
// NEW "single QR invitation" flow (BOOKING_NOTIFICATION_MODE=qr_invite).
//
//  - ONE invitation message per booking, whatever the quantity
//    (1, 2, 3, 4, 5 ... guests all get the SAME single QR / link).
//  - The QR belongs to the booking's first ticket. When it is scanned
//    at the gate, every guest of that booking is checked in at once
//    (see services/qr.service.js).
//
// The OLD flow (registration link + one QR per ticket) is NOT removed:
// it is still in booking.service.js / publicRegistration.service.js and
// is switched back on with BOOKING_NOTIFICATION_MODE=registration_link.
const BookingTicket = require("../models/bookingTicket.model");
const Booking = require("../models/booking.model");
const Event = require("../models/event.model");
const TicketType = require("../models/ticketType.model");
const AppError = require("../utils/AppError");
const whatsappService = require("./whatsapp.service");
const buildInvitationBodyParams = require("../utils/buildInvitationBodyParams");
const generateQrCode = require("../utils/generateQrCode");
const Contact = require("../models/contact.model");
const Member = require("../models/member.model");
const { toReferenceList } = require("../utils/splitReferences");
const {
  normalizeName,
  nameSimilarityScore,
  POSSIBLE_DUPLICATE_THRESHOLD,
} = require("../utils/nameSimilarity");

// ================= MODE SWITCH =================
// "qr_invite"         (default) -> NEW: one WhatsApp invitation with one QR link
// "registration_link"           -> OLD: registration link, one QR per guest
const getNotificationMode = () =>
  String(process.env.BOOKING_NOTIFICATION_MODE || "qr_invite").trim().toLowerCase() ===
  "registration_link"
    ? "registration_link"
    : "qr_invite";

const isQrInviteMode = () => getNotificationMode() === "qr_invite";

// ================= SEND THE INVITATION TEMPLATE =================
// Throws on failure; callers decide whether that is best-effort
// (booking creation) or must surface (manual resend).
const sendInvitationMessage = async ({ booking, event }) => {
  const templateName =
    process.env.CHATBOX_INVITE_TEMPLATE_NAME || "parv_invitation_confirmed";
  const languageCode = process.env.CHATBOX_INVITE_TEMPLATE_LANGUAGE || "en";

  return whatsappService.sendTemplateMessage({
    phone: booking.mobileNumber,
    templateName,
    languageCode,
    bodyParams: buildInvitationBodyParams({ booking, event }),
  });
};

// Best-effort wrapper used right after the booking transaction commits:
// a WhatsApp outage must never fail an already-saved booking.
const sendInvitationBestEffort = async (booking, event) => {
  try {
    await sendInvitationMessage({ booking, event });
  } catch (error) {
    console.error(
      `WhatsApp invitation failed for booking ${booking.bookingNumber}:`,
      error
    );
  }
};

// ================= "INVITED BY" (the guest's Reference) =================
// A booking does not store a reference itself, so it is looked up from the
// guest's Contact (Contact List) by 10-digit mobile number, falling back to
// the Contact Book (Member List). When several people share one number
// (husband / wife) the one whose name matches the booking is used.
// Never throws: a lookup problem must not break the pass.
const isSamePerson = (nameA, nameB) => {
  const a = normalizeName(nameA);
  const b = normalizeName(nameB);
  if (!a || !b) return true;
  if (a === b) return true;
  if (nameSimilarityScore(a, b) >= POSSIBLE_DUPLICATE_THRESHOLD) return true;
  const ta = a.split(" ");
  const tb = b.split(" ");
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return small.every((token) => big.includes(token));
};

const findReferencesForBooking = async (booking) => {
  try {
    const last10 = String(booking.mobileNumber || "").replace(/\D/g, "").slice(-10);
    if (last10.length !== 10) return [];

    const contacts = await Contact.find({
      whatsappNumber: new RegExp(`${last10}$`),
      isDeleted: { $ne: true },
      historyOnly: { $ne: true },
    })
      .select("fullName spouseName references")
      .lean();

    const withRefs = contacts.filter((c) => Array.isArray(c.references) && c.references.length);
    const best =
      withRefs.find((c) => isSamePerson(c.fullName, booking.name)) ||
      withRefs.find((c) => c.spouseName && isSamePerson(c.spouseName, booking.name)) ||
      withRefs[0];
    if (best) return toReferenceList(best.references);

    const members = await Member.find({ mobile: last10 }).select("name references").lean();
    const memberWithRefs = members.filter(
      (m) => Array.isArray(m.references) && m.references.length
    );
    const memberBest =
      memberWithRefs.find((m) => isSamePerson(m.name, booking.name)) || memberWithRefs[0];
    return memberBest ? toReferenceList(memberBest.references) : [];
  } catch (error) {
    console.error("Invited-by lookup failed:", error?.message || error);
    return [];
  }
};

// ================= PUBLIC INVITATION (for /ticket?qr=<invitationId>) =================
// The one QR is the first ticket (by creation order) of the booking.
const getPublicInvitation = async (invitationId) => {
  const booking = await Booking.findOne({ invitationId, isDeleted: false });

  if (!booking) {
    throw new AppError("Invitation not found.", 404);
  }

  const [event, ticketType, primaryTicket, usedCount, references] = await Promise.all([
    Event.findById(booking.eventId),
    TicketType.findById(booking.ticketTypeId),
    BookingTicket.findOne({ bookingId: booking._id }).sort({ createdAt: 1, _id: 1 }),
    BookingTicket.countDocuments({ bookingId: booking._id, status: "Used" }),
    findReferencesForBooking(booking),
  ]);

  if (!event || !primaryTicket) {
    throw new AppError("Invitation not found.", 404);
  }

  // The QR on the pass encodes ONLY the short 8-digit Invitation ID (the
  // same number printed under it as "Booking / Verification Code"), so it
  // is a small, easy-to-scan code. qr.service.js resolves that ID back to
  // this booking's ticket when the gate scans it.
  // It is generated here and sent inline (not a link under /uploads) so the
  // pass keeps working even if the server disk is wiped (e.g. Render
  // redeploy/restart). Falls back to the stored image URL if that fails.
  let qrImage = primaryTicket.qrImage;
  try {
    const qrBuffer = await generateQrCode(booking.invitationId);
    qrImage = `data:image/png;base64,${qrBuffer.toString("base64")}`;
  } catch (error) {
    console.error("Invitation QR regeneration failed, using stored image:", error);
  }

  return {
    invitationId: booking.invitationId,
    guestName: booking.name,
    companyName: booking.companyName || "",
    mobileNumber: String(booking.mobileNumber || "").replace(/^91(?=\d{10}$)/, ""),
    // Contact shown under "Venue & Event Help" (set in .env)
    contact: {
      name: process.env.EVENT_CONTACT_NAME || "Aniket Patel",
      number: process.env.EVENT_CONTACT_NUMBER || "7016851932",
    },
    numberOfGuests: booking.quantity,
    // Who invited this guest (the guest's Reference name(s)). [] if none.
    references,
    qrImage,
    isUsed: primaryTicket.status === "Used" || usedCount > 0,
    isCancelled: primaryTicket.status === "Cancelled",
    ticketName: ticketType?.ticketName || "",
    event: {
      title: event.title,
      image: event.image,
      date: buildInvitationBodyParams.formatEventDate(event.startDateTime),
      time: buildInvitationBodyParams.formatEventTime(event.startDateTime),
      venueName: event.venueName,
      address: event.address,
      dressCode: event.dressCode || "Traditional",
      locationUrl: buildInvitationBodyParams.buildVenueLocationUrl(event),
    },
  };
};

module.exports = {
  getNotificationMode,
  isQrInviteMode,
  sendInvitationMessage,
  sendInvitationBestEffort,
  getPublicInvitation,
};