const whatsappService = require("./whatsapp.service");
const { toReferenceList } = require("../utils/splitReferences");

// "Registration received" WhatsApp message, sent right after someone submits
// the public form - both the normal form (/city-lifestyle) and a
// "Share Form Link" form.
//
// WhatsApp template body (category: Utility, language: English):
//
//   Dear {{1}},
//
//   Your registration for PARV 6.0 by City Toppers has been successfully received.
//
//   Invited By: {{2}}
//
//   Your Entry QR Code will be shared with you shortly on this WhatsApp number.
//
//   Regards,
//   Team City Toppers
//
//   {{1}} = the person's name
//   {{2}} = the person's Reference (who invited them). On a Share Form Link
//           this is the link's name; on the normal form it is what the
//           person typed. Several references are joined with ", ".
//
// .env:
//   CHATBOX_REGISTRATION_TEMPLATE_NAME=<approved template name>
//   CHATBOX_REGISTRATION_TEMPLATE_LANGUAGE=en
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

// {{2}} "Invited By". WhatsApp rejects empty variables, so fall back to "-".
const cleanInvitedBy = (references) => {
  const list = toReferenceList(Array.isArray(references) ? references : [references]);
  return (
    list
      .join(", ")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 100) || "-"
  );
};

const sendRegistrationAck = async ({ name, phone, references }) => {
  let key = "";
  try {
    const templateName = String(process.env.CHATBOX_REGISTRATION_TEMPLATE_NAME || "").trim();

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
      //   {{1}} name      {{2}} invited by (reference)
      bodyParams: [cleanName(name), cleanInvitedBy(references)],
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