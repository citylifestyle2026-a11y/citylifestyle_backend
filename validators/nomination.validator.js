const { body, validationResult } = require("express-validator");
const mongoose = require("mongoose");
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

// Create Nomination Validation — same guest-field rules as
// guest.validator.js's createGuestValidation (fullName/mobile/etc.),
// plus the target editionId. Mobile is reused via the same
// normalizeMobileNumber utility so a nomination's mobile and a directly
// admin-created Guest's mobile are always stored/compared the same way.
const createNominationValidation = [
  body("editionId")
    .notEmpty()
    .withMessage("Edition is required")
    .bail()
    .custom((value) => mongoose.Types.ObjectId.isValid(value))
    .withMessage("Invalid Edition ID"),

  body("fullName").trim().notEmpty().withMessage("Full Name is required"),

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
  createNominationValidation,
  validate,
};
