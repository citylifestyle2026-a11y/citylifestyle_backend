const { body, validationResult } = require("express-validator");

const STATUS_VALUES = ["Draft", "Active", "Closed", "Archived"];

const createEditionValidation = [
  body("name").trim().notEmpty().withMessage("Edition Name is required"),

  body("editionNumber")
    .notEmpty()
    .withMessage("Edition Number is required")
    .bail()
    .isInt({ min: 1 })
    .withMessage("Edition Number must be a positive whole number"),

  body("year")
    .notEmpty()
    .withMessage("Year is required")
    .bail()
    .isInt({ min: 2000, max: 2100 })
    .withMessage("Year must be a valid year"),

  body("eventDateTime")
    .optional({ checkFalsy: true })
    .isISO8601()
    .withMessage("Event Date/Time must be a valid date"),

  body("venue").optional().trim(),

  body("guestCapacity")
    .optional({ checkFalsy: true })
    .isInt({ min: 1 })
    .withMessage("Guest Capacity must be a positive whole number"),

  body("status")
    .optional()
    .isIn(STATUS_VALUES)
    .withMessage(`Status must be one of: ${STATUS_VALUES.join(", ")}`),
];

const updateEditionValidation = [
  body("name").optional().trim().notEmpty().withMessage("Edition Name cannot be empty"),

  body("editionNumber")
    .optional()
    .isInt({ min: 1 })
    .withMessage("Edition Number must be a positive whole number"),

  body("year")
    .optional()
    .isInt({ min: 2000, max: 2100 })
    .withMessage("Year must be a valid year"),

  body("eventDateTime")
    .optional({ checkFalsy: true })
    .isISO8601()
    .withMessage("Event Date/Time must be a valid date"),

  body("venue").optional().trim(),

  body("guestCapacity")
    .optional({ checkFalsy: true })
    .isInt({ min: 1 })
    .withMessage("Guest Capacity must be a positive whole number"),

  body("status")
    .optional()
    .isIn(STATUS_VALUES)
    .withMessage(`Status must be one of: ${STATUS_VALUES.join(", ")}`),
];

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
  createEditionValidation,
  updateEditionValidation,
  validate,
};
