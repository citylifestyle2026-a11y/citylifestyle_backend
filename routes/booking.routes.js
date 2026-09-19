const express = require("express");
const router = express.Router();

const bookingController = require("../controllers/booking.controller");

const {
  createBookingValidation,
  validate,
} = require("../validators/booking.validator");

const { protect } = require("../middlewares/auth.middleware");
const { csvUpload } = require("../middlewares/upload.middleware");

// Create Booking
router.post(
  "/create",
  protect,
  createBookingValidation,
  validate,
  bookingController.createBooking
);

// Bulk Import Bookings via CSV
// Each row of the CSV is created as its own booking (line by line), and
// each successful booking automatically gets its registration link sent
// via WhatsApp — same as a normal single booking created through
// POST /create, since this reuses bookingService.createBooking internally.
router.post(
  "/import-csv",
  protect,
  csvUpload.single("file"),
  bookingController.importBookingsCsv
);

// Get All Bookings
router.get(
  "/get-all-bookings",
  protect,
  bookingController.getAllBookings
);

// Export Bookings
router.get(
  "/export",
  protect,
  bookingController.exportBookingsController
);

// Delete Booking
router.delete(
  "/delete/:id",
  protect,
  bookingController.deleteBooking
);

// Get Booking By ID
router.get(
  "/:id",
  protect,
  bookingController.getBookingById
);

module.exports = router;