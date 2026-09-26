const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const authorize = require("../middlewares/authorize.middleware");
const coordinatorController = require("../controllers/coordinator.controller");

const {
  createCoordinatorValidation,
  updateCoordinatorValidation,
  validate,
} = require("../validators/coordinator.validator");

// PARV CRM Phase 2: Coordinator account management (requirement doc,
// section 2). Admin-only — same convention as User Management
// (routes/user.routes.js) for Checker accounts, but kept in its own
// route tree so the existing Checker/User Management flow is never
// touched. Reuses the same User collection/model with role:"coordinator"
// (see models/user.model.js), the same login endpoint
// (controllers/auth.controller.js), and the same protect/authorize
// middleware — nothing new to wire in there.

// Create Coordinator
router.post(
  "/",
  protect,
  authorize("admin"),
  createCoordinatorValidation,
  validate,
  coordinatorController.createCoordinator
);

// Get All Coordinators — supports ?search=&page=&limit=
router.get("/", protect, authorize("admin"), coordinatorController.getCoordinators);

// Get Coordinator By Id
router.get("/:id", protect, authorize("admin"), coordinatorController.getCoordinatorById);

// Update Coordinator
router.put(
  "/:id",
  protect,
  authorize("admin"),
  updateCoordinatorValidation,
  validate,
  coordinatorController.updateCoordinator
);

// Delete Coordinator
router.delete("/:id", protect, authorize("admin"), coordinatorController.deleteCoordinator);

module.exports = router;
