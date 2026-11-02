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
const caches = {}; // one cache per design key ("default" / "guest")

const isGuest = (key) => key === "guest";
const nameBase = (key) => (isGuest(key) ? cfg.GUEST.NAME : cfg.NAME);

const getDesignAndStyle = async (key = "default") => {
  const meta = await InviteDesign.findOne({ key })
    .select("updatedAt nameStyle photoBox width height image")
    .lean();

  const hasUpload = Boolean(meta && meta.image && meta.image.length);
  const cacheKey = hasUpload ? `db:${new Date(meta.updatedAt).getTime()}` : "fallback";

  // The guest card has NO placeholder: until the admin uploads its design it is "not ready".
  if (!hasUpload && isGuest(key)) {
    throw new AppError("The card is not ready yet. Please try later.", 404);
  }

  const cache = caches[key];
  if (!cache || !cache.design || cache.key !== cacheKey) {
    caches[key] = {
      key: cacheKey,
      design: hasUpload ? Buffer.from(meta.image.buffer || meta.image) : await loadFallbackDesign(),
    };
  }

  return { design: caches[key].design, saved: (meta && meta.nameStyle) || {}, hasUpload };
};

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const HEX = /^#[0-9a-f]{6}$/i;

// default < saved by admin < temporary override (live preview sliders)
const resolveStyle = (saved = {}, override = {}, base = cfg.NAME) => {
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

// ---------- auto font size by name length ----------
// Slider = size for a name of up to NAME_LEN_NORMAL characters.
//   (15 chars)
//   shorter name -> a bit bigger (max NAME_BOOST_MAX x)
//   longer name  -> smaller, in proportion (never below NAME_SCALE_MIN x)
const NAME_LEN_NORMAL = 15;
const NAME_BOOST_MAX = 1.15;
const NAME_SCALE_MIN = 0.65;

const nameLengthScale = (name) => {
  const len = Array.from(String(name || "").trim()).length; // counts Gujarati/Hindi letters correctly
  if (!len) return 1;
  // square root = gentle shrink, so long names stay readable
  return Math.min(NAME_BOOST_MAX, Math.max(NAME_SCALE_MIN, Math.sqrt(NAME_LEN_NORMAL / len)));
};

// Returns a JPEG buffer (WhatsApp image headers accept JPG/PNG, not WebP).
//
// The name is ALWAYS centred on the spot the admin chose (style.centerXPct).
// Fitting a long name:
//   1. fits on one line            -> written at the full chosen size
//   2. too wide but has spaces     -> wrapped onto 2-3 centred lines, still full size
//   3. too wide and a single word  -> shrunk only as much as needed to fit
const generateCard = async (rawName, styleOverride = {}, baseImage = null, key = "default") => {
  const name = String(rawName || "").replace(/\s+/g, " ").trim() || "Guest";
  const { design: fixedDesign, saved } = await getDesignAndStyle(key);
  // baseImage = the design with the guest's photo already on it (name is drawn on top).
  const design = baseImage || fixedDesign;
  const { width: W, height: H } = await sharp(design).metadata();
  const style = resolveStyle(saved, styleOverride, nameBase(key));
  const n = nameBase(key);

  const baseSize = Math.max(
    8,
    Math.round(((W * style.fontSizePct) / 100) * nameLengthScale(name))
  );
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
  // Use the UNSCALED size here: the admin clicked the centre using the slider
  // size, so the centre must stay put however much the name was scaled.
  const sliderSize = Math.max(8, Math.round((W * style.fontSizePct) / 100));
  const idealBoxHeight = sliderSize * 1.5;
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

// ---------- photo box (where the guest's own photo goes) ----------
// Guest card only: where the guest's photo goes (defaults fit parv_template_card.jpg).
const DEFAULT_PHOTO_BOX = cfg.GUEST.PHOTO_BOX;

const resolvePhotoBox = (saved = {}, override = {}) => {
  const pick = (field) =>
    override[field] !== undefined && override[field] !== null && override[field] !== ""
      ? override[field]
      : saved && saved[field] !== undefined && saved[field] !== null
      ? saved[field]
      : DEFAULT_PHOTO_BOX[field];

  const wPct = clamp(pick("wPct"), 5, 100, DEFAULT_PHOTO_BOX.wPct);
  const hPct = clamp(pick("hPct"), 5, 100, DEFAULT_PHOTO_BOX.hPct);
  return {
    wPct,
    hPct,
    xPct: clamp(pick("xPct"), 0, 100 - wPct, DEFAULT_PHOTO_BOX.xPct),
    yPct: clamp(pick("yPct"), 0, 100 - hPct, DEFAULT_PHOTO_BOX.yPct),
    shape: pick("shape") === "rect" ? "rect" : "circle",
  };
};

// ---------- the GUEST card: design + the guest's photo + the guest's name ----------
// Used by the public "guest card" link: the guest uploads a photo and types a
// name; the photo is cropped to fill the admin's photo box (circle or
// rectangle) and the name goes where the admin placed it.
const generateGuestCard = async (rawName, photoBuffer) => {
  if (!photoBuffer) return generateCard(rawName, {}, null, "guest");

  const { design, saved } = await getDesignAndStyle("guest");
  const { width: W, height: H } = await sharp(design).metadata();
  const box = resolvePhotoBox(saved.photoBox || {});

  const bw = Math.max(20, Math.round((W * box.wPct) / 100));
  const bh = Math.max(20, Math.round((H * box.hPct) / 100));
  const left = Math.min(W - bw, Math.max(0, Math.round((W * box.xPct) / 100)));
  const top = Math.min(H - bh, Math.max(0, Math.round((H * box.yPct) / 100)));

  let photo;
  try {
    photo = await sharp(photoBuffer)
      .rotate() // phone photos: honour EXIF orientation
      .resize(bw, bh, { fit: "cover", position: "attention" })
      .png()
      .toBuffer();

    if (box.shape === "circle") {
      const mask = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${bh}">` +
          `<ellipse cx="${bw / 2}" cy="${bh / 2}" rx="${bw / 2}" ry="${bh / 2}" fill="#fff"/></svg>`
      );
      photo = await sharp(photo).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
    }
  } catch {
    throw new AppError("This photo could not be read. Please upload a JPG or PNG.", 400);
  }

  // Photo first, name on top - so the name is never hidden behind the photo.
  const withPhoto = await sharp(design)
    .flatten({ background: "#ffffff" })
    .composite([{ input: photo, left, top }])
    .png()
    .toBuffer();

  return generateCard(rawName, {}, withPhoto, "guest");
};

// Safe info for the public page (no admin data).
const publicInfo = async () => {
  const info = await designInfo("guest");
  return {
    hasDesign: info.hasDesign,
    width: info.width,
    height: info.height,
    photoBox: info.photoBox,
    nameStyle: info.nameStyle, // so the public page can show the name live on the card
    version: info.updatedAt ? new Date(info.updatedAt).getTime() : 0, // cache-buster for the picture
  };
};

// The blank design (no photo / name) for the public page's live preview.
// Downsized: it is only shown on screen; the download is generated at full size.
const previewDesign = async () => {
  const { design } = await getDesignAndStyle("guest");
  return sharp(design)
    .resize({ width: 1200, withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
};

const savePhotoBox = async (body = {}, adminId, key = "guest") => {
  const box = resolvePhotoBox({}, body);
  await InviteDesign.findOneAndUpdate(
    { key },
    { $set: { photoBox: box, updatedBy: adminId || undefined } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return designInfo(key);
};

// ---------- admin: design upload / position ----------
const designInfo = async (key = "default") => {
  const doc = await InviteDesign.findOne({ key })
    .select("width height originalName updatedAt nameStyle photoBox image")
    .lean();
  const hasDesign = Boolean(doc && doc.image && doc.image.length);

  return {
    hasDesign,
    width: hasDesign ? doc.width : 0,
    height: hasDesign ? doc.height : 0,
    originalName: hasDesign ? doc.originalName : "",
    updatedAt: hasDesign ? doc.updatedAt : null,
    nameStyle: resolveStyle((doc && doc.nameStyle) || {}, {}, nameBase(key)),
    photoBox: resolvePhotoBox((doc && doc.photoBox) || {}),
    defaults: resolveStyle({}, {}, nameBase(key)),
    defaultPhotoBox: { ...DEFAULT_PHOTO_BOX },
  };
};

// multer file -> normalised JPEG stored in MongoDB.
const saveDesign = async (file, adminId, key = "default") => {
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
    { key },
    {
      $set: {
        image: jpeg,
        width: info.width,
        height: info.height,
        originalName: String(file.originalname || "").slice(0, 120),
        // A different design needs the name somewhere else: start from the
        // defaults and let the admin click the spot (Invitation Cards page).
        nameStyle: { centerXPct: null, topPct: null, fontSizePct: null, color: null },
        photoBox: { xPct: null, yPct: null, wPct: null, hPct: null, shape: null },
        updatedBy: adminId || undefined,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  delete caches[key];
  return designInfo(key);
};

const saveNameStyle = async (body = {}, adminId, key = "default") => {
  const style = resolveStyle({}, body, nameBase(key));
  await InviteDesign.findOneAndUpdate(
    { key },
    { $set: { nameStyle: style, updatedBy: adminId || undefined } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return designInfo(key);
};

// Invitation: back to the built-in placeholder card. Guest card: "not ready" again.
const removeDesign = async (key = "default") => {
  await InviteDesign.findOneAndUpdate(
    { key },
    { $set: { image: null, width: 0, height: 0, originalName: "" } }
  );
  delete caches[key];
  return designInfo(key);
};

module.exports = {
  generateCard,
  generateGuestCard,
  publicInfo,
  previewDesign,
  savePhotoBox,
  designInfo,
  saveDesign,
  saveNameStyle,
  removeDesign,
};