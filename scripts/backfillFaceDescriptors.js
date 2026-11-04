// One-time (and re-runnable) job: makes the face fingerprint for every
// already-registered attendee photo, so Face Scan works for old tickets too.
//
//   npm run face:backfill            -> only tickets that have no fingerprint yet
//   node scripts/backfillFaceDescriptors.js --all   -> redo every ticket
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const BookingTicket = require("../models/bookingTicket.model");
const faceService = require("../services/faceRecognition.service");

const redoAll = process.argv.includes("--all");

(async () => {
  await connectDB();

  const filter = {
    isRegistered: true,
    "attendee.profileImagePublicId": { $ne: "" },
  };
  if (!redoAll) filter["attendee.faceDescriptor"] = null; // never processed

  const tickets = await BookingTicket.find(filter).select("_id attendee.profileImage attendee.profileImagePublicId ticketNumber");
  console.log(`Photos to process: ${tickets.length}`);

  let ok = 0;
  let noFace = 0;
  for (const t of tickets) {
    const d =
      (await faceService.getDescriptorFromStoredPhoto(t.attendee.profileImagePublicId)) ||
      (await faceService.getDescriptorFromUrl(t.attendee.profileImage));
    await BookingTicket.updateOne({ _id: t._id }, { $set: { "attendee.faceDescriptor": d || [] } });
    if (d) ok += 1;
    else noFace += 1;
    console.log(`${t.ticketNumber}: ${d ? "face saved" : "no clear face / file missing"}`);
  }

  console.log(`Done. Saved: ${ok}, no face: ${noFace}`);

  // Guest List contacts that already got a pass: copy their photo onto the
  // pass ticket so Face Scan works for them too.
  const Contact = require("../models/contact.model");
  const { syncContactPhotoToPass } = require("../services/contact.service");
  const contacts = await Contact.find({
    isDeleted: { $ne: true },
    profileImage: { $nin: ["", null] },
    $or: [{ passBookingId: { $ne: null } }, { passSentAt: { $ne: null } }],
  });
  console.log(`Guest List contacts with a pass and a photo: ${contacts.length}`);
  for (const c of contacts) {
    await syncContactPhotoToPass(c);
    console.log(`${c.fullName}: pass ticket updated`);
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});