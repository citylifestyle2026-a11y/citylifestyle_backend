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
router.put("/design/photo-box", controller.savePhotoBox);
router.delete("/design", controller.removeDesign);

// GUEST CARD design (separate from the invitation card design above): the picture
// guests add their own photo + name to, and where the photo / name go on it.
router.get("/guest-design", controller.guestDesignInfo);
router.get("/guest-design/image", controller.guestDesignImage);
router.post("/guest-design", upload.designUpload.single("design"), controller.guestUploadDesign);
router.put("/guest-design/style", controller.guestSaveNameStyle);
router.put("/guest-design/photo-box", controller.guestSavePhotoBox);
router.delete("/guest-design", controller.guestRemoveDesign);

router.post("/", controller.create);
router.put("/:id", controller.update);
router.post("/import-csv", upload.csvUpload.single("file"), controller.importCsv);
router.post("/send", controller.send);
router.post("/reset-stuck", controller.resetStuck);
router.post("/delete", controller.remove);

module.exports = router;