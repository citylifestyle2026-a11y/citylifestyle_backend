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

// POST /api/members/import  (?dryRun=true only checks the file)
const importMembers = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "File is required" });
    }

    const dryRun = String(req.query.dryRun || "") === "true";
    const result = await memberService.importMembers(
      req.file.buffer,
      req.file.originalname,
      req.user.id,
      { dryRun }
    );

    return res.status(200).json({
      success: dryRun || result.successCount > 0,
      message: `Processed ${result.totalRows} row(s): ${result.successCount} ${
        dryRun ? "ready to import" : "member(s) added"
      }, ${result.duplicateCount} duplicate(s) skipped, ${result.failureCount} failed`,
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
  importMembers,
  moveToGuestList,
  deleteMember,
};
