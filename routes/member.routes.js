const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const memberController = require("../controllers/member.controller");
const upload = require("../middlewares/upload.middleware");

// Profile photo + spouse profile photo (Add / Edit Member form). Same 100 MB
// image middleware as Contact; every image is re-encoded to WEBP on save.
const memberUpload = upload.largeImageUpload.fields([
  { name: "profileImage", maxCount: 1 },
  { name: "spouseProfileImage", maxCount: 1 },
]);

// With a photo the form is sent as multipart/form-data, where `references`
// can only be a JSON string - turn it back into an array.
const parseMemberFormData = (req, res, next) => {
  if (req.body && typeof req.body.references === "string") {
    try {
      const parsed = JSON.parse(req.body.references);
      req.body.references = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      req.body.references = [];
    }
  }
  next();
};

// Static paths first so they are never read as an :id.
router.get("/professions", protect, memberController.getProfessions);
router.get("/references", protect, memberController.getReferences);
// Needs Fix tools: download the rows as CSV / delete them in bulk.
router.get("/export", protect, memberController.exportMembers);
router.post("/bulk-delete", protect, memberController.bulkDeleteNeedsFix);

// Import members from .xlsx / .csv. Add ?dryRun=true to only check the file.
router.post(
  "/import",
  protect,
  upload.spreadsheetUpload.single("file"),
  memberController.importMembers
);

// Move members (ids, or every member matching filters) to Guest List.
router.post("/move-to-guest-list", protect, memberController.moveToGuestList);

// Add one member by hand.
router.post("/", protect, memberUpload, parseMemberFormData, memberController.createMember);

router.get("/", protect, memberController.getAllMembers);

router.put("/:id", protect, memberUpload, parseMemberFormData, memberController.updateMember);

router.delete("/:id", protect, memberController.deleteMember);

module.exports = router;