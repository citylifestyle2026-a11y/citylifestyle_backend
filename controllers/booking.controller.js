const bookingService = require("../services/booking.service");

// Create Booking
// Follows the same pattern as eventService.createEvent(req.body, req.file, req.user.id)
// and ticketTypeService.createTicketType(req.body, req.user.id): the
// authenticated user's id is passed as its own argument, never taken from
// (or spread into) req.body.
const createBooking = async (req, res, next) => {
  try {
    const result = await bookingService.createBooking(req.body, req.user.id);

    return res.status(201).json({
      success: true,
      message: "Booking created successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// ================= GET ALL BOOKINGS =================
const getAllBookings = async (req, res, next) => {
  try {
    const result = await bookingService.getAllBookings(req.query);

    return res.status(200).json({
      success: true,
      message: "Bookings fetched successfully",
      data: result.rows,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
};

// ================= DELETE BOOKING =================
const deleteBooking = async (req, res, next) => {
  try {
    const { remark } = req.body;

    // Was req.user._id — functionally identical (Mongoose's `.id` is a
    // virtual getter for `_id.toString()`), just normalized to `.id` to
    // match the convention used everywhere else (Event, TicketType,
    // createBooking above). This was already a separate argument, unlike
    // createBooking's previous merged-object call.
    const booking = await bookingService.deleteBooking(
      req.params.id,
      remark,
      req.user.id
    );

    return res.status(200).json({
      success: true,
      message: "Booking deleted successfully",
      data: booking,
    });
  } catch (error) {
    next(error);
  }
};
// getbooking by id
const getBookingById = async (req, res, next) => {
  try {
    const booking = await bookingService.getBookingById(
      req.params.id
    );

    return res.status(200).json({
      success: true,
      message: "Booking fetched successfully",
      data: booking,
    });
  } catch (error) {
    next(error);
  }
}; const exportBookingsController = async (req, res, next) => {
  try {
    await bookingService.exportBookings(req.query, res);
  } catch (error) {
    next(error);
  }
};

// ================= BULK IMPORT BOOKINGS FROM CSV =================
// File arrives via multer (csvUpload.single("file") on the route) as
// req.file.buffer. Each CSV row is turned into a booking by
// bookingService.bulkImportBookings, which internally calls the same
// createBooking used by the single-booking endpoint above — so every
// successful row also gets its registration link sent automatically,
// exactly like a normal booking does.
const importBookingsCsv = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "CSV file is required",
      });
    }

    const result = await bookingService.bulkImportBookings(
      req.file.buffer,
      req.user.id
    );

    // The request itself succeeded (HTTP 200, per-row results are in
    // `data.results`), but the message/`success` flag must not claim
    // success when NOTHING was created — e.g. a file where every row is a
    // duplicate or has an error.
    const otherFailed = result.failureCount - result.duplicateCount;
    const summary = `Processed ${result.totalRows} row(s): ${result.successCount} booking(s) created, ${result.duplicateCount} duplicate(s) skipped, ${otherFailed} failed`;

    return res.status(200).json({
      success: result.status !== "failed",
      message:
        result.status === "failed"
          ? `No bookings were created. ${summary}`
          : summary,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// ================= CHECK CSV BEFORE IMPORT =================
// Same multer upload as importBookingsCsv, but read-only: reports rows
// that share a mobile number (which must be merged / changed before the
// import is allowed), rows that already have a booking, and invalid
// rows — without creating anything.
const checkBookingsCsv = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "CSV file is required",
      });
    }

    const result = await bookingService.checkBookingCsv(req.file.buffer);

    return res.status(200).json({
      success: true,
      message: result.canImport
        ? "CSV checked"
        : "Same mobile number found in more than one row",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createBooking,
  importBookingsCsv,
  checkBookingsCsv,
  getAllBookings,
  deleteBooking,
  getBookingById,
  exportBookingsController,
};