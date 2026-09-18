const express = require("express");
const router = express.Router();

const userController = require("../controllers/user.controller");
const { protect } = require("../middlewares/auth.middleware");
const upload = require("../middlewares/upload.middleware");
const {
  createUserValidation,
  updateUserValidation,
  validate,
} = require("../validators/user.validator");

// Create User
// Uses the 100 MB image upload middleware (middlewares/upload.middleware.js),
// same as Admin profile and Registration photo uploads — the file is
// re-encoded to WEBP and compressed by uploadToLocal before it's ever
// written to disk.
router.post(
  "/",
  protect,
  upload.largeImageUpload.single("profileImage"),
  createUserValidation,
  validate,
  userController.createUser
);
// get users
router.get(
  "/",
  protect,
  userController.getUsers
);
//update user
// Same 100 MB image upload middleware as Create User above.
router.put(
  "/:id",
  protect,
  upload.largeImageUpload.single("profileImage"),
  updateUserValidation,
  validate,
  userController.updateUser
);
// delete users
router.delete(
  "/:id",
  protect,
  userController.deleteUser
);
module.exports = router;