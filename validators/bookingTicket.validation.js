const { body, validationResult } = require("express-validator");
const {
  normalizeMobileNumber,
  MOBILE_ERROR_MESSAGE,
} = require("../utils/normalizeMobileNumber");

exports.registerUserValidation = [
  body("name")
    .trim()
    .notEmpty()
    .withMessage("Name is required"),

  // Accepts 9876543210, 919876543210, +919876543210 (spaces/dashes are
  // ignored). Whatever is sent, the value that reaches the controller /
  // service is already the canonical "91XXXXXXXXXX" form, so it is stored
  // (and duplicate-checked) the same way no matter how it was typed.
  body("mobileNumber")
    .trim()
    .notEmpty()
    .withMessage("Mobile Number is required")
    .bail()
    .custom((value) => {
      if (!normalizeMobileNumber(value)) {
        throw new Error(MOBILE_ERROR_MESSAGE);
      }
      return true;
    })
    .customSanitizer((value) => normalizeMobileNumber(value) || value),

  body("email")
    .optional({ checkFalsy: true })
    .isEmail()
    .withMessage("Invalid email"),
];

exports.validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const errorList = errors.array();

    return res.status(400).json({
      success: false,
      // First real reason (e.g. the mobile number message) instead of a
      // generic "Validation Error", so the frontend can show/map it.
      message: errorList[0]?.msg || "Validation Error",
      errors: errorList,
    });
  }

  next();
};