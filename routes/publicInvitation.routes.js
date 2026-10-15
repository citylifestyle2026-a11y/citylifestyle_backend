const express = require("express");
const router = express.Router();
const publicInvitationController = require("../controllers/publicInvitation.controller");

// Public (no login) -- opened from the "Your Digital Invite" link in the
// WhatsApp message (frontend: /ticket?qr=<invitationId>).
router.get("/:invitationId", (req, res, next) => {
  if (!/^\d{8}$/.test(String(req.params.invitationId || ""))) {
    return res.status(404).json({ success: false, message: "Invitation not found." });
  }
  return publicInvitationController.getInvitation(req, res, next);
});

module.exports = router;
