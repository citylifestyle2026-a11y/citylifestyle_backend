const rsvpService = require("../services/rsvp.service");

// GET /api/public/rsvp/:token
const getRsvp = async (req, res, next) => {
  try {
    const data = await rsvpService.getRsvpByToken(req.params.token);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// POST /api/public/rsvp/:token  { response: "yes" | "no" }
const submitRsvp = async (req, res, next) => {
  try {
    const data = await rsvpService.submitRsvp(
      req.params.token,
      req.body?.response
    );

    return res.status(200).json({
      success: true,
      message:
        data.status === "yes"
          ? "Your attendance has been confirmed."
          : "Your response has been recorded.",
      data,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getRsvp, submitRsvp };
