const multer = require("multer");
const AppError = require("../utils/AppError");
const path = require("path");
// Memory Storage
const storage = multer.memoryStorage();

// Allowed MIME Types
const allowedMimeTypes = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

// File Filter
// Shared by every upload limit variant below — the existing allowed
// image formats/types are NOT changed by this file, except for the
// addition of HEIC/HEIF (iPhone's default camera photo format) below —
// uploadToLocal (utils/localUpload.util.js) decodes and converts these
// to compressed WEBP the same way it already does for JPG/PNG.
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "application/octet-stream", // fallback — also covers some browsers/OS that send HEIC files with this generic mimetype
  ];

  const allowedExtensions = [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".heic",
    ".heif",
  ];

  const ext = path.extname(file.originalname).toLowerCase();

  if (
    allowedMimeTypes.includes(file.mimetype) &&
    allowedExtensions.includes(ext)
  ) {
    return cb(null, true);
  }

  return cb(
    new AppError(
      "Only JPG, JPEG, PNG, WEBP, HEIC and HEIF images are allowed.",
      400
    ),
    false
  );
};

// ================= UPLOAD MIDDLEWARE FACTORY =================
// Builds a multer instance with the shared memory storage + fileFilter
// above, differing only in the max file size allowed. Kept as a factory
// (instead of duplicating storage/fileFilter per variant) so every
// upload route continues to share the exact same format/type validation.
const buildUploadMiddleware = (maxFileSizeBytes) =>
  multer({
    storage,
    limits: {
      fileSize: maxFileSizeBytes,
    },
    fileFilter,
  });

// ================= DEFAULT UPLOAD MIDDLEWARE =================
// Unchanged 5 MB limit — still used as-is by every existing upload route
// that isn't the Public/Private Registration photo upload (e.g. Event
// image, User/Admin profile photo), so those limits are not affected by
// the registration-specific increase below.
const upload = buildUploadMiddleware(5 * 1024 * 1024); // 5 MB

// ================= LARGE IMAGE UPLOAD MIDDLEWARE (100 MB) =================
// Shared by every "profile photo" style upload route that now allows
// images up to 100 MB:
//   - routes/auth.routes.js           PUT /profile              (Admin profile photo)
//   - routes/user.routes.js           POST /, PUT /:id           (User profile photo)
//   - routes/bookingTicket.routes.js  PUT /register-user/:ticketId  (Private Registration attendee photo, staff-authenticated)
//   - routes/publicRegistration.routes.js  PUT /:token  (Public Registration attendee photo, no-login)
// Same storage + fileFilter as the default upload middleware above, so
// allowed image formats/types are unchanged. Every file that comes
// through here is later re-encoded to WEBP and size-capped by
// `uploadToLocal` (utils/localUpload.util.js) before being written to
// disk, so a large upload is compressed down, not stored at its full
// original size. Event image upload (routes/event.routes.js) is NOT
// part of this group and keeps using the default 5 MB `upload` above.
const largeImageUpload = buildUploadMiddleware(100 * 1024 * 1024); // 100 MB

// ================= CSV UPLOAD MIDDLEWARE (BULK BOOKING IMPORT) =================
// Separate multer instance (own storage + own fileFilter) so the image
// fileFilter above is completely untouched — this one only ever accepts
// a single .csv file, used by POST /api/bookings/import-csv
// (routes/booking.routes.js -> bookingController.importBookingsCsv).
const csvFileFilter = (req, file, cb) => {
  const allowedCsvMimeTypes = [
    "text/csv",
    "application/vnd.ms-excel",
    "application/csv",
    "text/plain",
    "application/octet-stream", // fallback — some browsers/OS send CSV with a generic mimetype
  ];

  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === ".csv" && allowedCsvMimeTypes.includes(file.mimetype)) {
    return cb(null, true);
  }

  return cb(new AppError("Only .csv files are allowed.", 400), false);
};

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB — plenty for a booking list CSV
  },
  fileFilter: csvFileFilter,
});

module.exports = upload;
module.exports.largeImageUpload = largeImageUpload;
// Alias kept so existing imports of `upload.registrationPhotoUpload`
// (bookingTicket.routes.js, publicRegistration.routes.js) keep working
// unchanged — both names point at the exact same 100 MB middleware.
module.exports.registrationPhotoUpload = largeImageUpload;
module.exports.csvUpload = csvUpload;