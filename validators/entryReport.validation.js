const { query } = require("express-validator");
// get all entery report
const getAllEntryReportValidation = [
  query("eventId")
    .optional({ checkFalsy: true })
    .isMongoId()
    .withMessage("Invalid Event Id"),

  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("Page must be a positive integer"),

  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("Limit must be between 1 and 100"),

  query("bookingId")
    .optional()
    .trim(),

  query("ticketId")
    .optional()
    .trim(),

  query("mobileNumber")
    .optional()
    .trim()
    .matches(/^[0-9]{0,10}$/)
    .withMessage("Mobile number must contain digits only (maximum 10 digits)"),

  query("name")
    .optional()
    .trim(),

  query("search")
    .optional()
    .trim(),

  query("startDate")
    .optional({ checkFalsy: true })
    .isISO8601()
    .withMessage("Invalid start date"),

  query("endDate")
    .optional({ checkFalsy: true })
    .isISO8601()
    .withMessage("Invalid end date")
    .bail()
    .custom((endDate, { req }) => {
      const startDate = req.query.startDate;

      if (startDate && new Date(endDate) < new Date(startDate)) {
        throw new Error("End date cannot be before start date");
      }

      return true;
    }),
];
// export entery report excel
const exportEntryReportValidation = [
  ...getAllEntryReportValidation,
];

module.exports = {
  getAllEntryReportValidation,
  exportEntryReportValidation,
};