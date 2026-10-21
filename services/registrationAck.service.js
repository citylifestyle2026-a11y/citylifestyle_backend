const whatsappService = require("./whatsapp.service");

// "Registration received" WhatsApp message, sent right after someone submits
// the public form (Share Form Link / city-lifestyle form).
//
// WhatsApp template body (category: Utility, language: English):
//
//   Dear {{1}},
//
//   Thank you for registering for *Parv by City Toppers*. We have received your details successfully.
//
//   Our team will review your submission and confirm your participation by *{{2}}*. You will receive the update on this WhatsApp number.
//
//   Regards,
//   City Toppers
//
//   {{1}} = the person's name      {{2}} = FORM_REVIEW_DATE from .env
//
// .env:
//   CHATBOX_REGISTRATION_TEMPLATE_NAME=<approved template name>
//   CHATBOX_REGISTRATION_TEMPLATE_LANGUAGE=en
//   FORM_REVIEW_DATE=25 October 2026
//
// This is a courtesy message: it NEVER blocks or fails the form submit.

// The public form is open to anyone, so one number can receive at most one of
// these messages per window (stops someone using the form to spam a number).
const WINDOW_MS = 10 * 60 * 1000;
const recentlySent = new Map(); // phone -> timestamp

const cleanName = (value) =>
  String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 60) || "Guest";

const sendRegistrationAck = async ({ name, phone }) => {
  try {
    const templateName = String(process.env.CHATBOX_REGISTRATION_TEMPLATE_NAME || "").trim();
    const reviewDate = String(process.env.FORM_REVIEW_DATE || "").trim();

    if (!templateName || !reviewDate) {
      console.warn(
        "Registration WhatsApp not sent: set CHATBOX_REGISTRATION_TEMPLATE_NAME and FORM_REVIEW_DATE in .env."
      );
      return false;
    }
    if (!phone || !String(phone).trim()) return false;

    const key = String(phone).replace(/\D/g, "").slice(-10);
    const now = Date.now();
    for (const [k, t] of recentlySent) if (now - t > WINDOW_MS) recentlySent.delete(k);
    if (recentlySent.has(key)) return false;
    recentlySent.set(key, now);

    await whatsappService.sendTemplateMessage({
      phone,
      templateName,
      languageCode: String(process.env.CHATBOX_REGISTRATION_TEMPLATE_LANGUAGE || "en").trim(),
      bodyParams: [cleanName(name), reviewDate],
    });
    return true;
  } catch (error) {
    console.error("Registration WhatsApp failed:", error.message);
    return false;
  }
};

module.exports = { sendRegistrationAck };