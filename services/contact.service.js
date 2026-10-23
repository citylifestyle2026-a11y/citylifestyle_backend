const mongoose = require("mongoose");
const Contact = require("../models/contact.model")
const ContactDuplicate = require("../models/contactDuplicate.model");
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
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Area compare key: trimmed, single spaces, lower-case ("Vesu " == "vesu").
const normalizeAreaKey = (value) =>
  String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

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
  // Edition (event) the contact was moved into from Member List.
  if (query.editionEventId) {
    if (!mongoose.Types.ObjectId.isValid(query.editionEventId)) {
      throw new AppError("Invalid edition", 400);
    }
    filter.editionEventId = query.editionEventId;
  }

  // Pass filter: sent | cancelled | notSent
  //  sent      - a pass is active (sent to WhatsApp)
  //  cancelled - the pass was cancelled and not restored yet
  //  notSent   - no pass has been sent (and none was cancelled)
  if (query.passStatus === "sent") {
    filter.passSentAt = { $ne: null };
  } else if (query.passStatus === "cancelled") {
    // The "Pass Cancelled" tab: rejected guests whose pass was cancelled.
    filter.approvalStatus = "rejected";
    filter.passSentAt = null;
    filter.passCancelledAt = { $ne: null };
  } else if (query.passStatus === "notSent") {
    filter.passSentAt = null;
    filter.passCancelledAt = null;
  }

  // Attendance answer filter: yes | no | none (reminder sent, not answered)
  // | notSent (no reminder sent yet).
  if (query.rsvpStatus === "yes" || query.rsvpStatus === "no") {
    filter.rsvpStatus = query.rsvpStatus;
  } else if (query.rsvpStatus === "none") {
    filter.rsvpReminderSentAt = { $ne: null };
    filter.rsvpStatus = { $in: ["none", null] };
  } else if (query.rsvpStatus === "notSent") {
    filter.rsvpReminderSentAt = null;
  }

  if (APPROVAL_STATUSES.includes(query.approvalStatus)) {
    filter.$and = [
      ...(filter.$and || []),
      query.approvalStatus === "approved"
        ? { approvalStatus: { $in: ["approved", null] } }
        : { approvalStatus: query.approvalStatus },
    ];

    // A guest whose pass was cancelled lives in the "Pass Cancelled" tab only,
    // not in Rejected.
    if (query.approvalStatus === "rejected") {
      filter.$and.push({
        $or: [{ passCancelledAt: null }, { passSentAt: { $ne: null } }],
      });
    }
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
  // `reference` can be one value or several (?reference=a&reference=b):
  // a contact matches when it has ANY of the selected references.
  const referenceKeys = [
    ...new Set(
      (Array.isArray(query.reference)
        ? query.reference
        : query.reference
        ? [query.reference]
        : []
      )
        .map((ref) => Contact.normalizeReferenceKey(ref))
        .filter(Boolean)
    ),
  ];
  const referenceFilterValue = referenceKeys.length > 0;

  // One condition per selected reference, joined with $or, so selecting
  // Ankita AND Mitesh lists every contact that has Ankita OR Mitesh (a
  // contact that has both is listed once). Each condition is a
  // case-insensitive whole-value match on the references array (an array
  // field matches when ANY of its items matches), so this does not depend
  // on collation or on $in handling.
  if (referenceFilterValue) {
    filter.$and = [
      ...(filter.$and || []),
      {
        $or: referenceKeys.map((key) => ({
          references: {
            $regex: `^\\s*${escapeRegex(key)}\\s*$`,
            $options: "i",
          },
        })),
      },
    ];
  }

  // ================= AREA FILTER =================
  // Works like the reference filter: `area` can be one value or several
  // (?area=Vesu&area=Adajan) and a contact matches when its area is ANY of
  // them. Whole-value, case-insensitive match, so "Vesu", "vesu" and " Vesu "
  // are one area. Used by BOTH the list and the Excel export.
  const areaKeys = [
    ...new Set(
      (Array.isArray(query.area) ? query.area : query.area ? [query.area] : [])
        .map(normalizeAreaKey)
        .filter(Boolean)
    ),
  ];

  if (areaKeys.length) {
    filter.$and = [
      ...(filter.$and || []),
      {
        $or: areaKeys.map((key) => ({
          area: {
            // spaces inside an area may be stored as 1 or more spaces
            $regex: `^\\s*${escapeRegex(key).replace(/ /g, "\\s+")}\\s*$`,
            $options: "i",
          },
        })),
      },
    ];
  }

  const applyCollationIfNeeded = (mongooseQuery) => mongooseQuery;

  return { filter, sortField, sortOrder, applyCollationIfNeeded };
}


// ================= APPROVAL STATUS COUNTS =================
// Numbers shown on the Pending / Approved / Rejected filter tabs. Counted
// over every visible contact (same base filter as the list), independent of
// the search / category / reference filters.
const getApprovalStatusCounts = async (editionEventId = null) => {
  const match = { isDeleted: { $ne: true }, historyOnly: { $ne: true } };

  // When one edition is selected the tabs count only that edition's guests.
  if (editionEventId && mongoose.Types.ObjectId.isValid(editionEventId)) {
    match.editionEventId = new mongoose.Types.ObjectId(editionEventId);
  }

  const rows = await Contact.aggregate([
    { $match: match },
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
  // Guests whose pass was cancelled (and not brought back) have their own
  // "Pass Cancelled" tab, so they are not counted under Rejected.
  counts.passCancelled = await Contact.countDocuments({
    ...match,
    approvalStatus: "rejected",
    passSentAt: null,
    passCancelledAt: { $ne: null },
  });
  counts.rejected = Math.max(0, counts.rejected - counts.passCancelled);
  counts.all = counts.pending + counts.approved + counts.rejected + counts.passCancelled;
  // Form submissions whose number is already in the Guest List (Duplicate tab).
  // Rows of guests that were deleted meanwhile are removed first, so the
  // count matches what the Duplicate tab shows.
  try {
    await require("./contactDuplicate.service").purgeOrphanDuplicates();
  } catch (error) {
    console.error("Could not clean orphan duplicates:", error.message);
  }
  counts.duplicate = await ContactDuplicate.countDocuments({});

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
  let cancelledBookingId = null;

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

    if (!cancelledBookingId) cancelledBookingId = booking._id;
    cancelled += 1;
  }

  if (alreadyUsed === 0) {
    await Contact.updateOne(
      { _id: contact._id },
      {
        $set: {
          passSentAt: null,
          passEventId: null,
          passBookingId: null,
          // Remembered so "Approve Pass" can bring this same pass back.
          ...(cancelledBookingId
            ? {
                passCancelledBookingId: cancelledBookingId,
                passCancelledEventId: contact.passEventId || null,
              }
            : {}),
        },
      }
    );
  }

  return { cancelled, alreadyUsed };
};

// ================= RESTORE A CANCELLED PASS (APPROVE PASS) =================
// Brings back the SAME pass that "Cancel Pass" cancelled: the booking and its
// QR ticket(s) become active again (the seats are taken from the ticket stock
// again) and the pass is sent to the guest on WhatsApp once more.
// Returns { restored, messageSent, reason }.
const restorePassForContact = async (contact) => {
  const Booking = require("../models/booking.model");
  const BookingTicket = require("../models/bookingTicket.model");
  const TicketType = require("../models/ticketType.model");
  const bookingTicketService = require("./bookingTicket.service");

  const fail = (reason) => ({ restored: false, messageSent: false, reason });

  if (!contact.passCancelledBookingId) return fail("No cancelled pass to bring back.");

  const booking = await Booking.findOne({
    _id: contact.passCancelledBookingId,
    isDeleted: { $ne: true },
  });
  if (!booking) return fail("The cancelled pass no longer exists. Send a new pass.");

  if (booking.bookingStatus === "Cancelled") {
    // Take the seats back from the ticket stock (never below zero).
    const stock = await TicketType.findOneAndUpdate(
      { _id: booking.ticketTypeId, availableCount: { $gte: booking.quantity } },
      { $inc: { availableCount: -booking.quantity } }
    );
    if (!stock) return fail("Not enough tickets left to bring this pass back.");

    await BookingTicket.updateMany(
      { bookingId: booking._id, status: "Cancelled" },
      { $set: { status: "Active" } }
    );

    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          bookingStatus: "Confirmed",
          remark: String(booking.remark || "").replace(
            / \| Pass cancelled \(contact status changed\)/g,
            ""
          ),
        },
      }
    );
  }

  await Contact.updateOne(
    { _id: contact._id },
    {
      $set: {
        passSentAt: new Date(),
        passEventId: booking.eventId || contact.passCancelledEventId || null,
        passBookingId: booking._id,
        passCancelledAt: null,
        passCancelMessageSentAt: null,
        passCancelledBookingId: null,
        passCancelledEventId: null,
      },
    }
  );

  // Send the very same pass again.
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

  let contactIds = validateIdList(ids);

  // Rejecting an APPROVED guest is allowed:
  //  - with a pass sent  -> same as "Cancel Pass" (pass cancelled, proper
  //                         "pass cancelled" message, guest moves to Rejected)
  //  - without a pass    -> a normal rejection
  let skippedApproved = 0;
  let cancelResult = null;
  if (status === "rejected") {
    const approvedWithPass = await Contact.find({
      _id: { $in: contactIds },
      isDeleted: { $ne: true },
      historyOnly: { $ne: true },
      passSentAt: { $ne: null },
      $or: [{ approvalStatus: "approved" }, { approvalStatus: null }],
    })
      .select("_id")
      .lean();

    if (approvedWithPass.length) {
      const handled = new Set(approvedWithPass.map((c) => String(c._id)));
      cancelResult = await cancelPassesOfContacts({ ids: [...handled] }, adminId);
      contactIds = contactIds.filter((id) => !handled.has(String(id)));

      if (contactIds.length === 0) return cancelResult;
    }
  }

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

  // Approving a guest whose pass was cancelled brings the SAME pass back and
  // sends it again.
  let passesRestored = 0;
  let passRestoreFailed = 0;
  let passMessageFailed = 0;
  let passRestoreError = "";

  if (status === "approved") {
    for (const contact of before) {
      if (!contact.passCancelledBookingId) continue;
      if ((contact.approvalStatus || "approved") === "approved") continue;

      try {
        const outcome = await restorePassForContact(contact);
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
        console.error(`Pass restore failed for contact ${contact._id}:`, error);
      }
    }
  }

  let rejectionSent = 0;
  let rejectionFailed = 0;
  let rejectionError = "";
  const rejectionUsedTemplate = Boolean(
    String(process.env.CHATBOX_REJECTION_TEMPLATE_NAME || "").trim()
  );

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
        if (!rejectionError) {
          rejectionError = String(error?.message || "Unknown WhatsApp error");
        }
        console.error(
          `Rejection WhatsApp failed for contact ${contact._id}:`,
          error.message || error
        );
      }
    }
  }

  const notes = [];
  if (skippedApproved) {
    notes.push(
      `${skippedApproved} approved contact${skippedApproved === 1 ? "" : "s"} skipped (use Cancel Pass)`
    );
  }
  if (cancelResult?.data?.cancelled) {
    notes.push(`${cancelResult.data.cancelled} pass${cancelResult.data.cancelled === 1 ? "" : "es"} cancelled`);
  }
  if (passesRestored) {
    notes.push(
      `${passesRestored} pass${passesRestored === 1 ? "" : "es"} brought back` +
        (passMessageFailed ? ` (WhatsApp failed for ${passMessageFailed})` : " and sent again")
    );
  }
  if (passRestoreFailed) {
    notes.push(
      `${passRestoreFailed} pass${passRestoreFailed === 1 ? "" : "es"} could not be brought back` +
        (passRestoreError ? ` (${passRestoreError})` : "")
    );
  }
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
    notes.push(
      `WhatsApp message failed for ${rejectionFailed}` +
        (rejectionError ? ` (${rejectionError})` : "")
    );
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
      skippedApproved,
      passesRestored,
      passRestoreFailed,
      passMessageFailed,
      passRestoreError,
      rejectionSent,
      rejectionFailed,
      rejectionError,
      rejectionUsedTemplate,
    },
  };
};

// ================= CANCEL PASS (APPROVED GUEST) =================
// POST /api/contacts/cancel-pass { ids: [...] }
//
// For an APPROVED guest who already has a pass:
//  1. the pass is cancelled (booking + QR ticket -> Cancelled, so the QR
//     scanner answers "This ticket has been cancelled." and the invite page
//     shows "Cancelled Pass"; the seat goes back to the ticket stock),
//  2. the guest moves to Rejected (re-approve later to send a fresh pass),
//  3. a professional "your pass has been cancelled" WhatsApp message is sent.
// A pass whose guests already entered cannot be cancelled. A WhatsApp
// failure never undoes the cancellation - it is reported per guest.
const cancelPassesOfContacts = async ({ ids }, adminId) => {
  const Event = require("../models/event.model");
  const { sendPassCancelledMessage } = require("./contactNotification.service");

  const contactIds = validateIdList(ids);

  const contacts = await Contact.find({
    _id: { $in: contactIds },
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
  });

  const byId = new Map(contacts.map((c) => [String(c._id), c]));
  const results = [];

  for (const id of contactIds) {
    const contact = byId.get(String(id));

    if (!contact) {
      // Say WHY it was not found (deleted / history-only / really missing)
      // instead of a plain "Contact not found".
      const raw = await Contact.findById(id).select("fullName isDeleted historyOnly").lean();
      let message = "Contact not found. Refresh the Guest List and try again.";
      if (raw?.isDeleted) message = "This guest was deleted. Refresh the Guest List.";
      else if (raw?.historyOnly) message = "This is only an Event History record, not a Guest List contact.";
      console.error(`Cancel pass: contact ${id} not usable (${raw ? "exists but excluded" : "missing in DB"}).`);
      results.push({ id, name: raw?.fullName || "-", status: "failed", message });
      continue;
    }

    const base = { id: String(contact._id), name: contact.fullName };

    if ((contact.approvalStatus || "approved") !== "approved") {
      results.push({
        ...base,
        status: "failed",
        message: "Only an approved guest's pass can be cancelled.",
      });
      continue;
    }

    if (!contact.passSentAt) {
      results.push({ ...base, status: "failed", message: "No pass has been sent to this guest." });
      continue;
    }

    try {
      // Read the edition BEFORE the cancel (it clears passEventId).
      let editionName = contact.editionName || "";
      if (contact.passEventId) {
        const event = await Event.findById(contact.passEventId)
          .select("title edition")
          .lean();
        if (event) editionName = event.edition || event.title || editionName;
      }

      const outcome = await cancelPassForContact(contact, adminId);

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

      await Contact.updateOne(
        { _id: contact._id },
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
        await sendPassCancelledMessage(contact, editionName);
        await Contact.updateOne(
          { _id: contact._id },
          { $set: { passCancelMessageSentAt: new Date() } }
        );
        messageSent = true;
      } catch (error) {
        messageError = String(error?.message || "Unknown WhatsApp error");
        console.error(
          `Pass-cancelled WhatsApp failed for contact ${contact._id}:`,
          messageError
        );
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
      results.push({
        ...base,
        status: "failed",
        message: error.message || "Failed to cancel the pass.",
      });
    }
  }

  const cancelled = results.filter((r) => r.status === "cancelled").length;
  const messageSent = results.filter((r) => r.messageSent).length;
  const messageFailed = cancelled - messageSent;
  const failed = results.length - cancelled;
  const firstFailure = results.find((r) => r.status === "failed");
  const firstMessageError = results.find(
    (r) => r.status === "cancelled" && !r.messageSent
  );

  const parts = [];
  parts.push(
    cancelled
      ? `Pass cancelled for ${cancelled} guest${cancelled === 1 ? "" : "s"}`
      : "No pass was cancelled"
  );
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
      usedTemplate: Boolean(
        String(process.env.CHATBOX_PASS_CANCEL_TEMPLATE_NAME || "").trim()
      ),
      results,
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

// ================= DELETE BOOKING (PASS) OF CONTACTS =================
// POST /api/contacts/delete-booking { ids }
// Removes the booking(s) made by Send Pass for the selected contacts - also
// ones whose pass was already cancelled (Pending / Rejected) and are still
// sitting in Manual Booking as "Cancelled". After this: the QR is dead, the
// seats are back in the ticket stock, the booking is gone from Manual
// Booking, and the contact is "Approved, no pass yet" (Send Pass works
// again). The contact itself and its status are NOT touched. Contacts with
// no booking are simply skipped. A pass whose guests already entered
// (scanned) cannot be deleted.
const findPassBookingsIncludingCancelled = async (contact) => {
  const Booking = require("../models/booking.model");

  const or = [];

  if (contact.passBookingId) or.push({ _id: contact.passBookingId });

  const digits = last10Digits(contact.whatsappNumber);
  if (digits.length === 10) {
    or.push({
      mobileNumber: new RegExp(`${digits}$`),
      remark: /^Pass sent from Contact List/,
    });
  }

  if (!or.length) return [];

  return Booking.find({ isDeleted: { $ne: true }, $or: or });
};

const deleteBookingsOfContacts = async ({ ids }, adminId) => {
  const Booking = require("../models/booking.model");
  const BookingTicket = require("../models/bookingTicket.model");
  const TicketType = require("../models/ticketType.model");

  const contactIds = validateIdList(ids);

  const contacts = await Contact.find({
    _id: { $in: contactIds },
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
  });

  const results = [];

  for (const contact of contacts) {
    const base = { id: String(contact._id), name: contact.fullName };

    try {
      const bookings = await findPassBookingsIncludingCancelled(contact);

      if (!bookings.length) {
        // The booking was already removed elsewhere (e.g. from Manual
        // Booking) but the contact still shows "Pass sent". Clear the stale
        // mark so the list is correct and Send Pass works again.
        if (contact.passSentAt || contact.passBookingId) {
          await Contact.updateOne(
            { _id: contact._id },
            { $set: { passSentAt: null, passEventId: null, passBookingId: null } }
          );
          results.push({
            ...base,
            status: "deleted",
            message: "Booking was already removed; pass mark cleared.",
          });
          continue;
        }

        results.push({ ...base, status: "skipped", message: "No booking found." });
        continue;
      }

      let deletedHere = 0;
      let blocked = false;

      for (const booking of bookings) {
        const usedCount = await BookingTicket.countDocuments({
          bookingId: booking._id,
          status: "Used",
        });

        if (usedCount > 0) {
          blocked = true;
          continue;
        }

        // Still live -> kill the QR and give the seats back first.
        if (booking.bookingStatus !== "Cancelled") {
          await BookingTicket.updateMany(
            { bookingId: booking._id, status: "Active" },
            { $set: { status: "Cancelled" } }
          );

          await TicketType.updateOne(
            { _id: booking.ticketTypeId },
            { $inc: { availableCount: booking.quantity } }
          );
        }

        await Booking.updateOne(
          { _id: booking._id },
          {
            $set: {
              bookingStatus: "Cancelled",
              isDeleted: true,
              deleteRemark: "Deleted from Guest List",
              deletedAt: new Date(),
              deletedBy: adminId || null,
            },
          }
        );

        deletedHere += 1;
      }

      if (deletedHere > 0 && !blocked) {
        await Contact.updateOne(
          { _id: contact._id },
          { $set: { passSentAt: null, passEventId: null, passBookingId: null } }
        );
      }

      results.push(
        deletedHere > 0
          ? { ...base, status: "deleted", message: "Booking deleted." }
          : {
              ...base,
              status: "failed",
              message: "Guests already entered with this pass, so it cannot be deleted.",
            }
      );
    } catch (error) {
      results.push({
        ...base,
        status: "failed",
        message: error.message || "Failed to delete booking.",
      });
    }
  }

  const deleted = results.filter((r) => r.status === "deleted").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;

  const parts = [`${deleted} booking${deleted === 1 ? "" : "s"} deleted`];
  if (skipped) parts.push(`${skipped} had no booking`);
  if (failed) parts.push(`${failed} could not be deleted`);

  return {
    success: deleted > 0 || failed === 0,
    message:
      deleted === 0 && failed === 0
        ? "No booking found for the selected contacts."
        : `${parts.join(", ")}.`,
    data: {
      deleted,
      skipped,
      failed,
      failedReason: results.find((r) => r.status === "failed")?.message || "",
      results,
    },
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

  const statusCounts = await getApprovalStatusCounts(query.editionEventId);

  // Which of these guests are also in the Contact Book (same WhatsApp number)?
  // Powers the "Merge with Contact Book" button on a Guest List row.
  const rows = contacts.map((c) => (typeof c.toObject === "function" ? c.toObject() : c));
  try {
    const { normalizeMobileNumber } = require("../utils/normalizeMobileNumber");
    const Member = require("../models/member.model");
    const locals = [
      ...new Set(
        rows.map((r) => (normalizeMobileNumber(r.whatsappNumber) || "").slice(2)).filter(Boolean)
      ),
    ];
    const members = locals.length
      ? await Member.find({ mobile: { $in: locals }, mobileStatus: "valid" }).lean()
      : [];
    const byMobile = new Map(members.map((m) => [m.mobile, m]));
    const { needsMerge } = require("./contactMerge.service");
    rows.forEach((r) => {
      const m = byMobile.get((normalizeMobileNumber(r.whatsappNumber) || "").slice(2));
      // "Merge & Sync" is offered only while the two rows still differ; once
      // merged (both identical) it disappears.
      r.memberMatch = m && needsMerge(r, m) ? { _id: m._id, name: m.name } : null;
    });
  } catch (error) {
    console.error("Could not check Contact Book matches:", error.message);
  }

  return {
    success: true,
    message: "Contacts fetched successfully",
    data: rows,
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
    { header: "Edition", key: "editionName", width: 18 },
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
      editionName: contact.editionName || "-",
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

  if (data.fullName) updateFields.fullName = data.fullName; // blank on edit = keep existing
  if (data.whatsappNumber) updateFields.whatsappNumber = data.whatsappNumber;
  if (data.companyName) updateFields.companyName = data.companyName;
  if (data.designation) updateFields.designation = data.designation;
  if (data.address !== undefined) updateFields.address = data.address;
  if (data.area !== undefined) updateFields.area = data.area;
  if (data.instagramId !== undefined) updateFields.instagramId = data.instagramId;
  if (Array.isArray(data.references) && data.references.length) {
    updateFields.references = data.references;
  }
  if (data.companyCategory !== undefined) {
    updateFields.companyCategory = data.companyCategory || null;
  }
  if (data.email !== undefined) updateFields.email = data.email;
  if (data.relationship) updateFields.relationship = data.relationship;
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

  // Event History keeps the spouse: when the spouse's name is about to
  // disappear from the Contact (switched to Single, or spouse cleared), the
  // spouse's history rows get a copy of who the person was.
  const spouseCleared =
    !!String(contact.spouseName || "").trim() &&
    ((data.relationship && data.relationship !== "Couple") ||
      (data.spouseName !== undefined && !String(data.spouseName || "").trim()));

  if (spouseCleared && updatedContact) {
    try {
      const ContactEventHistory = require("../models/contactEventHistory.model");
      await ContactEventHistory.updateMany(
        { contactId: id, isSpouse: true, contactSnapshot: null },
        {
          $set: {
            contactSnapshot: {
              fullName: contact.fullName,
              whatsappNumber: contact.whatsappNumber,
              spouseName: contact.spouseName,
              spouseMobile: contact.spouseMobile || "",
            },
          },
        }
      );
    } catch (error) {
      // Never fail the contact update because of history bookkeeping.
      console.error("Could not save spouse details on Event History:", error.message);
    }
  }

  return updatedContact;
};

// ================= DELETE CONTACT =================
// Removes the guest from the Guest List - see hardDeleteContacts below for
// what is removed and what is KEPT (Event History is kept).
const deleteContact = async (id, adminId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Contact ID", 400);
  }

  // A hidden history-only record is not a Guest List guest, so it can't be
  // deleted from here (its Event History rows are managed on that page).
  const contact = await Contact.findOne({
    _id: id,
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
  });

  if (!contact) {
    throw new AppError("Contact not found", 404);
  }

  await hardDeleteContacts([contact]);

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

  // Same base filter as the Guest List itself (history-only records from
  // Entry Report are never listed), so every reference offered in the filter
  // dropdown really belongs to at least one guest that can be shown.
  const contacts = await Contact.find(
    { isDeleted: { $ne: true }, historyOnly: { $ne: true } },
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

// ================= GET UNIQUE AREAS =================
// Feeds the Guest List "All Areas" filter dropdown: every area used by a
// visible guest, trimmed, de-duplicated case-insensitively ("Vesu" and
// "vesu " count once) and sorted A-Z. Same base filter as the Guest List
// itself (history-only records are never listed).
const getUniqueAreas = async () => {
  const contacts = await Contact.find(
    { isDeleted: { $ne: true }, historyOnly: { $ne: true } },
    { area: 1 }
  ).lean();

  const seen = new Set();
  const areas = [];

  for (const contact of contacts) {
    if (typeof contact.area !== "string") continue;

    const trimmed = contact.area.trim().replace(/\s+/g, " ");
    if (!trimmed) continue;

    const key = normalizeAreaKey(trimmed);
    if (seen.has(key)) continue;

    seen.add(key);
    areas.push(trimmed);
  }

  areas.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  return {
    success: true,
    message: "Unique areas fetched successfully",
    data: areas,
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

// ================= DELETE FROM GUEST LIST =================
// Event History is a permanent record, so deleting a guest must NOT erase it
// (same rule as deleting an Event - see eventCleanup.service.js):
//  - a guest WITH Event History rows is NOT removed from the database. It is
//    turned into a hidden `historyOnly` contact (name, number, spouse stay;
//    edition / approval / pass / RSVP data is cleared). It disappears from
//    Guest List but the history keeps showing the person. Adding the same
//    number again later re-uses this record, so the history re-attaches.
//  - a guest WITHOUT history is removed completely (photos too), as before.
// Bookings and passes are NOT touched - use "Delete Booking" for that.
// Returns how many guests were removed from the Guest List.
const hardDeleteContacts = async (contacts) => {
  if (!contacts.length) return 0;

  const ContactEventHistory = require("../models/contactEventHistory.model");
  const { hideContactsAsHistoryOnly } = require("./eventCleanup.service");

  const allIds = contacts.map((contact) => contact._id);

  // Only LIVE history rows count (rows the admin already deleted from the
  // Event History page are gone for good and do not keep a guest alive).
  const withHistory = new Set(
    (
      await ContactEventHistory.distinct("contactId", {
        contactId: { $in: allIds },
        isDeleted: { $ne: true },
      })
    ).map(String)
  );

  const keepIds = allIds.filter((id) => withHistory.has(String(id)));
  const removeList = contacts.filter((c) => !withHistory.has(String(c._id)));
  const ids = removeList.map((contact) => contact._id);

  if (keepIds.length) {
    await hideContactsAsHistoryOnly(keepIds);
  }

  if (ids.length) {
    // Rows already deleted from Event History would point to nothing.
    await ContactEventHistory.deleteMany({ contactId: { $in: ids } });
    await Contact.deleteMany({ _id: { $in: ids } });
  }

  // Form submissions parked in the Duplicate tab for these guests come back
  // into the Guest List as normal guests (same status). Never allowed to
  // fail the delete itself.
  try {
    await require("./contactDuplicate.service").promoteDuplicatesForContacts(contacts);
  } catch (error) {
    console.error("Could not restore duplicates after guest delete:", error.message);
  }

  // The deleted guests must show as "Not in Guest List" again on Member List.
  // Never allowed to fail the delete itself.
  try {
    const { releaseMembersWithoutContact } = require("./member.service");
    await releaseMembersWithoutContact({
      memberIds: contacts.map((c) => c.memberId).filter(Boolean),
      mobiles: contacts.flatMap((c) => {
        const n = String(c.whatsappNumber || "");
        return n ? [n, n.length === 12 && n.startsWith("91") ? n.slice(2) : n] : [];
      }),
    });
  } catch (error) {
    console.error("Could not update Member List after guest delete:", error.message);
  }

  // Photos last and best-effort: a missing file must never fail the delete.
  // Only for contacts that were really removed - a kept (hidden) contact
  // still owns its photos.
  for (const contact of removeList) {
    for (const publicId of [
      contact.profileImagePublicId,
      contact.spouseProfileImagePublicId,
    ]) {
      if (!publicId) continue;
      try {
        await deleteImage(publicId);
      } catch (error) {
        console.error("Could not delete contact photo:", error.message);
      }
    }
  }

  return contacts.length;
};

// ================= BULK DELETE CONTACTS =================
// POST /api/contacts/bulk-delete { ids: [...] }
// Hard-deletes the selected contacts (see hardDeleteContacts above).
const bulkDeleteContacts = async ({ ids }, adminId) => {
  const contactIds = validateIdList(ids);

  const contacts = await Contact.find({
    _id: { $in: contactIds },
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
  });
  const deleted = await hardDeleteContacts(contacts);

  return {
    success: deleted > 0,
    message:
      deleted > 0
        ? `${deleted} contact${deleted === 1 ? "" : "s"} deleted.`
        : "No contacts were deleted (already removed).",
    data: { deleted },
  };
};

module.exports = {
  cancelPassesOfContacts,
  bulkDeleteContacts,
  bulkUpdateApprovalStatus,
  resendPassToContacts,
  deleteBookingsOfContacts,
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
  getUniqueAreas,
  getReferenceSummary,
};