const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const asyncHandler = require("../utils/asyncHandler");
const formLinkService = require("../services/formLink.service");

// Admin side of "Share Form Link" (Contact List / Member List).
router.use(protect);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await formLinkService.listFormLinks(req.query) });
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = await formLinkService.createFormLink(req.body, req.user?.id);
    res.status(201).json({ success: true, message: "Form link created.", data });
  })
);

// Excel of everyone who filled this link.
router.get(
  "/:id/export",
  asyncHandler(async (req, res) => {
    await formLinkService.exportFormLinkEntries(req.params.id, res);
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = await formLinkService.updateFormLink(req.params.id, req.body);
    res.json({ success: true, message: "Form link updated.", data });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await formLinkService.deleteFormLink(req.params.id);
    res.json({ success: true, message: "Form link deleted." });
  })
);

module.exports = router;
