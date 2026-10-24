const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const upload = require("../middlewares/upload.middleware");
const crewController = require("../controllers/crew.controller");
const {
  createCrewValidation,
  updateCrewValidation,
  validate,
} = require("../validators/crew.validator");

// Static paths first, so Express never reads them as an "/:id".
router.post("/create", protect, createCrewValidation, validate, crewController.createCrew);
router.get("/get-all-crew", protect, crewController.getAllCrew);
router.get("/export", protect, crewController.exportCrew);
router.get("/import-template", protect, crewController.importTemplate);
router.post("/import", protect, upload.spreadsheetUpload.single("file"), crewController.importCrew);
router.post("/bulk-delete", protect, crewController.bulkDeleteCrew);
router.post("/send-pass", protect, crewController.sendPass);
router.post("/resend-pass", protect, crewController.resendPass);
router.post("/cancel-pass", protect, crewController.cancelPass);
router.put("/bulk-status", protect, crewController.bulkUpdateStatus);

router.get("/:id", protect, crewController.getCrewById);
router.put("/:id/update", protect, updateCrewValidation, validate, crewController.updateCrew);
router.delete("/:id/delete", protect, crewController.deleteCrew);

module.exports = router;
