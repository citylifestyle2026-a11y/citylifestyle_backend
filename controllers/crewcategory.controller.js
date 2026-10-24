const crewCategoryService = require("../services/crewcategory.service");

// ================= CREATE COMPANY CATEGORY =================
// Follows the same pattern as contactController.createContact /
// ticketTypeService.createTicketType(req.body, req.user.id): the
// authenticated admin's id is passed as its own argument, never taken
// from (or spread into) req.body.
const createCrewCategory = async (req, res, next) => {
  try {
    const category = await crewCategoryService.createCrewCategory(
      req.body,
      req.user.id
    );

    return res.status(201).json({
      success: true,
      message: "Crew Category created successfully",
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

// ================= GET ALL COMPANY CATEGORIES =================
// Supports: search, sorting, pagination — all parsed inside
// crewCategoryService.getAllCrewCategories from req.query, same
// convention as contactController.getAllContacts.
const getAllCrewCategories = async (req, res, next) => {
  try {
    const result = await crewCategoryService.getAllCrewCategories(
      req.query
    );

    return res.status(200).json({
      success: true,
      message: result.message,
      data: result.data,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
};

// ================= GET COMPANY CATEGORY BY ID =================
const getCrewCategoryById = async (req, res, next) => {
  try {
    const category = await crewCategoryService.getCrewCategoryById(
      req.params.id
    );

    return res.status(200).json({
      success: true,
      message: "Crew Category fetched successfully",
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

// ================= UPDATE COMPANY CATEGORY =================
const updateCrewCategory = async (req, res, next) => {
  try {
    const category = await crewCategoryService.updateCrewCategory(
      req.params.id,
      req.body
    );

    return res.status(200).json({
      success: true,
      message: "Crew Category updated successfully",
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

// ================= DELETE COMPANY CATEGORY (SOFT DELETE) =================
const deleteCrewCategory = async (req, res, next) => {
  try {
    const category = await crewCategoryService.deleteCrewCategory(
      req.params.id,
      req.user.id
    );

    return res.status(200).json({
      success: true,
      message: "Crew Category deleted successfully",
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createCrewCategory,
  getAllCrewCategories,
  getCrewCategoryById,
  updateCrewCategory,
  deleteCrewCategory,
};