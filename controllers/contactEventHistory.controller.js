const contactEventHistoryService = require("../services/contactEventHistory.service");

// ================= CREATE EVENT HISTORY =================
const createEventHistory = async (req, res, next) => {
  try {
    const history = await contactEventHistoryService.createEventHistory(
      req.body,
      req.user.id
    );

    return res.status(201).json({
      success: true,
      message: "Event history entry created successfully",
      data: history,
    });
  } catch (error) {
    next(error);
  }
};

// ================= GET EVENT HISTORY BY CONTACT =================
// GET /api/contact-event-history/contact/:contactId — supports optional
// ?page=&limit= (see contactEventHistoryService.getEventHistoryByContact).
const getEventHistoryByContact = async (req, res, next) => {
  try {
    const result = await contactEventHistoryService.getEventHistoryByContact(
      req.params.contactId,
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

// ================= UPDATE EVENT HISTORY =================
const updateEventHistory = async (req, res, next) => {
  try {
    const history = await contactEventHistoryService.updateEventHistory(
      req.params.id,
      req.body
    );

    return res.status(200).json({
      success: true,
      message: "Event history entry updated successfully",
      data: history,
    });
  } catch (error) {
    next(error);
  }
};

// ================= DELETE EVENT HISTORY (SOFT DELETE) =================
const deleteEventHistory = async (req, res, next) => {
  try {
    const history = await contactEventHistoryService.deleteEventHistory(
      req.params.id,
      req.user.id
    );

    return res.status(200).json({
      success: true,
      message: "Event history entry deleted successfully",
      data: history,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createEventHistory,
  getEventHistoryByContact,
  updateEventHistory,
  deleteEventHistory,
};
