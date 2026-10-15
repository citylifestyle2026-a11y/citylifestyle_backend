const invitationService = require("../services/invitation.service");

// GET /api/public/invitation/:invitationId  (no login)
const getInvitation = async (req, res, next) => {
  try {
    const data = await invitationService.getPublicInvitation(
      String(req.params.invitationId || "").trim()
    );

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

module.exports = { getInvitation };
