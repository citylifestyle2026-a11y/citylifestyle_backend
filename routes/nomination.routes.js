const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const authorize = require("../middlewares/authorize.middleware");
const nominationController = require("../controllers/nomination.controller");

const {
  createNominationValidation,
  validate,
} = require("../validators/nomination.validator");

// PARV CRM Phase 2: Nomination module (requirement doc, section 4). A
// Coordinator submits guests for an edition; an Admin can do the same on
// a coordinator's behalf and see everything. Built ON TOP of the
// existing Guest/Edition collections (Phase 1) rather than opening
// guest.routes.js/edition.routes.js to the "coordinator" role — see the
// comment already left in guest.routes.js anticipating this split.
//
// Review/approval actions (status transitions beyond the default
// "Nominated") are Phase 4 and are NOT exposed here.

// Create Nomination
router.post(
  "/create",
  protect,
  authorize("admin", "coordinator"),
  createNominationValidation,
  validate,
  nominationController.createNomination
);

// Get All Nominations — Coordinator sees only their own nominations
// (RBAC-scoped in services/nomination.service.js); Admin sees everything
// and may filter with ?coordinatorId=&editionId=&status=&sortBy=
// &sortOrder=&page=&limit=.
router.get(
  "/get-all-nominations",
  protect,
  authorize("admin", "coordinator"),
  nominationController.getAllNominations
);

// Get Nomination By Id — same ownership check as above, enforced in the
// service.
router.get(
  "/:id",
  protect,
  authorize("admin", "coordinator"),
  nominationController.getNominationById
);

module.exports = router;
