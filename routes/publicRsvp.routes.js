const express = require("express");
const router = express.Router();

const publicRsvpController = require("../controllers/publicRsvp.controller");
const publicRateLimit = require("../middlewares/publicRateLimit.middleware");

// Public (no login) - opened from the Yes / No buttons of the attendance
// reminder WhatsApp message (frontend: /rsvp/yes/:token, /rsvp/no/:token).
// A guest can change their answer a few times, so the limit is generous.
// Limit is per guest link (token), not per IP: many guests share one IP on
// mobile data / venue wifi, which caused "Too many submissions" errors.
const limiter = publicRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => `rsvp:${req.params.token}`,
});

router.get("/:token", limiter, publicRsvpController.getRsvp);
router.post("/:token", limiter, publicRsvpController.submitRsvp);

module.exports = router;