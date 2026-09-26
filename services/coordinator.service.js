const User = require("../models/user.model");
const AppError = require("../utils/AppError");
const { normalizeMobileSearchTerm } = require("../utils/normalizeMobileNumber");

// PARV CRM Phase 2 — Coordinator account management.
//
// Deliberately a SEPARATE service from services/user.service.js rather
// than an extension of it: user.service.js's createUser/getUsers/
// updateUser hardcode role:"checker" and the Checker-specific
// permissions list at several points, and that file backs the existing,
// already-working User Management feature. Duplicating the small CRUD
// shape here (same conventions: AppError, mobile/email uniqueness
// checks, pagination) keeps Checker behavior completely unchanged while
// still storing Coordinators in the same User collection, so the
// existing login endpoint / protect middleware / authorize("coordinator")
// all work with zero changes.

// ================= CREATE COORDINATOR =================
const createCoordinator = async (admin, data) => {
  if (!admin || admin.role !== "admin") {
    throw new AppError("Only Admin can create coordinators", 403);
  }

  const { name, mobile, password, confirmPassword } = data;
  const email = data.email?.trim() || null;

  if (!name || !mobile || !password || !confirmPassword) {
    throw new AppError("All required fields are mandatory", 400);
  }

  if (password !== confirmPassword) {
    throw new AppError("Password and Confirm Password do not match", 400);
  }

  const mobileExist = await User.findOne({ mobile, status: "active" });

  if (mobileExist) {
    throw new AppError("Mobile already exists", 409);
  }

  if (email) {
    const emailExist = await User.findOne({ email, status: "active" });

    if (emailExist) {
      throw new AppError("Email already exists", 409);
    }
  }

  const coordinator = await User.create({
    name,
    mobile,
    email,
    password,
    role: "coordinator",
    createdBy: admin._id,
  });

  return coordinator;
};

// ================= GET ALL COORDINATORS =================
const getCoordinators = async (query) => {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 10;
  // A full number typed as "+91 98765 43210" / "919876543210" still
  // finds the 10-digit stored mobile.
  const search = normalizeMobileSearchTerm(query.search || "");

  const skip = (page - 1) * limit;

  const filter = {
    role: "coordinator",
    status: "active",
  };

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { mobile: { $regex: search, $options: "i" } },
    ];
  }

  const coordinators = await User.find(filter)
    .select("-password")
    .populate("createdBy", "name")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await User.countDocuments(filter);

  return {
    coordinators,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

// ================= GET COORDINATOR BY ID =================
const getCoordinatorById = async (id) => {
  const coordinator = await User.findOne({ _id: id, role: "coordinator" }).select(
    "-password"
  );

  if (!coordinator) {
    throw new AppError("Coordinator not found", 404);
  }

  return coordinator;
};

// ================= UPDATE COORDINATOR =================
const updateCoordinator = async (id, data) => {
  const { name, mobile, email, password, status } = data;

  const coordinator = await User.findOne({ _id: id, role: "coordinator" });

  if (!coordinator) {
    throw new AppError("Coordinator not found", 404);
  }

  if (mobile && mobile !== coordinator.mobile) {
    const mobileExists = await User.findOne({
      mobile,
      _id: { $ne: id },
    });

    if (mobileExists) {
      throw new AppError("Mobile already exists", 409);
    }
  }

  if (email && email !== coordinator.email) {
    const emailExists = await User.findOne({
      email,
      _id: { $ne: id },
    });

    if (emailExists) {
      throw new AppError("Email already exists", 409);
    }
  }

  const updatedCoordinator = await User.findByIdAndUpdate(
    id,
    {
      name,
      mobile,
      email,
      status,
      ...(password && { password }),
    },
    {
      new: true,
      runValidators: true,
    }
  ).select("-password");

  return updatedCoordinator;
};

// ================= DELETE COORDINATOR =================
const deleteCoordinator = async (id) => {
  const coordinator = await User.findOne({ _id: id, role: "coordinator" });

  if (!coordinator) {
    throw new AppError("Coordinator not found", 404);
  }

  await User.findByIdAndDelete(id);

  return coordinator;
};

module.exports = {
  createCoordinator,
  getCoordinators,
  getCoordinatorById,
  updateCoordinator,
  deleteCoordinator,
};
