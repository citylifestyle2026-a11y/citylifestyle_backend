const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const heicConvert = require("heic-convert");
const { UPLOAD_ROOT, PUBLIC_BASE_URL, FOLDER_MAP } = require("../config/uploadPaths");

const MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

// Every mimetype the upload middleware's fileFilter already allows
// through (middlewares/upload.middleware.js) — kept in sync with that
// list. Used only to decide whether the global "convert to WEBP" rule
// below applies; it does not change what's accepted for upload.
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

// iPhone's default camera photo format. sharp/libvips can't reliably
// decode these on every build (HEIC decode support is patent-encumbered
// and often left out of prebuilt sharp binaries), so these are decoded
// to a plain buffer via `heic-convert` FIRST, then handed to the same
// sharp resize+webp pipeline as every other format below.
const HEIC_MIME_TYPES = new Set(["image/heic", "image/heif"]);

const sanitizeSegment = (value) =>
  String(value).replace(/[^a-zA-Z0-9_-]/g, "-");

// ================= WEBP COMPRESSION SETTINGS =================
// Applied by the "GLOBAL IMAGE -> WEBP RULE" below to every
// user-uploaded image (Event image, Admin/User profile photo,
// Public/Private Registration attendee photo). Two independent knobs:
//   - MAX_IMAGE_DIMENSION: caps the longer edge of very large photos
//     (e.g. a 4000x3000 upload) down to a sane on-screen size. Small
//     images are left at their original resolution — `withoutEnlargement`
//     below means this never *upscales* a small image.
//   - WEBP_QUALITY: sharp's WEBP encoder quality (0-100, sharp default
//     is 80). 75 keeps visual quality close to the original while
//     meaningfully shrinking file size for photos.
// Together these mean a "very large" (e.g. 100 MB) upload is resized +
// re-encoded down to a much smaller compressed file before it's ever
// written to disk, instead of just having its format renamed to .webp.
const MAX_IMAGE_DIMENSION = 1920; // px, longer edge
const WEBP_QUALITY = 75;

/**
 * Save a file to local disk, under uploads/<subfolder>, and return a
 * publicly reachable URL. Drop-in replacement for the old
 * uploadToCloudinary(buffer, folder, resourceType, extraOptions) —
 * every existing caller keeps working unchanged, since only
 * `result.url` and `result.public_id` are ever read from the return
 * value.
 *
 * @param {Buffer|Object} input - Either a raw Buffer, or a multer file
 *   object ({ buffer, mimetype, ... }) — passing the multer file lets
 *   the correct image extension be derived from its mimetype.
 * @param {String} folder - Legacy Cloudinary-style folder string (e.g.
 *   "event-management/events"), mapped to a local subfolder via
 *   FOLDER_MAP. Falls back to the last "/"-segment for any folder not
 *   in the map, so a new caller can't accidentally write outside
 *   uploads/.
 * @param {String} resourceType - Unused for local storage; kept only so
 *   every existing call site (which still passes it, e.g. "image") does
 *   not need to change its argument list.
 * @param {Object} extraOptions - Optional { public_id, format } to force
 *   a specific file name/extension (used by services/pdf.service.js for
 *   ticket PDFs). Defaults to {} so every image-upload caller is
 *   unaffected.
 * @returns {Promise<{ public_id: string, url: string, bytes: number, format: string }>}
 */
const uploadToLocal = async (input, folder, resourceType = "image", extraOptions = {}) => {
  const isMulterFile = input && Buffer.isBuffer(input.buffer);
  let buffer = isMulterFile ? input.buffer : input;

  if (!Buffer.isBuffer(buffer)) {
    throw new Error("uploadToLocal: no valid file buffer provided.");
  }

  const subfolder = FOLDER_MAP[folder] || sanitizeSegment(String(folder).split("/").pop() || "misc");
  const dir = path.join(UPLOAD_ROOT, subfolder);
  fs.mkdirSync(dir, { recursive: true });

  // ================= GLOBAL IMAGE → WEBP RULE =================
  // Applies to every user-uploaded image that comes in as a multer file
  // with a recognized image mimetype (Event image, User/Admin profile
  // photo, attendee registration photo, etc. — every caller that passes
  // `input` = the raw multer `file` object). JPG/JPEG/PNG/HEIC/HEIF are
  // all converted to compressed WEBP (HEIC/HEIF via `heic-convert` first
  // — see below); an uploaded WEBP is re-compressed too, not just passed
  // through, in case it was itself very large. The final file on disk —
  // and therefore the `.url`/`.public_id` saved to the database by
  // every caller — always ends in `.webp` for these uploads.
  //
  // Deliberately gated on `!extraOptions.format`: callers that
  // explicitly force an output format are NOT user-uploaded images —
  // they're internally generated artifacts (QR code PNGs in
  // booking.service.js / bookingTicket.service.js, ticket PDFs in
  // pdf.service.js) and must keep their existing format untouched, since
  // changing those would break QR scanning / ticket delivery, which is
  // outside the scope of this rule.
  const isUploadedImage =
    !extraOptions.format &&
    isMulterFile &&
    input.mimetype &&
    IMAGE_MIME_TYPES.has(input.mimetype);

  let ext;

  if (isUploadedImage) {
    // HEIC/HEIF (iPhone's default camera format) -> decode to a plain
    // raster buffer FIRST via `heic-convert`, since sharp can't reliably
    // read HEIC on every build. Every other allowed format (JPG/PNG/
    // WEBP) skips straight to the sharp pipeline below unchanged.
    if (HEIC_MIME_TYPES.has(input.mimetype)) {
      buffer = await heicConvert({
        buffer,
        format: "JPEG",
        quality: 1, // lossless handoff — WEBP_QUALITY below does the actual compression
      });
    }

    // JPG/JPEG/PNG/WEBP/(decoded HEIC) -> compressed WEBP. Resize only
    // ever shrinks (withoutEnlargement), so a small image's dimensions
    // are untouched; a very large upload gets capped to
    // MAX_IMAGE_DIMENSION on its longer edge and re-encoded at
    // WEBP_QUALITY, so it's stored on disk meaningfully smaller than
    // what was uploaded. Applied even when the original is already
    // WEBP, since an oversized WEBP upload should still be compressed,
    // not just passed through as-is.
    buffer = await sharp(buffer)
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    ext = ".webp";
  } else if (extraOptions.format) {
    ext = `.${String(extraOptions.format).replace(/^\./, "")}`;
  } else if (isMulterFile && input.mimetype && MIME_TO_EXT[input.mimetype]) {
    ext = MIME_TO_EXT[input.mimetype];
  } else {
    ext = ".png";
  }

  // extraOptions.public_id forces a specific, stable file name (e.g.
  // ticket PDFs, which build their own unique name upstream). Otherwise
  // a random, collision-safe name is generated, matching Cloudinary's
  // previous auto-generated public_id behavior.
  const baseName = extraOptions.public_id
    ? sanitizeSegment(extraOptions.public_id)
    : `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;

  const fileName = `${baseName}${ext}`;
  const absolutePath = path.join(dir, fileName);

  await fs.promises.writeFile(absolutePath, buffer);

  // Verify the write actually landed on disk before handing back a
  // public URL for it. Without this, a write that silently fails to
  // persist (full disk, permissions, filesystem/mount issue) still
  // returns a success URL that then 404s later — masking the real
  // failure at generation time instead of surfacing it immediately.
  if (!fs.existsSync(absolutePath)) {
    throw new Error(
      `uploadToLocal: file was not found on disk after write (${absolutePath}).`
    );
  }

  // Stored as the "public_id" equivalent (relative path under
  // uploads/), so utils/deleteLocalFile.js can resolve and remove the
  // exact same file later.
  const relativePath = path.posix.join(subfolder, fileName);
  const url = `${PUBLIC_BASE_URL}/uploads/${relativePath}`;

  return {
    public_id: relativePath,
    url,
    bytes: buffer.length,
    format: ext.replace(".", ""),
  };
};

module.exports = uploadToLocal;