const memberService = require("../services/member.service");

const getAllMembers = async (req, res, next) => {
  try {
    return res.status(200).json(await memberService.getAllMembers(req.query));
  } catch (error) {
    next(error);
  }
};

const getProfessions = async (req, res, next) => {
  try {
    const data = await memberService.getMemberProfessions();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

const getReferences = async (req, res, next) => {
  try {
    const data = await memberService.getMemberReferences();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// POST /api/members/import  (?dryRun=true only checks the file)
const importMembers = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "File is required" });
    }

    const dryRun = String(req.query.dryRun || "") === "true";
    // ?mode=all saves every row (duplicate / invalid ones flagged "Needs Fix").
    const mode = String(req.query.mode || "") === "all" ? "all" : "valid";
    const result = await memberService.importMembers(
      req.file.buffer,
      req.file.originalname,
      req.user.id,
      { dryRun, mode }
    );

    const added = result.successCount + (result.flaggedCount || 0);
    const message = dryRun
      ? `Processed ${result.totalRows} row(s): ${result.successCount} ready to import, ${result.duplicateCount} duplicate(s), ${result.failureCount} invalid`
      : mode === "all"
      ? `${added} member(s) added, ${result.flaggedCount} of them need fixing (see Needs Fix tab)`
      : `Processed ${result.totalRows} row(s): ${result.successCount} member(s) added, ${result.duplicateCount} duplicate(s) skipped, ${result.failureCount} failed`;

    return res.status(200).json({
      success: dryRun || added > 0,
      message,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

const moveToGuestList = async (req, res, next) => {
  try {
    const result = await memberService.moveMembersToGuestList(req.body, req.user.id);
    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const createMember = async (req, res, next) => {
  try {
    const member = await memberService.createMember(req.body, req.user.id);
    return res.status(201).json({
      success: true,
      message: "Member added successfully",
      data: member,
    });
  } catch (error) {
    next(error);
  }
};

const updateMember = async (req, res, next) => {
  try {
    const member = await memberService.updateMember(req.params.id, req.body);
    return res.status(200).json({
      success: true,
      message: "Member updated successfully",
      data: member,
    });
  } catch (error) {
    next(error);
  }
};

const deleteMember = async (req, res, next) => {
  try {
    await memberService.deleteMember(req.params.id);
    return res.status(200).json({ success: true, message: "Member deleted successfully" });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllMembers,
  getProfessions,
  getReferences,
  importMembers,
  moveToGuestList,
  createMember,
  updateMember,
  deleteMember,
};
