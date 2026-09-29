const contactEventHistoryService = require("../services/contactEventHistory.service");
const eventHistorySyncService = require("../services/eventHistorySync.service");

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

// ================= GET ALL EVENT HISTORY (ALL CONTACTS) =================
// GET /api/contact-event-history/get-all-event-history — supports
// optional ?contactId=&editionId=&status=&page=&limit=. Powers the
// standalone Sidebar "Event History" page.
const getAllEventHistory = async (req, res, next) => {
  try {
    const result = await contactEventHistoryService.getAllEventHistory(req.query);

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

// ================= SYNC SUMMARY (ENTRY REPORT -> ADD TO EVENT HISTORY) =================
// GET /api/contact-event-history/sync-summary?eventId=
// Counts shown in the confirmation popup before anything is saved.
const getSyncSummary = async (req, res, next) => {
  try {
    const data = await eventHistorySyncService.getSyncSummary(req.query.eventId);

    return res.status(200).json({
      success: true,
      message: "Sync summary fetched successfully",
      data,
    });
  } catch (error) {
    next(error);
  }
};

// ================= SYNC FROM EVENT (ENTRY REPORT -> ADD TO EVENT HISTORY) =================
// POST /api/contact-event-history/sync-from-event
// Body: { eventId, ticketIds?: [...], selectAll?: boolean }
const syncFromEvent = async (req, res, next) => {
  try {
    const data = await eventHistorySyncService.syncFromEvent(req.body, req.user.id);

    return res.status(200).json({
      success: true,
      message: `Event history updated: ${data.attendedCount} attended, ${data.notAttendedCount} not attended`,
      data,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getSyncSummary,
  syncFromEvent,
  createEventHistory,
  getAllEventHistory,
  getEventHistoryByContact,
  updateEventHistory,
  deleteEventHistory,
};
