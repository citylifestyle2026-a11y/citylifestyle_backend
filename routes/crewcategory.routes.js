const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const crewCategoryController = require("../controllers/crewcategory.controller");

const {
  createCrewCategoryValidation,
  updateCrewCategoryValidation,
  validate,
} = require("../validators/crewcategory.validator");

// `protect` runs before validation, same convention as
// contact.routes.js/event.routes.js/ticketType.routes.js — an
// unauthenticated caller should never even see field-level validation
// errors.

// Create Crew Category
router.post(
  "/create",
  protect,
  createCrewCategoryValidation,
  validate,
  crewCategoryController.createCrewCategory
);

// Get All Crew Categories — supports ?search=&sortBy=&sortOrder=&page=&limit=
router.get(
  "/get-all-categories",
  protect,
  crewCategoryController.getAllCrewCategories
);

// Get Crew Category By Id
router.get(
  "/:id",
  protect,
  crewCategoryController.getCrewCategoryById
);

// Update Crew Category
router.put(
  "/:id/update",
  protect,
  updateCrewCategoryValidation,
  validate,
  crewCategoryController.updateCrewCategory
);

// Delete Crew Category (soft delete)
router.delete(
  "/:id/delete",
  protect,
  crewCategoryController.deleteCrewCategory
);

module.exports = router;