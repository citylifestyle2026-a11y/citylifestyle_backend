const { body, validationResult } = require("express-validator");
const {
  mobileCustomValidator,
  toLocalMobileNumber,
  toLocalMobileSanitizer,
} = require("../utils/normalizeMobileNumber");

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

  // Accepts 9876543210 / 919876543210 / +91 98765 43210 — saved as the
  // 10-digit number (see utils/normalizeMobileNumber.js).
  body("whatsappNumber")
    .trim()
    .notEmpty()
    .withMessage("WhatsApp Number is required")
    .bail()
    .custom(
      mobileCustomValidator(
        "Invalid WhatsApp Number (10 digits, with or without 91)"
      )
    )
    .customSanitizer(toLocalMobileSanitizer),

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

  // Email follows the same optional-but-validated-if-present style
  // already used by validators/guest.validator.js's own `email` field
  // (checkFalsy so an empty string is treated as "not provided", not a
  // format error).
  body("email")
    .optional({ checkFalsy: true })
    .trim()
    .isEmail()
    .withMessage("Invalid email address"),

  // Single / Couple — required outright, independent of every
  // conditional rule below. No gender is inferred from this value
  // anywhere in this validator or the service.
  body("relationship")
    .trim()
    .notEmpty()
    .withMessage("Relationship is required")
    .bail()
    .isIn(["Single", "Couple"])
    .withMessage('Relationship must be "Single" or "Couple"'),

  // ================= CONDITIONAL: COUPLE-ONLY REQUIRED FIELDS =================
  // spouseName / spouseMobile / profession are each only required when
  // this same submission's `relationship` is "Couple" — when it's
  // "Single" they're accepted blank. Read directly off `req.body`
  // (already validated/normalized above by the time these run, since
  // express-validator runs body() checks in the order they're declared)
  // rather than duplicating the enum check.
  body("spouseName")
    .trim()
    .custom((value, { req }) => {
      if (req.body.relationship === "Couple" && !String(value || "").trim()) {
        throw new Error("Spouse Name is required for Couple");
      }
      return true;
    }),

  // Same "required only for Couple" rule as spouseName above, plus the
  // exact same 10-digit-with-or-without-91 format/normalization already
  // used by `whatsappNumber` (utils/normalizeMobileNumber.js) — applied
  // only when a value is actually present, so a blank Single submission
  // is never rejected for "invalid format".
  body("spouseMobile")
    .trim()
    .custom((value, { req }) => {
      const trimmed = String(value || "").trim();
      const isCouple = req.body.relationship === "Couple";

      if (isCouple && !trimmed) {
        throw new Error("Spouse Mobile Number is required for Couple");
      }

      if (trimmed && !toLocalMobileNumber(trimmed)) {
        throw new Error(
          "Invalid Spouse Mobile Number (10 digits, with or without 91)"
        );
      }

      return true;
    })
    .customSanitizer(toLocalMobileSanitizer),

  // Profession/Occupation — required only for Couple per this step's
  // spec, same conditional pattern as spouseName/spouseMobile above.
  body("profession")
    .trim()
    .custom((value, { req }) => {
      if (req.body.relationship === "Couple" && !String(value || "").trim()) {
        throw new Error("Profession is required for Couple");
      }
      return true;
    }),

  // Spouse's profession Category (from the Company Category list) —
  // compulsory for Couple, ignored for Single.
  body("professionCategory").custom((value, { req }) => {
    const v = String(value ?? "").trim();
    if (req.body.relationship === "Couple" && !v) {
      throw new Error("Category is required for Couple");
    }
    if (v && !/^[0-9a-fA-F]{24}$/.test(v)) {
      throw new Error("Invalid Category");
    }
    return true;
  }),
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
    .bail()
    .custom(
      mobileCustomValidator(
        "Invalid WhatsApp Number (10 digits, with or without 91)"
      )
    )
    .customSanitizer(toLocalMobileSanitizer),

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

  // Same rules as createContactValidation above — see the comments
  // there for the reasoning behind each one.
  body("email")
    .optional({ checkFalsy: true })
    .trim()
    .isEmail()
    .withMessage("Invalid email address"),

  body("relationship")
    .trim()
    .notEmpty()
    .withMessage("Relationship is required")
    .bail()
    .isIn(["Single", "Couple"])
    .withMessage('Relationship must be "Single" or "Couple"'),

  body("spouseName")
    .trim()
    .custom((value, { req }) => {
      if (req.body.relationship === "Couple" && !String(value || "").trim()) {
        throw new Error("Spouse Name is required for Couple");
      }
      return true;
    }),

  body("spouseMobile")
    .trim()
    .custom((value, { req }) => {
      const trimmed = String(value || "").trim();
      const isCouple = req.body.relationship === "Couple";

      if (isCouple && !trimmed) {
        throw new Error("Spouse Mobile Number is required for Couple");
      }

      if (trimmed && !toLocalMobileNumber(trimmed)) {
        throw new Error(
          "Invalid Spouse Mobile Number (10 digits, with or without 91)"
        );
      }

      return true;
    })
    .customSanitizer(toLocalMobileSanitizer),

  body("profession")
    .trim()
    .custom((value, { req }) => {
      if (req.body.relationship === "Couple" && !String(value || "").trim()) {
        throw new Error("Profession is required for Couple");
      }
      return true;
    }),

  // Spouse's profession Category (from the Company Category list) —
  // compulsory for Couple, ignored for Single.
  body("professionCategory").custom((value, { req }) => {
    const v = String(value ?? "").trim();
    if (req.body.relationship === "Couple" && !v) {
      throw new Error("Category is required for Couple");
    }
    if (v && !/^[0-9a-fA-F]{24}$/.test(v)) {
      throw new Error("Invalid Category");
    }
    return true;
  }),
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