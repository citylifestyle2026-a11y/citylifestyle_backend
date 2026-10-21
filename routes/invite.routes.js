const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const authorize = require("../middlewares/authorize.middleware");
const upload = require("../middlewares/upload.middleware");
const controller = require("../controllers/invite.controller");

// Admin only.
router.use(protect, authorize("admin"));

router.get("/", controller.list);
router.get("/preview", controller.preview);

// Card design: upload the JPG/PNG once, set where the name goes.
router.get("/design", controller.designInfo);
router.post("/design", upload.designUpload.single("design"), controller.uploadDesign);
router.put("/design/style", controller.saveNameStyle);
router.delete("/design", controller.removeDesign);

router.post("/", controller.create);
router.put("/:id", controller.update);
router.post("/import-csv", upload.csvUpload.single("file"), controller.importCsv);
router.post("/send", controller.send);
router.post("/reset-stuck", controller.resetStuck);
router.post("/delete", controller.remove);

module.exports = router;
