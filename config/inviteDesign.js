// config/inviteDesign.js
//
// Settings for the "Invitation Cards" feature: ONE fixed design for every
// guest, only the guest's NAME differs.
//
// TO CHANGE THE DESIGN LATER:
//   1. Replace  assets/invite-design.png  with the real design (PNG/JPG,
//      any size - positions below are percentages, so they still work).
//      Or set INVITE_DESIGN_FILE in .env to another file path.
//   2. Adjust NAME below (where the name sits, its size and colour).
// Until a design file exists, a simple placeholder design is generated.
const path = require("path");

const ASSETS_DIR = path.join(__dirname, "..", "assets");

module.exports = {
  DESIGN_FILE:
    process.env.INVITE_DESIGN_FILE || path.join(ASSETS_DIR, "invite-design.png"),

  FONT_FILE: path.join(ASSETS_DIR, "fonts", "Poppins-SemiBold.ttf"),
  FONT_FAMILY: "Poppins SemiBold",

  // Everything in % of the design size, so any design size works.
  NAME: {
    centerXPct: 50, // horizontal centre of the name
    topPct: 48, // top edge of the name box
    maxWidthPct: 80, // name wraps / shrinks to stay inside this width
    fontSizePct: 5.2, // font size as % of design WIDTH
    minFontSizePct: 2.6, // never smaller than this
    color: "#C9A24B",
    // Names longer than this start shrinking
    shrinkAfterChars: 16,
  },
};
