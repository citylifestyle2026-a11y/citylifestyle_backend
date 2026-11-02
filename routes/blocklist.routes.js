const express = require("express");
const router = express.Router();

const { protect } = require("../middlewares/auth.middleware");
const authorize = require("../middlewares/authorize.middleware");
const controller = require("../controllers/blocklist.controller");

// Block List: ADMIN accounts only (staff users / checkers get 403).
router.use(protect, authorize("admin"));

router.get("/check", controller.checkBlock);
router.get("/", controller.listBlocks);
router.post("/", controller.createBlock);
router.put("/:id", controller.updateBlock);
router.delete("/:id", controller.removeBlock);

module.exports = router;