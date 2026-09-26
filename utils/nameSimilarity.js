/**
 * Name Similarity Utility — PARV CRM, Phase 3 (Duplicate Detection)
 *
 * Implements matching priority #4 from the requirement doc (section 4):
 * "Name similarity -> Flag as Possible Duplicate - manual review". This
 * runs ONLY after an exact mobile match (priority #1/#2) and an exact
 * email match (priority #3) have both failed — see
 * services/nomination.service.js's createNomination, which calls
 * `findSimilarGuests` as the last step before deciding a nomination is
 * genuinely a brand-new person.
 *
 * No fuzzy-matching npm package is added — the project's package.json
 * has none installed, and a token-sort Levenshtein ratio is more than
 * enough accuracy for "same person, typed differently" on a guest list
 * of this size (a few thousand at most), without adding a dependency
 * the person hosting this backend would have to `npm install`.
 */

// Titles/prefixes that vary by who typed the nomination but never change
// who the person IS ("Rahul Shah" and "Mr. Rahul Shah" must compare as
// identical). Suffix honorifics fused onto the name in casual Gujarati
// spelling (e.g. "Rahulbhai") are deliberately NOT stripped — removing a
// suffix blindly risks cutting real name characters ("Shahbhai" could be
// a surname), whereas these prefixes are always separate words.
const HONORIFIC_PREFIXES = new Set([
  "mr", "mrs", "ms", "miss", "dr", "shri", "smt", "kum", "er", "adv", "prof",
]);

// Lowercase, collapse whitespace, drop punctuation, drop honorific
// prefix words. Exported so callers/tests can see exactly what two
// names normalize to.
const normalizeName = (name) => {
  const cleaned = String(name ?? "")
    .toLowerCase()
    .replace(/[.,'"()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  const words = cleaned.split(" ").filter((word) => !HONORIFIC_PREFIXES.has(word));

  return words.length ? words.join(" ") : cleaned;
};

// Standard Levenshtein edit distance between two strings.
const levenshteinDistance = (a, b) => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prevRow = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i++) {
    const currRow = [i];

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1, // insertion
        prevRow[j] + 1, // deletion
        prevRow[j - 1] + cost // substitution
      );
    }

    prevRow = currRow;
  }

  return prevRow[b.length];
};

// 1 = identical, 0 = completely different.
const levenshteinRatio = (a, b) => {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
};

// Sorts a name's words alphabetically before comparing — this is what
// lets "Rahul Shah" and "Shah Rahul" (same person, coordinator typed the
// surname first) score as a near-perfect match instead of a poor one,
// since a plain Levenshtein diff on the un-sorted strings would see them
// as almost entirely rewritten.
const tokenSortKey = (normalized) => normalized.split(" ").sort().join(" ");

// Combined similarity score (0-1) between two raw, un-normalized names.
const nameSimilarityScore = (nameA, nameB) => {
  const normA = normalizeName(nameA);
  const normB = normalizeName(nameB);

  if (!normA || !normB) return 0;
  if (normA === normB) return 1;

  return levenshteinRatio(tokenSortKey(normA), tokenSortKey(normB));
};

// A score at or above this is treated as "possibly the same person" and
// flagged for admin review (doc section 4) rather than silently either
// merging or ignoring. Deliberately conservative (high bar) — a false
// "Possible Duplicate" only costs the admin one extra glance in the
// review queue; a false non-match silently creates a real duplicate
// guest, which is the more expensive mistake to allow.
const POSSIBLE_DUPLICATE_THRESHOLD = 0.82;

// Scans `candidateGuests` (each needs at least `_id` and `fullName`) and
// returns the ones whose name is similar enough to `name`, sorted by
// score descending, capped at `limit` — this cap keeps the review queue
// showing only the strongest few candidates rather than every
// vaguely-similar name on a large guest list.
const findSimilarGuests = (name, candidateGuests, limit = 3) => {
  const scored = candidateGuests
    .map((guest) => ({ guest, score: nameSimilarityScore(name, guest.fullName) }))
    .filter((entry) => entry.score >= POSSIBLE_DUPLICATE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
};

module.exports = {
  normalizeName,
  levenshteinDistance,
  levenshteinRatio,
  nameSimilarityScore,
  findSimilarGuests,
  POSSIBLE_DUPLICATE_THRESHOLD,
};
