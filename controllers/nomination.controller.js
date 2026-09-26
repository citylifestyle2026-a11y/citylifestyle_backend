const nominationService = require("../services/nomination.service");

// ================= CREATE NOMINATION =================
const createNomination = async (req, res, next) => {
  try {
    const nomination = await nominationService.createNomination(req.user, req.body);

    return res.status(201).json({
      success: true,
      message: "Nomination created successfully",
      data: nomination,
    });
  } catch (error) {
    next(error);
  }
};

// ================= GET ALL NOMINATIONS =================
const getAllNominations = async (req, res, next) => {
  try {
    const result = await nominationService.getAllNominations(req.query, req.user);

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

// ================= GET NOMINATION BY ID =================
const getNominationById = async (req, res, next) => {
  try {
    const nomination = await nominationService.getNominationById(req.params.id, req.user);

    return res.status(200).json({
      success: true,
      message: "Nomination fetched successfully",
      data: nomination,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createNomination,
  getAllNominations,
  getNominationById,
};
