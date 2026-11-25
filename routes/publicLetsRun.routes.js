const express = require("express");
const router = express.Router();

const asyncHandler = require("../utils/asyncHandler");
const publicRateLimit = require("../middlewares/publicRateLimit.middleware");
const runService = require("../services/runRegistration.service");

// Public (no login) - the "Let's Run" form at  <site>/lets-run
// Name + mobile number only. Limit is per IP + mobile number, so many people
// on one venue wifi / mobile network never block each other, while one number
// cannot be used to spam WhatsApp.
const submitLimiter = publicRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req, ip) => `lets-run:${ip}:${String(req.body?.mobile ?? req.body?.mobileNumber ?? "")}`,
});

// Event shown on top of the form (the current active event).
router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await runService.getLetsRunInfo() });
  })
);

router.post(
  "/",
  submitLimiter,
  asyncHandler(async (req, res) => {
    const data = await runService.submitLetsRun(req.body);
    res.status(201).json({
      success: true,
      message: data.whatsappSent
        ? "Your ticket has been sent on WhatsApp."
        : "Registered, but we could not send the WhatsApp message. Please open your ticket from this page.",
      data,
    });
  })
);

module.exports = router;
