const { body, validationResult } = require("express-validator");

// Create Contact Validation
// This only checks shape/type/presence — trimming and case-insensitive
// de-duplication of `references` happens in the model itself
// (models/contact.model.js's pre-save/pre-findOneAndUpdate hooks), same
// separation of concerns already used elsewhere in this project (e.g.
// User.model.js hashes `password` in a hook rather than the validator).
// Every field is compulsory EXCEPT `address` — see the matching
// `updateContactValidation` below, which mirrors this field-for-field.
const createContactValidation = [
  body("fullName")
    .trim()
    .notEmpty()
    .withMessage("Full Name is required"),

  body("whatsappNumber")
    .trim()
    .notEmpty()
    .withMessage("WhatsApp Number is required")
    .isMobilePhone("en-IN")
    .withMessage("Invalid WhatsApp Number"),

  body("companyName")
    .trim()
    .notEmpty()
    .withMessage("Company Name is required"),

  body("designation")
    .trim()
    .notEmpty()
    .withMessage("Designation is required"),

  // Address is the one field that's allowed to be blank.
  body("address")
    .optional({ values: "falsy" })
    .trim(),

  // At least one reference is required — duplicate removal
  // (case-insensitive, within this same contact) is the model's job,
  // not this validator's.
  body("references")
    .isArray({ min: 1 })
    .withMessage("At least one Reference is required"),

  body("references.*")
    .isString()
    .withMessage("Each reference must be text")
    .trim()
    .notEmpty()
    .withMessage("Reference cannot be empty"),

  body("companyCategory")
    .notEmpty()
    .withMessage("Company Category is required")
    .isMongoId()
    .withMessage("Invalid Company Category"),
];

// Update Contact Validation
// Mirrors createContactValidation field-for-field — the Edit form
// (CreateContactModal.jsx in edit mode) always resubmits the full set
// of fields, so the same "every field except Address is compulsory"
// rule applies here too. `fullName`/`whatsappNumber` keep `.optional()`
// (checked only when present) purely so a value that's already valid
// on the existing document is never re-rejected just for being
// "missing" from a differently-shaped request; every other field below
// is required outright, same as create.
const updateContactValidation = [
  body("fullName")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Full Name is required"),

  body("whatsappNumber")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("WhatsApp Number is required")
    .isMobilePhone("en-IN")
    .withMessage("Invalid WhatsApp Number"),

  body("companyName")
    .trim()
    .notEmpty()
    .withMessage("Company Name is required"),

  body("designation")
    .trim()
    .notEmpty()
    .withMessage("Designation is required"),

  body("address")
    .optional({ values: "falsy" })
    .trim(),

  body("references")
    .isArray({ min: 1 })
    .withMessage("At least one Reference is required"),

  body("references.*")
    .isString()
    .withMessage("Each reference must be text")
    .trim()
    .notEmpty()
    .withMessage("Reference cannot be empty"),

  body("companyCategory")
    .notEmpty()
    .withMessage("Company Category is required")
    .isMongoId()
    .withMessage("Invalid Company Category"),
];

// Validation Result
// Same shape already used by event.validator.js / ticketType.validator.js /
// user.validator.js / admin.validator.js — surfaces the first field
// error as `message` (what the frontend's error handling reads) while
// still returning the full `errors` array.
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

module.exports = {
  createContactValidation,
  updateContactValidation,
  validate,
};