const crewService = require("../services/crew.service");

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

const createCrew = wrap(async (req, res) => {
  const crew = await crewService.createCrew(req.body, req.user.id);
  res.status(201).json({ success: true, message: "Crew member created successfully", data: crew });
});

const getAllCrew = wrap(async (req, res) => {
  const result = await crewService.getAllCrew(req.query);
  res.status(200).json({
    success: true,
    message: result.message,
    data: result.data,
    counts: result.counts,
    pagination: result.pagination,
  });
});

const getCrewById = wrap(async (req, res) => {
  const crew = await crewService.getCrewById(req.params.id);
  res.status(200).json({ success: true, message: "Crew member fetched successfully", data: crew });
});

const updateCrew = wrap(async (req, res) => {
  const crew = await crewService.updateCrew(req.params.id, req.body);
  res.status(200).json({ success: true, message: "Crew member updated successfully", data: crew });
});

const deleteCrew = wrap(async (req, res) => {
  await crewService.deleteCrew(req.params.id, req.user.id);
  res.status(200).json({ success: true, message: "Crew member deleted successfully" });
});

const bulkDeleteCrew = wrap(async (req, res) => {
  res.status(200).json(await crewService.bulkDeleteCrew(req.body, req.user.id));
});

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const exportCrew = wrap(async (req, res) => {
  const { buffer } = await crewService.exportCrewXlsx(req.query);
  res.setHeader("Content-Type", XLSX_TYPE);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="crew-${new Date().toISOString().slice(0, 10)}.xlsx"`
  );
  res.status(200).send(Buffer.from(buffer));
});

const importTemplate = wrap(async (req, res) => {
  const buffer = await crewService.buildImportTemplate();
  res.setHeader("Content-Type", XLSX_TYPE);
  res.setHeader("Content-Disposition", 'attachment; filename="crew-import-sample.xlsx"');
  res.status(200).send(Buffer.from(buffer));
});

const importCrew = wrap(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "Please choose a .xlsx or .csv file." });
  }
  const result = await crewService.importCrew(req.file.buffer, req.file.originalname, req.user.id, {
    dryRun: req.query.dryRun === "true",
  });
  res.status(200).json(result);
});

const sendPass = wrap(async (req, res) => {
  res.status(200).json(await crewService.sendPassToCrew(req.body, req.user.id));
});

const resendPass = wrap(async (req, res) => {
  const result = await crewService.resendPassToCrew(req.body);
  res.status(result.success ? 200 : 400).json(result);
});

const cancelPass = wrap(async (req, res) => {
  const result = await crewService.cancelPassesOfCrew(req.body, req.user.id);
  res.status(result.success ? 200 : 400).json(result);
});

const bulkUpdateStatus = wrap(async (req, res) => {
  res.status(200).json(await crewService.bulkUpdateCrewStatus(req.body, req.user.id));
});

module.exports = {
  createCrew,
  getAllCrew,
  getCrewById,
  updateCrew,
  deleteCrew,
  bulkDeleteCrew,
  exportCrew,
  importTemplate,
  importCrew,
  sendPass,
  resendPass,
  cancelPass,
  bulkUpdateStatus,
};
