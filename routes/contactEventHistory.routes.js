const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const authorize = require("../middlewares/authorize.middleware");
const contactEventHistoryController = require("../controllers/contactEventHistory.controller");

const {
  createEventHistoryValidation,
  updateEventHistoryValidation,
  markAttendanceValidation,
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

// Entry Report -> "Add to Event History" (admin only).
// GET  /sync-summary?eventId=   counts for the confirmation popup
// POST /sync-from-event         { eventId, ticketIds?, selectAll? } saves the
//                               Attended (selected) + Not Attended (booked,
//                               never scanned) rows for that event's edition.
router.get(
  "/sync-summary",
  protect,
  authorize("admin"),
  contactEventHistoryController.getSyncSummary
);

router.post(
  "/sync-from-event",
  protect,
  authorize("admin"),
  contactEventHistoryController.syncFromEvent
);

// Get All Event History (every contact) — supports
// ?contactId=&editionId=&status=&page=&limit=. Powers the standalone
// Sidebar "Event History" page.
router.get(
  "/get-all-event-history",
  protect,
  contactEventHistoryController.getAllEventHistory
);

// Excel download of the Event History (same ?eventId=&search= filters as the
// list; every matching entry, not just one page).
router.get(
  "/export",
  protect,
  contactEventHistoryController.exportEventHistory
);

// Attended / Not Attended counts for the Event History page (same
// ?eventId=&search= filters as the list).
router.get(
  "/stats",
  protect,
  contactEventHistoryController.getHistoryStats
);

// Mark a guest Attended by hand (pass never scanned but the guest came).
router.patch(
  "/:id/attendance",
  protect,
  markAttendanceValidation,
  validate,
  contactEventHistoryController.markAttendance
);

// Editions that have history (also those of deleted events) - filter dropdown.
router.get(
  "/editions",
  protect,
  contactEventHistoryController.getHistoryEditions
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
