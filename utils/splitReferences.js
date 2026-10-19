// utils/splitReferences.js
//
// A Reference typed as "Ramesh & Suresh", "Ramesh / Suresh" or
// "Ramesh - Suresh" is really TWO different people. The name before the
// special character and the name after it are kept as separate references.
//
//   toReferenceList(["Ramesh & Suresh", "Mahesh"])  -> ["Ramesh", "Suresh", "Mahesh"]
//   toReferenceList("A, B-C", { splitLists: true }) -> ["A", "B", "C"]
//
// Every value is trimmed and duplicates are dropped case-insensitively
// (the first spelling is kept) - same rule as before.

// & / - (hyphen, en dash, em dash)
const REFERENCE_SEPARATORS = /[&/\-\u2013\u2014]/;
// Used only when the whole list arrives as ONE text value.
const LIST_SEPARATORS = /[,|;]/;

const toReferenceList = (input, { splitLists = false } = {}) => {
  let items;

  if (Array.isArray(input)) {
    items = input;
  } else if (splitLists) {
    items = String(input || "").split(LIST_SEPARATORS);
  } else {
    items = [input];
  }

  const seen = new Set();
  const result = [];

  for (const raw of items) {
    if (typeof raw !== "string") continue;

    for (const part of raw.split(REFERENCE_SEPARATORS)) {
      const name = part.replace(/\s+/g, " ").trim();
      if (!name) continue;

      const key = name.toLowerCase();
      if (seen.has(key)) continue;

      seen.add(key);
      result.push(name);
    }
  }

  return result;
};

module.exports = { toReferenceList, REFERENCE_SEPARATORS };
