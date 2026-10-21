// services/eventCleanup.service.js
//
// What happens to Guest List / Contact Book / Form Links when an Event is
// deleted. Used by event.service.js (deleteEvent) and by the one-time script
// scripts/cleanupOrphanEventData.js (for events that were deleted earlier).
//
// KEPT:     Contact Book (Member rows), Event History rows and Form Links
//           (Form Links are never touched here).
// REMOVED:  everything else that belonged to the event:
//   Guest List (Contact)
//     - contacts of the deleted event(s) are removed from Guest List.
//         * a contact that has Event History rows is NOT hard-deleted (the
//           history would lose its person) - it is turned into a hidden
//           `historyOnly` contact and all event / pass / approval data on it
//           is cleared. It no longer shows in Guest List.
//         * every other contact is hard-deleted (photos too).
//     - the REST of the Guest List (e.g. public-form submissions that never
//       got an edition) is cleared the same way - after an event delete the
//       Guest List is empty.
//   Contact Book (Member)
//     - the deleted event is removed from `movedTo`, so the "Past: PV6" tag
//       disappears and the member is "Not in Guest List" again.
const Contact = require("../models/contact.model");
const Member = require("../models/member.model");
const ContactEventHistory = require("../models/contactEventHistory.model");

const cleanupAfterEventDelete = async ({ eventIds = [], clearUnassigned = true, session } = {}) => {
  const opts = session ? { session } : {};
  const result = {
    contactsRemoved: 0,
    contactsHidden: 0,
    membersCleared: 0,
    filesToDelete: [],
  };

  // ---- 1. which Guest List contacts go ----
  const contactFilter = clearUnassigned
    ? { historyOnly: { $ne: true } }
    : {
        historyOnly: { $ne: true },
        $or: [
          { editionEventId: { $in: eventIds } },
          { passEventId: { $in: eventIds } },
          { passCancelledEventId: { $in: eventIds } },
        ],
      };

  const contacts = await Contact.find(contactFilter)
    .select("profileImagePublicId spouseProfileImagePublicId")
    .session(session || null)
    .lean();

  if (contacts.length) {
    const ids = contacts.map((c) => c._id);

    // Contacts that still have Event History rows must stay (hidden).
    const withHistory = new Set(
      (await ContactEventHistory.distinct("contactId", { contactId: { $in: ids } }, opts)).map(String)
    );

    const hideIds = ids.filter((id) => withHistory.has(String(id)));
    const deleteList = contacts.filter((c) => !withHistory.has(String(c._id)));

    if (hideIds.length) {
      await Contact.updateMany(
        { _id: { $in: hideIds } },
        {
          $set: {
            historyOnly: true,
            editionEventId: null,
            editionName: "",
            memberId: null,
            approvalStatus: "approved",
            approvalUpdatedAt: null,
            approvalUpdatedBy: null,
            passSentAt: null,
            passEventId: null,
            passBookingId: null,
            rejectionMessageSentAt: null,
            passCancelledAt: null,
            passCancelMessageSentAt: null,
            passCancelledBookingId: null,
            passCancelledEventId: null,
          },
        },
        opts
      );
      result.contactsHidden = hideIds.length;
    }

    if (deleteList.length) {
      await Contact.deleteMany({ _id: { $in: deleteList.map((c) => c._id) } }, opts);
      result.contactsRemoved = deleteList.length;

      for (const c of deleteList) {
        for (const publicId of [c.profileImagePublicId, c.spouseProfileImagePublicId]) {
          if (publicId) result.filesToDelete.push(publicId);
        }
      }
    }
  }

  // ---- 2. Contact Book: forget the deleted event(s) ("Past: PV6") ----
  if (eventIds.length) {
    const memberResult = await Member.updateMany(
      { "movedTo.eventId": { $in: eventIds } },
      { $pull: { movedTo: { eventId: { $in: eventIds } } } },
      opts
    );
    result.membersCleared = memberResult.modifiedCount || 0;
  }

  return result;
};

module.exports = { cleanupAfterEventDelete };