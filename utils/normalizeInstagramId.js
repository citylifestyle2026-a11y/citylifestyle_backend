// Instagram ID helpers shared by the Contact validator and service.
//
// Admins paste Instagram IDs in all sorts of shapes:
//   "@karan.shah"  /  "karan.shah"  /  "https://www.instagram.com/karan.shah/?hl=en"
// Everything is stored as the bare, lowercase username ("karan.shah") so
// the frontend can always build https://instagram.com/<id> from it.
const INSTAGRAM_USERNAME_REGEX = /^[a-z0-9._]{1,30}$/;

const normalizeInstagramId = (value) => {
  let v = String(value ?? "").trim();
  if (!v) return "";

  // A pasted profile link -> take the username segment out of it.
  const linkMatch = v.match(/instagram\.com\/([^/?#\s]+)/i);
  if (linkMatch) v = linkMatch[1];

  return v.replace(/^@+/, "").trim().toLowerCase();
};

const isValidInstagramId = (value) => INSTAGRAM_USERNAME_REGEX.test(value);

// ---------------------------------------------------------------------
// Contact forms now ask for the Instagram PROFILE LINK, not a name.
//   https://instagram.com/karan.shah   OK  -> "karan.shah"
//   instagram.com/karan.shah/?hl=en    OK  -> "karan.shah"
//   karan.shah / @karan.shah           NOT accepted (it is a name, not a link)
//   https://instagram.com/p/xyz        NOT accepted (post link, not a profile)
// The field is optional: blank is fine. The stored value stays the bare
// username so existing contacts and the profile-link buttons keep working.
// ---------------------------------------------------------------------
const INSTAGRAM_LINK_REGEX =
  /^(?:https?:\/\/)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i;
const INSTAGRAM_RESERVED_PATHS = new Set([
  "p", "reel", "reels", "stories", "explore", "tv", "accounts", "direct", "about",
]);

// Returns the username for a valid profile link, or null if it is not one.
const parseInstagramLink = (value) => {
  const match = String(value ?? "").trim().match(INSTAGRAM_LINK_REGEX);
  if (!match) return null;

  const username = match[1].toLowerCase();
  return INSTAGRAM_RESERVED_PATHS.has(username) ? null : username;
};

module.exports = {
  normalizeInstagramId,
  isValidInstagramId,
  parseInstagramLink,
};
