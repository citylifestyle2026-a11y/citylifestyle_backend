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
  let key = "";
  try {
    const templateName = String(process.env.CHATBOX_REGISTRATION_TEMPLATE_NAME || "").trim();
    const reviewDate = String(process.env.FORM_REVIEW_DATE || "").trim();

    if (!templateName) {
      console.warn(
        "[RegistrationAck] NOT SENT: set CHATBOX_REGISTRATION_TEMPLATE_NAME in the server environment, then redeploy/restart."
      );
      return false;
    }
    if (!phone || !String(phone).trim()) {
      console.warn("[RegistrationAck] NOT SENT: no WhatsApp number in the form.");
      return false;
    }

    key = String(phone).replace(/\D/g, "").slice(-10);
    const now = Date.now();
    for (const [k, t] of recentlySent) if (now - t > WINDOW_MS) recentlySent.delete(k);
    if (recentlySent.has(key)) {
      console.warn(
        `[RegistrationAck] SKIPPED: ${key} already got this message in the last 10 minutes (anti-spam).`
      );
      return false;
    }
    recentlySent.set(key, now);

    await whatsappService.sendTemplateMessage({
      phone,
      templateName,
      languageCode: String(process.env.CHATBOX_REGISTRATION_TEMPLATE_LANGUAGE || "en").trim(),
      // The number of values MUST equal the number of {{variables}} in the
      // approved template, or WhatsApp rejects it (error 132000).
      //   FORM_REVIEW_DATE set   -> template has {{1}} name + {{2}} date
      //   FORM_REVIEW_DATE empty -> template has only {{1}} name
      bodyParams: reviewDate ? [cleanName(name), reviewDate] : [cleanName(name)],
    });
    console.log(`[RegistrationAck] SENT to ${key} using template "${templateName}".`);
    return true;
  } catch (error) {
    // A failed send must NOT block the number: let it retry straight away.
    if (key) recentlySent.delete(key);
    console.error("[RegistrationAck] FAILED:", error?.message || error);
    return false;
  }
};

module.exports = { sendRegistrationAck };