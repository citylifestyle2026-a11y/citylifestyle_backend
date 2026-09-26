const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const contactEventHistoryController = require("../controllers/contactEventHistory.controller");

const {
  createEventHistoryValidation,
  updateEventHistoryValidation,
  validate,
} = require("../validators/contactEventHistory.validator");

// Contact List -> Event History (Step 4). Same access as
// routes/contact.routes.js itself — `protect` only, no `authorize(...)`
// role restriction — since this is per-contact data reached from the
// Contact List page, which every authenticated role can already open.

// Create Event History Entry
router.post(
  "/create",
  protect,
  createEventHistoryValidation,
  validate,
  contactEventHistoryController.createEventHistory
);

// Get Event History for a Contact — supports ?page=&limit=
router.get(
  "/contact/:contactId",
  protect,
  contactEventHistoryController.getEventHistoryByContact
);

// Update Event History Entry
router.put(
  "/:id/update",
  protect,
  updateEventHistoryValidation,
  validate,
  contactEventHistoryController.updateEventHistory
);

// Delete Event History Entry (soft delete)
router.delete(
  "/:id/delete",
  protect,
  contactEventHistoryController.deleteEventHistory
);

module.exports = router;
