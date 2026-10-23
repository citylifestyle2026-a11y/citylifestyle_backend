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

// Get Unique Areas — also BEFORE "/:id". Powers the Guest List "All Areas"
// filter dropdown.
router.get(
  "/unique-areas",
  protect,
  contactController.getUniqueAreas
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

// Import contacts from a CSV file. Add ?dryRun=true to only check the file.
router.post(
  "/import-csv",
  protect,
  upload.csvUpload.single("file"),
  contactController.importContactsCsv
);

// Approve / Reject / set Pending for one or many contacts (checkbox
// selection). Body: { ids: [...], status }.
router.put(
  "/bulk-status",
  protect,
  contactController.bulkUpdateStatus
);

// Hamper: add approved guests to the Hamper tab, remove them, or mark the
// hamper sent / not sent. Body: { ids: [...], action: add|remove|sent|notSent }.
router.post("/hamper", protect, contactController.updateHamper);

// Send the WhatsApp invitation pass to one or many APPROVED contacts.
// Body: { ids: [...], eventId, ticketTypeId }.
router.post(
  "/send-pass",
  protect,
  contactController.sendPass
);

// Send the SAME pass again (WhatsApp) to approved contacts that already
// have an active pass. Body: { ids: [...] }.
router.post(
  "/resend-pass",
  protect,
  contactController.resendPass
);

// Send the attendance reminder (WhatsApp template with Yes / No buttons) to
// approved guests. Body: { ids: [...], eventId?, includeResponded? }.
router.post(
  "/send-reminder",
  protect,
  contactController.sendReminder
);

// Cancel the pass of approved guest(s): QR stops working, the guest moves
// to Rejected and gets a "your pass has been cancelled" WhatsApp message.
// Body: { ids: [...] }.
router.post("/cancel-pass", protect, contactController.cancelPass);

// Delete the booking (pass) made by Send Pass. Body: { ids: [...] }.
router.post("/delete-booking", protect, contactController.deleteBooking);

// Duplicate tab: form submissions whose WhatsApp number is already in the
// Guest List. Static paths, so they must stay above "/:id".
router.get("/duplicates", protect, contactController.listDuplicates);
// Bulk: body { ids: [...] } or { all: true, search }.
router.post("/duplicates/bulk-fix", protect, contactController.bulkFixDuplicates);
router.post("/duplicates/bulk-ignore", protect, contactController.bulkIgnoreDuplicates);
router.get("/duplicates/:id/preview", protect, contactController.getDuplicatePreview);
router.post("/duplicates/:id/fix", protect, contactController.fixDuplicate);
router.delete("/duplicates/:id", protect, contactController.ignoreDuplicate);

// Merge a Guest List row with the Contact Book member that has the same number.
router.get("/:id/merge-preview", protect, contactController.getMergePreview);
router.post("/:id/merge-member", protect, contactController.mergeWithContactBook);

// Guest count of a contact's already-sent pass (shown in Edit Contact).
router.get("/:id/pass", protect, contactController.getContactPass);
router.put("/:id/pass", protect, contactController.updateContactPass);

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