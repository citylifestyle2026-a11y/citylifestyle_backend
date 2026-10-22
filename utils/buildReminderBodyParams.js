// utils/buildReminderBodyParams.js
//
// Body parameters for the approved WhatsApp template
// "event_attendance_confirmation" (Utility, English):
//
//   Hello {{1}},
//
//   You are registered for the following event:
//
//   Event: {{2}}
//   Date: {{3}}
//   Time: {{4}}
//   Venue: {{5}}
//
//   Kindly confirm whether you will be attending the event by selecting
//   one of the options below.
//
//   Will you be attending?
//
//   [ Yes ]  [ No ]        <- two "Visit website" (dynamic URL) buttons
//
// The order below MUST match {{1}}..{{5}} exactly. Dates are always shown in
// Indian time (the server may run in UTC on Render).
const TIME_ZONE = "Asia/Kolkata";

const formatEventDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);
};

const formatEventTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(date)
    .toUpperCase();
};

const buildReminderBodyParams = ({ contact, event }) => [
  String(contact.fullName || "").trim() || "Guest",
  String(event.title || "").trim() || "the event",
  formatEventDate(event.startDateTime),
  formatEventTime(event.startDateTime),
  String(event.venueName || "").trim() || "-",
];

module.exports = buildReminderBodyParams;
module.exports.formatEventDate = formatEventDate;
module.exports.formatEventTime = formatEventTime;
