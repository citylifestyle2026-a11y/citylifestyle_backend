const mongoose = require("mongoose");
const Contact = require("../models/contact.model")
const CompanyCategory = require("../models/companycategory.model");
const AppError = require("../utils/AppError");
const { normalizeMobileSearchTerm } = require("../utils/normalizeMobileNumber");
const uploadImage = require("../utils/localUpload.util");
const deleteImage = require("../utils/deleteLocalFile");

// ================= CONTACT IMAGE HELPERS =================
// Profile photo + spouse profile photo arrive as multer files
// (req.files.profileImage[0] / req.files.spouseProfileImage[0]).
// uploadToLocal re-encodes them to compressed WEBP under uploads/contacts.
const CONTACT_IMAGE_FOLDER = "event-management/contacts";

const isTrue = (value) => value === true || value === "true";

const firstFile = (files, field) =>
  files && files[field] && files[field][0] ? files[field][0] : null;

const uploadOne = async (file) => {
  if (!file) return null;
  const result = await uploadImage(file, CONTACT_IMAGE_FOLDER, "image");
  return { url: result.url, publicId: result.public_id };
};

// Profile Photo is compulsory (and Spouse Profile Photo for Couple).
// `hasProfile` / `hasSpouse` say whether a photo will exist after this
// save (a new upload, or an already-saved one that isn't being removed).
// NOTE: photos are now OPTIONAL (profile + spouse). The function is kept so
// the call sites below do not change; it no longer throws. To make photos
// compulsory again, restore the two checks:
//   if (!hasProfile) throw new AppError("Profile Photo is required", 400);
//   if (isCouple && !hasSpouse) throw new AppError("Spouse Profile Photo is required for Couple", 400);
// eslint-disable-next-line no-unused-vars
const assertPhotosPresent = ({ hasProfile, hasSpouse, isCouple }) => {};

// Uploads whichever of the two photos were sent. The spouse photo is
// only ever stored for Couple. `skip*` lets the duplicate-merge path
// avoid uploading a photo it will not use (existing photo is kept).
const uploadContactImages = async (
  files,
  isCouple,
  { skipProfile = false, skipSpouse = false } = {}
) => {
  const images = { profile: null, spouse: null };

  if (!skipProfile) {
    images.profile = await uploadOne(firstFile(files, "profileImage"));
  }

  if (isCouple && !skipSpouse) {
    try {
      images.spouse = await uploadOne(firstFile(files, "spouseProfileImage"));
    } catch (error) {
      await discardUploadedImages(images);
      throw error;
    }
  }

  return images;
};

// Turns freshly uploaded images into the Mongo fields to set.
const imageFields = (images) => {
  const fields = {};

  if (images.profile) {
    fields.profileImage = images.profile.url;
    fields.profileImagePublicId = images.profile.publicId;
  }

  if (images.spouse) {
    fields.spouseProfileImage = images.spouse.url;
    fields.spouseProfileImagePublicId = images.spouse.publicId;
  }

  return fields;
};

// Best-effort removal of files that were uploaded for a save that then
// failed — so a rejected save never leaves orphan files on disk.
const discardUploadedImages = async (images) => {
  if (!images) return;
  if (images.profile) await deleteImage(images.profile.publicId);
  if (images.spouse) await deleteImage(images.spouse.publicId);
};

// Case-insensitive collation used for the reference filter below — same
// settings as the collation-based indexes already defined on
// Contact.model.js (`references`) and CompanyCategory.model.js (`name`),
// so this query actually uses those indexes instead of a full scan.
const CASE_INSENSITIVE_COLLATION = { locale: "en", strength: 2 };

// Fields the List API is allowed to sort by — kept to an explicit
// allow-list so an unrecognized/typo'd `sortBy` query value can never
// silently turn into an unindexed or unexpected sort; it just falls
// back to the default instead.
const APPROVAL_STATUSES = ["pending", "approved", "rejected"];

const SORTABLE_FIELDS = [
  "fullName",
  "whatsappNumber",
  "companyName",
  "designation",
  "area",
  "spouseName",
  "spouseMobile",
  "profession",
  "createdAt",
  "updatedAt",
];

// ================= CREATE CONTACT =================
// `adminId` always comes from the authenticated admin (req.user.id in
// the controller), never from req.body — same convention already used
// by eventService.createEvent/ticketTypeService.createTicketType.
//
// DUPLICATE HANDLING: if an existing, non-deleted contact already has
// the SAME Full Name + WhatsApp/Mobile Number (name compared
// case-insensitively, via the same collation used by getAllContacts'
// reference filter above), this submission is treated as an update to
// that contact — never a new document, and never rejected with
// "WhatsApp Number already exists". See mergeIntoExistingContact below
// for exactly what gets updated.
const createContact = async (data, adminId, files = {}, options = {}) => {
  const {
    fullName,
    whatsappNumber,
    companyName,
    designation,
    address,
    area,
    instagramId,
    spouseInstagramId,
    references,
    companyCategory,
    email,
    relationship,
    spouseName,
    spouseMobile,
    profession,
    professionCategory,
  } = data;

  assertPhotosPresent({
    hasProfile: !!firstFile(files, "profileImage"),
    hasSpouse: !!firstFile(files, "spouseProfileImage"),
    isCouple: relationship === "Couple",
  });

  if (companyCategory) {
    await assertCompanyCategoryExists(companyCategory);
  }
  if (professionCategory) {
    await assertCompanyCategoryExists(professionCategory);
  }

  const trimmedFullName = String(fullName || "").trim();
  const trimmedWhatsappNumber = String(whatsappNumber || "").trim();

  const existingContact = await Contact.findOne({
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
    whatsappNumber: trimmedWhatsappNumber,
    fullName: trimmedFullName,
  }).collation(CASE_INSENSITIVE_COLLATION);

  if (existingContact) {
    return mergeIntoExistingContact(
      existingContact,
      {
      companyName,
      designation,
      address,
      area,
      instagramId,
      spouseInstagramId,
      references,
      companyCategory,
      email,
      relationship,
      spouseName,
      spouseMobile,
      profession,
      professionCategory,
      },
      files
    );
  }

  // A history-only contact (made by Entry Report) with this number already
  // exists: adding the contact manually now turns THAT record into a real,
  // visible Contact instead of failing as a duplicate.
  const historyOnlyContact = await Contact.findOne({
    isDeleted: { $ne: true },
    historyOnly: true,
    whatsappNumber: trimmedWhatsappNumber,
  });

  if (historyOnlyContact) {
    const promoteImages = await uploadContactImages(
      files,
      relationship === "Couple"
    );

    try {
      const promoted = await Contact.findOneAndUpdate(
        { _id: historyOnlyContact._id },
        {
          fullName,
          companyName,
          designation,
          address,
          area,
          instagramId,
          spouseInstagramId: relationship === "Couple" ? spouseInstagramId : "",
          references: Array.isArray(references) ? references : [],
          companyCategory: companyCategory || null,
          email,
          relationship,
          spouseName,
          spouseMobile,
          profession,
          professionCategory: professionCategory || null,
          historyOnly: false,
          ...(options.approvalStatus
            ? { approvalStatus: options.approvalStatus }
            : {}),
          createdBy: adminId || historyOnlyContact.createdBy,
          ...imageFields(promoteImages),
        },
        { new: true, runValidators: true }
      )
        .populate("companyCategory", "name")
        .populate("professionCategory", "name")
        .populate("createdBy", "name");

      return promoted;
    } catch (error) {
      await discardUploadedImages(promoteImages);
      throw error;
    }
  }

  await assertWhatsappNumberNotDuplicate(trimmedWhatsappNumber);

  // References are passed through as-is here — trimming and
  // case-insensitive de-duplication happen in Contact.model.js's own
  // pre-save hook, not here, so every write path (this create, or a
  // future bulk-import) gets the same guarantee for free.
  // Photos are uploaded only AFTER every duplicate/category check above
  // has passed, and are removed again if the save itself fails.
  const images = await uploadContactImages(files, relationship === "Couple");

  try {
    const contact = await Contact.create({
      fullName,
      whatsappNumber,
      companyName,
      designation,
      address,
      area,
      instagramId,
      // Spouse details only mean something for Couple.
      spouseInstagramId: relationship === "Couple" ? spouseInstagramId : "",
      references: Array.isArray(references) ? references : [],
      companyCategory: companyCategory || null,
      email,
      relationship,
      spouseName,
      spouseMobile,
      profession,
      // Only meaningful for Couple; a Single contact never keeps one.
      professionCategory:
        relationship === "Couple" ? professionCategory || null : null,
      // Public form submissions pass { approvalStatus: "pending" };
      // admin-created contacts leave it out and use the schema default
      // ("approved").
      ...(options.approvalStatus
        ? { approvalStatus: options.approvalStatus }
        : {}),
      createdBy: adminId,
      ...imageFields(images),
    });

    return contact;
  } catch (error) {
    await discardUploadedImages(images);
    throw error;
  }
};

// ================= MERGE INTO EXISTING CONTACT (DUPLICATE SUBMIT) =================
// Called by createContact when a submission's Full Name + WhatsApp
// Number matches an existing, non-deleted contact.
//  - Never creates a second document for the same person.
//  - `companyName`/`address`/`companyCategory` are only applied if the
//    existing contact's value is currently empty — an existing
//    non-empty field is never overwritten by this path.
//  - `references` are APPENDED to the existing list, never replacing
//    it, so old references are always preserved; case-insensitive
//    de-duplication (e.g. existing "A", new "a") is handled by
//    Contact.model.js's pre-findOneAndUpdate hook, same as every other
//    write path for this field.
async function mergeIntoExistingContact(existingContact, incoming, files = {}) {
  const {
    companyName,
    designation,
    address,
    area,
    instagramId,
    spouseInstagramId,
    references,
    companyCategory,
    email,
    relationship,
    spouseName,
    spouseMobile,
    profession,
    professionCategory,
  } = incoming;

  const updateFields = {};

  if (companyName && !existingContact.companyName) {
    updateFields.companyName = companyName;
  }

  if (designation && !existingContact.designation) {
    updateFields.designation = designation;
  }

  if (address && !existingContact.address) {
    updateFields.address = address;
  }

  if (area && !existingContact.area) {
    updateFields.area = area;
  }

  if (instagramId && !existingContact.instagramId) {
    updateFields.instagramId = instagramId;
  }

  if (companyCategory && !existingContact.companyCategory) {
    updateFields.companyCategory = companyCategory;
  }

  if (Array.isArray(references) && references.length) {
    updateFields.references = [...existingContact.references, ...references];
  }

  // Same "only fill if currently empty, never overwrite" rule as
  // companyName/designation/address/companyCategory above, extended to
  // the 5 new fields — a duplicate submission enriches an existing
  // contact's record instead of ever clobbering data it already has.
  if (email && !existingContact.email) {
    updateFields.email = email;
  }

  if (relationship && !existingContact.relationship) {
    updateFields.relationship = relationship;
  }

  if (spouseName && !existingContact.spouseName) {
    updateFields.spouseName = spouseName;
  }

  if (spouseMobile && !existingContact.spouseMobile) {
    updateFields.spouseMobile = spouseMobile;
  }

  if (profession && !existingContact.profession) {
    updateFields.profession = profession;
  }

  if (professionCategory && !existingContact.professionCategory) {
    updateFields.professionCategory = professionCategory;
  }

  const mergedIsCouple =
    (existingContact.relationship || relationship) === "Couple";

  if (mergedIsCouple && spouseInstagramId && !existingContact.spouseInstagramId) {
    updateFields.spouseInstagramId = spouseInstagramId;
  }

  // Photos follow the same "only fill if empty" rule: an existing photo
  // is never replaced by a duplicate submission.
  const mergeImages = await uploadContactImages(files, mergedIsCouple, {
    skipProfile: !!existingContact.profileImage,
    skipSpouse: !!existingContact.spouseProfileImage,
  });
  Object.assign(updateFields, imageFields(mergeImages));

  if (Object.keys(updateFields).length === 0) {
    return existingContact.populate([
      { path: "companyCategory", select: "name" },
      { path: "professionCategory", select: "name" },
      { path: "createdBy", select: "name" },
    ]);
  }

  try {
    const updatedContact = await Contact.findOneAndUpdate(
      { _id: existingContact._id },
      updateFields,
      { new: true, runValidators: true }
    )
      .populate("companyCategory", "name")
      .populate("professionCategory", "name")
      .populate("createdBy", "name");

    return updatedContact;
  } catch (error) {
    await discardUploadedImages(mergeImages);
    throw error;
  }
}

// ================= SHARED FILTER/SORT BUILDER =================
// Used by BOTH getAllContacts and exportContacts, so the exported file
// always matches exactly what the table/search/filters/sort are
// currently showing — never a separate, possibly-stale definition of
// "search" or "sort" that could drift out of sync with the list API.
function buildContactQuery(query) {
  // A full number typed as "+91 98765 43210" / "919876543210" still finds
  // the 10-digit stored WhatsApp number.
  const search = normalizeMobileSearchTerm((query.search || "").trim());

  const sortField = SORTABLE_FIELDS.includes(query.sortBy)
    ? query.sortBy
    : "createdAt";
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;

  // historyOnly contacts (auto-created by Entry Report -> Event History) never
  // appear in Contact List / export.
  const filter = { isDeleted: { $ne: true }, historyOnly: { $ne: true } };

  if (search) {
    filter.$or = [
      { fullName: { $regex: search, $options: "i" } },
      { whatsappNumber: { $regex: search, $options: "i" } },
      { companyName: { $regex: search, $options: "i" } },
      { designation: { $regex: search, $options: "i" } },
      { address: { $regex: search, $options: "i" } },
      { area: { $regex: search, $options: "i" } },
      { instagramId: { $regex: search, $options: "i" } },
      { spouseInstagramId: { $regex: search, $options: "i" } },
    ];
  }

  // ================= APPROVAL STATUS FILTER =================
  // pending | approved | rejected. "approved" also matches contacts that
  // have no approvalStatus at all (created before this field existed).
  if (APPROVAL_STATUSES.includes(query.approvalStatus)) {
    filter.$and = [
      ...(filter.$and || []),
      query.approvalStatus === "approved"
        ? { approvalStatus: { $in: ["approved", null] } }
        : { approvalStatus: query.approvalStatus },
    ];
  }

  if (query.companyCategory) {
    if (!mongoose.Types.ObjectId.isValid(query.companyCategory)) {
      throw new AppError("Invalid Company Category filter", 400);
    }
    // A contact matches if EITHER its own Company Category OR its
    // spouse's profession Category is the selected one. $and keeps this
    // separate from the search $or above.
    filter.$and = [
      ...(filter.$and || []),
      {
        $or: [
          { companyCategory: query.companyCategory },
          { professionCategory: query.companyCategory },
        ],
      },
    ];
  }

  // ================= REFERENCE FILTER =================
  // "Same reference must be treated as one unique reference across
  // contacts" (e.g. Karan's "a" and Mahesh's "A" are the same
  // reference) — references are stored with their ORIGINAL casing (see
  // Contact.model.js), so an exact-equality filter would miss "A" when
  // searching for "a". A case-insensitive collation on the query (the
  // exact same collation the `references` index was built with in Step
  // 1) makes Mongo compare "a" and "A" as equal while still using that
  // index, without needing a separate lowercase shadow field.
  const referenceFilterValue = query.reference
    ? Contact.normalizeReferenceKey(query.reference)
    : null;

  if (referenceFilterValue) {
    filter.references = referenceFilterValue;
  }

  const applyCollationIfNeeded = (mongooseQuery) =>
    referenceFilterValue
      ? mongooseQuery.collation(CASE_INSENSITIVE_COLLATION)
      : mongooseQuery;

  return { filter, sortField, sortOrder, applyCollationIfNeeded };
}


// ================= APPROVAL STATUS COUNTS =================
// Numbers shown on the Pending / Approved / Rejected filter tabs. Counted
// over every visible contact (same base filter as the list), independent of
// the search / category / reference filters.
const getApprovalStatusCounts = async () => {
  const rows = await Contact.aggregate([
    { $match: { isDeleted: { $ne: true }, historyOnly: { $ne: true } } },
    {
      $group: {
        _id: { $ifNull: ["$approvalStatus", "approved"] },
        count: { $sum: 1 },
      },
    },
  ]);

  const counts = { pending: 0, approved: 0, rejected: 0 };
  rows.forEach((row) => {
    if (counts[row._id] !== undefined) counts[row._id] = row.count;
  });
  counts.all = counts.pending + counts.approved + counts.rejected;

  return counts;
};

const validateIdList = (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError("Please select at least one contact.", 400);
  }

  const unique = [...new Set(ids.map((id) => String(id)))];

  if (unique.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw new AppError("Invalid contact selection.", 400);
  }

  return unique;
};

// ================= PASS HELPERS =================
// A "pass" is the Booking created by Send Pass. Its single QR is the
// booking's first ticket, so cancelling the pass = cancelling those tickets
// (the scanner then answers "This ticket has been cancelled." and the
// /ticket page shows "Cancelled Pass").
const last10Digits = (value) => String(value || "").replace(/\D/g, "").slice(-10);

// Active (not cancelled / deleted) pass bookings of a contact.
const findActivePassBookings = async (contact) => {
  const Booking = require("../models/booking.model");

  const base = {
    isDeleted: { $ne: true },
    bookingStatus: { $ne: "Cancelled" },
  };

  if (contact.passBookingId) {
    const direct = await Booking.find({ _id: contact.passBookingId, ...base });
    if (direct.length) return direct;
  }

  if (!contact.passSentAt || !contact.passEventId) return [];

  const digits = last10Digits(contact.whatsappNumber);
  if (digits.length < 10) return [];

  // Contacts whose pass was sent before passBookingId existed.
  return Booking.find({
    ...base,
    eventId: contact.passEventId,
    remark: "Pass sent from Contact List",
    mobileNumber: new RegExp(`${digits}$`),
  });
};

// Invalidates the contact's pass(es) so the QR can no longer be used, gives
// the seats back to the ticket stock and clears the "Pass sent" mark.
// A pass whose guests already entered (a ticket is "Used") is left alone.
const cancelPassForContact = async (contact, adminId) => {
  const Booking = require("../models/booking.model");
  const BookingTicket = require("../models/bookingTicket.model");
  const TicketType = require("../models/ticketType.model");

  const bookings = await findActivePassBookings(contact);
  let cancelled = 0;
  let alreadyUsed = 0;

  for (const booking of bookings) {
    const usedCount = await BookingTicket.countDocuments({
      bookingId: booking._id,
      status: "Used",
    });

    if (usedCount > 0) {
      alreadyUsed += 1;
      continue;
    }

    await BookingTicket.updateMany(
      { bookingId: booking._id, status: "Active" },
      { $set: { status: "Cancelled" } }
    );

    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          bookingStatus: "Cancelled",
          remark: `${booking.remark || "Pass"} | Pass cancelled (contact status changed)`,
        },
      }
    );

    await TicketType.updateOne(
      { _id: booking.ticketTypeId },
      { $inc: { availableCount: booking.quantity } }
    );

    cancelled += 1;
  }

  if (alreadyUsed === 0) {
    await Contact.updateOne(
      { _id: contact._id },
      { $set: { passSentAt: null, passEventId: null, passBookingId: null } }
    );
  }

  return { cancelled, alreadyUsed };
};

// ================= BULK UPDATE APPROVAL STATUS =================
// PUT /api/contacts/bulk-status { ids: [...], status: "pending" |
// "approved" | "rejected" }. One contact (row action) or many (checkbox
// selection) go through this same function.
//
// Extra rules:
//  - Moving a contact that already got a pass to Pending or Rejected
//    cancels that pass (QR stops working).
//  - Moving a contact to Rejected sends the polite "we will invite you to
//    the next Parv" WhatsApp message (once per rejection; a failed message
//    never blocks the status change).
const bulkUpdateApprovalStatus = async ({ ids, status }, adminId) => {
  if (!APPROVAL_STATUSES.includes(status)) {
    throw new AppError("Status must be pending, approved or rejected.", 400);
  }

  const contactIds = validateIdList(ids);

  const baseFilter = {
    _id: { $in: contactIds },
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
  };

  // Snapshot BEFORE the update, to know who actually changes status.
  const before = await Contact.find(baseFilter);

  let passesCancelled = 0;
  let passesUsed = 0;

  if (status !== "approved") {
    for (const contact of before) {
      if (!contact.passSentAt) continue;

      try {
        const result = await cancelPassForContact(contact, adminId);
        passesCancelled += result.cancelled;
        passesUsed += result.alreadyUsed;
      } catch (error) {
        console.error(`Pass cancel failed for contact ${contact._id}:`, error);
      }
    }
  }

  const result = await Contact.updateMany(baseFilter, {
    $set: {
      approvalStatus: status,
      approvalUpdatedAt: new Date(),
      approvalUpdatedBy: adminId || null,
    },
  });

  const updated = result.modifiedCount ?? result.nModified ?? 0;
  const matched = result.matchedCount ?? result.n ?? contactIds.length;

  let rejectionSent = 0;
  let rejectionFailed = 0;

  if (status === "rejected") {
    const { sendRejectionMessage } = require("./contactNotification.service");

    for (const contact of before) {
      if ((contact.approvalStatus || "approved") === "rejected") continue;

      try {
        await sendRejectionMessage(contact);
        await Contact.updateOne(
          { _id: contact._id },
          { $set: { rejectionMessageSentAt: new Date() } }
        );
        rejectionSent += 1;
      } catch (error) {
        rejectionFailed += 1;
        console.error(
          `Rejection WhatsApp failed for contact ${contact._id}:`,
          error.message || error
        );
      }
    }
  }

  const notes = [];
  if (passesCancelled) {
    notes.push(`${passesCancelled} pass${passesCancelled === 1 ? "" : "es"} cancelled`);
  }
  if (passesUsed) {
    notes.push(`${passesUsed} pass${passesUsed === 1 ? "" : "es"} already used (not cancelled)`);
  }
  if (rejectionSent) {
    notes.push(`WhatsApp message sent to ${rejectionSent}`);
  }
  if (rejectionFailed) {
    notes.push(`WhatsApp message failed for ${rejectionFailed}`);
  }

  return {
    success: true,
    message:
      `${matched} contact${matched === 1 ? "" : "s"} marked as ${status}.` +
      (notes.length ? ` ${notes.join(", ")}.` : ""),
    data: {
      matched,
      updated,
      status,
      passesCancelled,
      passesUsed,
      rejectionSent,
      rejectionFailed,
    },
  };
};

// ================= EDIT A CONTACT'S PASS (GUEST COUNT) =================
// GET /api/contacts/:id/pass -> { hasPass, quantity, bookingNumber, ... }
// PUT /api/contacts/:id/pass { quantity, resendInvitation } -> changes how
// many guests the already-sent pass admits (stock + amount + extra tickets
// are handled by bookingService.updateBooking; works for single-QR passes).
const getActivePassOfContact = async (contactId) => {
  if (!mongoose.Types.ObjectId.isValid(contactId)) {
    throw new AppError("Invalid contact id", 400);
  }

  const contact = await Contact.findOne({
    _id: contactId,
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
  });

  if (!contact) throw new AppError("Contact not found", 404);

  const bookings = contact.passSentAt ? await findActivePassBookings(contact) : [];

  return { contact, booking: bookings[0] || null };
};

const getContactPass = async (contactId) => {
  const { booking } = await getActivePassOfContact(contactId);

  return {
    success: true,
    data: booking
      ? {
          hasPass: true,
          quantity: booking.quantity,
          bookingNumber: booking.bookingNumber,
          editable: booking.entryMode === "single_qr",
          maxGuests: MAX_PASS_GUESTS,
        }
      : { hasPass: false },
  };
};

const updateContactPass = async (contactId, { quantity, resendInvitation }) => {
  const bookingService = require("./booking.service");
  const { booking } = await getActivePassOfContact(contactId);

  if (!booking) {
    throw new AppError("This contact has no active pass.", 400);
  }

  const guests = Number(quantity);
  if (!Number.isInteger(guests) || guests < 1 || guests > MAX_PASS_GUESTS) {
    throw new AppError(`Guests must be between 1 and ${MAX_PASS_GUESTS}.`, 400);
  }

  const result = await bookingService.updateBooking(booking._id, {
    quantity: guests,
    resendInvitation: resendInvitation === true || resendInvitation === "true",
  });

  return {
    success: true,
    message:
      `Pass updated to ${guests} guest${guests === 1 ? "" : "s"}.` +
      (result.whatsappSent ? " Pass sent again on WhatsApp." : "") +
      (result.whatsappError ? ` WhatsApp failed: ${result.whatsappError}` : ""),
    data: { quantity: result.booking.quantity, whatsappSent: result.whatsappSent },
  };
};

// ================= RESEND PASS (WHATSAPP) =================
// POST /api/contacts/resend-pass { ids }
// Sends the SAME invitation (same QR link) again to approved contacts that
// already have an active pass — e.g. when they say they never got it.
const resendPassToContacts = async ({ ids }) => {
  const BookingTicket = require("../models/bookingTicket.model");
  const bookingTicketService = require("./bookingTicket.service");

  const contactIds = validateIdList(ids);

  const contacts = await Contact.find({
    _id: { $in: contactIds },
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
  });

  const byId = new Map(contacts.map((c) => [String(c._id), c]));
  const results = [];

  for (const id of contactIds) {
    const contact = byId.get(id);

    if (!contact) {
      results.push({ id, name: "-", status: "failed", message: "Contact not found." });
      continue;
    }

    const base = { id, name: contact.fullName };

    if ((contact.approvalStatus || "approved") !== "approved") {
      results.push({
        ...base,
        status: "failed",
        message: "Only approved contacts can receive a pass.",
      });
      continue;
    }

    try {
      const bookings = await findActivePassBookings(contact);

      if (!bookings.length) {
        results.push({
          ...base,
          status: "failed",
          message: "No active pass found. Use Send Pass instead.",
        });
        continue;
      }

      const primaryTicket = await BookingTicket.findOne({
        bookingId: bookings[0]._id,
        status: { $ne: "Cancelled" },
      }).sort({ createdAt: 1, _id: 1 });

      if (!primaryTicket) {
        results.push({
          ...base,
          status: "failed",
          message: "No active ticket found for this pass.",
        });
        continue;
      }

      await bookingTicketService.resendTicket(primaryTicket._id);

      results.push({ ...base, status: "sent", message: "Pass sent again." });
    } catch (error) {
      results.push({
        ...base,
        status: "failed",
        message: error.message || "Failed to resend pass.",
      });
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const failed = results.length - sent;

  return {
    success: failed === 0,
    message:
      failed === 0
        ? `Pass sent again to ${sent} contact${sent === 1 ? "" : "s"}.`
        : sent === 0
          ? results[0]?.message || "Failed to resend pass."
          : `Pass sent again to ${sent}, failed for ${failed}.`,
    data: { sent, failed, results },
  };
};

// ================= SEND PASS (WHATSAPP INVITATION) =================
// POST /api/contacts/send-pass { ids, eventId, ticketTypeId }
//
// For every selected APPROVED contact: creates a booking for the chosen
// event + ticket type (1 guest for Single, 2 for Couple) through the same
// bookingService.createBooking the Booking page uses, which also sends the
// WhatsApp invitation pass. Contacts are processed one at a time so two
// contacts can never race for the same ticket stock, and one failure
// never stops the rest. Returns a per-contact result for the UI.
// Most guests one pass can admit (guards against typos like 100).
const MAX_PASS_GUESTS = 10;

// Admin-chosen guest count for a pass; falls back to the old rule
// (Single = 1, Couple = 2) when nothing valid was sent.
const resolvePassQuantity = (contact, quantities) => {
  const requested = Number(quantities?.[String(contact._id)]);

  if (Number.isInteger(requested) && requested >= 1) {
    return Math.min(requested, MAX_PASS_GUESTS);
  }

  return contact.relationship === "Couple" ? 2 : 1;
};

const sendPassToContacts = async ({ ids, eventId, ticketTypeId, quantities }, adminId) => {
  // Required lazily: booking.service is heavy and only needed here.
  const bookingService = require("./booking.service");
  const Event = require("../models/event.model");
  const TicketType = require("../models/ticketType.model");

  const contactIds = validateIdList(ids);

  if (!mongoose.Types.ObjectId.isValid(eventId)) {
    throw new AppError("Please select an event.", 400);
  }
  if (!mongoose.Types.ObjectId.isValid(ticketTypeId)) {
    throw new AppError("Please select a ticket.", 400);
  }

  const [event, ticketType] = await Promise.all([
    Event.findById(eventId),
    TicketType.findOne({ _id: ticketTypeId, eventId, isDeleted: false }),
  ]);

  if (!event) throw new AppError("Event not found.", 404);
  if (!ticketType) throw new AppError("Ticket not found for this event.", 404);

  const contacts = await Contact.find({
    _id: { $in: contactIds },
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
  });

  const byId = new Map(contacts.map((c) => [String(c._id), c]));
  const results = [];

  for (const id of contactIds) {
    const contact = byId.get(id);

    if (!contact) {
      results.push({ id, name: "-", status: "failed", message: "Contact not found." });
      continue;
    }

    const base = { id, name: contact.fullName };
    const currentStatus = contact.approvalStatus || "approved";

    if (currentStatus !== "approved") {
      results.push({
        ...base,
        status: "failed",
        message: "Only approved contacts can receive a pass.",
      });
      continue;
    }

    // Already has a live pass -> don't create a second booking.
    if (contact.passSentAt && (await findActivePassBookings(contact)).length) {
      results.push({
        ...base,
        status: "failed",
        message: "Pass already sent. Use Resend Pass instead.",
      });
      continue;
    }

    const quantity = resolvePassQuantity(contact, quantities);

    try {
      const { booking } = await bookingService.createBooking(
        {
          eventId,
          ticketTypeId,
          quantity,
          amount: ticketType.amount * quantity,
          discount: 0,
          name: contact.fullName,
          mobileNumber: contact.whatsappNumber,
          email: contact.email || "",
          companyName: contact.companyName || "N/A",
          remark: "Pass sent from Contact List",
        },
        adminId
      );

      await Contact.updateOne(
        { _id: contact._id },
        {
          $set: {
            passSentAt: new Date(),
            passEventId: event._id,
            passBookingId: booking._id,
          },
        }
      );

      results.push({
        ...base,
        status: "sent",
        message: `Pass sent (${quantity} guest${quantity === 1 ? "" : "s"}) - ${booking.bookingNumber}`,
      });
    } catch (error) {
      results.push({
        ...base,
        status: "failed",
        message: error.message || "Failed to send pass.",
      });
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const failed = results.length - sent;

  return {
    success: true,
    message:
      failed === 0
        ? `Pass sent to ${sent} contact${sent === 1 ? "" : "s"}.`
        : `Pass sent to ${sent}, failed for ${failed}.`,
    data: { sent, failed, results },
  };
};

// ================= GET ALL CONTACTS =================
// Supports: search, sorting, pagination, companyCategory filter,
// reference filter (case-insensitive — see the reference-filter note
// below). Response shape mirrors eventService.getAllEvents (the service
// returns the full { success, message, data, pagination } payload, and
// the controller just forwards it as-is).
const getAllContacts = async (query) => {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;

  const { filter, sortField, sortOrder, applyCollationIfNeeded } =
    buildContactQuery(query);

  const total = await applyCollationIfNeeded(Contact.countDocuments(filter));

  const contacts = await applyCollationIfNeeded(
    Contact.find(filter)
      .populate("companyCategory", "name")
    .populate("professionCategory", "name")
      .populate("createdBy", "name")
      .sort({ [sortField]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit)
  );

  const statusCounts = await getApprovalStatusCounts();

  return {
    success: true,
    message: "Contacts fetched successfully",
    data: contacts,
    statusCounts,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
};

// ================= EXPORT CONTACTS =================
// GET /api/contacts/export?search=&sortBy=&sortOrder=&companyCategory=
// &reference= — same query params as getAllContacts (minus
// page/limit: every matching contact is exported, not just one page),
// built through the exact same buildContactQuery helper so the
// exported file can never disagree with what the Contact List table is
// currently showing for that search/filter/sort combination. Streams
// an .xlsx file directly onto the response, same convention as
// bookingService.exportBookings.
const exportContacts = async (query, res) => {
  const { filter, sortField, sortOrder, applyCollationIfNeeded } =
    buildContactQuery(query);

  const contacts = await applyCollationIfNeeded(
    Contact.find(filter)
      .populate("companyCategory", "name")
    .populate("professionCategory", "name")
      .populate("createdBy", "name")
      .sort({ [sortField]: sortOrder })
  ).lean();

  // ================= WORKBOOK =================
  const ExcelJS = require("exceljs");

  const workbook = new ExcelJS.Workbook();

  workbook.creator = "Event Management CRM";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("Contact List");

  worksheet.columns = [
    { header: "Full Name", key: "fullName", width: 25 },
    { header: "WhatsApp Number", key: "whatsappNumber", width: 20 },
    { header: "Email", key: "email", width: 28 },
    { header: "Company Name", key: "companyName", width: 25 },
    { header: "Designation", key: "designation", width: 22 },
    { header: "Company Category", key: "companyCategory", width: 22 },
    { header: "Address", key: "address", width: 30 },
    { header: "Area", key: "area", width: 20 },
    { header: "Instagram ID", key: "instagramId", width: 22 },
    { header: "Relationship", key: "relationship", width: 14 },
    { header: "Spouse Name", key: "spouseName", width: 25 },
    { header: "Spouse Mobile Number", key: "spouseMobile", width: 22 },
    { header: "Spouse Instagram ID", key: "spouseInstagramId", width: 22 },
    { header: "Spouse Category", key: "spouseCategory", width: 22 },
    { header: "Profession", key: "profession", width: 22 },
    { header: "Reference", key: "references", width: 30 },
    { header: "Status", key: "approvalStatus", width: 14 },
    { header: "Pass Sent", key: "passSent", width: 22 },
    { header: "Created At", key: "createdAt", width: 22 },
  ];

  // ================= HEADER STYLE =================
  // Same header styling as bookingService.exportBookings, so every
  // exported report in the app looks consistent.
  worksheet.getRow(1).font = {
    bold: true,
    color: { argb: "FFFFFFFF" },
  };

  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "1F4E78" },
  };

  worksheet.getRow(1).alignment = {
    vertical: "middle",
    horizontal: "center",
  };

  // ================= ROWS =================
  // When a Company Category filter is selected, a Couple contact can match
  // in two different ways, and the export must only show the person who
  // actually belongs to that category:
  //   - the contact's OWN companyCategory is the selected one  -> only the
  //     contact's details are shown (spouse columns stay "-")
  //   - the SPOUSE's professionCategory is the selected one     -> only the
  //     spouse's details are shown (the contact's own name / number /
  //     company / designation stay "-")
  //   - both are the selected category                          -> both shown
  // With no category filter, every contact is exported in full (own
  // details + spouse details), exactly like the Contact List table.
  const selectedCategoryId = query.companyCategory
    ? String(query.companyCategory)
    : null;

  const idOf = (category) =>
    category && category._id ? String(category._id) : null;

  contacts.forEach((contact) => {
    const references = Array.isArray(contact.references)
      ? contact.references.filter(
          (reference) => typeof reference === "string" && reference.trim()
        )
      : [];

    let showOwn = true;
    let showSpouse = true;

    if (selectedCategoryId) {
      const ownMatches = idOf(contact.companyCategory) === selectedCategoryId;
      const spouseMatches =
        idOf(contact.professionCategory) === selectedCategoryId;

      showOwn = ownMatches;
      showSpouse = spouseMatches;
    }

    let categoryNames;
    if (selectedCategoryId) {
      categoryNames = [
        showOwn ? contact.companyCategory?.name : null,
        showSpouse ? contact.professionCategory?.name : null,
      ];
    } else {
      categoryNames = [
        contact.companyCategory?.name,
        contact.professionCategory?.name,
      ];
    }

    worksheet.addRow({
      fullName: (showOwn && contact.fullName) || "-",
      whatsappNumber: (showOwn && contact.whatsappNumber) || "-",
      email: (showOwn && contact.email) || "-",
      companyName: (showOwn && contact.companyName) || "-",
      designation: (showOwn && contact.designation) || "-",
      companyCategory:
        [...new Set(categoryNames.filter(Boolean))].join(", ") || "-",
      address: contact.address || "-",
      area: contact.area || "-",
      instagramId: (showOwn && contact.instagramId) || "-",
      relationship: contact.relationship || "-",
      spouseName: (showSpouse && contact.spouseName) || "-",
      spouseMobile: (showSpouse && contact.spouseMobile) || "-",
      spouseInstagramId: (showSpouse && contact.spouseInstagramId) || "-",
      spouseCategory:
        (showSpouse && contact.professionCategory?.name) || "-",
      profession: (showSpouse && contact.profession) || "-",
      references: references.length ? references.join(", ") : "-",
      approvalStatus: (() => {
        const status = contact.approvalStatus || "approved";
        return status.charAt(0).toUpperCase() + status.slice(1);
      })(),
      passSent: contact.passSentAt
        ? `Yes - ${new Date(contact.passSentAt).toLocaleString("en-GB")}`
        : "No",
      createdAt: contact.createdAt
        ? new Date(contact.createdAt).toLocaleString("en-GB")
        : "-",
    });
  });

  // ================= DOWNLOAD =================
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename=ContactList_${Date.now()}.xlsx`
  );

  await workbook.xlsx.write(res);

  res.end();
};

// ================= GET CONTACT BY ID =================
const getContactById = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Contact ID", 400);
  }

  const contact = await Contact.findOne({ _id: id, isDeleted: { $ne: true } })
    .populate("companyCategory", "name")
    .populate("professionCategory", "name")
    .populate("createdBy", "name");

  if (!contact) {
    throw new AppError("Contact not found", 404);
  }

  return contact;
};

// ================= UPDATE CONTACT =================
// Only fields actually present in `data` are touched — an edit may send
// just a subset of fields (same convention as eventService.updateEvent
// leaving untouched fields alone). References normalization (trim +
// case-insensitive de-dup within this contact) happens in
// Contact.model.js's pre-findOneAndUpdate hook.
const updateContact = async (id, data, files = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Contact ID", 400);
  }

  const contact = await Contact.findOne({ _id: id, isDeleted: { $ne: true } });

  if (!contact) {
    throw new AppError("Contact not found", 404);
  }

  if (data.companyCategory) {
    await assertCompanyCategoryExists(data.companyCategory);
  }
  if (data.professionCategory) {
    await assertCompanyCategoryExists(data.professionCategory);
  }

  // Only re-check for a duplicate if the number is actually changing —
  // re-saving a contact with its own unchanged number must never be
  // rejected as "already exists" (same pattern as
  // companyCategoryService.updateCompanyCategory's name check).
  if (
    data.whatsappNumber !== undefined &&
    data.whatsappNumber.trim() !== contact.whatsappNumber.trim()
  ) {
    await assertWhatsappNumberNotDuplicate(data.whatsappNumber, id);
  }

  const updateFields = {};

  if (data.fullName !== undefined) updateFields.fullName = data.fullName;
  if (data.whatsappNumber !== undefined) updateFields.whatsappNumber = data.whatsappNumber;
  if (data.companyName !== undefined) updateFields.companyName = data.companyName;
  if (data.designation !== undefined) updateFields.designation = data.designation;
  if (data.address !== undefined) updateFields.address = data.address;
  if (data.area !== undefined) updateFields.area = data.area;
  if (data.instagramId !== undefined) updateFields.instagramId = data.instagramId;
  if (data.references !== undefined) updateFields.references = data.references;
  if (data.companyCategory !== undefined) {
    updateFields.companyCategory = data.companyCategory || null;
  }
  if (data.email !== undefined) updateFields.email = data.email;
  if (data.relationship !== undefined) updateFields.relationship = data.relationship;
  if (data.spouseName !== undefined) updateFields.spouseName = data.spouseName;
  if (data.spouseMobile !== undefined) updateFields.spouseMobile = data.spouseMobile;
  if (data.profession !== undefined) updateFields.profession = data.profession;
  if (data.professionCategory !== undefined || data.relationship !== undefined) {
    // Only meaningful for Couple; switching to Single clears it.
    const isCouple = (data.relationship ?? contact.relationship) === "Couple";
    updateFields.professionCategory = isCouple
      ? data.professionCategory || contact.professionCategory || null
      : null;
  }

  // ---------- Photos + spouse Instagram ----------
  // Spouse details only exist for Couple: switching to Single wipes the
  // spouse Instagram ID and removes the spouse photo from disk.
  const isCoupleNow = (data.relationship ?? contact.relationship) === "Couple";
  const staleImageIds = []; // old files deleted only AFTER the DB update succeeds

  // Photos are compulsory: a new upload, or the saved one kept (not removed).
  assertPhotosPresent({
    hasProfile:
      !!firstFile(files, "profileImage") ||
      (!!contact.profileImage && !isTrue(data.removeProfileImage)),
    hasSpouse:
      !!firstFile(files, "spouseProfileImage") ||
      (!!contact.spouseProfileImage && !isTrue(data.removeSpouseProfileImage)),
    isCouple: isCoupleNow,
  });

  const images = await uploadContactImages(files, isCoupleNow);

  if (images.profile) {
    staleImageIds.push(contact.profileImagePublicId);
  } else if (isTrue(data.removeProfileImage) && contact.profileImage) {
    staleImageIds.push(contact.profileImagePublicId);
    updateFields.profileImage = "";
    updateFields.profileImagePublicId = "";
  }

  if (!isCoupleNow) {
    updateFields.spouseInstagramId = "";
    if (contact.spouseProfileImage) {
      staleImageIds.push(contact.spouseProfileImagePublicId);
      updateFields.spouseProfileImage = "";
      updateFields.spouseProfileImagePublicId = "";
    }
  } else {
    if (data.spouseInstagramId !== undefined) {
      updateFields.spouseInstagramId = data.spouseInstagramId;
    }

    if (images.spouse) {
      staleImageIds.push(contact.spouseProfileImagePublicId);
    } else if (isTrue(data.removeSpouseProfileImage) && contact.spouseProfileImage) {
      staleImageIds.push(contact.spouseProfileImagePublicId);
      updateFields.spouseProfileImage = "";
      updateFields.spouseProfileImagePublicId = "";
    }
  }

  Object.assign(updateFields, imageFields(images));

  let updatedContact;
  try {
    updatedContact = await Contact.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      updateFields,
      { new: true, runValidators: true }
    )
      .populate("companyCategory", "name")
      .populate("professionCategory", "name")
      .populate("createdBy", "name");
  } catch (error) {
    await discardUploadedImages(images);
    throw error;
  }

  for (const publicId of staleImageIds) {
    if (publicId) await deleteImage(publicId);
  }

  return updatedContact;
};

// ================= DELETE CONTACT (SOFT DELETE) =================
// Same soft-delete pattern as bookingService.deleteBooking: sets
// isDeleted/deletedAt/deletedBy rather than removing the document.
const deleteContact = async (id, adminId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Contact ID", 400);
  }

  const contact = await Contact.findOne({ _id: id, isDeleted: { $ne: true } });

  if (!contact) {
    throw new AppError("Contact not found", 404);
  }

  contact.isDeleted = true;
  contact.deletedAt = new Date();
  contact.deletedBy = adminId;

  await contact.save();

  return contact;
};

// ================= GET UNIQUE REFERENCES =================
// GET /api/contacts/unique-references — powers the Contact List's
// "All References" filter dropdown (see contactService.getUniqueReferencesApi
// on the frontend). Returns a flat, case-insensitively de-duplicated,
// alphabetically sorted list of every reference value across active
// (non-soft-deleted) contacts — e.g. Karan -> ["a","b"] and
// Mahesh -> ["A","c"] becomes ["a","b","c"], keeping whichever casing
// was encountered first. Optional `search` narrows the list to values
// containing that text (case-insensitive), same as the frontend
// service's documented optional param.
const getUniqueReferences = async (query = {}) => {
  const search = String(query.search || "").trim().toLowerCase();

  const contacts = await Contact.find(
    { isDeleted: { $ne: true } },
    { references: 1 }
  ).lean();

  const seen = new Set();
  const uniqueReferences = [];

  for (const contact of contacts) {
    const references = Array.isArray(contact.references)
      ? contact.references
      : [];

    for (const raw of references) {
      if (typeof raw !== "string") continue;

      const trimmed = raw.trim();
      if (!trimmed) continue;

      if (search && !trimmed.toLowerCase().includes(search)) continue;

      const key = Contact.normalizeReferenceKey(trimmed);
      if (seen.has(key)) continue;

      seen.add(key);
      uniqueReferences.push(trimmed);
    }
  }

  uniqueReferences.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  return {
    success: true,
    message: "Unique references fetched successfully",
    data: uniqueReferences,
  };
};

// ================= GET REFERENCE SUMMARY =================
// Groups every reference value across ALL active (non-soft-deleted)
// contacts, case-insensitively, into { reference, contacts: [...] }
// records — e.g. Karan -> [a,d,c,x] and Ramesh -> [a,s,z,t] becomes
// a -> [Karan, Ramesh], d -> [Karan], s -> [Ramesh], etc.
//
// Grouping uses Contact.normalizeReferenceKey (the exact same
// trim + lowercase logic already used by the model's own de-dup hooks
// and by getAllContacts' reference filter above), so "a" on one contact
// and "A" on another land in the same group. The original casing of
// whichever occurrence is seen first is kept as the display value for
// that group, and each contact name is only ever listed once per
// reference even if (defensively) it appeared more than once.
const getReferenceSummary = async () => {
  const contacts = await Contact.find(
    { isDeleted: { $ne: true } },
    { fullName: 1, references: 1 }
  ).lean();

  const groups = new Map(); // normalized key -> { reference, contacts: [] }

  for (const contact of contacts) {
    const references = Array.isArray(contact.references)
      ? contact.references
      : [];

    for (const raw of references) {
      if (typeof raw !== "string") continue;

      const trimmed = raw.trim();
      if (!trimmed) continue;

      const key = Contact.normalizeReferenceKey(trimmed);

      if (!groups.has(key)) {
        groups.set(key, { reference: trimmed, contacts: [] });
      }

      const group = groups.get(key);
      if (!group.contacts.includes(contact.fullName)) {
        group.contacts.push(contact.fullName);
      }
    }
  }

  // Alphabetical, case-insensitive order (e.g. a, b, c, d, h, n, v) —
  // only orders the reference groups themselves, unrelated to any
  // Contact List row sorting.
  const data = Array.from(groups.values()).sort((a, b) =>
    a.reference.trim().toLowerCase().localeCompare(b.reference.trim().toLowerCase())
  );

  return {
    success: true,
    message: "Reference summary fetched successfully",
    data,
  };
};

// Shared uniqueness pre-check used by both createContact and
// updateContact — same collation-free string-equality approach as
// CompanyCategory's assertNameNotDuplicate, just without a collation
// since WhatsApp numbers have no meaningful "case". Scoped to active
// (non-soft-deleted) contacts only, so a soft-deleted contact's number
// never blocks that same number being reused on a new/other contact —
// the underlying guarantee against a create/update race is the partial
// unique index on Contact.model.js's `whatsappNumber` field.
async function assertWhatsappNumberNotDuplicate(whatsappNumber, excludeId = null) {
  const filter = {
    isDeleted: { $ne: true },
    whatsappNumber: String(whatsappNumber || "").trim(),
  };

  if (excludeId) {
    filter._id = { $ne: excludeId };
  }

  const existing = await Contact.findOne(filter);

  if (existing) {
    throw new AppError("WhatsApp Number already exists", 400);
  }
}

// Shared existence/shape check used by both createContact and
// updateContact whenever a companyCategory is supplied.
async function assertCompanyCategoryExists(companyCategoryId) {
  if (!mongoose.Types.ObjectId.isValid(companyCategoryId)) {
    throw new AppError("Invalid Company Category", 400);
  }

  const category = await CompanyCategory.findOne({
    _id: companyCategoryId,
    isDeleted: { $ne: true },
  });

  if (!category) {
    throw new AppError("Company Category not found", 404);
  }
}

module.exports = {
  bulkUpdateApprovalStatus,
  resendPassToContacts,
  getContactPass,
  updateContactPass,
  sendPassToContacts,
  createContact,
  getAllContacts,
  exportContacts,
  getContactById,
  updateContact,
  deleteContact,
  getUniqueReferences,
  getReferenceSummary,
};