const editionService = require("../services/edition.service");

// ================= CREATE EDITION =================
const createEdition = async (req, res, next) => {
  try {
    const edition = await editionService.createEdition(req.body, req.user.id);

    return res.status(201).json({
      success: true,
      message: "Edition created successfully",
      data: edition,
    });
  } catch (error) {
    next(error);
  }
};

// ================= GET ALL EDITIONS =================
const getAllEditions = async (req, res, next) => {
  try {
    const result = await editionService.getAllEditions(req.query);

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

// ================= GET EDITION BY ID =================
const getEditionById = async (req, res, next) => {
  try {
    const edition = await editionService.getEditionById(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Edition fetched successfully",
      data: edition,
    });
  } catch (error) {
    next(error);
  }
};

// ================= UPDATE EDITION =================
const updateEdition = async (req, res, next) => {
  try {
    const edition = await editionService.updateEdition(req.params.id, req.body);

    return res.status(200).json({
      success: true,
      message: "Edition updated successfully",
      data: edition,
    });
  } catch (error) {
    next(error);
  }
};

// ================= DELETE EDITION =================
const deleteEdition = async (req, res, next) => {
  try {
    await editionService.deleteEdition(req.params.id, req.user.id);

    return res.status(200).json({
      success: true,
      message: "Edition deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createEdition,
  getAllEditions,
  getEditionById,
  updateEdition,
  deleteEdition,
};
