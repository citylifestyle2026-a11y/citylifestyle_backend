// utils/normalizeMobileNumber.js
//
// ================= ONE RULE FOR EVERY MOBILE NUMBER IN THE BOOKING FLOW =================
// A mobile number is accepted WITH or WITHOUT the India country code:
//
//   9876543210          -> valid
//   919876543210        -> valid
//   +919876543210       -> valid
//   +91 98765 43210     -> valid (spaces, dashes, dots, brackets are ignored)
//   9876543210 / 91-98765-43210 ...
//
// Whatever form comes in, it is stored in ONE canonical form:
//   "91" + 10-digit number   (e.g. "919876543210")
// That is the same shape the Create Booking / Registration forms already
// send, and the shape WhatsApp needs (see formatWhatsappPhoneNumber.js).
//
// Having a single stored form is what makes the duplicate check in
// booking.service.js reliable: "9876543210" (typed in a CSV), "91 98765
// 43210" and "+919876543210" are all the SAME person, so they must
// compare equal.
//
// The 10-digit local part must start with 6-9 (Indian mobile numbers).
const COUNTRY_CODE = "91";

const MOBILE_ERROR_MESSAGE =
  "Mobile Number must be a valid 10-digit number (with or without 91 prefix)";

// Returns the canonical "91XXXXXXXXXX" string, or null when the value is
// not a valid Indian mobile number.
const normalizeMobileNumber = (value) => {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  if (!text) return null;

  // Only digits, an optional leading "+", and common separators allowed —
  // anything else ("abc", "98765-4321x", "9876543210,9999999999") is rejected.
  if (!/^\+?[\d\s\-().]+$/.test(text)) return null;

  const hasPlus = text.startsWith("+");
  const digits = text.replace(/\D/g, "");

  let localNumber;
  if (digits.length === 12 && digits.startsWith(COUNTRY_CODE)) {
    localNumber = digits.slice(2);
  } else if (digits.length === 10 && !hasPlus) {
    // "+9876543210" (a "+" without a country code) is ambiguous — reject.
    localNumber = digits;
  } else {
    return null;
  }

  if (!/^[6-9]\d{9}$/.test(localNumber)) return null;

  return `${COUNTRY_CODE}${localNumber}`;
};

// Every spelling a number may already be stored under in the DB (older
// bookings were saved exactly as typed, before normalisation existed).
// Used by the duplicate check so old "9876543210" rows and new
// "919876543210" rows are recognised as the same number.
const getMobileNumberVariants = (value) => {
  const canonical = normalizeMobileNumber(value);

  if (!canonical) {
    const raw = String(value ?? "").trim();
    return raw ? [raw] : [];
  }

  return [canonical.slice(COUNTRY_CODE.length), canonical, `+${canonical}`];
};

// ================= 10-DIGIT FORM (CONTACT / ADMIN / USER) =================
// Contacts (whatsappNumber), Admins and Users (mobile) have always been
// stored as a bare 10-digit number — Admin/User login looks the number up
// as typed, and User.mobile is schema-validated as exactly 10 digits — so
// those keep that stored form. They now ALSO accept 91 / +91 in front:
// "+91 98765 43210" and "919876543210" are validated and saved as
// "9876543210". (Booking flows above store the "91XXXXXXXXXX" form.)
//
// Returns the 10-digit string, or null when invalid.
const toLocalMobileNumber = (value) => {
  const canonical = normalizeMobileNumber(value);
  return canonical ? canonical.slice(COUNTRY_CODE.length) : null;
};

// LOGIN ONLY — deliberately looser than toLocalMobileNumber: it does not
// insist on the 6-9 first digit, so an existing account whose stored
// number happens to be "unusual" can still log in exactly like before.
// Accepts 10 digits, or 91 / +91 followed by 10 digits; returns the
// 10 digits, or null.
const extractLoginMobileDigits = (value) => {
  const text = String(value ?? "").trim();
  if (!/^\+?[\d\s\-().]+$/.test(text)) return null;

  const hasPlus = text.startsWith("+");
  const digits = text.replace(/\D/g, "");

  if (digits.length === 12 && digits.startsWith(COUNTRY_CODE)) {
    return digits.slice(2);
  }
  if (digits.length === 10 && !hasPlus) return digits;

  return null;
};

// ================= SEARCH / FILTER BOXES =================
// Stored numbers are "91XXXXXXXXXX" (bookings, registrations) or
// "XXXXXXXXXX" (contacts, admins, users), and the list search boxes
// match by substring. So a FULL number typed with a country code or
// separators — "+91 98765 43210", "91-98765-43210" — is reduced to its
// 10 digits, which is a substring of BOTH stored forms. Anything that is
// not a full phone number (a name, a booking id, a partial number such
// as "9876") is returned unchanged.
const normalizeMobileSearchTerm = (term) => {
  const text = String(term ?? "").trim();
  if (!/^\+?[\d\s\-().]+$/.test(text)) return text;

  const digits = text.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith(COUNTRY_CODE)) {
    return digits.slice(2);
  }
  if (digits.length === 10) return digits;

  return text;
};

// For fields that are ONLY ever a mobile number (the dedicated "Mobile
// Number" filter). Returns a value that is safe to use as a regex: the
// digits only (91 prefix dropped from a full number), or — if there are
// no digits at all — the escaped raw text, so a stray "+" or "(" can never
// make MongoDB throw "Regular expression is invalid".
const toMobileFilterDigits = (term) => {
  const text = String(term ?? "").trim();
  const digits = text.replace(/\D/g, "");

  if (!digits) return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (digits.length === 12 && digits.startsWith(COUNTRY_CODE)) {
    return digits.slice(2);
  }
  return digits;
};

// express-validator helpers so every validator uses the same code:
//   .custom(mobileCustomValidator("Invalid mobile number"))
//   .customSanitizer(toLocalMobileSanitizer)
const mobileCustomValidator = (message) => (value) => {
  if (!toLocalMobileNumber(value)) {
    throw new Error(message);
  }
  return true;
};

const toLocalMobileSanitizer = (value) => toLocalMobileNumber(value) || value;

module.exports = {
  normalizeMobileNumber,
  getMobileNumberVariants,
  toLocalMobileNumber,
  extractLoginMobileDigits,
  normalizeMobileSearchTerm,
  toMobileFilterDigits,
  mobileCustomValidator,
  toLocalMobileSanitizer,
  MOBILE_ERROR_MESSAGE,
};
