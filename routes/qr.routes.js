const express = require("express");

const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const authorize = require("../middlewares/authorize.middleware");
const qrController = require("../controllers/qr.controller");
const {
  verifyQrValidation,
  checkInQrValidation,
  faceMatchValidation,
  faceCheckInValidation,
  validate,
} = require("../validators/qr.validation");

// verfiy
// Admin always has access; a Checker additionally needs the
// "QR Pass" permission on their User document.
router.post(
  "/verify",
  protect,
  authorize("admin", "checker", { permission: "QR Pass" }),
  verifyQrValidation,
  validate,
  qrController.verifyQr
);
//  check-in
router.post(
  "/check-in",
  protect,
  authorize("admin", "checker", { permission: "QR Pass" }),
  checkInQrValidation,
  validate,
  qrController.checkInQr
);
// undo check-in (fix a wrong guest count)
router.post(
  "/undo-check-in",
  protect,
  authorize("admin", "checker", { permission: "QR Pass" }),
  checkInQrValidation,
  validate,
  qrController.undoCheckInQr
);
// face scan: find the registered person for a live face (no check-in yet)
router.post(
  "/face-match",
  protect,
  authorize("admin", "checker", { permission: "QR Pass" }),
  faceMatchValidation,
  validate,
  qrController.faceMatch
);
// face scan: staff confirmed the matched person -> check that ticket in
router.post(
  "/face-check-in",
  protect,
  authorize("admin", "checker", { permission: "QR Pass" }),
  faceCheckInValidation,
  validate,
  qrController.faceCheckIn
);
module.exports = router;