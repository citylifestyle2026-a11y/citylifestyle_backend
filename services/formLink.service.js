// services/formLink.service.js
//
// "Share Form Link": the admin enters a Name and a Quantity and gets a link to the public form that accepts exactly that
// many submissions. Each person's Reference is set to the Name automatically.
const crypto = require("crypto");
const FormLink = require("../models/formLink.model");
const CompanyCategory = require("../models/companycategory.model");
const AppError = require("../utils/AppError");
const Contact = require("../models/contact.model");
const Member = require("../models/member.model");
const { normalizeMobileNumber } = require("../utils/normalizeMobileNumber");
const contactService = require("./contact.service");
const memberService = require("./member.service");
const contactDuplicateService = require("./contactDuplicate.service");

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
  const l = Math.min(100, Math.max(1, Number(limit) || 10));

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

const unavailableMessage = (link) =>
  link.status === "closed"
    ? "This form link is closed."
    : `All ${link.quantity} entries for this link are already filled.`;

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

    req.formLink = link;
    return next();
  } catch (error) {
    return next(error);
  }
};

// Atomically takes one place on the link. Two people submitting at the same
// moment can never push it past the quantity.
const reserveSlot = async (linkId) => {
  const link = await FormLink.findOneAndUpdate(
    {
      _id: linkId,
      status: "active",
      $expr: { $lt: ["$usedCount", "$quantity"] },
    },
    { $inc: { usedCount: 1 } },
    { new: true }
  );
  if (!link) {
    const current = await FormLink.findById(linkId);
    throw new AppError(current ? unavailableMessage(current) : "This form link is not valid.", 410);
  }
  return link;
};

// Gives the place back when saving the person failed.
const releaseSlot = async (linkId) => {
  await FormLink.updateOne({ _id: linkId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
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
      relationship: data.relationship || data.entryType,
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

  await reserveSlot(link._id);

  if (alreadyGuest) {
    try {
      await contactDuplicateService.saveDuplicate(alreadyGuest, data, files, {
        source: "link",
        formLinkId: link._id,
      });
    } catch (error) {
      await releaseSlot(link._id);
      throw error;
    }
    return;
  }

  try {
    // Guest List first: it is the one that must succeed.
    await contactService.createContact(data, null, files, { approvalStatus: "pending" });
  } catch (error) {
    await releaseSlot(link._id);
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
  getPublicInfo,
  attachLink,
  submitThroughLink,
  addToContactBookIfMissing,
};