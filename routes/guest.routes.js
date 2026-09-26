const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const authorize = require("../middlewares/authorize.middleware");
const guestController = require("../controllers/guest.controller");

const {
  createGuestValidation,
  updateGuestValidation,
  validate,
} = require("../validators/guest.validator");

// Phase 1: Guest is the Master Guest Database (PARV CRM requirement doc,
// section 3). Admin-only for now — Coordinator's own scoped "add/view my
// nominations" access is introduced in Phase 2 as its own Nomination
// module built ON TOP of this Guest collection, not by opening these
// routes to the "checker" role.

// Create Guest
router.post(
  "/create",
  protect,
  authorize("admin"),
  createGuestValidation,
  validate,
  guestController.createGuest
);

// Get All Guests — supports ?search=&sortBy=&sortOrder=&page=&limit=
// &category=&city=&isVip= (see services/guest.service.js).
router.get("/get-all-guests", protect, authorize("admin"), guestController.getAllGuests);

// Get Guest By Id
router.get("/:id", protect, authorize("admin"), guestController.getGuestById);

// Update Guest
router.put(
  "/:id/update",
  protect,
  authorize("admin"),
  updateGuestValidation,
  validate,
  guestController.updateGuest
);

// Delete Guest (soft delete)
router.delete("/:id/delete", protect, authorize("admin"), guestController.deleteGuest);

module.exports = router;
