// "Let's Run" works WITHOUT an Event, and the form is ALWAYS open.
//
// The date / time / venue of the run come from .env:
//   LETS_RUN_START   ISO date-time, default 2026-11-29T05:30:00+05:30
//   LETS_RUN_VENUE / LETS_RUN_ADDRESS / LETS_RUN_MAP_LINK / LETS_RUN_DRESS_CODE (optional)
//
// RUN WITHOUT AN EVENT = identified by its DATE (the calendar day in India):
//   - only the TIME of LETS_RUN_START changes (same date): still the same run. Every
//     registration of that date shows the new time on its pass, in the WhatsApp
//     message and on the scanner; nobody registers twice; numbers carry on.
//   - the DATE changes: a NEW run. Registrations start again (RUN020001, ...), the
//     same mobile number can register again with a new QR, and the passes of the
//     earlier date keep their own date.
// (To send people the new time again: Run Report -> tick -> Resend.)
//
// If a "Let's Run" EVENT exists and has not ended, it is used instead (its own
// date / venue) and registrations belong to the event.
const LETS_RUN_NAME = "Let's Run";

const toDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const getRunSettings = async () => ({
  startDateTime: toDate(process.env.LETS_RUN_START) || new Date("2026-11-29T05:30:00+05:30"),
  venueName: process.env.LETS_RUN_VENUE || "",
  address: process.env.LETS_RUN_ADDRESS || "",
  mapLink: process.env.LETS_RUN_MAP_LINK || "",
  dressCode: process.env.LETS_RUN_DRESS_CODE || "Sportswear",
});

const editionKeyOf = (date) => new Date(date).toISOString();

// "2026-11-29" = the calendar day in India (IST, UTC+5:30) of an ISO date / Date.
const istDay = (value) => {
  const d = toDate(value);
  return d ? new Date(d.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10) : "";
};

// editionKey range covering that whole IST day (ISO strings sort like dates).
const istDayRange = (value) => {
  const day = istDay(value);
  if (!day) return null;
  return {
    $gte: new Date(`${day}T00:00:00.000+05:30`).toISOString(),
    $lte: new Date(`${day}T23:59:59.999+05:30`).toISOString(),
  };
};

// Event-shaped object for the form header, pass page, WhatsApp and scanner, so
// callers never branch on "no event".
//   event       -> the Let's Run event (its own date / venue)
//   editionKey  -> a no-event run (the start the row was registered with). Same date as
//                  .env now -> the CURRENT time of .env; an earlier date keeps its own.
const getRunSchedule = async (event, editionKey = "") => {
  if (event) {
    return {
      isFallback: false,
      _id: event._id,
      title: LETS_RUN_NAME,
      image: event.image || "",
      startDateTime: event.startDateTime,
      endDateTime: event.endDateTime || null,
      venueName: event.venueName || "",
      address: event.address || "",
      dressCode: event.dressCode || "Sportswear",
      mapLink: event.mapLink || "",
      latitude: event.latitude,
      longitude: event.longitude,
      termsConditions: event.termsConditions || "",
    };
  }

  const settings = await getRunSettings();
  const rowStart = toDate(editionKey);
  const sameDay = !rowStart || istDay(rowStart) === istDay(settings.startDateTime);
  return {
    isFallback: true,
    _id: null,
    title: LETS_RUN_NAME,
    image: "",
    startDateTime: sameDay ? settings.startDateTime : rowStart,
    endDateTime: null,
    venueName: settings.venueName,
    address: settings.address,
    dressCode: settings.dressCode,
    mapLink: settings.mapLink,
    latitude: undefined,
    longitude: undefined,
    termsConditions: "",
  };
};

module.exports = { LETS_RUN_NAME, getRunSettings, getRunSchedule, editionKeyOf, istDay, istDayRange };