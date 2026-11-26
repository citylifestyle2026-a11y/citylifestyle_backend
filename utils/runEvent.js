// "Let's Run" events.
//
// An event named "Let's Run" (also "Lets Run", "Let’s Run 8.0" ...) is the run
// event: its ONLY report is the Run Report (sidebar + dashboard Run section).
// It must not show anywhere else - not in the event dropdown, dashboard
// numbers, Entry Report, Booking, Guest List, Contact Book ...
//
// Matching is by event title, so nothing has to be flagged or migrated: create
// an event called "Let's Run" and it is a run event.
// NOTE: MongoDB (PCRE2) does not understand \uXXXX escapes, so no unicode escapes
// here. [^a-z0-9\s]? = the optional apostrophe, straight (') or curly (’).
const RUN_EVENT_TITLE = /\blet[^a-z0-9\s]?s\s*run\b/i;

const isRunEventTitle = (title) => RUN_EVENT_TITLE.test(String(title || ""));

// Mongo filter fragments (spread into an Event query; they use the `title` key).
const notRunEvent = () => ({ title: { $not: RUN_EVENT_TITLE } });
const onlyRunEvent = () => ({ title: RUN_EVENT_TITLE });

module.exports = { RUN_EVENT_TITLE, isRunEventTitle, notRunEvent, onlyRunEvent };
