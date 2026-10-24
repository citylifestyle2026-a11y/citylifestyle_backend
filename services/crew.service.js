const mongoose = require("mongoose");
const { Readable } = require("stream");
const ExcelJS = require("exceljs");
const Crew = require("../models/crew.model");
const CrewCategory = require("../models/crewcategory.model");
const AppError = require("../utils/AppError");
const {
  normalizeMobileNumber,
  MOBILE_ERROR_MESSAGE,
} = require("../utils/normalizeMobileNumber");

const SORTABLE_FIELDS = ["fullName", "whatsappNumber", "designation", "area", "createdAt"];
const MAX_PASS_GUESTS = 10;
const POPULATE = [
  { path: "crewCategory", select: "name" },
];
const CASE_INSENSITIVE = { locale: "en", strength: 2 };

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const text = (value) => String(value ?? "").trim();

const toObjectId = (id, label = "ID") => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new AppError(`Invalid ${label}`, 400);
  return id;
};

const validateIdList = (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError("Please select at least one crew member.", 400);
  }
  const unique = [...new Set(ids.map((id) => String(id)))];
  if (unique.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw new AppError("Invalid crew selection.", 400);
  }
  return unique;
};

const normalizeNumberOrThrow = (value) => {
  const number = normalizeMobileNumber(value);
  if (!number) throw new AppError(MOBILE_ERROR_MESSAGE || "Enter a valid WhatsApp number", 400);
  return number;
};

const assertNumberFree = async (number, excludeId = null) => {
  const filter = { whatsappNumber: number, isDeleted: { $ne: true } };
  if (excludeId) filter._id = { $ne: excludeId };
  if (await Crew.exists(filter)) {
    throw new AppError("A crew member with this WhatsApp number already exists", 400);
  }
};

const resolveCategory = async (value) => {
  if (value === undefined) return undefined;
  if (!value) return null;
  toObjectId(value, "Crew Category ID");
  const category = await CrewCategory.findOne({ _id: value, isDeleted: { $ne: true } });
  if (!category) throw new AppError("Crew Category not found", 404);
  return category._id;
};

// ================= FILTERS (shared by list + export) =================
const buildCrewQuery = (query = {}) => {
  const filter = { isDeleted: { $ne: true } };
  const search = text(query.search);

  if (search) {
    const rx = { $regex: escapeRegex(search), $options: "i" };
    filter.$or = [
      { fullName: rx },
      { whatsappNumber: rx },
      { designation: rx },
      { area: rx },
      { email: rx },
    ];
  }

  if (query.crewCategory) {
    toObjectId(query.crewCategory, "Crew Category ID");
    filter.crewCategory = query.crewCategory;
  }

  // Pass tabs (same idea as Guest List):
  //  sent      - pass is live
  //  notSent   - no pass sent, none cancelled
  //  rejected  - rejected crew (a cancelled pass lives in its own tab)
  //  cancelled - pass was cancelled and not brought back yet
  if (query.passStatus === "pending") {
    filter.approvalStatus = "pending";
  } else if (query.passStatus === "sent") {
    filter.passSentAt = { $ne: null };
  } else if (query.passStatus === "notSent") {
    filter.passSentAt = null;
    filter.passCancelledAt = null;
  } else if (query.passStatus === "rejected") {
    filter.approvalStatus = "rejected";
    filter.$and = [{ $or: [{ passCancelledAt: null }, { passSentAt: { $ne: null } }] }];
  } else if (query.passStatus === "cancelled") {
    filter.approvalStatus = "rejected";
    filter.passSentAt = null;
    filter.passCancelledAt = { $ne: null };
  }

  return filter;
};

// ================= CREATE =================
const createCrew = async (data, adminId) => {
  const whatsappNumber = normalizeNumberOrThrow(data.whatsappNumber);
  await assertNumberFree(whatsappNumber);

  const crew = await Crew.create({
    fullName: text(data.fullName),
    whatsappNumber,
    email: text(data.email),
    crewCategory: (await resolveCategory(data.crewCategory)) || null,
    designation: text(data.designation),
    area: text(data.area),
    address: text(data.address),
    remark: text(data.remark),
    // New crew always starts as Pending; an admin approves them later.
    approvalStatus: "pending",
    createdBy: adminId,
  });

  return crew.populate(POPULATE);
};

// ================= LIST =================
const getAllCrew = async (query = {}) => {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit) || 10, 1), 200);
  const sortField = SORTABLE_FIELDS.includes(query.sortBy) ? query.sortBy : "createdAt";
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;
  const filter = buildCrewQuery(query);

  const [total, crew] = await Promise.all([
    Crew.countDocuments(filter),
    Crew.find(filter)
      .collation(CASE_INSENSITIVE)
      .populate(POPULATE)
      .sort({ [sortField]: sortOrder, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
  ]);

  // Tab counts follow the search + category filter, not the pass tab itself.
  const base = buildCrewQuery({ ...query, passStatus: undefined });
  const [all, passSent, passNotSent, passCancelled, rejectedAll, pending] = await Promise.all([
    Crew.countDocuments(base),
    Crew.countDocuments({ ...base, passSentAt: { $ne: null } }),
    Crew.countDocuments({ ...base, passSentAt: null, passCancelledAt: null }),
    Crew.countDocuments({
      ...base,
      approvalStatus: "rejected",
      passSentAt: null,
      passCancelledAt: { $ne: null },
    }),
    Crew.countDocuments({ ...base, approvalStatus: "rejected" }),
    Crew.countDocuments({ ...base, approvalStatus: "pending" }),
  ]);

  return {
    success: true,
    message: "Crew fetched successfully",
    data: crew,
    counts: {
      all,
      passSent,
      passNotSent,
      passCancelled,
      pending,
      rejected: Math.max(0, rejectedAll - passCancelled),
    },
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
};

// ================= GET ONE =================
const getCrewById = async (id) => {
  toObjectId(id, "Crew ID");
  const crew = await Crew.findOne({ _id: id, isDeleted: { $ne: true } }).populate(POPULATE);
  if (!crew) throw new AppError("Crew member not found", 404);
  return crew;
};

// ================= UPDATE =================
const updateCrew = async (id, data) => {
  toObjectId(id, "Crew ID");
  const crew = await Crew.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!crew) throw new AppError("Crew member not found", 404);

  if (data.whatsappNumber !== undefined) {
    const number = normalizeNumberOrThrow(data.whatsappNumber);
    if (number !== crew.whatsappNumber) {
      await assertNumberFree(number, crew._id);
      crew.whatsappNumber = number;
    }
  }

  ["fullName", "email", "designation", "area", "address", "remark"].forEach((key) => {
    if (data[key] !== undefined) crew[key] = text(data[key]);
  });

  if (data.crewCategory !== undefined) crew.crewCategory = await resolveCategory(data.crewCategory);

  await crew.save();
  return crew.populate(POPULATE);
};

// ================= DELETE (SOFT) =================
const deleteCrew = async (id, adminId) => {
  toObjectId(id, "Crew ID");
  const crew = await Crew.findOne({ _id: id, isDeleted: { $ne: true } });
  if (!crew) throw new AppError("Crew member not found", 404);

  crew.isDeleted = true;
  crew.deletedAt = new Date();
  crew.deletedBy = adminId;
  await crew.save();
  return crew;
};

const bulkDeleteCrew = async ({ ids }, adminId) => {
  const list = validateIdList(ids);
  const result = await Crew.updateMany(
    { _id: { $in: list }, isDeleted: { $ne: true } },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: adminId } }
  );
  return {
    success: true,
    message: `${result.modifiedCount} crew member${result.modifiedCount === 1 ? "" : "s"} deleted`,
    data: { deleted: result.modifiedCount },
  };
};

// ================= EXPORT (EXCEL) =================
const EXPORT_COLUMNS = [
  ["Full Name", "fullName", 26],
  ["WhatsApp Number", "whatsappNumber", 18],
  ["Email", "email", 26],
  ["Crew Category", "category", 22],
  ["Designation", "designation", 22],
  ["Area", "area", 18],
  ["Address", "address", 34],
  ["Remark", "remark", 30],
  ["Pass Sent", "passSent", 12],
];

const exportCrewXlsx = async (query = {}) => {
  const filter = buildCrewQuery(query);
  const ids = String(query.ids || "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (ids.length) filter._id = { $in: ids };

  const crew = await Crew.find(filter)
    .collation(CASE_INSENSITIVE)
    .populate(POPULATE)
    .sort({ fullName: 1, _id: 1 })
    .lean();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Crew", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = EXPORT_COLUMNS.map(([header, key, width]) => ({ header, key, width }));
  sheet.getColumn("whatsappNumber").numFmt = "@";

  crew.forEach((c) =>
    sheet.addRow({
      fullName: c.fullName,
      whatsappNumber: String(c.whatsappNumber || ""),
      email: c.email,
      category: c.crewCategory?.name || "",
      designation: c.designation,
      area: c.area,
      address: c.address,
      remark: c.remark,
      passSent: c.passSentAt ? "Yes" : "No",
    })
  );

  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3B82C4" } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: EXPORT_COLUMNS.length } };

  return { buffer: await workbook.xlsx.writeBuffer(), count: crew.length };
};

// Empty sample file for the Import dialog.
const buildImportTemplate = async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Crew");
  const columns = EXPORT_COLUMNS.slice(0, 10);
  sheet.columns = columns.map(([header, key, width]) => ({ header, key, width }));
  sheet.getColumn("whatsappNumber").numFmt = "@";
  sheet.addRow({
    fullName: "Rahul Shah",
    whatsappNumber: "9876543210",
    email: "rahul@example.com",
    category: "Security",
    designation: "Team Lead",
    area: "Adajan",
    address: "",
    remark: "",
  });
  sheet.getRow(1).font = { bold: true };
  return workbook.xlsx.writeBuffer();
};

// ================= IMPORT (EXCEL / CSV) =================
const cellText = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (value.text !== undefined) return text(value.text);
    if (Array.isArray(value.richText)) return text(value.richText.map((r) => r.text).join(""));
    if (value.result !== undefined) return text(value.result);
    if (value instanceof Date) return value.toISOString();
  }
  return text(value);
};

const HEADER_ALIASES = {
  fullName: ["full name", "name", "fullname", "crew name"],
  whatsappNumber: ["whatsapp number", "whatsapp", "mobile", "mobile number", "contact", "phone", "number"],
  email: ["email", "email id"],
  category: ["crew category", "category", "company category", "company categories"],
  designation: ["designation", "role", "position"],
  area: ["area", "city"],
  address: ["address"],
  remark: ["remark", "remarks", "note", "notes"],
};

const parseCrewFile = async (buffer, fileName) => {
  const workbook = new ExcelJS.Workbook();
  if (/\.csv$/i.test(fileName || "")) {
    await workbook.csv.read(Readable.from(buffer));
  } else {
    await workbook.xlsx.load(buffer);
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new AppError("The file is empty.", 400);

  const headerRow = sheet.getRow(1);
  const columnByKey = {};
  headerRow.eachCell((cell, col) => {
    const label = cellText(cell.value).toLowerCase();
    Object.entries(HEADER_ALIASES).forEach(([key, aliases]) => {
      if (columnByKey[key] === undefined && aliases.includes(label)) columnByKey[key] = col;
    });
  });

  if (!columnByKey.fullName || !columnByKey.whatsappNumber) {
    throw new AppError('The file needs at least the columns "Full Name" and "WhatsApp Number".', 400);
  }

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const data = {};
    Object.entries(columnByKey).forEach(([key, col]) => {
      data[key] = cellText(row.getCell(col).value);
    });
    if (Object.values(data).every((v) => !v)) return; // blank line
    rows.push({ rowNumber, ...data });
  });

  if (rows.length === 0) throw new AppError("No crew rows found in the file.", 400);
  if (rows.length > 2000) throw new AppError("A file can have at most 2000 rows.", 400);
  return rows;
};

// POST /crew/import  (?dryRun=true only checks the file)
// A Category name that does not exist yet is created automatically.
const importCrew = async (buffer, fileName, adminId, { dryRun = false } = {}) => {
  const rows = await parseCrewFile(buffer, fileName);

  const categories = await CrewCategory.find({ isDeleted: { $ne: true } }).lean();
  const categoryByName = new Map(categories.map((c) => [c.name.toLowerCase(), c._id]));

  const existing = await Crew.find({ isDeleted: { $ne: true } }, { whatsappNumber: 1 }).lean();
  const seen = new Set(existing.map((c) => c.whatsappNumber));

  const problems = [];
  const toInsert = [];
  const newCategories = new Set();

  for (const row of rows) {
    const name = text(row.fullName);
    const number = normalizeMobileNumber(row.whatsappNumber);

    if (!name) {
      problems.push({ row: row.rowNumber, name: "-", reason: "Full Name is empty" });
      continue;
    }
    if (!number) {
      problems.push({ row: row.rowNumber, name, reason: "Invalid WhatsApp number" });
      continue;
    }
    if (seen.has(number)) {
      problems.push({ row: row.rowNumber, name, reason: "WhatsApp number already exists" });
      continue;
    }
    seen.add(number);

    const categoryName = text(row.category);
    if (categoryName && !categoryByName.has(categoryName.toLowerCase())) {
      newCategories.add(categoryName);
    }

    toInsert.push({
      fullName: name,
      whatsappNumber: number,
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(row.email)) ? text(row.email) : "",
      categoryName,
      designation: text(row.designation),
      area: text(row.area),
      address: text(row.address),
      remark: text(row.remark),
    });
  }

  const summary = {
    totalRows: rows.length,
    valid: toInsert.length,
    failed: problems.length,
    newCategories: [...newCategories],
  };

  if (dryRun) {
    return {
      success: true,
      message: `${toInsert.length} of ${rows.length} rows are ready to import.`,
      data: { ...summary, imported: 0, problems: problems.slice(0, 100), dryRun: true },
    };
  }

  for (const categoryName of newCategories) {
    try {
      const created = await CrewCategory.create({ name: categoryName, createdBy: adminId });
      categoryByName.set(categoryName.toLowerCase(), created._id);
    } catch (error) {
      // Created meanwhile by someone else -> look it up.
      const found = await CrewCategory.findOne({ name: categoryName, isDeleted: { $ne: true } }).collation(CASE_INSENSITIVE);
      if (found) categoryByName.set(categoryName.toLowerCase(), found._id);
    }
  }

  const docs = toInsert.map(({ categoryName, ...rest }) => ({
    ...rest,
    crewCategory: categoryName ? categoryByName.get(categoryName.toLowerCase()) || null : null,
    approvalStatus: "pending", // imported crew also start as Pending
    createdBy: adminId,
  }));

  let imported = 0;
  if (docs.length) {
    const inserted = await Crew.insertMany(docs, { ordered: false }).catch((error) => error.insertedDocs || []);
    imported = Array.isArray(inserted) ? inserted.length : 0;
  }

  return {
    success: true,
    message: `${imported} crew member${imported === 1 ? "" : "s"} imported${problems.length ? `, ${problems.length} skipped` : ""}.`,
    data: { ...summary, imported, problems: problems.slice(0, 100), dryRun: false },
  };
};

// ================= SEND PASS (WHATSAPP) =================
// Same flow as Guest List: a booking is created for the chosen event +
// ticket (bookingService.createBooking also sends the WhatsApp pass).
const sendPassToCrew = async ({ ids, eventId, ticketTypeId, quantities }, adminId) => {
  const bookingService = require("./booking.service");
  const Event = require("../models/event.model");
  const TicketType = require("../models/ticketType.model");
  const Booking = require("../models/booking.model");

  const crewIds = validateIdList(ids);
  if (!mongoose.Types.ObjectId.isValid(eventId)) throw new AppError("Please select an event.", 400);
  if (!mongoose.Types.ObjectId.isValid(ticketTypeId)) throw new AppError("Please select a ticket.", 400);

  const [event, ticketType] = await Promise.all([
    Event.findById(eventId),
    TicketType.findOne({ _id: ticketTypeId, eventId, isDeleted: false }),
  ]);
  if (!event) throw new AppError("Event not found.", 404);
  if (!ticketType) throw new AppError("Ticket not found for this event.", 404);

  const members = await Crew.find({ _id: { $in: crewIds }, isDeleted: { $ne: true } }).populate("crewCategory", "name");
  const byId = new Map(members.map((c) => [String(c._id), c]));
  const results = [];

  for (const id of crewIds) {
    const member = byId.get(id);
    if (!member) {
      results.push({ id, name: "-", status: "failed", message: "Crew member not found." });
      continue;
    }
    const base = { id, name: member.fullName };

    if ((member.approvalStatus || "approved") !== "approved") {
      results.push({ ...base, status: "failed", message: "Only an approved crew member can receive a pass." });
      continue;
    }

    if (member.passSentAt && member.passBookingId) {
      const live = await Booking.exists({
        _id: member.passBookingId,
        isDeleted: { $ne: true },
        bookingStatus: { $ne: "Cancelled" },
      });
      if (live) {
        results.push({ ...base, status: "failed", message: "Pass already sent. Use Resend Pass instead." });
        continue;
      }
    }

    const requested = Number(quantities?.[id]);
    const quantity =
      Number.isInteger(requested) && requested >= 1 ? Math.min(requested, MAX_PASS_GUESTS) : 1;

    try {
      const { booking } = await bookingService.createBooking(
        {
          eventId,
          ticketTypeId,
          quantity,
          amount: ticketType.amount * quantity,
          discount: 0,
          name: member.fullName,
          mobileNumber: member.whatsappNumber,
          email: member.email || "",
          companyName: member.crewCategory?.name || "N/A",
          remark: "Pass sent from Crew",
        },
        adminId
      );

      // Crew passes are marked so they never reach Event History.
      await Booking.updateOne({ _id: booking._id }, { $set: { isCrew: true } });

      await Crew.updateOne(
        { _id: member._id },
        {
          $set: {
            passSentAt: new Date(),
            passEventId: event._id,
            passBookingId: booking._id,
            passQuantity: quantity,
            passCancelledAt: null,
            passCancelMessageSentAt: null,
            passCancelledBookingId: null,
            passCancelledEventId: null,
          },
        }
      );

      results.push({
        ...base,
        status: "sent",
        message: `Pass sent (${quantity} guest${quantity === 1 ? "" : "s"}) - ${booking.bookingNumber}`,
      });
    } catch (error) {
      results.push({ ...base, status: "failed", message: error.message || "Failed to send pass." });
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const failed = results.length - sent;

  return {
    success: true,
    message:
      failed === 0
        ? `Pass sent to ${sent} crew member${sent === 1 ? "" : "s"}.`
        : `Pass sent to ${sent}, failed for ${failed}.`,
    data: { sent, failed, results },
  };
};


// ================= CANCEL / RESTORE PASS (same as Guest List) =================
const APPROVAL_STATUSES = ["pending", "approved", "rejected"];
const PASS_CANCELLED_REMARK = " | Pass cancelled (crew status changed)";

// Live (not cancelled / deleted) pass booking of a crew member.
const findActivePassBookings = async (member) => {
  const Booking = require("../models/booking.model");
  if (!member.passBookingId) return [];
  return Booking.find({
    _id: member.passBookingId,
    isDeleted: { $ne: true },
    bookingStatus: { $ne: "Cancelled" },
  });
};

// Invalidates the pass (QR stops working), gives the seats back to the ticket
// stock and clears "Pass sent". A pass that was already used is left alone.
const cancelPassForCrew = async (member) => {
  const Booking = require("../models/booking.model");
  const BookingTicket = require("../models/bookingTicket.model");
  const TicketType = require("../models/ticketType.model");

  const bookings = await findActivePassBookings(member);
  let cancelled = 0;
  let alreadyUsed = 0;
  let cancelledBookingId = null;

  for (const booking of bookings) {
    const usedCount = await BookingTicket.countDocuments({ bookingId: booking._id, status: "Used" });
    if (usedCount > 0) {
      alreadyUsed += 1;
      continue;
    }

    await BookingTicket.updateMany({ bookingId: booking._id, status: "Active" }, { $set: { status: "Cancelled" } });
    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          bookingStatus: "Cancelled",
          remark: `${booking.remark || "Pass"}${PASS_CANCELLED_REMARK}`,
        },
      }
    );
    await TicketType.updateOne({ _id: booking.ticketTypeId }, { $inc: { availableCount: booking.quantity } });

    if (!cancelledBookingId) cancelledBookingId = booking._id;
    cancelled += 1;
  }

  if (alreadyUsed === 0) {
    await Crew.updateOne(
      { _id: member._id },
      {
        $set: {
          passSentAt: null,
          passEventId: null,
          passBookingId: null,
          // Remembered so "Approve Pass" can bring this same pass back.
          ...(cancelledBookingId
            ? { passCancelledBookingId: cancelledBookingId, passCancelledEventId: member.passEventId || null }
            : {}),
        },
      }
    );
  }

  return { cancelled, alreadyUsed };
};

// Brings back the SAME pass (same QR) and sends it again on WhatsApp.
// Returns { restored, messageSent, reason }.
const restorePassForCrew = async (member) => {
  const Booking = require("../models/booking.model");
  const BookingTicket = require("../models/bookingTicket.model");
  const TicketType = require("../models/ticketType.model");
  const bookingTicketService = require("./bookingTicket.service");

  const fail = (reason) => ({ restored: false, messageSent: false, reason });

  if (!member.passCancelledBookingId) return fail("No cancelled pass to bring back.");

  const booking = await Booking.findOne({ _id: member.passCancelledBookingId, isDeleted: { $ne: true } });
  if (!booking) return fail("The cancelled pass no longer exists. Send a new pass.");

  if (booking.bookingStatus === "Cancelled") {
    const stock = await TicketType.findOneAndUpdate(
      { _id: booking.ticketTypeId, availableCount: { $gte: booking.quantity } },
      { $inc: { availableCount: -booking.quantity } }
    );
    if (!stock) return fail("Not enough tickets left to bring this pass back.");

    await BookingTicket.updateMany({ bookingId: booking._id, status: "Cancelled" }, { $set: { status: "Active" } });
    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          bookingStatus: "Confirmed",
          remark: String(booking.remark || "").split(PASS_CANCELLED_REMARK).join(""),
        },
      }
    );
  }

  await Crew.updateOne(
    { _id: member._id },
    {
      $set: {
        passSentAt: new Date(),
        passEventId: booking.eventId || member.passCancelledEventId || null,
        passBookingId: booking._id,
        passCancelledAt: null,
        passCancelMessageSentAt: null,
        passCancelledBookingId: null,
        passCancelledEventId: null,
      },
    }
  );

  try {
    const primaryTicket = await BookingTicket.findOne({
      bookingId: booking._id,
      status: { $ne: "Cancelled" },
    }).sort({ createdAt: 1, _id: 1 });
    if (!primaryTicket) return { restored: true, messageSent: false, reason: "No active ticket found to send." };

    await bookingTicketService.resendTicket(primaryTicket._id);
    return { restored: true, messageSent: true, reason: "" };
  } catch (error) {
    return { restored: true, messageSent: false, reason: String(error?.message || "WhatsApp error") };
  }
};

// POST /crew/cancel-pass { ids }
// Approved crew with a pass: pass cancelled (QR dead, seat back to stock),
// crew moves to Rejected / "Pass Cancelled" and gets a WhatsApp message.
const cancelPassesOfCrew = async ({ ids }, adminId) => {
  const Event = require("../models/event.model");
  const { sendPassCancelledMessage } = require("./contactNotification.service");

  const crewIds = validateIdList(ids);
  const members = await Crew.find({ _id: { $in: crewIds }, isDeleted: { $ne: true } });
  const byId = new Map(members.map((c) => [String(c._id), c]));
  const results = [];

  for (const id of crewIds) {
    const member = byId.get(String(id));
    if (!member) {
      results.push({ id, name: "-", status: "failed", message: "Crew member not found. Refresh the list and try again." });
      continue;
    }
    const base = { id: String(member._id), name: member.fullName };

    if ((member.approvalStatus || "approved") !== "approved") {
      results.push({ ...base, status: "failed", message: "Only an approved crew member's pass can be cancelled." });
      continue;
    }
    if (!member.passSentAt) {
      results.push({ ...base, status: "failed", message: "No pass has been sent to this crew member." });
      continue;
    }

    try {
      // Read the event name BEFORE the cancel (it clears passEventId).
      let editionName = "";
      if (member.passEventId) {
        const event = await Event.findById(member.passEventId).select("title edition").lean();
        if (event) editionName = event.edition || event.title || "";
      }

      const outcome = await cancelPassForCrew(member);
      if (outcome.cancelled === 0) {
        results.push({
          ...base,
          status: "failed",
          message:
            outcome.alreadyUsed > 0
              ? "This pass has already been used at the gate, so it cannot be cancelled."
              : "No active pass found to cancel.",
        });
        continue;
      }

      await Crew.updateOne(
        { _id: member._id },
        {
          $set: {
            approvalStatus: "rejected",
            approvalUpdatedAt: new Date(),
            approvalUpdatedBy: adminId || null,
            passCancelledAt: new Date(),
            passCancelMessageSentAt: null,
          },
        }
      );

      let messageSent = false;
      let messageError = "";
      try {
        await sendPassCancelledMessage(member, editionName);
        await Crew.updateOne({ _id: member._id }, { $set: { passCancelMessageSentAt: new Date() } });
        messageSent = true;
      } catch (error) {
        messageError = String(error?.message || "Unknown WhatsApp error");
        console.error(`Pass-cancelled WhatsApp failed for crew ${member._id}:`, messageError);
      }

      results.push({
        ...base,
        status: "cancelled",
        messageSent,
        message: messageSent
          ? "Pass cancelled and WhatsApp message sent."
          : `Pass cancelled, but the WhatsApp message could not be sent (${messageError}).`,
      });
    } catch (error) {
      results.push({ ...base, status: "failed", message: error.message || "Failed to cancel the pass." });
    }
  }

  const cancelled = results.filter((r) => r.status === "cancelled").length;
  const messageSent = results.filter((r) => r.messageSent).length;
  const messageFailed = cancelled - messageSent;
  const failed = results.length - cancelled;
  const firstFailure = results.find((r) => r.status === "failed");
  const firstMessageError = results.find((r) => r.status === "cancelled" && !r.messageSent);

  const parts = [cancelled ? `Pass cancelled for ${cancelled} crew member${cancelled === 1 ? "" : "s"}` : "No pass was cancelled"];
  if (cancelled && messageSent) parts.push(`WhatsApp message sent to ${messageSent}`);
  if (messageFailed) parts.push(`WhatsApp message failed for ${messageFailed}`);
  if (failed) parts.push(`${failed} could not be cancelled`);

  return {
    success: cancelled > 0,
    message: `${parts.join(", ")}.`,
    data: {
      cancelled,
      failed,
      messageSent,
      messageFailed,
      failedReason: firstFailure ? firstFailure.message : "",
      messageError: firstMessageError ? firstMessageError.message : "",
      usedTemplate: Boolean(String(process.env.CHATBOX_PASS_CANCEL_TEMPLATE_NAME || "").trim()),
      results,
    },
  };
};

// PUT /crew/bulk-status { ids, status: pending | approved | rejected }
//  - Reject / Pending on crew WITH a pass -> same as Cancel Pass (pass cancelled).
//  - Approve on crew whose pass was cancelled -> the SAME pass comes back and
//    is sent again on WhatsApp.
const bulkUpdateCrewStatus = async ({ ids, status }, adminId) => {
  if (!APPROVAL_STATUSES.includes(status)) {
    throw new AppError("Status must be pending, approved or rejected.", 400);
  }

  let crewIds = validateIdList(ids);
  let cancelResult = null;

  // Rejecting an approved crew member who has a pass = Cancel Pass.
  if (status === "rejected") {
    const withPass = await Crew.find({
      _id: { $in: crewIds },
      isDeleted: { $ne: true },
      passSentAt: { $ne: null },
      approvalStatus: { $in: ["approved", null] },
    })
      .select("_id")
      .lean();

    if (withPass.length) {
      const handled = new Set(withPass.map((c) => String(c._id)));
      cancelResult = await cancelPassesOfCrew({ ids: [...handled] }, adminId);
      crewIds = crewIds.filter((id) => !handled.has(String(id)));
      if (crewIds.length === 0) return cancelResult;
    }
  }

  const baseFilter = { _id: { $in: crewIds }, isDeleted: { $ne: true } };
  const before = await Crew.find(baseFilter);

  let passesCancelled = 0;
  let passesUsed = 0;
  if (status === "pending") {
    for (const member of before) {
      if (!member.passSentAt) continue;
      try {
        const result = await cancelPassForCrew(member);
        passesCancelled += result.cancelled;
        passesUsed += result.alreadyUsed;
      } catch (error) {
        console.error(`Pass cancel failed for crew ${member._id}:`, error);
      }
    }
  }

  const result = await Crew.updateMany(baseFilter, {
    $set: { approvalStatus: status, approvalUpdatedAt: new Date(), approvalUpdatedBy: adminId || null },
  });
  const matched = result.matchedCount ?? result.n ?? crewIds.length;

  let passesRestored = 0;
  let passRestoreFailed = 0;
  let passMessageFailed = 0;
  let passRestoreError = "";

  if (status === "approved") {
    for (const member of before) {
      if (!member.passCancelledBookingId) continue;
      if ((member.approvalStatus || "approved") === "approved") continue;
      try {
        const outcome = await restorePassForCrew(member);
        if (!outcome.restored) {
          passRestoreFailed += 1;
          if (!passRestoreError) passRestoreError = outcome.reason;
        } else {
          passesRestored += 1;
          if (!outcome.messageSent) {
            passMessageFailed += 1;
            if (!passRestoreError) passRestoreError = outcome.reason;
          }
        }
      } catch (error) {
        passRestoreFailed += 1;
        if (!passRestoreError) passRestoreError = String(error?.message || "Failed to restore the pass");
        console.error(`Pass restore failed for crew ${member._id}:`, error);
      }
    }
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const notes = [];
  if (cancelResult?.data?.cancelled) {
    notes.push(`${cancelResult.data.cancelled === 1 ? "1 pass" : `${cancelResult.data.cancelled} passes`} cancelled`);
  }
  if (passesRestored) {
    notes.push(
      `${passesRestored === 1 ? "1 pass" : `${passesRestored} passes`} brought back` +
        (passMessageFailed ? ` (WhatsApp failed for ${passMessageFailed})` : " and sent again")
    );
  }
  if (passRestoreFailed) {
    notes.push(
      `${passRestoreFailed === 1 ? "1 pass" : `${passRestoreFailed} passes`} could not be brought back` +
        (passRestoreError ? ` (${passRestoreError})` : "")
    );
  }
  if (passesCancelled) notes.push(`${passesCancelled === 1 ? "1 pass" : `${passesCancelled} passes`} cancelled`);
  if (passesUsed) notes.push(`${passesUsed === 1 ? "1 pass" : `${passesUsed} passes`} already used (not cancelled)`);

  return {
    success: true,
    message: `${plural(matched, "crew member")} marked as ${status}.` + (notes.length ? ` ${notes.join(", ")}.` : ""),
    data: { matched, status, passesCancelled, passesUsed, passesRestored, passRestoreFailed, passMessageFailed, passRestoreError },
  };
};

// Sends the SAME pass (same QR) again.
const resendPassToCrew = async ({ ids }) => {
  const Booking = require("../models/booking.model");
  const BookingTicket = require("../models/bookingTicket.model");
  const bookingTicketService = require("./bookingTicket.service");

  const crewIds = validateIdList(ids);
  const members = await Crew.find({ _id: { $in: crewIds }, isDeleted: { $ne: true } });
  const byId = new Map(members.map((c) => [String(c._id), c]));
  const results = [];

  for (const id of crewIds) {
    const member = byId.get(id);
    if (!member) {
      results.push({ id, name: "-", status: "failed", message: "Crew member not found." });
      continue;
    }
    const base = { id, name: member.fullName };

    try {
      const booking = member.passBookingId
        ? await Booking.findOne({
            _id: member.passBookingId,
            isDeleted: { $ne: true },
            bookingStatus: { $ne: "Cancelled" },
          })
        : null;
      if (!booking) {
        results.push({ ...base, status: "failed", message: "No active pass found. Use Send Pass instead." });
        continue;
      }

      const ticket = await BookingTicket.findOne({
        bookingId: booking._id,
        status: { $ne: "Cancelled" },
      }).sort({ createdAt: 1, _id: 1 });
      if (!ticket) {
        results.push({ ...base, status: "failed", message: "No active ticket found for this pass." });
        continue;
      }

      await bookingTicketService.resendTicket(ticket._id);
      results.push({ ...base, status: "sent", message: "Pass sent again." });
    } catch (error) {
      results.push({ ...base, status: "failed", message: error.message || "Failed to resend pass." });
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const failed = results.length - sent;

  return {
    success: failed === 0,
    message:
      failed === 0
        ? `Pass sent again to ${sent} crew member${sent === 1 ? "" : "s"}.`
        : sent === 0
          ? results[0]?.message || "Failed to resend pass."
          : `Pass sent again to ${sent}, failed for ${failed}.`,
    data: { sent, failed, results },
  };
};

module.exports = {
  createCrew,
  getAllCrew,
  getCrewById,
  updateCrew,
  deleteCrew,
  bulkDeleteCrew,
  exportCrewXlsx,
  buildImportTemplate,
  importCrew,
  sendPassToCrew,
  resendPassToCrew,
  cancelPassesOfCrew,
  bulkUpdateCrewStatus,
};
