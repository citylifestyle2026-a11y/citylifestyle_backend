const { body, validationResult } = require("express-validator");

// Must stay in sync with models/contactEventHistory.model.js's
// STATUS_VALUES — duplicated locally here rather than imported, same
// convention used by the other validators.
const STATUS_VALUES = [
  "Invited",
  "Confirmed",
  "Attended",
  "Not Attended",
  "Cancelled",
];

// Create Event History Validation
const createEventHistoryValidation = [
  body("contactId")
    .notEmpty()
    .withMessage("Contact is required")
    .bail()
    .isMongoId()
    .withMessage("Invalid Contact ID"),

  body("eventId")
    .notEmpty()
    .withMessage("Event is required")
    .bail()
    .isMongoId()
    .withMessage("Invalid Event ID"),

  body("status")
    .optional()
    .isIn(STATUS_VALUES)
    .withMessage(`Status must be one of: ${STATUS_VALUES.join(", ")}`),

  body("isSpouse")
    .optional()
    .isBoolean()
    .withMessage("isSpouse must be true or false"),

  body("notes").optional({ values: "falsy" }).trim(),
];

// Update Event History Validation
// contactId is intentionally NOT accepted for update — an entry stays
// attached to the contact it was created under (see
// contactEventHistory.service.js's updateEventHistory).
const updateEventHistoryValidation = [
  body("eventId")
    .optional()
    .isMongoId()
    .withMessage("Invalid Event ID"),

  body("status")
    .optional()
    .isIn(STATUS_VALUES)
    .withMessage(`Status must be one of: ${STATUS_VALUES.join(", ")}`),

  body("notes").optional({ values: "falsy" }).trim(),
];

// Validation Result — same shape used by every other validator in this
// project (see validators/contact.validator.js's own `validate`).
const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const errorList = errors.array();

    return res.status(400).json({
      success: false,
      message: errorList[0]?.msg || "Validation Error",
      errors: errorList,
    });
  }

  next();
};

module.exports = {
  createEventHistoryValidation,
  updateEventHistoryValidation,
  validate,
  STATUS_VALUES,
};