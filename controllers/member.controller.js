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
    const updated = result.updatedCount || 0;
    const newOnes = result.successCount - updated;
    const message = dryRun
      ? `Processed ${result.totalRows} row(s): ${newOnes} new, ${updated} to update, ${result.failureCount} invalid`
      : mode === "all"
      ? `${newOnes} contact(s) added, ${updated} updated, ${result.flaggedCount} need fixing (see Needs Fix tab)`
      : `Processed ${result.totalRows} row(s): ${newOnes} contact(s) added, ${updated} updated, ${result.failureCount} failed`;

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
    const member = await memberService.createMember(req.body, req.user.id, req.files);
    return res.status(201).json({
      success: true,
      message: "Contact added successfully",
      data: member,
    });
  } catch (error) {
    next(error);
  }
};

const updateMember = async (req, res, next) => {
  try {
    const member = await memberService.updateMember(req.params.id, req.body, req.files);
    return res.status(200).json({
      success: true,
      message: "Contact updated successfully",
      data: member,
    });
  } catch (error) {
    next(error);
  }
};

const deleteMember = async (req, res, next) => {
  try {
    await memberService.deleteMember(req.params.id);
    return res.status(200).json({ success: true, message: "Contact deleted successfully" });
  } catch (error) {
    next(error);
  }
};

// POST /members/bulk-delete  { ids } | { selectAll: true, filters }
const bulkDeleteNeedsFix = async (req, res, next) => {
  try {
    return res.status(200).json(await memberService.deleteNeedsFixMembers(req.body));
  } catch (error) {
    next(error);
  }
};

// GET /members/export?moved=needsFix&fixType=invalid        -> .csv download
// GET /members/export?format=xlsx&moved=inGuestList&...     -> .xlsx download
// Any list filter (search, profession, reference, moved, fixType) works,
// and `ids=a,b,c` exports only the ticked rows.
const exportMembers = async (req, res, next) => {
  try {
    const moved = String(req.query.moved || "");
    const type = String(req.query.fixType || "").toLowerCase();

    if (String(req.query.format || "").toLowerCase() === "xlsx") {
      const { buffer } = await memberService.exportMembersXlsx(req.query);
      const tab = { needsFix: "needs-fix", inGuestList: "in-guest-list", notInGuestList: "not-in-guest-list" }[moved];
      const parts = ["contact-book", tab, moved === "needsFix" ? type : "", new Date().toISOString().slice(0, 10)];
      const fileName = `${parts.filter(Boolean).join("-")}.xlsx`;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      return res.status(200).send(Buffer.from(buffer));
    }

    const { csv } = await memberService.exportMembersCsv(req.query);
    const name = moved === "needsFix" ? `members-needs-fix${type ? `-${type}` : ""}` : "members";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
    return res.status(200).send(csv);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  bulkDeleteNeedsFix,
  exportMembers,
  getAllMembers,
  getProfessions,
  getReferences,
  importMembers,
  moveToGuestList,
  createMember,
  updateMember,
  deleteMember,
};