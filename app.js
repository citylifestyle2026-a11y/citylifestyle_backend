const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");
const healthRoutes = require("./routes/health.routes");
const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const adminRoutes = require("./routes/admin.routes");
const eventRoutes = require('./routes/event.routes');
const ticketTypeRoutes = require("./routes/ticketType.routes");
const bookingRoutes = require("./routes/booking.routes");
const bookingTicketRoutes = require("./routes/bookingTicket.routes");
const qrRoutes = require("./routes/qr.routes");
const entryReportRoutes = require("./routes/entryReport.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const roleRoutes = require("./routes/role.routes");
const publicRegistrationRoutes = require("./routes/publicRegistration.routes");
const contactRoutes = require("./routes/contact.routes");
const companyCategoryRoutes = require("./routes/companycategory.routes");
const app = express();

// ---------- Core Middlewares ----------
const corsOptions = {
  origin: [
    "https://citytoppers.in",
    "https://www.citytoppers.in",
    "http://localhost:5173",
    "https://localhost",
    "capacitor://localhost",
  ],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

// ---------- Routes ----------
app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
//users
app.use("/api/users", userRoutes);
// admin management (was previously missing here — routes/admin.routes.js
// already implements GET/POST/PUT for Admin Management and Edit
// Profile-by-Super-Admin, it just was never mounted, hence every
// /api/admin/... request falling through to the 404 handler below)
app.use("/api/admin", adminRoutes);
// events
app.use("/api/events", eventRoutes);
// ticket 
app.use("/api/ticket-type", ticketTypeRoutes);
// booking
app.use("/api/bookings", bookingRoutes);;
// booking ticket
app.use("/api/booking-ticket", bookingTicketRoutes);
// qr routes
app.use("/api/qr", qrRoutes);
// entery reports
app.use("/api/entry-report", entryReportRoutes);
//dashboard
app.use("/api/dashboard", dashboardRoutes);
// ROLE
app.use("/api/roles", roleRoutes);
// export
app.use("/api/bookings", bookingRoutes);
// publick register router
app.use("/api/public/registration", publicRegistrationRoutes);
// contacts (was previously missing here — routes/contact.routes.js
// already implements Reference Summary plus create/list/get/update/
// delete, it just was never mounted, hence every /api/contacts/...
// request falling through to the 404 handler below)
app.use("/api/contacts", contactRoutes);
// company categories (same as above — was implemented but never mounted)
app.use("/api/company-categories", companyCategoryRoutes);
// image 
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ---------- 404 Handler ----------
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// ---------- Global Error Handler ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // If a response (e.g. a streamed Excel export) has already started,
  // headers can't be changed any more — hand over to Express's default
  // handler, which closes the connection, instead of throwing
  // "Cannot set headers after they are sent".
  if (res.headersSent) {
    return next(err);
  }

  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal Server Error";

  // Malformed JSON body (thrown by express.json())
  if (err.type === "entity.parse.failed") {
    statusCode = 400;
    message = "Invalid JSON in request body";
  }

  // File upload limits (multer) — was falling through as a 500.
  if (err.name === "MulterError") {
    statusCode = 400;
    message =
      err.code === "LIMIT_FILE_SIZE"
        ? "Uploaded file is too large."
        : err.message || "File upload failed";
  }

  // Invalid MongoDB ObjectId
  if (err.name === "CastError") {
    statusCode = 400;
    message = `Invalid value for field: ${err.path}`;
  }

  // Mongoose schema validation errors
  if (err.name === "ValidationError") {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((val) => val.message)
      .join(", ");
  }

  // Duplicate key error (e.g. email already exists)
  if (err.code === 11000) {
    statusCode = 400;
    const field = Object.keys(err.keyValue || {})[0];
    message = `${field ? field.charAt(0).toUpperCase() + field.slice(1) : "Field"} already exists`;
  }

  // JWT errors that slip through (defensive; auth middleware already handles most)
  if (err.name === "JsonWebTokenError") {
    statusCode = 401;
    message = "Invalid token";
  }

  if (err.name === "TokenExpiredError") {
    statusCode = 401;
    message = "Token has expired";
  }

  // Unexpected (non-AppError) failures are logged in production too —
  // previously they were silent there, so a live-only failure left no
  // trace in the server logs. Expected AppErrors (validation, not found,
  // etc.) stay quiet.
  if (!err.isOperational) {
    console.error(`[${req.method} ${req.originalUrl}]`, err.stack || err);
  }

  res.status(statusCode).json({
    success: false,
    message,
  });
});

module.exports = app;