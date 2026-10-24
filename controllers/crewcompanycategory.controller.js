const crewCompanyCategoryService = require("../services/crewcompanycategory.service");

// ================= CREATE COMPANY CATEGORY =================
// Follows the same pattern as contactController.createContact /
// ticketTypeService.createTicketType(req.body, req.user.id): the
// authenticated admin's id is passed as its own argument, never taken
// from (or spread into) req.body.
const createCrewCompanyCategory = async (req, res, next) => {
  try {
    const category = await crewCompanyCategoryService.createCrewCompanyCategory(
      req.body,
      req.user.id
    );

    return res.status(201).json({
      success: true,
      message: "Crew Company Category created successfully",
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

// ================= GET ALL COMPANY CATEGORIES =================
// Supports: search, sorting, pagination — all parsed inside
// crewCompanyCategoryService.getAllCrewCompanyCategories from req.query, same
// convention as contactController.getAllContacts.
const getAllCrewCompanyCategories = async (req, res, next) => {
  try {
    const result = await crewCompanyCategoryService.getAllCrewCompanyCategories(
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
const getCrewCompanyCategoryById = async (req, res, next) => {
  try {
    const category = await crewCompanyCategoryService.getCrewCompanyCategoryById(
      req.params.id
    );

    return res.status(200).json({
      success: true,
      message: "Crew Company Category fetched successfully",
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

// ================= UPDATE COMPANY CATEGORY =================
const updateCrewCompanyCategory = async (req, res, next) => {
  try {
    const category = await crewCompanyCategoryService.updateCrewCompanyCategory(
      req.params.id,
      req.body
    );

    return res.status(200).json({
      success: true,
      message: "Crew Company Category updated successfully",
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

// ================= DELETE COMPANY CATEGORY (SOFT DELETE) =================
const deleteCrewCompanyCategory = async (req, res, next) => {
  try {
    const category = await crewCompanyCategoryService.deleteCrewCompanyCategory(
      req.params.id,
      req.user.id
    );

    return res.status(200).json({
      success: true,
      message: "Crew Company Category deleted successfully",
      data: category,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createCrewCompanyCategory,
  getAllCrewCompanyCategories,
  getCrewCompanyCategoryById,
  updateCrewCompanyCategory,
  deleteCrewCompanyCategory,
};