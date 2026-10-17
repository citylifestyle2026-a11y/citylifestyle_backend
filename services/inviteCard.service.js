// services/inviteCard.service.js
//
// Draws the invitation card: the fixed design image + the guest's name.
// Uses sharp's text rendering with the bundled Poppins font file, so it
// does not depend on fonts installed on the server.
const fs = require("fs");
const sharp = require("sharp");
const cfg = require("../config/inviteDesign");

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

const loadDesign = async () => {
  if (fs.existsSync(cfg.DESIGN_FILE)) {
    return sharp(cfg.DESIGN_FILE).rotate().png().toBuffer();
  }
  return buildPlaceholderDesign();
};

// Cache the (read-only) design between cards so sending to hundreds of
// guests does not re-read / re-draw it every time.
let cachedDesign = null;
let cachedKey = "";

const getDesign = async () => {
  const exists = fs.existsSync(cfg.DESIGN_FILE);
  const key = exists ? `${cfg.DESIGN_FILE}:${fs.statSync(cfg.DESIGN_FILE).mtimeMs}` : "placeholder";

  if (!cachedDesign || cachedKey !== key) {
    cachedDesign = await loadDesign();
    cachedKey = key;
  }
  return cachedDesign;
};

// ---------- the card: design + name ----------
// Returns a PNG buffer (WhatsApp image headers accept JPG/PNG, not WebP).
const generateCard = async (rawName) => {
  const name = String(rawName || "").trim() || "Guest";
  const design = await getDesign();
  const { width: W, height: H } = await sharp(design).metadata();
  const n = cfg.NAME;

  // Longer names get a smaller font so they stay on the card.
  const over = Math.max(0, name.length - n.shrinkAfterChars);
  const sizePct = Math.max(
    n.minFontSizePct,
    n.fontSizePct * (n.shrinkAfterChars / (n.shrinkAfterChars + over))
  );
  const fontSize = Math.round((W * sizePct) / 100);
  const boxWidth = Math.round((W * n.maxWidthPct) / 100);

  const nameImage = await sharp({
    text: {
      text: `<span foreground="${n.color}">${escapeMarkup(name)}</span>`,
      font: `${cfg.FONT_FAMILY} ${fontSize}`,
      fontfile: cfg.FONT_FILE,
      width: boxWidth,
      align: "center",
      rgba: true,
      dpi: 72,
    },
  })
    .png()
    .toBuffer();

  const meta = await sharp(nameImage).metadata();
  const left = Math.max(
    0,
    Math.round((W * n.centerXPct) / 100 - meta.width / 2)
  );
  const top = Math.max(0, Math.round((H * n.topPct) / 100));

  return sharp(design)
    .composite([{ input: nameImage, left, top }])
    .png()
    .toBuffer();
};

module.exports = { generateCard };
