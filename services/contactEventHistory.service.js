const mongoose = require("mongoose");
const ContactEventHistory = require("../models/contactEventHistory.model");
const Contact = require("../models/contact.model");
const Event = require("../models/event.model");
const AppError = require("../utils/AppError");
const { personsOf } = require("../utils/persons");
const { normalizeMobileSearchTerm } = require("../utils/normalizeMobileNumber");

// Contact fields the Event History page needs (person, category, qty, reference).
const CONTACT_POPULATE = {
  path: "contactId",
  select:
    "fullName whatsappNumber spouseName spouseMobile references persons entryType relationship companyCategory professionCategory",
  populate: [
    { path: "companyCategory", select: "name" },
    { path: "professionCategory", select: "name" },
  ],
};

// Merge several reference lists into one, case-insensitive de-dup (first
// spelling wins), e.g. ["Mukund"] + ["dhaval", "Mukund"] -> ["Mukund", "dhaval"].
const mergeReferences = (...lists) => {
  const seen = new Set();
  const out = [];
  lists.flat().forEach((raw) => {
    if (typeof raw !== "string") return;
    const name = raw.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  });
  return out;
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ================= CREATE EVENT HISTORY =================
// `adminId` always comes from the authenticated user (req.user.id in
// the controller), never from req.body — same convention already used
// by contactService.createContact.
const createEventHistory = async (data, adminId) => {
  const { contactId, eventId, status, notes } = data;
  const isSpouse = data.isSpouse === true || data.isSpouse === "true";

  await assertContactExists(contactId);
  await assertEventExists(eventId);

  const contact = await Contact.findById(contactId).select(
    "relationship spouseName references"
  );

  // A spouse entry is only valid for a Couple contact that actually has
  // a spouse recorded.
  if (isSpouse) {
    if (contact.relationship !== "Couple" || !contact.spouseName) {
      throw new AppError("This contact has no spouse recorded", 400);
    }
  }

  // The reference(s) of this event: the ones sent with the request, else
  // the contact's references as they are right now.
  const entryReferences = mergeReferences(
    Array.isArray(data.references) ? data.references : [],
    Array.isArray(contact.references) ? contact.references : []
  );

  const history = await ContactEventHistory.create({
    contactId,
    eventId,
    isSpouse,
    status: status || "Invited",
    notes: notes || "",
    references: entryReferences,
    createdBy: adminId,
  });

  return populateHistory(history);
};

// Builds the Mongo $match used by the list AND the counts, so both always
// agree on which entries are "in view" (edition filter + search box).
const buildHistoryMatch = async (query = {}) => {
  const filter = { isDeleted: { $ne: true } };

  if (query.contactId) {
    if (!mongoose.Types.ObjectId.isValid(query.contactId)) {
      throw new AppError("Invalid Contact ID", 400);
    }
    filter.contactId = query.contactId;
  }

  // ONE edition (?eventId=a) or SEVERAL (?eventId=a&eventId=b, or "a,b").
  const eventIds = [
    ...new Set(
      (Array.isArray(query.eventId) ? query.eventId : [query.eventId])
        .flatMap((v) => String(v || "").split(","))
        .map((v) => v.trim())
        .filter(Boolean)
    ),
  ];
  if (eventIds.length) {
    if (!eventIds.every((id) => mongoose.Types.ObjectId.isValid(id))) {
      throw new AppError("Invalid Event ID", 400);
    }
    filter.eventId = eventIds.length === 1 ? eventIds[0] : { $in: eventIds };
  }

  if (query.status) {
    filter.status = query.status;
  }

  // One ROW per person (same contact + same isSpouse flag => same mobile
  // number), carrying ALL of that person's events inside `entries`.
  // Grouping happens in the database so pagination counts people, not
  // individual (contact, event) entries.
  const toObjectId = (v) => new mongoose.Types.ObjectId(v);
  const matchStage = { ...filter };
  if (matchStage.contactId) matchStage.contactId = toObjectId(matchStage.contactId);
  if (matchStage.eventId) {
    matchStage.eventId = matchStage.eventId.$in
      ? { $in: matchStage.eventId.$in.map(toObjectId) }
      : toObjectId(matchStage.eventId);
  }

  const andConditions = [];

  // ---- category filter ----
  // A normal row belongs to the contact's Company Category; a spouse row to
  // the spouse's (profession) category - same idea as the Guest List.
  if (query.category) {
    if (!mongoose.Types.ObjectId.isValid(query.category)) {
      throw new AppError("Invalid Category ID", 400);
    }
    const [mainContacts, spouseContacts] = await Promise.all([
      Contact.find({ companyCategory: query.category }).select("_id").lean(),
      Contact.find({ professionCategory: query.category }).select("_id").lean(),
    ]);
    andConditions.push({
      $or: [
        { contactId: { $in: mainContacts.map((c) => c._id) }, isSpouse: { $ne: true } },
        { contactId: { $in: spouseContacts.map((c) => c._id) }, isSpouse: true },
      ],
    });
  }

  // ---- reference filter (several can be ticked: a person matches when
  // they have ANY of them; whole-value, case-insensitive like Guest List) ----
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
  if (referenceKeys.length) {
    const refContacts = await Contact.find({
      $or: referenceKeys.map((key) => ({
        references: { $regex: `^\\s*${escapeRegex(key)}\\s*$`, $options: "i" },
      })),
    })
      .select("_id")
      .lean();
    andConditions.push({
      $or: [
        { contactId: { $in: refContacts.map((c) => c._id) } },
        // a reference that only exists on one event's entry (PV6 -> Mukund)
        ...referenceKeys.map((key) => ({
          references: { $regex: `^\\s*${escapeRegex(key)}\\s*$`, $options: "i" },
        })),
      ],
    });
  }

  if (andConditions.length) matchStage.$and = andConditions;

  // ---- search ----
  const searchText = String(query.search || "").trim();

  if (searchText) {
    const pattern = new RegExp(
      escapeRegex(normalizeMobileSearchTerm(searchText)),
      "i"
    );

    const [mainContacts, spouseContacts, matchedEvents] = await Promise.all([
      Contact.find({
        isDeleted: { $ne: true },
        $or: [{ fullName: pattern }, { whatsappNumber: pattern }],
      })
        .select("_id")
        .lean(),
      Contact.find({
        isDeleted: { $ne: true },
        $or: [{ spouseName: pattern }, { spouseMobile: pattern }],
      })
        .select("_id")
        .lean(),
      Event.find({
        isDeleted: { $ne: true },
        $or: [{ edition: pattern }, { title: pattern }],
      })
        .select("_id")
        .lean(),
    ]);

    matchStage.$and = [
      ...(matchStage.$and || []),
      {
        $or: [
          {
            contactId: { $in: mainContacts.map((c) => c._id) },
            isSpouse: { $ne: true },
          },
          {
            contactId: { $in: spouseContacts.map((c) => c._id) },
            isSpouse: true,
          },
          { eventId: { $in: matchedEvents.map((e) => e._id) } },
          { "eventSnapshot.edition": pattern },
          { "eventSnapshot.title": pattern },
        ],
      },
    ];
  }

  // ---- reference filter, PER ENTRY ----
  // The person-level filter above only finds people who have the reference
  // somewhere. Keep only the entries (edition rows) whose OWN edition
  // reference is one of the ticked ones (PV6 -> Mukund, PV7 -> Rahul:
  // ticking Mukund leaves the PV6 entry only).
  if (referenceKeys.length) {
    const candidates = await ContactEventHistory.find(matchStage)
      .select("eventId references contactSnapshot")
      .populate({ path: "contactId", select: "whatsappNumber references" })
      .lean();
    const referencesOfEntry = await makeReferenceResolver(candidates);
    const wanted = new Set(referenceKeys);
    const keepIds = candidates
      .filter((e) =>
        referencesOfEntry(e).some((ref) => wanted.has(Contact.normalizeReferenceKey(ref)))
      )
      .map((e) => e._id);
    matchStage._id = { $in: keepIds };
  }

  return matchStage;
};

// ---- reference of EACH edition (used by the page AND the Excel export) ----
// A guest's reference belongs to the edition (PV6 -> Mukund, PV7 -> Rahul).
// It can be saved on the history entry, on that entry's Contact, or only on
// the Guest List contact of the SAME number for that edition (e.g. a person
// added from Entry Report gets a history-only contact with no reference).
// Returns (entry) => [references of that entry's edition].
const last10Digits = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
};

const makeReferenceResolver = async (entries) => {
  const numberVariants = new Set();
  entries.forEach((e) => {
    const n = last10Digits(e.contactId?.whatsappNumber || e.contactSnapshot?.whatsappNumber);
    if (n.length === 10) {
      numberVariants.add(n);
      numberVariants.add(`91${n}`);
      numberVariants.add(`+91${n}`);
    }
  });
  const sameNumberContacts = numberVariants.size
    ? await Contact.find({
        isDeleted: { $ne: true },
        whatsappNumber: { $in: [...numberVariants] },
      })
        .select("whatsappNumber references editionEventId")
        .lean()
    : [];
  const contactsByNumber = new Map();
  sameNumberContacts.forEach((c) => {
    const n = last10Digits(c.whatsappNumber);
    if (!contactsByNumber.has(n)) contactsByNumber.set(n, []);
    contactsByNumber.get(n).push(c);
  });

  return (e) => {
    const eventKey = String(e.eventId?._id || e.eventId || "");
    const n = last10Digits(e.contactId?.whatsappNumber || e.contactSnapshot?.whatsappNumber);
    const fromSameEdition = (contactsByNumber.get(n) || [])
      .filter((c) => eventKey && String(c.editionEventId || "") === eventKey)
      .map((c) => c.references || []);
    return mergeReferences(
      e.references || [],
      Array.isArray(e.contactId?.references) ? e.contactId.references : [],
      ...fromSameEdition
    );
  };
};

// ================= GET ALL EVENT HISTORY (ALL CONTACTS) =================
// Powers the standalone Sidebar "Event History" page (not scoped to one
// contact) — every entry, across every contact, with both contactId and
// eventId populated. Supports optional ?contactId=&eventId=&status=
// &page=&limit=&search= filters.
//
// `search` (case-insensitive, partial) matches the PERSON of a row and the
// edition:
//   - a normal row  -> the contact's fullName / whatsappNumber
//   - a spouse row  -> the contact's spouseName / spouseMobile
//   - any row       -> the event's edition / title (e.g. "Parv 5")
// A full number typed with +91 / spaces ("+91 98765 43210") still matches.
const getAllEventHistory = async (query = {}) => {
  const matchStage = await buildHistoryMatch(query);

  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;

  // ONE row per person NUMBER (not per Contact document): a Contact belongs to
  // one edition, so the same guest in two editions has two Contacts with the
  // same number. Grouping by number puts every edition of that person on ONE
  // row (an edition badge each), so a new edition only adds a badge.
  const rawRows = await ContactEventHistory.find(matchStage)
    .select("_id contactId isSpouse createdAt contactSnapshot")
    .lean();

  const contactDocs = await Contact.find({
    _id: { $in: [...new Set(rawRows.map((r) => String(r.contactId)))] },
  })
    .select("whatsappNumber spouseMobile")
    .lean();
  const numberById = new Map(contactDocs.map((c) => [String(c._id), c]));

  const last10 = (value) => {
    const digits = String(value || "").replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : digits;
  };

  const groupMap = new Map();
  rawRows.forEach((row) => {
    const isSpouse = !!row.isSpouse;
    const live = numberById.get(String(row.contactId)) || {};
    const saved = row.contactSnapshot || {};
    const number = last10(
      isSpouse
        ? live.spouseMobile || saved.spouseMobile
        : live.whatsappNumber || saved.whatsappNumber
    );
    // No number at all (very old data): keep it per contact, as before.
    const key = `${isSpouse ? "spouse" : "main"}:${number || `id-${row.contactId}`}`;

    let group = groupMap.get(key);
    if (!group) {
      group = { _id: { key, isSpouse }, latest: row.createdAt, entryIds: [] };
      groupMap.set(key, group);
    }
    group.entryIds.push(row._id);
    if (new Date(row.createdAt) > new Date(group.latest)) group.latest = row.createdAt;
  });

  const sortedGroups = [...groupMap.values()].sort(
    (x, y) => new Date(y.latest) - new Date(x.latest) || x._id.key.localeCompare(y._id.key)
  );

  const total = sortedGroups.length;
  const groups = sortedGroups.slice((page - 1) * limit, page * limit);

  const allIds = groups.flatMap((g) => g.entryIds);
  const entries = allIds.length
    ? await ContactEventHistory.find({ _id: { $in: allIds } })
        .populate(CONTACT_POPULATE)
        .populate("eventId", "title edition startDateTime endDateTime venueName status")
    : [];

  const entryById = new Map(entries.map((e) => [String(e._id), withEventFallback(e)]));

  const referencesOfEntry = await makeReferenceResolver(entries);

  const history = groups.map((g) => {
    const groupEntries = g.entryIds
      .map((id) => entryById.get(String(id)))
      .filter(Boolean)
      // oldest event first (by event date)
      .sort(
        (x, y) =>
          new Date(x.eventId?.startDateTime || 0) - new Date(y.eventId?.startDateTime || 0) ||
          new Date(x.createdAt) - new Date(y.createdAt)
      );

    // Newest edition's contact is the "live" one (latest details win).
    const refsByEntry = new Map(groupEntries.map((e) => [String(e._id), referencesOfEntry(e)]));
    const withContact = groupEntries.filter((e) => e.contactId);
    const live = withContact.length ? withContact[withContact.length - 1].contactId : null;
    // Category: newest edition that has one (a guest may have it in one edition only).
    const categoryOf = (c) => (g._id.isSpouse ? c?.professionCategory : c?.companyCategory);
    const rowCategory =
      [...withContact].reverse().map((e) => categoryOf(e.contactId)).find((c) => c?._id) || null;
    return {
      _id: g._id.key,
      contactId: live,
      // Shown as the Category / Qty / Reference columns.
      categoryId: rowCategory?._id ? String(rowCategory._id) : "",
      category: rowCategory?.name || "",
      // ONE merged Reference cell: the references of every edition's contact
      // PLUS the reference saved on each event entry
      // (PV6 -> Mukund, PV7 -> Dhaval  =>  Mukund, Dhaval).
      references: mergeReferences(
        withContact.map((e) => (Array.isArray(e.contactId.references) ? e.contactId.references : [])),
        groupEntries.map((e) => refsByEntry.get(String(e._id)) || [])
      ),
      // Saved copy of the person (see model) - used when the live Contact
      // no longer has these details.
      contactSnapshot: groupEntries.find((e) => e.contactSnapshot)?.contactSnapshot || null,
      isSpouse: g._id.isSpouse,
      createdAt: g.latest,
      entries: groupEntries.map((e) => ({
        _id: e._id,
        eventId: e.eventId,
        status: e.status,
        notes: e.notes,
        source: e.source || "manual",
        markedManually: !!e.markedManually,
        // This edition's own reference(s) - shown per edition on the page.
        references: refsByEntry.get(String(e._id)) || [],
        createdAt: e.createdAt,
      })),
    };
  });

  return {
    message: history.length
      ? "Event history fetched successfully"
      : "No event history found",
    data: history,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

// ================= ATTENDANCE COUNTS =================
// GET /stats — Attended / Not Attended for the same view as the table
// (edition filter + search): `total/attended/notAttended` count ENTRIES (one
// person at one edition), `persons` is the same split QTY-wise (a couple = 2).
const getHistoryStats = async (query = {}) => {
  const matchStage = await buildHistoryMatch({
    eventId: query.eventId,
    search: query.search,
    category: query.category,
    reference: query.reference,
  });

  // QTY-wise: one entry stands for the PERSONS of its contact (Single = 1,
  // Couple = 2, Manual = typed number), not for "1". A spouse entry is the
  // one spouse (1). When a contact has BOTH a main and a spouse entry for
  // the same event, the main entry only counts the remaining persons so
  // nobody is counted twice.
  const rows = await ContactEventHistory.find(matchStage)
    .select("contactId eventId isSpouse status")
    .lean();

  const contacts = await Contact.find({
    _id: { $in: [...new Set(rows.map((r) => String(r.contactId)))] },
  })
    .select("persons entryType relationship")
    .lean();
  const contactById = new Map(contacts.map((c) => [String(c._id), c]));

  const spouseKeys = new Set(
    rows.filter((r) => r.isSpouse).map((r) => `${r.contactId}:${r.eventId}`)
  );

  const qtyOf = (row) => {
    if (row.isSpouse) return 1;
    const contact = contactById.get(String(row.contactId));
    const persons = contact ? personsOf(contact) : 1;
    const hasSpouseRow = spouseKeys.has(`${row.contactId}:${row.eventId}`);
    return Math.max(1, hasSpouseRow ? persons - 1 : persons);
  };

  // Entry counts (one entry = one person at one edition) - the main cards.
  let total = rows.length;
  let attended = 0;
  let notAttended = 0;
  // Qty-wise PERSON counts - shown below the cards.
  const persons = { total: 0, attended: 0, notAttended: 0 };
  // The same split per edition, so an edition can be swapped for its real
  // ticket numbers below.
  const personsByEvent = new Map();
  rows.forEach((row) => {
    const qty = qtyOf(row);
    const key = String(row.eventId);
    if (!personsByEvent.has(key)) {
      personsByEvent.set(key, {
        total: 0, attended: 0, notAttended: 0, // persons (qty)
        entries: 0, entriesAttended: 0, entriesNotAttended: 0, // entries
      });
    }
    const ev = personsByEvent.get(key);
    ev.total += qty;
    ev.entries += 1;
    persons.total += qty;
    if (row.status === "Attended") {
      attended += 1;
      persons.attended += qty;
      ev.attended += qty;
      ev.entriesAttended += 1;
    } else if (row.status === "Not Attended") {
      notAttended += 1;
      persons.notAttended += qty;
      ev.notAttended += qty;
      ev.entriesNotAttended += 1;
    }
  });

  // Person Wise Bookings = the Dashboard numbers. With no search / category /
  // reference / status filter the view is a whole edition, so for every
  // edition that has bookings the persons are its real TICKETS - exactly what
  // the Dashboard shows: Total = sum of booking quantities, Attended = scanned
  // tickets (Checked In), Not Attended = the rest. An edition without
  // bookings (an old event added by hand) keeps the contact-based persons.
  const wholeEditions = !query.search && !query.category && !query.reference && !query.status;
  if (wholeEditions) {
    try {
      const dashboardService = require("./dashboard.service");
      const eventIds = [...personsByEvent.keys()];
      const totals = { total: 0, attended: 0, notAttended: 0 };
      // Total Bookings cards: the number of BOOKINGS (Dashboard "quantity wise"
      // bookings, e.g. 273+616+2+6+1+1 = 899); Attended = bookings with a scanned ticket.
      const bookingTotals = { total: 0, attended: 0, notAttended: 0 };
      for (const id of eventIds) {
        const oid = new mongoose.Types.ObjectId(id);
        const counts = await dashboardService.getDashboardCounts(oid);
        const ev = personsByEvent.get(id);
        if (counts.totalBookings > 0) {
          const attendedQty = Math.min(counts.scannedEntries, counts.totalBookings);
          totals.total += counts.totalBookings;
          totals.attended += attendedQty;
          totals.notAttended += counts.totalBookings - attendedQty;

          const bk = await dashboardService.getBookingAttendanceCounts(oid);
          const attendedBookings = Math.min(bk.attendedBookings, bk.bookings);
          bookingTotals.total += bk.bookings;
          bookingTotals.attended += attendedBookings;
          bookingTotals.notAttended += bk.bookings - attendedBookings;
        } else {
          totals.total += ev.total;
          totals.attended += ev.attended;
          totals.notAttended += ev.notAttended;
          bookingTotals.total += ev.entries;
          bookingTotals.attended += ev.entriesAttended;
          bookingTotals.notAttended += ev.entriesNotAttended;
        }
      }
      persons.total = totals.total;
      persons.attended = totals.attended;
      persons.notAttended = totals.notAttended;
      total = bookingTotals.total;
      attended = bookingTotals.attended;
      notAttended = bookingTotals.notAttended;
    } catch (error) {
      console.error("Event History: could not read Dashboard ticket numbers:", error.message);
    }
  }

  return {
    total,
    attended,
    notAttended,
    other: total - attended - notAttended,
    persons,
  };
};

// ================= MARK ATTENDANCE BY HAND =================
// For a guest whose pass was never scanned but who did come. attended=true
// turns the entry green (Attended); attended=false puts a MANUALLY marked
// entry back to Not Attended (an entry that really was scanned is not
// touched by the undo).
const markAttendance = async (id, attended, adminId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Event History ID", 400);
  }

  const history = await ContactEventHistory.findOne({
    _id: id,
    isDeleted: { $ne: true },
  });

  if (!history) {
    throw new AppError("Event history entry not found", 404);
  }

  // Already in the wanted state - nothing to do.
  if (attended && history.status === "Attended") return populateHistory(history);
  if (!attended && history.status === "Not Attended") return populateHistory(history);

  if (attended) {
    if (history.scanOverriddenOff) {
      // Was really scanned, then un-ticked by hand: ticking it again simply
      // restores the real scan (no extra "manual" person on the Dashboard).
      history.scanOverriddenOff = false;
      history.markedManually = false;
    } else {
      history.markedManually = true; // counted as +Attended on the Dashboard
    }
    history.status = "Attended";
  } else {
    if (history.markedManually) {
      // A manual Attended is simply taken back.
      history.markedManually = false;
      history.scanOverriddenOff = false;
    } else {
      // Attended because the pass was really scanned: keep that fact, but
      // leave this person out of the scanned numbers (-1 on the Dashboard).
      history.scanOverriddenOff = true;
    }
    history.status = "Not Attended";
  }
  history.markedBy = adminId || null;
  history.markedAt = new Date();

  await history.save();

  return populateHistory(history);
};

// ================= MANUAL MARKS -> DASHBOARD NUMBERS =================
// The Dashboard counts scanned tickets. A person ticked Attended by hand (pass
// never scanned) must still be counted, and a really scanned person who was
// un-ticked by hand must not. This returns, for ONE edition:
//   addQty / addEntries   = persons / entries marked Attended by hand  (+)
//   subQty / subEntries   = scanned persons / entries un-ticked by hand (-)
// Qty follows the Event History rule: a contact stands for its persons
// (couple = 2); a spouse entry is 1; a main entry next to a spouse entry only
// counts the remaining persons.
const getManualAttendanceAdjustments = async (eventId) => {
  const empty = { addQty: 0, addEntries: 0, subQty: 0, subEntries: 0 };
  try {
    const rows = await ContactEventHistory.find({
      eventId,
      isDeleted: { $ne: true },
      $or: [
        { status: "Attended", markedManually: true },
        { status: "Not Attended", scanOverriddenOff: true },
      ],
    })
      .select("contactId isSpouse status markedManually")
      .lean();
    if (rows.length === 0) return empty;

    const contactIds = [...new Set(rows.map((r) => String(r.contactId)))];
    const [contacts, spouseRows] = await Promise.all([
      Contact.find({ _id: { $in: contactIds } })
        .select("persons entryType relationship")
        .lean(),
      ContactEventHistory.find({
        eventId,
        isDeleted: { $ne: true },
        isSpouse: true,
        contactId: { $in: contactIds },
      })
        .select("contactId")
        .lean(),
    ]);
    const contactById = new Map(contacts.map((c) => [String(c._id), c]));
    const hasSpouse = new Set(spouseRows.map((r) => String(r.contactId)));

    const out = { ...empty };
    rows.forEach((row) => {
      let qty = 1;
      if (!row.isSpouse) {
        const contact = contactById.get(String(row.contactId));
        const persons = contact ? personsOf(contact) : 1;
        qty = Math.max(1, hasSpouse.has(String(row.contactId)) ? persons - 1 : persons);
      }
      if (row.status === "Attended") {
        out.addQty += qty;
        out.addEntries += 1;
      } else {
        out.subQty += qty;
        out.subEntries += 1;
      }
    });
    return out;
  } catch (error) {
    console.error("Event History: could not read manual attendance marks:", error.message);
    return empty;
  }
};

// ================= EXPORT TO EXCEL =================
// GET /export?eventId=&search=&status= - streams an .xlsx of EXACTLY what the
// page is filtered to (edition + search), not just the current page. One row
// per entry (person + edition), plus a "Summary" sheet with Attended / Not
// Attended counts per edition.
const exportEventHistory = async (query, res) => {
  const ExcelJS = require("exceljs");

  const matchStage = await buildHistoryMatch({
    eventId: query.eventId,
    search: query.search,
    status: query.status,
    category: query.category,
    reference: query.reference,
  });

  const rawEntries = await ContactEventHistory.find(matchStage)
    .populate(CONTACT_POPULATE)
    .populate("eventId", "title edition startDateTime")
    .sort({ createdAt: -1 });

  const entries = rawEntries.map(withEventFallback);
  const referencesOfEntry = await makeReferenceResolver(entries);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Event Management CRM";
  workbook.created = new Date();

  const fmt = (value) => (value ? new Date(value).toLocaleString("en-GB") : "-");

  const styleHeader = (sheet) => {
    const row = sheet.getRow(1);
    row.font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "1F4E78" } };
    row.alignment = { vertical: "middle", horizontal: "center" };
  };

  // ---------- sheet 1: every entry ----------
  const sheet = workbook.addWorksheet("Event History");
  sheet.columns = [
    { header: "Name", key: "name", width: 28 },
    { header: "WhatsApp Number", key: "mobile", width: 20 },
    { header: "Guest Type", key: "type", width: 14 },
    { header: "Spouse Of", key: "spouseOf", width: 26 },
    { header: "Category", key: "category", width: 22 },
    { header: "Reference", key: "reference", width: 28 },
    { header: "Edition", key: "edition", width: 18 },
    { header: "Event Date", key: "eventDate", width: 22 },
    { header: "Status", key: "status", width: 16 },
    { header: "Marked Manually", key: "manual", width: 16 },
    { header: "Notes", key: "notes", width: 40 },
    { header: "Added From", key: "source", width: 16 },
    { header: "Added On", key: "createdAt", width: 22 },
  ];
  styleHeader(sheet);

  const perEdition = new Map();
  const editionEventIds = new Map(); // edition label -> its event _id

  entries.forEach((entry) => {
    const live = entry.contactId || {};
    const saved = entry.contactSnapshot || {};
    const pick = (key) => live[key] || saved[key] || "";
    const isSpouse = entry.isSpouse === true;

    const name = isSpouse ? pick("spouseName") : pick("fullName");
    const mobile = isSpouse ? pick("spouseMobile") : pick("whatsappNumber");
    const edition = entry.eventId?.edition || entry.eventId?.title || "-";
    const status = entry.status || "-";

    const row = sheet.addRow({
      name: name || (entry.contactId ? "-" : "Deleted guest"),
      mobile: mobile || "-",
      type: isSpouse ? "Spouse" : "Guest",
      spouseOf: isSpouse ? pick("fullName") || "-" : "-",
      category:
        (isSpouse ? live.professionCategory?.name : live.companyCategory?.name) || "-",
      reference: (() => {
        // This entry's OWN edition reference (same as the page).
        const merged = referencesOfEntry(entry);
        return merged.length ? merged.join(", ") : "-";
      })(),
      edition,
      eventDate: fmt(entry.eventId?.startDateTime),
      status,
      manual: entry.markedManually ? "Yes" : "No",
      notes: entry.notes || "-",
      source: entry.source === "entry-report" ? "Entry Report" : "Manual",
      createdAt: fmt(entry.createdAt),
    });

    // Green / red status cell - same colours as the page.
    const statusCell = row.getCell("status");
    if (status === "Attended") {
      statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9F2E0" } };
      statusCell.font = { bold: true, color: { argb: "FF1E7B3A" } };
    } else if (status === "Not Attended") {
      statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFBE1E1" } };
      statusCell.font = { bold: true, color: { argb: "FFB42323" } };
    }

    const entryEventId = entry.eventId?._id || entry.eventId;
    if (entryEventId && !editionEventIds.has(edition)) editionEventIds.set(edition, String(entryEventId));

    const counts = perEdition.get(edition) || { attended: 0, notAttended: 0, other: 0 };
    if (status === "Attended") counts.attended += 1;
    else if (status === "Not Attended") counts.notAttended += 1;
    else counts.other += 1;
    perEdition.set(edition, counts);
  });

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  if (entries.length > 0) {
    sheet.autoFilter = { from: "A1", to: "M1" };
  }

  // ---------- sheet 2: counts per edition ----------
  const summary = workbook.addWorksheet("Summary");
  // Same numbers as the page cards (and the Dashboard): one getHistoryStats()
  // call per edition, with the page's own search / category / reference filters.
  summary.columns = [
    { header: "Edition", key: "edition", width: 24 },
    { header: "Total Bookings", key: "bookings", width: 16 },
    { header: "Attended", key: "attended", width: 12 },
    { header: "Not Attended", key: "notAttended", width: 15 },
    { header: "Other", key: "other", width: 10 },
    { header: "Total Persons (Qty)", key: "persons", width: 20 },
    { header: "Persons Attended", key: "personsAttended", width: 18 },
    { header: "Persons Not Attended", key: "personsNotAttended", width: 22 },
  ];
  styleHeader(summary);

  const totals = {
    bookings: 0, attended: 0, notAttended: 0, other: 0,
    persons: 0, personsAttended: 0, personsNotAttended: 0,
  };
  const editionRows = [...perEdition.keys()].sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true })
  );
  for (const edition of editionRows) {
    const c = perEdition.get(edition);
    let row = {
      bookings: c.attended + c.notAttended + c.other,
      attended: c.attended,
      notAttended: c.notAttended,
      other: c.other,
      persons: c.attended + c.notAttended + c.other,
      personsAttended: c.attended,
      personsNotAttended: c.notAttended,
    };
    const eid = editionEventIds.get(edition);
    if (eid && mongoose.Types.ObjectId.isValid(eid)) {
      try {
        const s = await getHistoryStats({
          eventId: eid,
          search: query.search,
          category: query.category,
          reference: query.reference,
        });
        row = {
          bookings: s.total,
          attended: s.attended,
          notAttended: s.notAttended,
          other: s.other,
          persons: s.persons.total,
          personsAttended: s.persons.attended,
          personsNotAttended: s.persons.notAttended,
        };
      } catch (error) {
        console.error("Event History export: edition numbers fell back to entries:", error.message);
      }
    }
    summary.addRow({ edition, ...row });
    Object.keys(totals).forEach((k) => {
      totals[k] += row[k];
    });
  }

  const totalRow = summary.addRow({ edition: "Total", ...totals });
  totalRow.font = { bold: true };

  // ---------- download ----------
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=EventHistory_${Date.now()}.xlsx`
  );

  await workbook.xlsx.write(res);
  res.end();
};

// ================= EDITIONS THAT HAVE HISTORY =================
// Options for the Event History "All Editions" filter. Built from the
// history itself, so an edition stays in the list (and stays filterable)
// even after its Event was deleted - for those the name comes from the
// eventSnapshot saved at delete time.
const getHistoryEditions = async () => {
  const groups = await ContactEventHistory.aggregate([
    { $match: { isDeleted: { $ne: true } } },
    { $group: { _id: "$eventId", snapshot: { $max: "$eventSnapshot" } } },
  ]);

  const liveEvents = await Event.find({ _id: { $in: groups.map((g) => g._id) } })
    .select("title edition startDateTime")
    .lean();
  const liveById = new Map(liveEvents.map((e) => [String(e._id), e]));

  return groups
    .map((g) => {
      const source = liveById.get(String(g._id)) || g.snapshot;
      if (!source) return null;
      return {
        value: String(g._id),
        label: source.edition || source.title || "-",
        startDateTime: source.startDateTime || null,
        isEventDeleted: !liveById.has(String(g._id)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.startDateTime || 0) - new Date(a.startDateTime || 0));
};

// ================= CATEGORY + REFERENCE FILTER OPTIONS =================
// Only categories / references of people who really have history, so every
// option in the Event History filters can show at least one row.
const getHistoryFilterOptions = async () => {
  const contactIds = await ContactEventHistory.distinct("contactId", {
    isDeleted: { $ne: true },
  });

  const contacts = await Contact.find({ _id: { $in: contactIds } })
    .select("references companyCategory professionCategory")
    .populate("companyCategory", "name")
    .populate("professionCategory", "name")
    .lean();

  const categories = new Map();
  const references = new Map();

  // references saved on the event entries themselves
  const entryRefs = await ContactEventHistory.distinct("references", {
    isDeleted: { $ne: true },
  });
  entryRefs.forEach((raw) => {
    if (typeof raw !== "string" || !raw.trim()) return;
    const key = Contact.normalizeReferenceKey(raw.trim());
    if (!references.has(key)) references.set(key, raw.trim());
  });

  contacts.forEach((contact) => {
    [contact.companyCategory, contact.professionCategory].forEach((cat) => {
      if (cat?._id && cat.name) categories.set(String(cat._id), cat.name);
    });
    (contact.references || []).forEach((raw) => {
      if (typeof raw !== "string") return;
      const trimmed = raw.trim();
      if (!trimmed) return;
      const key = Contact.normalizeReferenceKey(trimmed);
      if (!references.has(key)) references.set(key, trimmed);
    });
  });

  const byLabel = (a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase());

  return {
    categories: [...categories].map(([value, label]) => ({ value, label })).sort(byLabel),
    references: [...references.values()].map((value) => ({ value, label: value })).sort(byLabel),
  };
};

// ================= GET EVENT HISTORY BY CONTACT =================
// Supports optional ?page=&limit= — omit both to get the full,
// unpaginated timeline (the page's default view), same "pass what you
// need" shape as getAllEvents's own page/limit query params.
const getEventHistoryByContact = async (contactId, query = {}) => {
  await assertContactExists(contactId);

  const filter = { contactId, isDeleted: { $ne: true } };

  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 0; // 0 = no pagination applied below

  const baseQuery = ContactEventHistory.find(filter)
    .populate("eventId", "title edition startDateTime endDateTime venueName status")
    .sort({ createdAt: -1 });

  const total = await ContactEventHistory.countDocuments(filter);

  const rawHistory = limit
    ? await baseQuery.skip((page - 1) * limit).limit(limit)
    : await baseQuery;
  const history = rawHistory.map(withEventFallback);

  return {
    message: history.length
      ? "Event history fetched successfully"
      : "No event history found",
    data: history,
    pagination: {
      total,
      page,
      limit: limit || total,
      totalPages: limit ? Math.max(1, Math.ceil(total / limit)) : 1,
    },
  };
};

// ================= UPDATE EVENT HISTORY =================
// contactId is intentionally never accepted here — an entry always
// stays attached to the contact it was created under; only
// eventId/status/notes (the form's own fields, per this step's
// spec) are editable.
const updateEventHistory = async (id, data) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Event History ID", 400);
  }

  const history = await ContactEventHistory.findOne({
    _id: id,
    isDeleted: { $ne: true },
  });

  if (!history) {
    throw new AppError("Event history entry not found", 404);
  }

  // Unchanged event (e.g. only status/notes edited) needs no lookup, so a
  // row whose Event was deleted can still be edited.
  if (data.eventId && String(data.eventId) !== String(history.eventId)) {
    await assertEventExists(data.eventId);
    history.eventId = data.eventId;
    history.eventSnapshot = null;
  }

  if (data.status !== undefined) {
    history.status = data.status;
  }

  if (data.notes !== undefined) {
    history.notes = data.notes;
  }

  await history.save();

  return populateHistory(history);
};

// ================= DELETE EVENT HISTORY (SOFT DELETE) =================
const deleteEventHistory = async (id, adminId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Invalid Event History ID", 400);
  }

  const history = await ContactEventHistory.findOne({
    _id: id,
    isDeleted: { $ne: true },
  });

  if (!history) {
    throw new AppError("Event history entry not found", 404);
  }

  history.isDeleted = true;
  history.deletedAt = new Date();
  history.deletedBy = adminId || null;

  await history.save();

  return history;
};

// ================= HELPERS =================

async function assertContactExists(contactId) {
  if (!mongoose.Types.ObjectId.isValid(contactId)) {
    throw new AppError("Invalid Contact ID", 400);
  }

  const contact = await Contact.findOne({
    _id: contactId,
    isDeleted: { $ne: true },
  }).select("_id");

  if (!contact) {
    throw new AppError("Contact not found", 404);
  }
}

async function assertEventExists(eventId) {
  if (!mongoose.Types.ObjectId.isValid(eventId)) {
    throw new AppError("Invalid Event ID", 400);
  }

  const event = await Event.findOne({
    _id: eventId,
    isDeleted: { $ne: true },
  }).select("_id");

  if (!event) {
    throw new AppError("Event not found", 404);
  }
}

// Re-fetches with the Event populated the same way the list endpoint
// returns it, so create/update responses match getEventHistoryByContact's
// shape exactly (the frontend can drop either straight into its list
// state without a refetch).
async function populateHistory(history) {
  const doc = await ContactEventHistory.findById(history._id).populate(
    "eventId",
    "title edition startDateTime endDateTime venueName status"
  );
  return withEventFallback(doc);
}

// When the Event was deleted, populate() returns null for eventId. Rebuild
// it from the snapshot saved at delete time so the response keeps the same
// shape (eventId.title / edition / startDateTime ...) the frontend reads.
function withEventFallback(doc) {
  if (!doc) return doc;
  const obj = typeof doc.toObject === "function" ? doc.toObject() : doc;
  if (!obj.eventId && obj.eventSnapshot) {
    obj.eventId = { ...obj.eventSnapshot };
  }
  return obj;
}

module.exports = {
  createEventHistory,
  getAllEventHistory,
  getHistoryStats,
  markAttendance,
  getManualAttendanceAdjustments,
  exportEventHistory,
  getHistoryEditions,
  getHistoryFilterOptions,
  getEventHistoryByContact,
  updateEventHistory,
  deleteEventHistory,
};