const asyncHandler = require("../utils/asyncHandler");
const inviteService = require("../services/invite.service");

exports.importCsv = asyncHandler(async (req, res) => {
  const dryRun = String(req.query.dryRun || "") === "true";
  res.json(await inviteService.importCsv(req.file?.buffer, req.user?.id, { dryRun }));
});

exports.list = asyncHandler(async (req, res) => res.json(await inviteService.list(req.query)));

exports.send = asyncHandler(async (req, res) => res.json(await inviteService.send(req.body || {})));

exports.resetStuck = asyncHandler(async (req, res) => res.json(await inviteService.resetStuck()));

exports.remove = asyncHandler(async (req, res) => res.json(await inviteService.remove(req.body?.ids)));

// GET /preview?name=Rahul  -> the card as a PNG
exports.preview = asyncHandler(async (req, res) => {
  const png = await inviteService.generateCard(String(req.query.name || "Guest Name").slice(0, 60));
  res.set("Content-Type", "image/png").set("Cache-Control", "no-store").send(png);
});

exports.create = asyncHandler(async (req, res) =>
  res.status(201).json(await inviteService.create(req.body, req.user?.id))
);

exports.update = asyncHandler(async (req, res) =>
  res.json(await inviteService.update(req.params.id, req.body))
);
