const { validationResult } = require("express-validator");

const validateRequest = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map((err) => ({
      field: err.path,
      message: err.msg,
    }));

    // `message` carries the FIRST actual validation message (e.g.
    // "Invalid mobile number") instead of the generic "Validation failed".
    // Every frontend thunk only reads `response.data.message`, so with the
    // generic text the user never learned what was wrong. The full list
    // is still returned in `errors` for anything that wants all of them.
    return res.status(422).json({
      success: false,
      message: formattedErrors[0]?.message || "Validation failed",
      errors: formattedErrors,
    });
  }

  next();
};

module.exports = validateRequest;
