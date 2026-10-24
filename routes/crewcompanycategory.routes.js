const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const crewCompanyCategoryController = require("../controllers/crewcompanycategory.controller");

const {
  createCrewCompanyCategoryValidation,
  updateCrewCompanyCategoryValidation,
  validate,
} = require("../validators/crewcompanycategory.validator");

// `protect` runs before validation, same convention as
// contact.routes.js/event.routes.js/ticketType.routes.js — an
// unauthenticated caller should never even see field-level validation
// errors.

// Create Crew Company Category
router.post(
  "/create",
  protect,
  createCrewCompanyCategoryValidation,
  validate,
  crewCompanyCategoryController.createCrewCompanyCategory
);

// Get All Crew Company Categories — supports ?search=&sortBy=&sortOrder=&page=&limit=
router.get(
  "/get-all-categories",
  protect,
  crewCompanyCategoryController.getAllCrewCompanyCategories
);

// Get Crew Company Category By Id
router.get(
  "/:id",
  protect,
  crewCompanyCategoryController.getCrewCompanyCategoryById
);

// Update Crew Company Category
router.put(
  "/:id/update",
  protect,
  updateCrewCompanyCategoryValidation,
  validate,
  crewCompanyCategoryController.updateCrewCompanyCategory
);

// Delete Crew Company Category (soft delete)
router.delete(
  "/:id/delete",
  protect,
  crewCompanyCategoryController.deleteCrewCompanyCategory
);

module.exports = router;