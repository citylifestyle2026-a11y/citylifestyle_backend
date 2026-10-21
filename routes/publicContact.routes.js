const express = require("express");
const router = express.Router();

const upload = require("../middlewares/upload.middleware");
const publicRateLimit = require("../middlewares/publicRateLimit.middleware");
const CompanyCategory = require("../models/companycategory.model");
const contactService = require("../services/contact.service");
const formLinkService = require("../services/formLink.service");
const contactDuplicateService = require("../services/contactDuplicate.service");
const { sendRegistrationAck } = require("../services/registrationAck.service");
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

// Info for a "Share Form Link" (name + how many places are left), so the
// public page can show the form, or a "closed / full" message.
router.get("/link/:token", async (req, res, next) => {
  try {
    const data = await formLinkService.getPublicInfo(req.params.token);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

const normalLimit = publicRateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
// One person may fill the form for several people from the same phone, so a
// link (whose quantity is the real limit) gets a higher per-IP allowance.
const linkLimit = publicRateLimit({ windowMs: 60 * 60 * 1000, max: 200 });
const rateLimit = (req, res, next) =>
  (req.query.link ? linkLimit : normalLimit)(req, res, next);

router.post(
  "/",
  rateLimit,
  contactUpload,
  honeypot,
  parseContactFormData,
  formLinkService.attachLink, // ?link=<token>: forces the link's name as Reference
  createContactValidation,
  validate,
  async (req, res, next) => {
    try {
      if (req.formLink) {
        // Counts one place on the link, then saves in Contact List / Member List.
        await formLinkService.submitThroughLink(req.formLink, req.body, req.files);
      } else {
        // A number that is already in the Guest List is parked in the
        // Guest List "Duplicate" tab (no new row, no pass) - the person
        // still just sees the normal thank-you message.
        const duplicate = await contactDuplicateService.captureIfDuplicate(
          req.body,
          req.files,
          { source: "form" }
        );

        // Public submissions wait for an admin to approve them in Contact List.
        if (!duplicate) {
          await contactService.createContact(req.body, null, req.files, {
            approvalStatus: "pending",
          });
        }
      }

      // "Registration received" WhatsApp message. Fire-and-forget: it never
      // delays or fails the form (errors are logged inside the service).
      sendRegistrationAck({
        name: req.body.fullName,
        phone: req.body.whatsappNumber,
      });

      return res.status(201).json({
        success: true,
        message:
          "Thank you! Your details have been received. Our team will review them and inform you whether your participation in Parv is confirmed.",
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;