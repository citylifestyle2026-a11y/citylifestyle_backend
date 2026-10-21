// services/inviteCard.service.js
//
// Draws the invitation card: the fixed design image + the guest's name.
// Uses sharp's text rendering with the bundled Poppins font file, so it
// does not depend on fonts installed on the server.
const fs = require("fs");
const sharp = require("sharp");
const cfg = require("../config/inviteDesign");
const InviteDesign = require("../models/inviteDesign.model");
const AppError = require("../utils/AppError");

const escapeMarkup = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// ---------- placeholder design (used until the real design is added) ----------
const buildPlaceholderDesign = async () => {
  const W = 1080;
  const H = 1350;

  const background = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#14213D"/>
          <stop offset="1" stop-color="#0B1020"/>
        </linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#g)"/>
      <rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="28"
            fill="none" stroke="#C9A24B" stroke-width="4"/>
      <rect x="64" y="64" width="${W - 128}" height="${H - 128}" rx="20"
            fill="none" stroke="#C9A24B" stroke-opacity="0.45" stroke-width="2"/>
      <line x1="340" y1="470" x2="740" y2="470" stroke="#C9A24B" stroke-width="3"/>
      <line x1="340" y1="800" x2="740" y2="800" stroke="#C9A24B" stroke-opacity="0.6" stroke-width="2"/>
    </svg>`);

  const text = (markup, size, width) =>
    sharp({
      text: {
        text: markup,
        font: `${cfg.FONT_FAMILY} ${size}`,
        fontfile: cfg.FONT_FILE,
        width,
        align: "center",
        rgba: true,
        dpi: 72,
      },
    })
      .png()
      .toBuffer();

  const title = await text(
    '<span foreground="#C9A24B">YOU ARE INVITED</span>',
    62,
    900
  );
  const sub = await text(
    '<span foreground="#E8E8EE">Dear</span>',
    40,
    600
  );
  const foot = await text(
    '<span foreground="#E8E8EE">We would be delighted to have you with us.</span>',
    34,
    860
  );

  const placeCentered = async (buf, top) => {
    const { width } = await sharp(buf).metadata();
    return { input: buf, left: Math.round((W - width) / 2), top };
  };

  return sharp(background)
    .composite([
      await placeCentered(title, 330),
      await placeCentered(sub, 520),
      await placeCentered(foot, 860),
    ])
    .png()
    .toBuffer();
};

// ---------- the design: uploaded by the admin (MongoDB) -> file -> placeholder ----------
const loadFallbackDesign = async () => {
  if (fs.existsSync(cfg.DESIGN_FILE)) {
    return sharp(cfg.DESIGN_FILE).rotate().png().toBuffer();
  }
  return buildPlaceholderDesign();
};

// Cache the (read-only) design between cards so sending to hundreds of
// guests does not re-read / re-draw it every time. One tiny query per card
// checks `updatedAt`, so a new upload is picked up immediately.
let cache = { key: "", design: null };

const getDesignAndStyle = async () => {
  const meta = await InviteDesign.findOne({ key: "default" })
    .select("updatedAt nameStyle width height image")
    .lean();

  const hasUpload = Boolean(meta && meta.image && meta.image.length);
  const key = hasUpload ? `db:${new Date(meta.updatedAt).getTime()}` : "fallback";

  if (!cache.design || cache.key !== key) {
    cache = {
      key,
      design: hasUpload ? Buffer.from(meta.image.buffer || meta.image) : await loadFallbackDesign(),
    };
  }

  return { design: cache.design, saved: (meta && meta.nameStyle) || {}, hasUpload };
};

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const HEX = /^#[0-9a-f]{6}$/i;

// default < saved by admin < temporary override (live preview sliders)
const resolveStyle = (saved = {}, override = {}) => {
  const base = cfg.NAME;
  const pick = (field) =>
    override[field] !== undefined && override[field] !== null && override[field] !== ""
      ? override[field]
      : saved[field] !== undefined && saved[field] !== null
      ? saved[field]
      : base[field];

  const color = String(pick("color"));
  return {
    centerXPct: clamp(pick("centerXPct"), 0, 100, base.centerXPct),
    topPct: clamp(pick("topPct"), 0, 100, base.topPct),
    fontSizePct: clamp(pick("fontSizePct"), 1, 15, base.fontSizePct),
    color: HEX.test(color) ? color : base.color,
  };
};

// ---------- the card: design + name ----------
// Draws the name and cuts away the empty margin around the letters, so the
// VISIBLE text can be centred exactly (a long name used to look pushed to one
// side because of that margin).
const renderName = async (text, color, fontSize, { width, wrap = "none" } = {}) => {
  const input = await sharp({
    text: {
      text: `<span foreground="${color}">${escapeMarkup(text)}</span>`,
      font: `${cfg.FONT_FAMILY} ${fontSize}`,
      fontfile: cfg.FONT_FILE,
      ...(width ? { width } : {}),
      wrap,
      align: "center",
      rgba: true,
      dpi: 72,
    },
  })
    .png()
    .toBuffer();

  try {
    const { data, info } = await sharp(input)
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
      .png()
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  } catch {
    const meta = await sharp(input).metadata();
    return { buffer: input, width: meta.width, height: meta.height };
  }
};

// Returns a JPEG buffer (WhatsApp image headers accept JPG/PNG, not WebP).
//
// The name is ALWAYS centred on the spot the admin chose (style.centerXPct).
// Fitting a long name:
//   1. fits on one line            -> written at the full chosen size
//   2. too wide but has spaces     -> wrapped onto 2-3 centred lines, still full size
//   3. too wide and a single word  -> shrunk only as much as needed to fit
const generateCard = async (rawName, styleOverride = {}) => {
  const name = String(rawName || "").replace(/\s+/g, " ").trim() || "Guest";
  const { design, saved } = await getDesignAndStyle();
  const { width: W, height: H } = await sharp(design).metadata();
  const style = resolveStyle(saved, styleOverride);
  const n = cfg.NAME;

  const baseSize = Math.max(8, Math.round((W * style.fontSizePct) / 100));
  const maxWidth = Math.round((W * n.maxWidthPct) / 100);

  let text = await renderName(name, style.color, baseSize);

  if (text.width > maxWidth) {
    let fitted = false;

    if (/\s/.test(name)) {
      const wrapped = await renderName(name, style.color, baseSize, {
        width: maxWidth,
        wrap: "word",
      });
      if (wrapped.width <= maxWidth && wrapped.height <= baseSize * 1.5 * 3) {
        text = wrapped;
        fitted = true;
      }
    }

    if (!fitted) {
      let size = baseSize;
      for (let i = 0; i < 4 && text.width > maxWidth; i += 1) {
        size = Math.max(8, Math.floor(size * Math.min(0.98, maxWidth / text.width)));
        text = await renderName(name, style.color, size);
        if (size <= 8) break;
      }
    }
  }

  // The admin's spot is the CENTRE of the name: horizontally on centerXPct,
  // vertically in the middle of a normal one-line box that starts at topPct.
  const idealBoxHeight = baseSize * 1.5;
  const left = Math.min(
    Math.max(0, W - text.width),
    Math.max(0, Math.round((W * style.centerXPct) / 100 - text.width / 2))
  );
  const top = Math.min(
    Math.max(0, H - text.height),
    Math.max(0, Math.round((H * style.topPct) / 100 + (idealBoxHeight - text.height) / 2))
  );

  return sharp(design)
    .flatten({ background: "#ffffff" })
    .composite([{ input: text.buffer, left, top }])
    .jpeg({ quality: 90 })
    .toBuffer();
};

// ---------- admin: design upload / position ----------
const designInfo = async () => {
  const doc = await InviteDesign.findOne({ key: "default" })
    .select("width height originalName updatedAt nameStyle image")
    .lean();
  const hasDesign = Boolean(doc && doc.image && doc.image.length);

  return {
    hasDesign,
    width: hasDesign ? doc.width : 0,
    height: hasDesign ? doc.height : 0,
    originalName: hasDesign ? doc.originalName : "",
    updatedAt: hasDesign ? doc.updatedAt : null,
    nameStyle: resolveStyle((doc && doc.nameStyle) || {}),
    defaults: resolveStyle({}),
  };
};

// multer file -> normalised JPEG stored in MongoDB.
const saveDesign = async (file, adminId) => {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new AppError("Please choose the invitation card image (JPG or PNG).", 400);
  }

  let jpeg;
  let info;
  try {
    const out = await sharp(file.buffer)
      .rotate() // honour the phone's EXIF orientation
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92 })
      .toBuffer({ resolveWithObject: true });
    jpeg = out.data;
    info = out.info;
  } catch {
    throw new AppError("This file is not a readable image. Please upload a JPG or PNG.", 400);
  }

  if (info.width < 300 || info.height < 300) {
    throw new AppError("The image is too small. Use at least 300 x 300 pixels.", 400);
  }

  await InviteDesign.findOneAndUpdate(
    { key: "default" },
    {
      $set: {
        image: jpeg,
        width: info.width,
        height: info.height,
        originalName: String(file.originalname || "").slice(0, 120),
        // A different design needs the name somewhere else: start from the
        // defaults and let the admin click the spot (Invitation Cards page).
        nameStyle: { centerXPct: null, topPct: null, fontSizePct: null, color: null },
        updatedBy: adminId || undefined,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  cache = { key: "", design: null };
  return designInfo();
};

const saveNameStyle = async (body = {}, adminId) => {
  const style = resolveStyle({}, body);
  await InviteDesign.findOneAndUpdate(
    { key: "default" },
    { $set: { nameStyle: style, updatedBy: adminId || undefined } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return designInfo();
};

// Back to the built-in placeholder card.
const removeDesign = async () => {
  await InviteDesign.findOneAndUpdate(
    { key: "default" },
    { $set: { image: null, width: 0, height: 0, originalName: "" } }
  );
  cache = { key: "", design: null };
  return designInfo();
};

module.exports = { generateCard, designInfo, saveDesign, saveNameStyle, removeDesign };