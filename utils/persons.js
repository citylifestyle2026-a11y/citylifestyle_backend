// utils/persons.js
//
// "Persons" = how many people one guest entry stands for.
//   Single -> 1, Couple -> 2, Manual -> the number the admin typed.
// Form Link quantity, the progress bar and the default pass guests all count
// PERSONS (not forms). Older guests have no `persons` saved, so it is worked
// out from their Entry Type (or the old Relationship).

// Most persons one entry / one pass can hold. The real limit is the room left
// on the guest's Form Link (and the ticket stock); this is only a sanity cap
// (same as the most a Form Link can hold).
const MAX_PERSONS = 1000;

const personsOf = (item = {}) => {
  const saved = Number(item.persons);
  if (Number.isInteger(saved) && saved >= 1) return saved;
  return (item.entryType || item.relationship) === "Couple" ? 2 : 1;
};

// Persons for a submission / form body, validated. `entryType` Manual needs a
// whole number 1..MAX_PERSONS in `persons`; Single/Couple ignore `persons`.
// Returns { entryType, persons } or throws a plain Error (message is shown).
const resolvePersons = (body = {}) => {
  const type = String(body.entryType || "").trim();
  const relationship = String(body.relationship || "").trim();

  if (type === "Manual") {
    const n = Number(body.persons);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PERSONS) {
      throw new Error(`Persons must be a whole number between 1 and ${MAX_PERSONS}.`);
    }
    return { entryType: "Manual", persons: n };
  }

  const effective = type || relationship;
  return { entryType: type, persons: effective === "Couple" ? 2 : 1 };
};

module.exports = { MAX_PERSONS, personsOf, resolvePersons };
