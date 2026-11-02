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

// GET /preview?name=Rahul&top=48&x=50&size=5.2&color=%23C9A24B  -> the card as a JPG
// top / x / size / color are optional: they let the admin try a position before saving it.
exports.preview = asyncHandler(async (req, res) => {
  const { name, top, x, size, color } = req.query;
  const jpg = await inviteService.generateCard(String(name || "Guest Name").slice(0, 60), {
    topPct: top,
    centerXPct: x,
    fontSizePct: size,
    color,
  });
  res.set("Content-Type", "image/jpeg").set("Cache-Control", "no-store").send(jpg);
});

// ----- card design (the JPG the admin uploads) -----
exports.designInfo = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await inviteService.designInfo() })
);

exports.uploadDesign = asyncHandler(async (req, res) =>
  res.json({
    success: true,
    message: "Invitation card design uploaded.",
    data: await inviteService.saveDesign(req.file, req.user?.id),
  })
);

exports.saveNameStyle = asyncHandler(async (req, res) =>
  res.json({
    success: true,
    message: "Name position saved.",
    data: await inviteService.saveNameStyle(req.body, req.user?.id),
  })
);

exports.savePhotoBox = asyncHandler(async (req, res) =>
  res.json({
    success: true,
    message: "Photo position saved.",
    data: await inviteService.savePhotoBox(req.body, req.user?.id),
  })
);

exports.removeDesign = asyncHandler(async (req, res) =>
  res.json({
    success: true,
    message: "Design removed. The default card will be used.",
    data: await inviteService.removeDesign(),
  })
);

exports.create = asyncHandler(async (req, res) =>
  res.status(201).json(await inviteService.create(req.body, req.user?.id))
);

exports.update = asyncHandler(async (req, res) =>
  res.json(await inviteService.update(req.params.id, req.body))
);

// ----- GUEST CARD design (separate from the invitation card design above) -----
// The design the public /guest-card page uses: guests add their own photo + name.
const cardService = require("../services/inviteCard.service");

exports.guestDesignInfo = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await cardService.designInfo("guest") })
);

exports.guestUploadDesign = asyncHandler(async (req, res) =>
  res.json({
    success: true,
    message: "Guest card design uploaded.",
    data: await cardService.saveDesign(req.file, req.user?.id, "guest"),
  })
);

exports.guestSaveNameStyle = asyncHandler(async (req, res) =>
  res.json({
    success: true,
    message: "Name position saved.",
    data: await cardService.saveNameStyle(req.body, req.user?.id, "guest"),
  })
);

exports.guestSavePhotoBox = asyncHandler(async (req, res) =>
  res.json({
    success: true,
    message: "Photo position saved.",
    data: await cardService.savePhotoBox(req.body, req.user?.id, "guest"),
  })
);

exports.guestRemoveDesign = asyncHandler(async (req, res) =>
  res.json({
    success: true,
    message: "Guest card design removed. The guest card link will show \"not ready\".",
    data: await cardService.removeDesign("guest"),
  })
);

// The blank guest card picture, for the admin's position editor (same picture guests see).
exports.guestDesignImage = asyncHandler(async (req, res) => {
  const info = await cardService.designInfo("guest");
  if (!info.hasDesign) return res.status(404).json({ success: false, message: "No guest card design uploaded." });
  const jpg = await cardService.previewDesign();
  res.set("Content-Type", "image/jpeg").set("Cache-Control", "no-store").send(jpg);
});