const { body, validationResult } = require("express-validator");
const {
  mobileCustomValidator,
  toLocalMobileSanitizer,
} = require("../utils/normalizeMobileNumber");

const CATEGORY_VALUES = [
  "HNI",
  "Entrepreneur",
  "Creator",
  "Business Leader",
  "Professional",
  "Artist",
  "Influencer",
  "Other",
];

const createGuestValidation = [
  body("fullName").trim().notEmpty().withMessage("Full Name is required"),

  // Accepts 9876543210 / 919876543210 / +91 98765 43210 — stored as the
  // 10-digit number, same convention as Contact.whatsappNumber and
  // Admin/User.mobile (see utils/normalizeMobileNumber.js).
  body("mobile")
    .trim()
    .notEmpty()
    .withMessage("Mobile Number is required")
    .bail()
    .custom(
      mobileCustomValidator("Invalid Mobile Number (10 digits, with or without 91)")
    )
    .customSanitizer(toLocalMobileSanitizer),

  body("email")
    .optional({ checkFalsy: true })
    .trim()
    .isEmail()
    .withMessage("Invalid email address"),

  body("companyName").optional().trim(),
  body("designation").optional().trim(),

  body("category")
    .optional()
    .isIn(CATEGORY_VALUES)
    .withMessage(`Category must be one of: ${CATEGORY_VALUES.join(", ")}`),

  body("city").optional().trim(),

  body("relationship")
    .optional()
    .isIn(["Single", "Couple"])
    .withMessage('Relationship must be "Single" or "Couple"'),

  body("isVip").optional().isBoolean().withMessage("isVip must be true or false"),

  body("tags").optional().isArray().withMessage("Tags must be an array"),
  body("tags.*").optional().trim().notEmpty(),

  body("notes").optional().trim(),
];

const updateGuestValidation = [
  body("fullName").optional().trim().notEmpty().withMessage("Full Name cannot be empty"),

  body("mobile")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Mobile Number cannot be empty")
    .bail()
    .custom(
      mobileCustomValidator("Invalid Mobile Number (10 digits, with or without 91)")
    )
    .customSanitizer(toLocalMobileSanitizer),

  body("email")
    .optional({ checkFalsy: true })
    .trim()
    .isEmail()
    .withMessage("Invalid email address"),

  body("companyName").optional().trim(),
  body("designation").optional().trim(),

  body("category")
    .optional()
    .isIn(CATEGORY_VALUES)
    .withMessage(`Category must be one of: ${CATEGORY_VALUES.join(", ")}`),

  body("city").optional().trim(),

  body("relationship")
    .optional()
    .isIn(["Single", "Couple"])
    .withMessage('Relationship must be "Single" or "Couple"'),

  body("isVip").optional().isBoolean().withMessage("isVip must be true or false"),

  body("tags").optional().isArray().withMessage("Tags must be an array"),
  body("tags.*").optional().trim().notEmpty(),

  body("notes").optional().trim(),
];

// Same shape as every other validator in this project (e.g.
// booking.validator.js) — first real message surfaced at the top level,
// full list still available under `errors`.
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
  createGuestValidation,
  updateGuestValidation,
  validate,
};
