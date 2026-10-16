const contactService = require("../services/contact.service");
const contactImportService = require("../services/contactImport.service");

// ================= CREATE CONTACT =================
// Follows the same pattern as companyCategoryController.createCompanyCategory /
// ticketTypeService.createTicketType(req.body, req.user.id): the
// authenticated admin's id is passed as its own argument, never taken
// from (or spread into) req.body.
const createContact = async (req, res, next) => {
  try {
    const contact = await contactService.createContact(
      req.body,
      req.user.id,
      req.files
    );

    return res.status(201).json({
      success: true,
      message: "Contact created successfully",
      data: contact,
    });
  } catch (error) {
    next(error);
  }
};

// ================= GET ALL CONTACTS =================
// Supports: search, sorting, pagination, companyCategory filter,
// reference filter — all parsed inside contactService.getAllContacts
// from req.query, same convention as
// companyCategoryController.getAllCompanyCategories.
const getAllContacts = async (req, res, next) => {
  try {
    const result = await contactService.getAllContacts(req.query);

    return res.status(200).json({
      success: true,
      message: result.message,
      data: result.data,
      statusCounts: result.statusCounts,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
};

// ================= EXPORT CONTACTS =================
// GET /api/contacts/export — same search/sortBy/sortOrder/
// companyCategory/reference query params as getAllContacts (see
// contactService.exportContacts), so the exported file always matches
// whatever the Contact List page is currently searching/filtering/
// sorting by. The service streams the .xlsx directly onto `res`.
const exportContacts = async (req, res, next) => {
  try {
    await contactService.exportContacts(req.query, res);
  } catch (error) {
    next(error);
  }
};

// ================= GET UNIQUE REFERENCES =================
// GET /api/contacts/unique-references?search= — feeds the Contact List's
// "All References" filter dropdown.
const getUniqueReferences = async (req, res, next) => {
  try {
    const result = await contactService.getUniqueReferences(req.query);

    return res.status(200).json({
      success: true,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};

// ================= GET REFERENCE SUMMARY =================
// GET /api/contacts/reference-summary — no query params; returns every
// unique reference across all active contacts grouped with the list of
// contact names that hold it.
const getReferenceSummary = async (req, res, next) => {
  try {
    const result = await contactService.getReferenceSummary();

    return res.status(200).json({
      success: true,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};

// ================= GET CONTACT BY ID =================
const getContactById = async (req, res, next) => {
  try {
    const contact = await contactService.getContactById(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Contact fetched successfully",
      data: contact,
    });
  } catch (error) {
    next(error);
  }
};

// ================= UPDATE CONTACT =================
const updateContact = async (req, res, next) => {
  try {
    const contact = await contactService.updateContact(
      req.params.id,
      req.body,
      req.files
    );

    return res.status(200).json({
      success: true,
      message: "Contact updated successfully",
      data: contact,
    });
  } catch (error) {
    next(error);
  }
};

// ================= DELETE CONTACT (SOFT DELETE) =================
const deleteContact = async (req, res, next) => {
  try {
    const contact = await contactService.deleteContact(
      req.params.id,
      req.user.id
    );

    return res.status(200).json({
      success: true,
      message: "Contact deleted successfully",
      data: contact,
    });
  } catch (error) {
    next(error);
  }
};

// ================= BULK APPROVAL STATUS =================
const bulkUpdateStatus = async (req, res, next) => {
  try {
    const result = await contactService.bulkUpdateApprovalStatus(
      req.body,
      req.user.id
    );

    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

// ================= SEND PASS OVER WHATSAPP =================
const sendPass = async (req, res, next) => {
  try {
    const result = await contactService.sendPassToContacts(
      req.body,
      req.user.id
    );

    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

// ================= RESEND PASS OVER WHATSAPP =================
const resendPass = async (req, res, next) => {
  try {
    const result = await contactService.resendPassToContacts(req.body);

    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    next(error);
  }
};

// ================= DELETE BOOKING (PASS) =================
const deleteBooking = async (req, res, next) => {
  try {
    const result = await contactService.deleteBookingsOfContacts(
      req.body,
      req.user.id
    );

    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    next(error);
  }
};

// ================= PASS GUEST COUNT (EDIT) =================
const getContactPass = async (req, res, next) => {
  try {
    return res.status(200).json(await contactService.getContactPass(req.params.id));
  } catch (error) {
    next(error);
  }
};

const updateContactPass = async (req, res, next) => {
  try {
    return res
      .status(200)
      .json(await contactService.updateContactPass(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
};

// ================= IMPORT CONTACTS FROM CSV =================
// POST /api/contacts/import-csv            -> creates the contacts
// POST /api/contacts/import-csv?dryRun=true -> only checks the file
// multipart field "file" = the .csv, optional text field
// "approvalStatus" = approved (default) | pending.
const importContactsCsv = async (req, res, next) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "CSV file is required" });
    }

    const dryRun = String(req.query.dryRun || "") === "true";

    const result = await contactImportService.importContactsCsv(
      req.file.buffer,
      req.user.id,
      {
        approvalStatus: req.body?.approvalStatus || "approved",
        dryRun,
      }
    );

    const summary = `Processed ${result.totalRows} row(s): ${result.successCount} ${
      dryRun ? "ready to import" : "contact(s) created"
    }, ${result.duplicateCount} duplicate(s) skipped, ${result.failureCount} failed`;

    return res.status(200).json({
      success: dryRun || result.successCount > 0,
      message: summary,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  importContactsCsv,
  bulkUpdateStatus,
  sendPass,
  resendPass,
  deleteBooking,
  getContactPass,
  updateContactPass,
  createContact,
  getAllContacts,
  exportContacts,
  getUniqueReferences,
  getReferenceSummary,
  getContactById,
  updateContact,
  deleteContact,
};