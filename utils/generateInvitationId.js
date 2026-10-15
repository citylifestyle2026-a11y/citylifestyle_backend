// utils/generateInvitationId.js
//
// NEW "single QR invitation" flow.
// Creates the 8-digit numeric Invitation ID shown in the WhatsApp
// template ("Invitation ID: 63017687") and used in the digital invite
// link (<frontend>/ticket?qr=63017687).
//
// Random (not sequential) so IDs are not guessable one-by-one, and
// checked against Booking.invitationId so it is always unique.
const crypto = require("crypto");
const Booking = require("../models/booking.model");

const randomEightDigits = () => String(crypto.randomInt(10000000, 100000000));

const generateInvitationId = async (session) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = randomEightDigits();
    const query = Booking.exists({ invitationId: candidate });
    const exists = await (session ? query.session(session) : query);

    if (!exists) {
      return candidate;
    }
  }

  throw new Error("Could not generate a unique invitation ID. Please retry.");
};

module.exports = generateInvitationId;
