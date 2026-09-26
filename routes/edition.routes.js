const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const authorize = require("../middlewares/authorize.middleware");
const editionController = require("../controllers/edition.controller");

const {
  createEditionValidation,
  updateEditionValidation,
  validate,
} = require("../validators/edition.validator");

// Phase 1: Edition Management (PARV CRM requirement doc, section 3).
// Admin-only — Coordinators only ever SELECT an active edition when
// nominating (Phase 2); they never create/edit editions themselves.

// Create Edition
router.post(
  "/create",
  protect,
  authorize("admin"),
  createEditionValidation,
  validate,
  editionController.createEdition
);

// Get All Editions — supports ?search=&sortBy=&sortOrder=&page=&limit=
// &status=&year= (see services/edition.service.js).
router.get("/get-all-editions", protect, authorize("admin"), editionController.getAllEditions);

// Get Edition By Id
router.get("/:id", protect, authorize("admin"), editionController.getEditionById);

// Update Edition
router.put(
  "/:id/update",
  protect,
  authorize("admin"),
  updateEditionValidation,
  validate,
  editionController.updateEdition
);

// Delete Edition (soft delete)
router.delete("/:id/delete", protect, authorize("admin"), editionController.deleteEdition);

module.exports = router;
