const guestService = require("../services/guest.service");

// ================= CREATE GUEST =================
const createGuest = async (req, res, next) => {
  try {
    const guest = await guestService.createGuest(req.body, req.user.id);

    return res.status(201).json({
      success: true,
      message: "Guest created successfully",
      data: guest,
    });
  } catch (error) {
    next(error);
  }
};

// ================= GET ALL GUESTS =================
const getAllGuests = async (req, res, next) => {
  try {
    const result = await guestService.getAllGuests(req.query);

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

// ================= GET GUEST BY ID =================
const getGuestById = async (req, res, next) => {
  try {
    const guest = await guestService.getGuestById(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Guest fetched successfully",
      data: guest,
    });
  } catch (error) {
    next(error);
  }
};

// ================= UPDATE GUEST =================
const updateGuest = async (req, res, next) => {
  try {
    const guest = await guestService.updateGuest(req.params.id, req.body);

    return res.status(200).json({
      success: true,
      message: "Guest updated successfully",
      data: guest,
    });
  } catch (error) {
    next(error);
  }
};

// ================= DELETE GUEST =================
const deleteGuest = async (req, res, next) => {
  try {
    await guestService.deleteGuest(req.params.id, req.user.id);

    return res.status(200).json({
      success: true,
      message: "Guest deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createGuest,
  getAllGuests,
  getGuestById,
  updateGuest,
  deleteGuest,
};
