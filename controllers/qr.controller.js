const qrService = require("../services/qr.service");

// ================= VERIFY QR =================
const verifyQr = async (req, res, next) => {

  try {
    const result = await qrService.verifyQr({
      qrToken: req.body.qrToken,
      scannedBy: req.user._id,
    });

    return res.status(200).json({
      success: true,
      message: "QR verified successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
// ================= CHECK-IN QR =================
const checkInQr = async (req, res, next) => {
  try {
    const result = await qrService.checkInQr({
      qrToken: req.body.qrToken,
      scannedBy: req.user._id,
      guests: req.body.guests,
      askGuests: req.body.askGuests === true || req.body.askGuests === "true",
    });

    return res.status(200).json({
      success: true,
      message: result.needsGuestCount
        ? "Choose how many guests are entering."
        : "Ticket checked in successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
// ================= UNDO CHECK-IN =================
const undoCheckInQr = async (req, res, next) => {
  try {
    const result = await qrService.undoCheckInQr({
      qrToken: req.body.qrToken,
      guests: req.body.guests,
    });

    return res.status(200).json({
      success: true,
      message: "Entry reverted. You can scan again with the correct count.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
module.exports = {
  verifyQr,
  checkInQr,
  undoCheckInQr,
};