// "Let's Run" works WITHOUT an Event, and the form is ALWAYS open.
//
// The date / time / venue of the run come from .env:
//   LETS_RUN_START   ISO date-time, default 2026-11-29T05:30:00+05:30
//   LETS_RUN_VENUE / LETS_RUN_ADDRESS / LETS_RUN_MAP_LINK / LETS_RUN_DRESS_CODE (optional)
//
// NEXT RUN: change LETS_RUN_START in .env (and restart). Registrations made from
// then on belong to the new run: the same mobile number can register again and
// gets a NEW QR. Earlier entries stay in the Run Report, and old passes keep
// showing their own date (every no-event row stores its run's start in editionKey).
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

// Event-shaped object for the form header, pass page, WhatsApp and scanner, so
// callers never branch on "no event".
//   event       -> the Let's Run event (its own date / venue)
//   editionKey  -> a no-event run (ISO start of THAT run: an old pass keeps its own date)
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
  return {
    isFallback: true,
    _id: null,
    title: LETS_RUN_NAME,
    image: "",
    startDateTime: toDate(editionKey) || settings.startDateTime,
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

module.exports = { LETS_RUN_NAME, getRunSettings, getRunSchedule, editionKeyOf };
