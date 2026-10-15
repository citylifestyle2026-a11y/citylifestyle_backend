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

module.exports = { normalizeInstagramId, isValidInstagramId };
