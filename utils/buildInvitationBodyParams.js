// utils/buildInvitationBodyParams.js
//
// NEW "single QR invitation" flow.
// Builds the ordered BODY parameters for the approved WhatsApp template
// "YOUR INVITATION TO PARV IS CONFIRMED" (body only, no header/button --
// the invite link and map link are plain {{10}} / {{11}} text variables).
//
// ORDER MUST MATCH THE APPROVED TEMPLATE EXACTLY:
//   {{1}}  Dear {{1}}            -> booking.name
//   {{2}}  Event                 -> event.title
//   {{3}}  Guest Name            -> booking.name
//   {{4}}  Number of Guests      -> booking.quantity
//   {{5}}  Date                  -> DD-MM-YYYY (IST)
//   {{6}}  Time                  -> h:mm AM/PM (IST)
//   {{7}}  Venue                 -> event.venueName
//   {{8}}  Dress Code            -> event.dressCode (default "Traditional")
//   {{9}}  Invitation ID         -> booking.invitationId
//   {{10}} Your Digital Invite   -> <PUBLIC_INVITE_URL_BASE>/ticket?qr=<invitationId>
//   {{11}} Venue Location        -> event.mapLink, else Google Maps link from lat/lng
//
// Changing the order/count needs the WhatsApp template to be re-approved.
const AppError = require("./AppError");

const IST = "Asia/Kolkata";

const formatEventDate = (value) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date(value));

  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("day")}-${get("month")}-${get("year")}`;
};

const formatEventTime = (value) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: IST,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(value))
    .replace(/\u202f/g, " "); // newer Node uses a narrow no-break space before AM/PM

const buildInvitationUrl = (invitationId) => {
  const base = process.env.PUBLIC_INVITE_URL_BASE || process.env.PUBLIC_FRONTEND_URL;

  if (!base || !String(base).trim()) {
    throw new AppError(
      "PUBLIC_INVITE_URL_BASE (or PUBLIC_FRONTEND_URL) is not configured. Cannot build the digital invite link.",
      500
    );
  }

  return `${String(base).trim().replace(/\/+$/, "")}/ticket?qr=${invitationId}`;
};

const buildVenueLocationUrl = (event) => {
  if (event.mapLink && String(event.mapLink).trim()) {
    return String(event.mapLink).trim();
  }

  if (event.latitude && event.longitude) {
    return `https://www.google.com/maps?q=${event.latitude},${event.longitude}`;
  }

  return "";
};

const buildInvitationBodyParams = ({ booking, event }) => [
  booking.name,
  event.title,
  booking.name,
  booking.quantity,
  formatEventDate(event.startDateTime),
  formatEventTime(event.startDateTime),
  event.venueName,
  event.dressCode || "Traditional",
  booking.invitationId,
  buildInvitationUrl(booking.invitationId),
  buildVenueLocationUrl(event) || event.address || "-",
];

module.exports = buildInvitationBodyParams;
module.exports.buildInvitationUrl = buildInvitationUrl;
module.exports.formatEventDate = formatEventDate;
module.exports.formatEventTime = formatEventTime;
module.exports.buildVenueLocationUrl = buildVenueLocationUrl;
