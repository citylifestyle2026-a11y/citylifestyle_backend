const crypto = require("crypto");
const mongoose = require("mongoose");

const Contact = require("../models/contact.model");
const Event = require("../models/event.model");
const AppError = require("../utils/AppError");
const whatsappService = require("./whatsapp.service");
const buildReminderBodyParams = require("../utils/buildReminderBodyParams");
const {
  formatEventDate,
  formatEventTime,
} = require("../utils/buildReminderBodyParams");

/**
 * ATTENDANCE REMINDER (RSVP)
 *
 * Flow
 *  1. Admin opens Guest List -> Approved tab, selects guests, clicks
 *     "Send Reminder"  ->  sendRemindersToContacts().
 *  2. Each guest gets the approved WhatsApp template
 *     (CHATBOX_REMINDER_TEMPLATE_NAME) with two buttons, Yes and No. Both
 *     buttons are "Visit website" buttons whose URL ends with the guest's
 *     private token:
 *        Yes -> https://<site>/rsvp/yes/<token>
 *        No  -> https://<site>/rsvp/no/<token>
 *  3. The page calls submitRsvp() which saves the answer on the Contact.
 *     A guest who never tapped stays "none" (No response). If they tap
 *     later - or change their mind - the status simply updates.
 *  4. Dashboard / Guest List read the counts via getRsvpSummary().
 */

const RSVP_VALUES = ["yes", "no"];

const generateToken = () => crypto.randomBytes(16).toString("hex");

const maskToken = (token) => String(token || "").trim();

// Event a guest's reminder is about: the event of their pass, otherwise the
// edition they were moved into.
const resolveEventId = (contact, overrideEventId) =>
  overrideEventId || contact.passEventId || contact.editionEventId || null;

const getReminderConfig = () => {
  const templateName = String(
    process.env.CHATBOX_REMINDER_TEMPLATE_NAME || ""
  ).trim();

  if (!templateName) {
    throw new AppError(
      "Reminder template is not configured. Set CHATBOX_REMINDER_TEMPLATE_NAME (and CHATBOX_REMINDER_TEMPLATE_LANGUAGE) in the backend .env.",
      500
    );
  }

  return {
    templateName,
    languageCode:
      String(process.env.CHATBOX_REMINDER_TEMPLATE_LANGUAGE || "").trim() ||
      "en",
  };
};

// ================= SEND REMINDER (ADMIN) =================
// POST /api/contacts/send-reminder
// body: { ids: [...], eventId?: string, includeResponded?: boolean }
//
// Only APPROVED guests. By default a guest who already answered Yes / No for
// the same event is skipped (set includeResponded: true to remind them again).
// One guest at a time so a single failure never stops the rest.
const sendRemindersToContacts = async ({
  ids,
  eventId,
  includeResponded = false,
}) => {
  const { templateName, languageCode } = getReminderConfig();

  const contactIds = Array.isArray(ids)
    ? [...new Set(ids.map(String))].filter((id) =>
        mongoose.Types.ObjectId.isValid(id)
      )
    : [];

  if (!contactIds.length) {
    throw new AppError("Please select at least one guest.", 400);
  }

  if (eventId && !mongoose.Types.ObjectId.isValid(eventId)) {
    throw new AppError("Invalid event.", 400);
  }

  const contacts = await Contact.find({
    _id: { $in: contactIds },
    isDeleted: { $ne: true },
    historyOnly: { $ne: true },
  });

  const byId = new Map(contacts.map((c) => [String(c._id), c]));
  const eventCache = new Map();

  const loadEvent = async (id) => {
    const key = String(id);
    if (!eventCache.has(key)) {
      eventCache.set(
        key,
        await Event.findOne({ _id: id, isDeleted: { $ne: true } }).lean()
      );
    }
    return eventCache.get(key);
  };

  const results = [];

  for (const id of contactIds) {
    const contact = byId.get(id);

    if (!contact) {
      results.push({ id, name: "-", status: "failed", message: "Guest not found." });
      continue;
    }

    const base = { id, name: contact.fullName };

    if ((contact.approvalStatus || "approved") !== "approved") {
      results.push({
        ...base,
        status: "failed",
        message: "Only approved guests can get a reminder.",
      });
      continue;
    }

    const targetEventId = resolveEventId(contact, eventId);

    if (!targetEventId) {
      results.push({
        ...base,
        status: "failed",
        message: "No event linked to this guest (send a pass or move to an edition first).",
      });
      continue;
    }

    const event = await loadEvent(targetEventId);

    if (!event) {
      results.push({ ...base, status: "failed", message: "Event not found." });
      continue;
    }

    const sameEvent =
      contact.rsvpEventId && String(contact.rsvpEventId) === String(event._id);

    if (!includeResponded && sameEvent && contact.rsvpStatus !== "none") {
      results.push({
        ...base,
        status: "skipped",
        message: `Already answered "${contact.rsvpStatus === "yes" ? "Yes" : "No"}".`,
      });
      continue;
    }

    // Keep the same token on a re-send so an OLD WhatsApp message keeps
    // working too.
    const token = contact.rsvpToken || generateToken();

    try {
      await whatsappService.sendTemplateMessage({
        phone: contact.whatsappNumber,
        templateName,
        languageCode,
        bodyParams: buildReminderBodyParams({ contact, event }),
        buttonParams: [
          { index: 0, param: token }, // Yes
          { index: 1, param: token }, // No
        ],
      });

      const update = {
        rsvpToken: token,
        rsvpEventId: event._id,
        rsvpReminderSentAt: new Date(),
      };

      const mongoUpdate = { $set: update };

      if (sameEvent) {
        mongoUpdate.$inc = { rsvpReminderCount: 1 };
      } else {
        // A reminder for a DIFFERENT event starts with a clean answer.
        update.rsvpStatus = "none";
        update.rsvpRespondedAt = null;
        update.rsvpReminderCount = 1;
      }

      await Contact.updateOne({ _id: contact._id }, mongoUpdate);

      results.push({ ...base, status: "sent", message: "Reminder sent." });
    } catch (error) {
      console.error(
        `Reminder WhatsApp failed for contact ${contact._id}:`,
        error.message || error
      );
      results.push({
        ...base,
        status: "failed",
        message: error.message || "Failed to send the reminder.",
      });
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;

  const parts = [`Reminder sent to ${sent} guest${sent === 1 ? "" : "s"}`];
  if (skipped) parts.push(`${skipped} skipped (already answered)`);
  if (failed) parts.push(`${failed} failed`);

  return {
    success: failed === 0 || sent > 0,
    message: `${parts.join(", ")}.`,
    data: { sent, skipped, failed, results },
  };
};

// ================= PUBLIC: GET RSVP INFO =================
// GET /api/public/rsvp/:token
// Minimal, safe data for the Yes / No page (first name + event only).
const getRsvpByToken = async (token) => {
  const cleanToken = maskToken(token);

  if (!/^[a-f0-9]{32}$/.test(cleanToken)) {
    throw new AppError("This link is not valid.", 404);
  }

  const contact = await Contact.findOne({
    rsvpToken: cleanToken,
    isDeleted: { $ne: true },
  })
    .select("fullName rsvpStatus rsvpEventId rsvpRespondedAt approvalStatus")
    .lean();

  if (!contact || !contact.rsvpEventId) {
    throw new AppError("This link is not valid.", 404);
  }

  const event = await Event.findOne({
    _id: contact.rsvpEventId,
    isDeleted: { $ne: true },
  })
    .select("title edition startDateTime endDateTime venueName address mapLink")
    .lean();

  if (!event) {
    throw new AppError("This event is no longer available.", 404);
  }

  return {
    guestName: String(contact.fullName || "").trim(),
    status: contact.rsvpStatus || "none",
    respondedAt: contact.rsvpRespondedAt || null,
    event: {
      title: event.title,
      edition: event.edition || "",
      date: formatEventDate(event.startDateTime),
      time: formatEventTime(event.startDateTime),
      venue: event.venueName || "",
      address: event.address || "",
      mapLink: event.mapLink || "",
      isOver: new Date(event.endDateTime).getTime() < Date.now(),
    },
  };
};

// ================= PUBLIC: SAVE ANSWER =================
// POST /api/public/rsvp/:token { response: "yes" | "no" }
// Called by the page itself as soon as it opens (one tap = answer saved).
// Calling it again with the other value CHANGES the answer.
const submitRsvp = async (token, response) => {
  const answer = String(response || "").trim().toLowerCase();

  if (!RSVP_VALUES.includes(answer)) {
    throw new AppError("Please choose Yes or No.", 400);
  }

  const info = await getRsvpByToken(token); // validates token + event

  if (info.event.isOver) {
    throw new AppError("This event has already taken place.", 410);
  }

  const contact = await Contact.findOneAndUpdate(
    { rsvpToken: maskToken(token), isDeleted: { $ne: true } },
    { $set: { rsvpStatus: answer, rsvpRespondedAt: new Date() } },
    { new: true }
  )
    .select("rsvpStatus")
    .lean();

  if (!contact) {
    throw new AppError("This link is not valid.", 404);
  }

  return { ...info, status: contact.rsvpStatus, respondedAt: new Date() };
};

// ================= DASHBOARD SUMMARY =================
// Counts for ONE event: how many guests said Yes / No, and how many were
// sent the reminder but have not tapped anything yet.
const getRsvpSummary = async (eventId) => {
  const empty = { reminderSent: 0, yes: 0, no: 0, noResponse: 0 };
  if (!eventId) return empty;

  const rows = await Contact.aggregate([
    {
      $match: {
        rsvpEventId: new mongoose.Types.ObjectId(String(eventId)),
        rsvpReminderSentAt: { $ne: null },
        isDeleted: { $ne: true },
        historyOnly: { $ne: true },
      },
    },
    { $group: { _id: { $ifNull: ["$rsvpStatus", "none"] }, count: { $sum: 1 } } },
  ]);

  const summary = { ...empty };

  rows.forEach((row) => {
    if (row._id === "yes") summary.yes = row.count;
    else if (row._id === "no") summary.no = row.count;
    else summary.noResponse += row.count;
  });

  summary.reminderSent = summary.yes + summary.no + summary.noResponse;

  return summary;
};

module.exports = {
  sendRemindersToContacts,
  getRsvpByToken,
  submitRsvp,
  getRsvpSummary,
};
