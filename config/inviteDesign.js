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
  // Defaults are set for the "Parv 6.0" card: the name sits in the gap
  // between "6:30 PM ONWARDS" and the location pin.
  NAME: {
    centerXPct: 50, // horizontal centre of the name
    topPct: 33.5, // top edge of the name box
    maxWidthPct: 80, // name wraps / shrinks to stay inside this width
    fontSizePct: 4.2, // font size (for a name up to 15 chars) as % of design WIDTH
    minFontSizePct: 2, // never smaller than this
    color: "#FFFFFF",
    // Names longer than this start shrinking
    shrinkAfterChars: 15,
  },

  // The GUEST CARD (public /guest-card link, guest adds own photo + name) has its
  // OWN design, separate from the invitation card above. Defaults fit
  // parv_template_card.jpg (900 x 1600): circle photo + cream name pill.
  GUEST: {
    NAME: {
      centerXPct: 50,
      topPct: 43.8,
      maxWidthPct: 66,
      fontSizePct: 5.1,
      minFontSizePct: 2,
      color: "#6E0A0E",
      shrinkAfterChars: 15,
    },
    PHOTO_BOX: { xPct: 33.33, yPct: 21.25, wPct: 33.33, hPct: 18.75, shape: "circle" },
  },
};