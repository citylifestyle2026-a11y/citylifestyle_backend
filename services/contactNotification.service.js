const whatsappService = require("./whatsapp.service");

/**
 * WhatsApp messages sent to Contact List people when an admin acts on them.
 *
 * REJECTION MESSAGE
 * Sent once when a contact is marked "Rejected". Wording is deliberately
 * polite: it does not say "rejected", it thanks the person and promises an
 * invitation for the next Parv.
 *
 * How it is delivered (WhatsApp rule): a free-text message only reaches a
 * person who messaged the business number in the last 24 hours. For everyone
 * else WhatsApp needs an APPROVED TEMPLATE. So:
 *   - if CHATBOX_REJECTION_TEMPLATE_NAME is set in .env, that template is
 *     used (one body variable {{1}} = the person's name), otherwise
 *   - a normal text message is sent.
 * Suggested template body (create + get it approved in Chatbox / Meta):
 *   "Dear {{1}}, thank you for your interest in Parv by City Toppers. ..."
 *   (same text as buildRejectionText below, with {{1}} in place of the name)
 */
const buildRejectionText = (name) => {
  const firstName = String(name || "").trim() || "there";

  return [
    `Dear ${firstName},`,
    "",
    "Thank you for your interest in Parv by City Toppers and for taking the time to register with us.",
    "",
    "Due to limited seating at this edition, we are unable to confirm your invitation this time. We truly appreciate your understanding.",
    "",
    "We would be delighted to welcome you at the next edition of Parv, and we will personally share your invitation as soon as it is announced.",
    "",
    "Warm regards,",
    "Team City Toppers",
  ].join("\n");
};

// Throws on failure — the caller decides that a failed message must not
// block the status change itself.
const sendRejectionMessage = async (contact) => {
  const templateName = String(
    process.env.CHATBOX_REJECTION_TEMPLATE_NAME || ""
  ).trim();

  if (templateName) {
    return whatsappService.sendTemplateMessage({
      phone: contact.whatsappNumber,
      templateName,
      languageCode: process.env.CHATBOX_REJECTION_TEMPLATE_LANGUAGE || "en",
      bodyParams: [String(contact.fullName || "").trim() || "there"],
    });
  }

  return whatsappService.sendTextMessage({
    phone: contact.whatsappNumber,
    message: buildRejectionText(contact.fullName),
  });
};

/**
 * PASS CANCELLED MESSAGE
 * Sent when an admin uses "Cancel Pass" on an approved guest who already
 * received a pass. It tells the guest, politely and clearly, that the pass
 * (and its QR code) is no longer valid.
 *
 * Same delivery rule as above: use the approved template when
 * CHATBOX_PASS_CANCEL_TEMPLATE_NAME is set (two body variables:
 * {{1}} = guest name, {{2}} = edition / event name), otherwise a normal text.
 * Suggested template body (same wording as buildPassCancelledText):
 *   "Dear {{1}}, we regret to inform you that your pass for {{2}} has been
 *    cancelled. The QR code shared earlier is no longer valid and cannot be
 *    used for entry. ..."
 */
const buildPassCancelledText = (name, editionName) => {
  const firstName = String(name || "").trim() || "there";
  const edition = String(editionName || "").trim() || "the event";

  return [
    `Dear ${firstName},`,
    "",
    `We regret to inform you that your pass for ${edition} has been cancelled. The QR code shared with you earlier is no longer valid and cannot be used for entry.`,
    "",
    "If you believe this was done in error, or if you have any questions, please get in touch with the City Toppers team and we will be glad to assist you.",
    "",
    "Warm regards,",
    "Team City Toppers",
  ].join("\n");
};

// Throws on failure - the caller decides that a failed message must not
// undo the cancellation itself.
const sendPassCancelledMessage = async (contact, editionName) => {
  const templateName = String(
    process.env.CHATBOX_PASS_CANCEL_TEMPLATE_NAME || ""
  ).trim();

  if (templateName) {
    return whatsappService.sendTemplateMessage({
      phone: contact.whatsappNumber,
      templateName,
      languageCode: process.env.CHATBOX_PASS_CANCEL_TEMPLATE_LANGUAGE || "en",
      bodyParams: [
        String(contact.fullName || "").trim() || "there",
        String(editionName || "").trim() || "the event",
      ],
    });
  }

  return whatsappService.sendTextMessage({
    phone: contact.whatsappNumber,
    message: buildPassCancelledText(contact.fullName, editionName),
  });
};

module.exports = {
  buildRejectionText,
  sendRejectionMessage,
  buildPassCancelledText,
  sendPassCancelledMessage,
};
