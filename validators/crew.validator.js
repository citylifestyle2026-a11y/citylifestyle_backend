const { body, validationResult } = require("express-validator");

const createCrewValidation = [
  body("fullName").trim().notEmpty().withMessage("Full name is required"),
  body("whatsappNumber").trim().notEmpty().withMessage("WhatsApp number is required"),
  body("email")
    .optional({ values: "falsy" })
    .trim()
    .isEmail()
    .withMessage("Enter a valid email address"),
];

const updateCrewValidation = [
  body("fullName").optional().trim().notEmpty().withMessage("Full name is required"),
  body("whatsappNumber").optional().trim().notEmpty().withMessage("WhatsApp number is required"),
  body("email")
    .optional({ values: "falsy" })
    .trim()
    .isEmail()
    .withMessage("Enter a valid email address"),
];

const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const errorList = errors.array();
    return res.status(400).json({
      success: false,
      message: errorList[0].msg,
      errors: errorList,
    });
  }

  next();
};

module.exports = { createCrewValidation, updateCrewValidation, validate };
