const { body, validationResult } = require("express-validator");
const {
  mobileCustomValidator,
  toLocalMobileSanitizer,
} = require("../utils/normalizeMobileNumber");

// Create Coordinator Validation
const createCoordinatorValidation = [
  body("name").trim().notEmpty().withMessage("Name is required"),

  // Accepts 9876543210 / 919876543210 / +91 98765 43210 — saved as the
  // 10-digit number (see utils/normalizeMobileNumber.js).
  body("mobile")
    .trim()
    .notEmpty()
    .withMessage("Mobile number is required")
    .bail()
    .custom(
      mobileCustomValidator("Invalid mobile number (10 digits, with or without 91)")
    )
    .customSanitizer(toLocalMobileSanitizer),

  body("email")
    .optional({ values: "falsy" })
    .trim()
    .normalizeEmail()
    .isEmail()
    .withMessage("Invalid email address"),

  body("password")
    .notEmpty()
    .withMessage("Password is required")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters"),

  body("confirmPassword")
    .notEmpty()
    .withMessage("Confirm Password is required")
    .custom((value, { req }) => {
      if (value !== req.body.password) {
        throw new Error("Password and Confirm Password do not match");
      }
      return true;
    }),
];

// Update Coordinator Validation
const updateCoordinatorValidation = [
  body("name").optional().trim().notEmpty().withMessage("Name is required"),

  body("mobile")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Mobile number is required")
    .bail()
    .custom(
      mobileCustomValidator("Invalid mobile number (10 digits, with or without 91)")
    )
    .customSanitizer(toLocalMobileSanitizer),

  body("email")
    .optional({ values: "falsy" })
    .trim()
    .normalizeEmail()
    .isEmail()
    .withMessage("Invalid email address"),

  body("password")
    .optional({ values: "falsy" })
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .custom((value, { req }) => {
      if (req.body.confirmPassword === undefined || req.body.confirmPassword !== value) {
        throw new Error("Password and Confirm Password do not match");
      }
      return true;
    }),

  body("status")
    .optional()
    .isIn(["active", "inactive"])
    .withMessage('Status must be either "active" or "inactive"'),
];

// Same shape as every other validator in this project.
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
  createCoordinatorValidation,
  updateCoordinatorValidation,
  validate,
};
