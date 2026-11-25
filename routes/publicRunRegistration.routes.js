const express = require("express");
const router = express.Router();

const asyncHandler = require("../utils/asyncHandler");
const publicRateLimit = require("../middlewares/publicRateLimit.middleware");
const runService = require("../services/runRegistration.service");

// Public (no login) - the page opened from the WhatsApp link (frontend:
// /run/:token). The token in the address is the ONLY thing that identifies the
// person; the mobile number is never taken from the request.
// Limit is per link (token), not per IP: many people share one IP on mobile
// data / venue wifi.
const limiter = publicRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => `run:${req.params.token}`,
});

router.get(
  "/:token",
  limiter,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await runService.getPublicRun(req.params.token) });
  })
);

router.post(
  "/:token",
  limiter,
  asyncHandler(async (req, res) => {
    const data = await runService.submitPublicRun(req.params.token, req.body);
    res.status(201).json({ success: true, message: "Registration successful.", data });
  })
);

module.exports = router;
