const express = require("express");
const router = express.Router();

const upload = require("../middlewares/upload.middleware");
const publicRateLimit = require("../middlewares/publicRateLimit.middleware");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const cardService = require("../services/inviteCard.service");

// PUBLIC (no login) - the page opened from the link the admin sends:
//   GET  /info          -> is a card design ready? (+ where photo / name go)
//   GET  /design-image  -> the blank card picture for the live preview
//   POST /generate  -> multipart { photo, name } -> the finished card as a JPG
// Generating a card is CPU work, so it is rate-limited per IP (many guests can
// share one Wi-Fi, hence the generous default; change with GUEST_CARD_LIMIT_PER_HOUR).
const limit = parseInt(process.env.GUEST_CARD_LIMIT_PER_HOUR, 10);
const generateLimit = publicRateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number.isFinite(limit) && limit > 0 ? limit : 300,
});

router.get(
  "/info",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ success: true, data: await cardService.publicInfo() });
  })
);

// The blank card picture (no photo / name) - the page draws the guest's photo
// and name on top of it live, before the real card is generated.
router.get(
  "/design-image",
  asyncHandler(async (req, res) => {
    const info = await cardService.publicInfo();
    if (!info.hasDesign) throw new AppError("The card is not ready yet.", 404);
    const jpg = await cardService.previewDesign();
    // The page asks with ?v=<version>, so a new upload gets a new URL.
    res.set("Content-Type", "image/jpeg").set("Cache-Control", "public, max-age=86400").send(jpg);
  })
);

router.post(
  "/generate",
  generateLimit,
  upload.designUpload.single("photo"),
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || "").replace(/\s+/g, " ").trim();
    if (!name) throw new AppError("Please type your name.", 400);
    if (name.length > 60) throw new AppError("Name is too long (max 60 characters).", 400);
    if (!req.file || !Buffer.isBuffer(req.file.buffer)) {
      throw new AppError("Please upload your photo (JPG or PNG).", 400);
    }

    const info = await cardService.publicInfo();
    if (!info.hasDesign) throw new AppError("The card is not ready yet. Please try later.", 404);

    const jpg = await cardService.generateGuestCard(name, req.file.buffer);
    res.set("Content-Type", "image/jpeg").set("Cache-Control", "no-store").send(jpg);
  })
);

module.exports = router;