const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const memberController = require("../controllers/member.controller");
const upload = require("../middlewares/upload.middleware");

// Static paths first so they are never read as an :id.
router.get("/professions", protect, memberController.getProfessions);
router.get("/references", protect, memberController.getReferences);

// Import members from .xlsx / .csv. Add ?dryRun=true to only check the file.
router.post(
  "/import",
  protect,
  upload.spreadsheetUpload.single("file"),
  memberController.importMembers
);

// Move members (ids, or every member matching filters) to Guest List.
router.post("/move-to-guest-list", protect, memberController.moveToGuestList);

router.get("/", protect, memberController.getAllMembers);

router.delete("/:id", protect, memberController.deleteMember);

module.exports = router;
