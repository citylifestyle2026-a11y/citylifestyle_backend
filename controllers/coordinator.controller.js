const coordinatorService = require("../services/coordinator.service");

// ================= CREATE COORDINATOR =================
const createCoordinator = async (req, res, next) => {
  try {
    const coordinator = await coordinatorService.createCoordinator(req.user, req.body);

    return res.status(201).json({
      success: true,
      message: "Coordinator created successfully",
      data: coordinator,
    });
  } catch (error) {
    next(error);
  }
};

// ================= GET ALL COORDINATORS =================
const getCoordinators = async (req, res, next) => {
  try {
    const result = await coordinatorService.getCoordinators(req.query);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// ================= GET COORDINATOR BY ID =================
const getCoordinatorById = async (req, res, next) => {
  try {
    const coordinator = await coordinatorService.getCoordinatorById(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Coordinator fetched successfully",
      data: coordinator,
    });
  } catch (error) {
    next(error);
  }
};

// ================= UPDATE COORDINATOR =================
const updateCoordinator = async (req, res, next) => {
  try {
    const coordinator = await coordinatorService.updateCoordinator(req.params.id, req.body);

    return res.status(200).json({
      success: true,
      message: "Coordinator updated successfully",
      data: coordinator,
    });
  } catch (error) {
    next(error);
  }
};

// ================= DELETE COORDINATOR =================
const deleteCoordinator = async (req, res, next) => {
  try {
    await coordinatorService.deleteCoordinator(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Coordinator deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createCoordinator,
  getCoordinators,
  getCoordinatorById,
  updateCoordinator,
  deleteCoordinator,
};
