const express = require("express");
const router = express.Router();

const upload = require("../middlewares/upload.middleware");
const publicRateLimit = require("../middlewares/publicRateLimit.middleware");
const CompanyCategory = require("../models/companycategory.model");
const contactService = require("../services/contact.service");
const {
  parseContactFormData,
  createContactValidation,
  validate,
} = require("../validators/contact.validator");

// PUBLIC (no login) contact form, opened at <frontend>/city-lifestyle.
// Same validation + same createContact logic as the admin "Create Contact"
// form; the only differences are: no login, createdBy is empty, the response
// never returns the saved contact, and submissions are rate-limited.

const contactUpload = upload.largeImageUpload.fields([
  { name: "profileImage", maxCount: 1 },
  { name: "spouseProfileImage", maxCount: 1 },
]);

// Category dropdown for the public form (id + name only).
router.get("/categories", async (req, res, next) => {
  try {
    const categories = await CompanyCategory.find({ isDeleted: { $ne: true } })
      .select("name")
      .sort({ name: 1 })
      .lean();

    return res.status(200).json({ success: true, data: categories });
  } catch (error) {
    next(error);
  }
});

// Honeypot: real people never fill the hidden `website` field; bots do.
// Pretend success so the bot learns nothing, and save nothing.
const honeypot = (req, res, next) => {
  if (req.body && String(req.body.website || "").trim()) {
    return res.status(201).json({ success: true, message: "Thank you!" });
  }
  return next();
};

router.post(
  "/",
  publicRateLimit({ windowMs: 60 * 60 * 1000, max: 10 }),
  contactUpload,
  honeypot,
  parseContactFormData,
  createContactValidation,
  validate,
  async (req, res, next) => {
    try {
      // Public submissions wait for an admin to approve them in Contact List.
      await contactService.createContact(req.body, null, req.files, {
        approvalStatus: "pending",
      });

      return res.status(201).json({
        success: true,
        message: "Thank you! Your details have been submitted.",
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
