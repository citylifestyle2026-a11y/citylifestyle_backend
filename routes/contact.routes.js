const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const contactController = require("../controllers/contact.controller");
const upload = require("../middlewares/upload.middleware");

const {
  parseContactFormData,
  createContactValidation,
  updateContactValidation,
  validate,
} = require("../validators/contact.validator");

// Contact profile photo + spouse profile photo. Same 100 MB image
// middleware as the User/Admin profile photo routes — every image is
// re-encoded to compressed WEBP by uploadToLocal before it's saved.
// `parseContactFormData` then restores `references` (sent as a JSON
// string inside multipart/form-data) to an array for the validators.
const contactUpload = upload.largeImageUpload.fields([
  { name: "profileImage", maxCount: 1 },
  { name: "spouseProfileImage", maxCount: 1 },
]);

// `protect` runs before validation, same convention as
// event.routes.js/ticketType.routes.js — an unauthenticated caller
// should never even see field-level validation errors.

// Create Contact
router.post(
  "/create",
  protect,
  contactUpload,
  parseContactFormData,
  createContactValidation,
  validate,
  contactController.createContact
);

// Get All Contacts — supports ?search=&sortBy=&sortOrder=&page=&limit=
// &companyCategory=&reference= (see services/contact.service.js).
router.get(
  "/get-all-contacts",
  protect,
  contactController.getAllContacts
);

// Get Unique References — must be registered BEFORE the "/:id" route
// below, otherwise Express would match "unique-references" as an :id
// param and route it to getContactById instead (which then fails with
// "Invalid Contact ID" since it isn't a Mongo ObjectId). Powers the
// Contact List's "All References" filter dropdown.
router.get(
  "/unique-references",
  protect,
  contactController.getUniqueReferences
);

// Get Reference Summary — must be registered BEFORE the "/:id" route
// below, otherwise Express would match "reference-summary" as an :id
// param and route it to getContactById instead.
router.get(
  "/reference-summary",
  protect,
  contactController.getReferenceSummary
);

// Export Contacts — supports the same ?search=&sortBy=&sortOrder=
// &companyCategory=&reference= query params as get-all-contacts (see
// services/contact.service.js's exportContacts). Must be registered
// BEFORE the "/:id" route below, otherwise Express would match
// "export" as an :id param and route it to getContactById instead.
router.get(
  "/export",
  protect,
  contactController.exportContacts
);

// Get Contact By Id
router.get(
  "/:id",
  protect,
  contactController.getContactById
);

// Update Contact
router.put(
  "/:id/update",
  protect,
  contactUpload,
  parseContactFormData,
  updateContactValidation,
  validate,
  contactController.updateContact
);

// Delete Contact (soft delete)
router.delete(
  "/:id/delete",
  protect,
  contactController.deleteContact
);

module.exports = router;