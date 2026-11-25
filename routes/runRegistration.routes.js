const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const authorize = require("../middlewares/authorize.middleware");
const asyncHandler = require("../utils/asyncHandler");
const runService = require("../services/runRegistration.service");

// Run Registration (Let's Run). The REPORT (list / summary / Excel) is the
// sidebar page "Run Report" and the Dashboard section. Admin only. The gate
// staff scan with the normal QR scanner (/api/qr/...), which already knows the
// run QR codes.
router.use(protect);
const adminOnly = authorize("admin");
const reportAccess = authorize("admin");

// Every route below works on ONE event (edition): ?eventId=<id> from the
// header dropdown; without it the active (default) event is used.

// list + summary numbers  ?page&limit&search&status&distance&eventId
router.get(
  "/",
  reportAccess,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await runService.listRuns(req.query) });
  })
);

// dashboard numbers  ?eventId
router.get(
  "/summary",
  reportAccess,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await runService.getSummary(req.query.eventId) });
  })
);

// Excel of the current tab / distance / search
router.get(
  "/export",
  reportAccess,
  asyncHandler(async (req, res) => {
    await runService.exportRuns(req.query, res);
  })
);

// Add Data: { name, mobile, eventId? } -> saves + sends the WhatsApp link
router.post(
  "/",
  adminOnly,
  asyncHandler(async (req, res) => {
    const { run, whatsappSent } = await runService.createRun(req.body, req.user?._id);
    res.status(201).json({
      success: true,
      message: whatsappSent ? "Added. Registration link sent on WhatsApp." : "Added.",
      whatsappSent,
      data: run,
    });
  })
);

// Edit: { name?, mobile?, email?, distance? }
router.put(
  "/:id",
  adminOnly,
  asyncHandler(async (req, res) => {
    const { run, whatsappSent } = await runService.updateRun(req.params.id, req.body);
    res.json({ success: true, message: "Updated.", whatsappSent, data: run });
  })
);

// Not registered -> link again. Registered -> QR again.
router.post(
  "/:id/resend",
  adminOnly,
  asyncHandler(async (req, res) => {
    const result = await runService.resendRun(req.params.id);
    res.json({
      success: true,
      message: result.kind === "link" ? "Registration link sent on WhatsApp." : "QR sent again.",
      data: result,
    });
  })
);

router.delete(
  "/:id",
  adminOnly,
  asyncHandler(async (req, res) => {
    await runService.deleteRun(req.params.id);
    res.json({ success: true, message: "Deleted." });
  })
);

module.exports = router;
