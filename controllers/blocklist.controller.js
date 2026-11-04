const blocklistService = require("../services/blocklist.service");

const createBlock = async (req, res, next) => {
  try {
    const data = await blocklistService.createBlock(req.body, req.user);
    return res.status(201).json({ success: true, message: "Person blocked successfully", data });
  } catch (error) {
    next(error);
  }
};

const listBlocks = async (req, res, next) => {
  try {
    const { items, pagination } = await blocklistService.listBlocks(req.query);
    return res.status(200).json({ success: true, data: items, pagination });
  } catch (error) {
    next(error);
  }
};

const updateBlock = async (req, res, next) => {
  try {
    const data = await blocklistService.updateBlock(req.params.id, req.body);
    return res.status(200).json({ success: true, message: "Block updated successfully", data });
  } catch (error) {
    next(error);
  }
};

const removeBlock = async (req, res, next) => {
  try {
    const { movedToPending } = await blocklistService.removeBlock(
      req.params.id,
      req.query.number || null
    );
    return res.status(200).json({
      success: true,
      message: movedToPending
        ? `Person unblocked - ${movedToPending} guest${movedToPending === 1 ? "" : "s"} moved to Pending`
        : "Person unblocked successfully",
      movedToPending,
    });
  } catch (error) {
    next(error);
  }
};

// Quick check used by forms: GET /api/blocklist/check?mobile=...
const checkBlock = async (req, res, next) => {
  try {
    const data = await blocklistService.findBlockedByNumber(req.query.mobile);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

module.exports = { createBlock, listBlocks, updateBlock, removeBlock, checkBlock };
