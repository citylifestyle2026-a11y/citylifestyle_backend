// services/formLink.service.js
//
// "Share Form Link": the admin enters a Name and a Quantity and gets a link to the public form that accepts exactly that
// many submissions. Each person's Reference is set to the Name automatically.
const crypto = require("crypto");
const mongoose = require("mongoose");
const FormLink = require("../models/formLink.model");
const CompanyCategory = require("../models/companycategory.model");
const AppError = require("../utils/AppError");
const Contact = require("../models/contact.model");
const Member = require("../models/member.model");
const { normalizeMobileNumber } = require("../utils/normalizeMobileNumber");
const { personsOf } = require("../utils/persons");
const contactService = require("./contact.service");
const memberService = require("./member.service");
const contactDuplicateService = require("./contactDuplicate.service");
const ContactDuplicate = require("../models/contactDuplicate.model");

const MAX_QUANTITY = 1000;
const TARGETS = ["contact", "member"];

const cleanName = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const cleanQuantity = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new AppError("Quantity must be a whole number of at least 1.", 400);
  }
  if (n > MAX_QUANTITY) {
    throw new AppError(`Quantity cannot be more than ${MAX_QUANTITY}.`, 400);
  }
  return n;
};

// active | full | closed
const linkState = (link) => {
  if (link.status === "closed") return "closed";
  if (link.usedCount >= link.quantity) return "full";
  return "active";
};

const present = (link) => {
  const plain = typeof link.toObject === "function" ? link.toObject() : link;
  return {
    _id: plain._id,
    name: plain.name,
    quantity: plain.quantity,
    usedCount: plain.usedCount,
    remaining: Math.max(0, plain.quantity - plain.usedCount),
    token: plain.token,
    target: plain.target,
    status: plain.status,
    state: linkState(plain),
    createdAt: plain.createdAt,
  };
};

// ================= ADMIN =================
const createFormLink = async (body = {}, adminId = null) => {
  const name = cleanName(body.name);
  if (!name) throw new AppError("Name is required.", 400);
  if (name.length > 60) throw new AppError("Name is too long (max 60 characters).", 400);

  const quantity = cleanQuantity(body.quantity);
  const target = TARGETS.includes(body.target) ? body.target : "contact";

  const link = await FormLink.create({
    name,
    quantity,
    target,
    token: crypto.randomBytes(12).toString("hex"),
    createdBy: adminId || null,
  });

  return present(link);
};

const SORTABLE = ["name", "quantity", "usedCount", "createdAt"];
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Supports ?page=&limit=&search=&target=&sortBy=&sortOrder=
const listFormLinks = async ({
  target,
  search = "",
  sortBy = "createdAt",
  sortOrder = "desc",
  page = 1,
  limit = 10,
} = {}) => {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100000, Math.max(1, Number(limit) || 10));

  const filter = {};
  if (TARGETS.includes(target)) filter.target = target;
  const term = cleanName(search);
  if (term) filter.name = new RegExp(escapeRegex(term), "i");

  const field = SORTABLE.includes(sortBy) ? sortBy : "createdAt";
  const direction = sortOrder === "asc" ? 1 : -1;

  const [items, total] = await Promise.all([
    FormLink.find(filter)
      .sort({ [field]: direction, _id: direction })
      .skip((p - 1) * l)
      .limit(l)
      .lean(),
    FormLink.countDocuments(filter),
  ]);

  return {
    items: items.map(present),
    total,
    page: p,
    limit: l,
    totalPages: Math.max(1, Math.ceil(total / l)),
  };
};

// Edit a link: name, quantity (never below what was already used), where the
// people go (Guest List / Contact Book) and open / closed.
// A new name is used for the people who submit AFTER the edit; people who
// already submitted keep the reference they were saved with.
const updateFormLink = async (id, body = {}) => {
  const link = await FormLink.findById(id);
  if (!link) throw new AppError("Form link not found.", 404);

  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) throw new AppError("Name is required.", 400);
    if (name.length > 60) throw new AppError("Name is too long (max 60 characters).", 400);
    link.name = name;
  }

  if (body.target !== undefined) {
    if (!TARGETS.includes(body.target)) throw new AppError("Invalid destination.", 400);
    link.target = body.target;
  }

  if (body.quantity !== undefined) {
    const quantity = cleanQuantity(body.quantity);
    if (quantity < link.usedCount) {
      throw new AppError(
        `${link.usedCount} people have already submitted, so the quantity cannot be less than ${link.usedCount}.`,
        400
      );
    }
    link.quantity = quantity;
  }

  if (body.status !== undefined) {
    if (!["active", "closed"].includes(body.status)) {
      throw new AppError("Invalid status.", 400);
    }
    link.status = body.status;
  }

  await link.save();
  return present(link);
};

// Removing a link does NOT remove the people who already submitted.
const deleteFormLink = async (id) => {
  const link = await FormLink.findByIdAndDelete(id);
  if (!link) throw new AppError("Form link not found.", 404);
};

// ================= EXPORT (EXCEL) =================
// GET /api/form-links/:id/export
// Excel of every person who filled THIS link:
//   - guests saved with this link's id (all new submissions), and
//   - older guests (before the link id was stored) that carry this link's
//     name as a Reference and were created after the link was made, and
//   - submissions parked in the Guest List "Duplicate" tab through this link
//     (shown with Status "Duplicate").
const safeSheetName = (text) =>
  String(text || "Form Link").replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Form Link";

const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : "");

const exportFormLinkEntries = async (id, res) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid form link ID.", 400);
  }

  const link = await FormLink.findById(id).lean();
  if (!link) throw new AppError("Form link not found.", 404);

  const nameRegex = new RegExp(`^${escapeRegex(link.name)}$`, "i");

  const [contacts, duplicates] = await Promise.all([
    Contact.find({
      isDeleted: { $ne: true },
      historyOnly: { $ne: true },
      $or: [
        { formLinkId: link._id },
        {
          formLinkId: null,
          references: nameRegex,
          createdAt: { $gte: link.createdAt },
        },
      ],
    })
      .populate("companyCategory", "name")
      .populate("professionCategory", "name")
      .sort({ createdAt: 1 })
      .lean(),
    ContactDuplicate.find({ formLinkId: link._id })
      .populate("companyCategory", "name")
      .populate("professionCategory", "name")
      .sort({ createdAt: 1 })
      .lean(),
  ]);

  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Event Management CRM";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(safeSheetName(link.name));

  sheet.columns = [
    { header: "No.", key: "no", width: 6 },
    { header: "Full Name", key: "fullName", width: 25 },
    { header: "WhatsApp Number", key: "whatsappNumber", width: 20 },
    { header: "Email", key: "email", width: 28 },
    { header: "Company Name", key: "companyName", width: 25 },
    { header: "Designation", key: "designation", width: 22 },
    { header: "Company Category", key: "companyCategory", width: 22 },
    { header: "Address", key: "address", width: 30 },
    { header: "Area", key: "area", width: 20 },
    { header: "Instagram ID", key: "instagramId", width: 22 },
    { header: "Entry Type", key: "entryType", width: 14 },
    { header: "Persons", key: "persons", width: 10 },
    { header: "Reference", key: "references", width: 30 },
    { header: "Status", key: "status", width: 14 },
    { header: "Submitted At", key: "createdAt", width: 22 },
  ];

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "1F4E78" } };
  header.alignment = { vertical: "middle", horizontal: "center" };

  const dash = (value) => (value === undefined || value === null || value === "" ? "-" : value);

  const addRow = (item, status) => {
    const refs = Array.isArray(item.references)
      ? item.references.filter((r) => typeof r === "string" && r.trim())
      : [];

    // WhatsApp numbers are stored as text; keep them as text in Excel too so
    // long numbers are never shown as 9.9E+11.
    sheet.addRow({
      no: sheet.rowCount,
      fullName: dash(item.fullName),
      whatsappNumber: dash(item.whatsappNumber),
      email: dash(item.email),
      companyName: dash(item.companyName),
      designation: dash(item.designation),
      companyCategory: dash(item.companyCategory?.name),
      address: dash(item.address),
      area: dash(item.area),
      instagramId: dash(item.instagramId),
      entryType: dash(item.entryType || item.relationship),
      persons: personsOf(item),
      references: refs.length ? refs.join(", ") : "-",
      status,
      createdAt: item.createdAt ? new Date(item.createdAt).toLocaleString("en-GB") : "-",
    });
  };

  contacts.forEach((contact) =>
    addRow(contact, capitalize(contact.approvalStatus || "approved"))
  );
  duplicates.forEach((duplicate) => addRow(duplicate, "Duplicate"));

  const totalPersons = [...contacts, ...duplicates].reduce((sum, item) => sum + personsOf(item), 0);
  if (sheet.rowCount > 1) {
    const totalRow = sheet.addRow({ fullName: "Total persons", persons: totalPersons });
    totalRow.font = { bold: true };
  }

  if (sheet.rowCount === 1) {
    sheet.addRow({ no: "", fullName: "No one has filled this link yet." });
  }

  const fileName = `FormLink_${link.name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "entries"}_${Date.now()}.xlsx`;

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);

  await workbook.xlsx.write(res);
  res.end();
};

// ================= PUBLIC =================
const findByToken = async (token) => {
  const value = String(token || "").trim();
  if (!/^[a-f0-9]{24}$/.test(value)) {
    throw new AppError("This form link is not valid.", 404);
  }
  const link = await FormLink.findOne({ token: value });
  if (!link) throw new AppError("This form link is not valid.", 404);
  return link;
};

const notEnoughMessage = (left, needed) =>
  `Only ${left} place${left === 1 ? "" : "s"} left on this link, but this entry needs ${needed} ` +
  `(Single = 1, Couple = 2, Manual = typed number).`;

const unavailableMessage = (link) =>
  link.status === "closed"
    ? "This form link is closed."
    : `All ${link.quantity} places for this link are already filled.`;

// Used by the public page to decide: show the form, or a "closed / full" note.
const getPublicInfo = async (token) => {
  const link = await findByToken(token);
  const state = linkState(link);
  return {
    name: link.name,
    quantity: link.quantity,
    usedCount: link.usedCount,
    remaining: Math.max(0, link.quantity - link.usedCount),
    available: state === "active",
    message: state === "active" ? "" : unavailableMessage(link),
  };
};

// Express middleware for the public submit route. Looks up the link, refuses
// closed / full links early and forces the link's Name into `references`
// (so the person can never remove or change it).
const attachLink = async (req, res, next) => {
  try {
    const token = req.query.link;
    if (!token) return next();

    const link = await findByToken(token);
    if (linkState(link) !== "active") throw new AppError(unavailableMessage(link), 410);

    const sent = Array.isArray(req.body.references) ? req.body.references : [];
    const rest = sent.filter(
      (ref) => String(ref || "").trim().toLowerCase() !== link.name.toLowerCase()
    );
    req.body.references = [link.name, ...rest];

    // Quantity counts PERSONS: Single = 1, Couple = 2. Refuse early when what
    // is left is not enough for this entry (e.g. a Couple with 1 place left).
    const persons = personsOf({
      entryType: req.body.entryType,
      relationship: req.body.relationship,
      persons: req.body.persons,
    });
    const left = Math.max(0, link.quantity - link.usedCount);
    if (persons > left) throw new AppError(notEnoughMessage(left, persons), 410);

    req.formLink = link;
    return next();
  } catch (error) {
    return next(error);
  }
};

// Atomically takes one place on the link. Two people submitting at the same
// moment can never push it past the quantity.
const reserveSlot = async (linkId, persons = 1) => {
  const need = Math.max(1, Number(persons) || 1);
  const link = await FormLink.findOneAndUpdate(
    {
      _id: linkId,
      status: "active",
      $expr: { $lte: [{ $add: ["$usedCount", need] }, "$quantity"] },
    },
    { $inc: { usedCount: need } },
    { new: true }
  );
  if (!link) {
    const current = await FormLink.findById(linkId);
    if (!current) throw new AppError("This form link is not valid.", 410);
    if (current.status === "active" && current.usedCount < current.quantity) {
      throw new AppError(notEnoughMessage(current.quantity - current.usedCount, need), 410);
    }
    throw new AppError(unavailableMessage(current), 410);
  }
  return link;
};

// Gives the persons back when saving the entry failed / it was removed.
const releaseSlot = async (linkId, persons = 1) => {
  const give = Math.max(1, Number(persons) || 1);
  const link = await FormLink.findById(linkId).select("usedCount").lean();
  if (!link) return;
  const dec = Math.min(give, link.usedCount);
  if (dec > 0) await FormLink.updateOne({ _id: linkId }, { $inc: { usedCount: -dec } });
};

// Admin raises / lowers the persons of a guest that came through a link
// (edit guest, or a bigger pass). Raising needs room on the link: otherwise
// the admin must first edit the Form Link and increase its quantity.
// `from` / `to` = persons before / after. Returns nothing; throws AppError.
const changePersons = async (linkId, from, to) => {
  const delta = Number(to) - Number(from);
  if (!linkId || !delta) return;

  if (delta < 0) {
    await releaseSlot(linkId, -delta);
    return;
  }

  const link = await FormLink.findOneAndUpdate(
    { _id: linkId, $expr: { $lte: [{ $add: ["$usedCount", delta] }, "$quantity"] } },
    { $inc: { usedCount: delta } },
    { new: true }
  );
  if (link) return;

  const current = await FormLink.findById(linkId).lean();
  if (!current) return; // link was deleted: nothing to count against
  const left = Math.max(0, current.quantity - current.usedCount);
  throw new AppError(
    `Form link "${current.name}" has only ${left} place${left === 1 ? "" : "s"} left, ` +
      `but ${delta} more ${delta === 1 ? "is" : "are"} needed. ` +
      `First edit the form link and increase its quantity, then add it here.`,
    400
  );
};

// A guest that came in through a link was deleted from the Guest List: give
// that place back so the link's progress (usedCount / remaining) goes down
// too. `contacts` = the guest rows being removed (each may carry formLinkId).
// Guests that did not come from a link are ignored. Never goes below 0, and a
// "full" link opens again by itself (its state is worked out from usedCount).
const releaseSlotsForContacts = async (contacts = [], opts = {}) => {
  const perLink = new Map();
  for (const contact of contacts) {
    if (!contact || !contact.formLinkId) continue;
    const key = String(contact.formLinkId);
    perLink.set(key, (perLink.get(key) || 0) + personsOf(contact));
  }

  for (const [linkId, count] of perLink) {
    // Take back only what is really there, so usedCount can never be negative.
    const link = await FormLink.findById(linkId).select("usedCount").session(opts.session || null);
    if (!link) continue;
    const dec = Math.min(count, link.usedCount);
    if (dec > 0) {
      await FormLink.updateOne({ _id: linkId }, { $inc: { usedCount: -dec } }, opts);
    }
  }
};

// Public-form fields -> Member fields.
const saveAsMember = async (data, link, files = null) => {
  const categoryName = async (id) => {
    if (!id) return "";
    const category = await CompanyCategory.findById(id).select("name").lean();
    return category?.name || "";
  };

  const isCouple = (data.relationship || data.entryType) === "Couple";

  return memberService.createMember(
    {
      name: data.fullName,
      mobile: data.whatsappNumber,
      email: data.email,
      companyName: data.companyName,
      profession: await categoryName(data.companyCategory),
      designation: data.designation,
      address: data.address,
      area: data.area,
      instagramId: data.instagramId,
      relationship:
        data.relationship || (data.entryType === "Manual" ? "Single" : data.entryType),
      spouseName: isCouple ? data.spouseName : "",
      spouseMobile: isCouple ? data.spouseMobile : "",
      spouseInstagramId: isCouple ? data.spouseInstagramId : "",
      spouseProfession: isCouple ? await categoryName(data.professionCategory) : "",
      references: link
        ? [link.name]
        : Array.isArray(data.references)
        ? data.references
        : [],
      source: link ? "Form Link" : "Public Form",
    },
    (link && link.createdBy) || null,
    files
  );
};

// Every number spelling that could already be stored: "9876543210",
// "919876543210" and what was typed.
const numberVariants = (value) => {
  const raw = String(value || "").trim();
  const canonical = normalizeMobileNumber(raw);
  return [...new Set([raw, canonical, canonical ? canonical.slice(2) : null].filter(Boolean))];
};

// Handles one public submission that came through a link.
//
// The person is saved in BOTH lists:
//   - Guest List (Contact, waits for approval). If this WhatsApp number is
//     already in the Guest List the submission is refused with
//     "already exists" - this is the ONLY error a person gets for a repeated
//     number, and it does not use up a place on the link.
//   - Contact Book (Member). If the number is already in the Contact Book
//     nothing is added there and NO error is shown - the person still goes
//     to the Guest List. A problem while saving the Contact Book never stops
//     the Guest List entry (it is only logged).
const submitThroughLink = async (link, data, files) => {
  const variants = numberVariants(data.whatsappNumber);

  // A number that is already in the Guest List is NOT refused: the submission
  // is saved in the Guest List "Duplicate" tab (it uses one place on the link,
  // creates no guest row / pass) and the admin fixes + syncs it from there.
  const alreadyGuest = variants.length
    ? await Contact.findOne({
        isDeleted: { $ne: true },
        historyOnly: { $ne: true },
        whatsappNumber: { $in: variants },
      })
        .select("_id")
        .lean()
    : null;

  // Single = 1 person, Couple = 2: the link's quantity counts persons.
  const persons = personsOf({
    entryType: data.entryType,
    relationship: data.relationship,
    persons: data.persons,
  });

  await reserveSlot(link._id, persons);

  if (alreadyGuest) {
    try {
      await contactDuplicateService.saveDuplicate(alreadyGuest, data, files, {
        source: "link",
        formLinkId: link._id,
      });
    } catch (error) {
      await releaseSlot(link._id, persons);
      throw error;
    }
    return;
  }

  try {
    // Guest List first: it is the one that must succeed.
    await contactService.createContact(data, null, files, {
      approvalStatus: "pending",
      formLinkId: link._id,
    });
  } catch (error) {
    await releaseSlot(link._id, persons);
    throw error;
  }

  // Contact Book: only when the number is not there yet; never fails the submit.
  await addToContactBookIfMissing(data, link, files);
};

// Contact Book (Member): adds the person only when the number is NOT already
// there. Never throws - a Contact Book problem must not stop the Guest List
// entry. `link` is null for the plain public form (/city-lifestyle).
const addToContactBookIfMissing = async (data, link = null, files = null) => {
  try {
    const local = (normalizeMobileNumber(data.whatsappNumber) || "").slice(2);
    const inContactBook = local
      ? await Member.exists({ mobile: local, mobileStatus: "valid" })
      : false;

    if (!inContactBook) {
      await saveAsMember(data, link, files);
    }
  } catch (error) {
    console.error("Public form: could not add to Contact Book:", error.message);
  }
};

module.exports = {
  createFormLink,
  listFormLinks,
  updateFormLink,
  deleteFormLink,
  exportFormLinkEntries,
  getPublicInfo,
  attachLink,
  submitThroughLink,
  addToContactBookIfMissing,
  releaseSlotsForContacts,
  releaseSlot,
  changePersons,
};