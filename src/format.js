// Display formatting only — not rating math. elo.js is the single source of
// truth for rating math (K-factor, composite score, etc.) and is imported
// into matchmaking.js's hot loops; a "/10 plus an Unrated string" belongs
// here instead, kept separate so presentation churn never touches the math
// file's contract.

// Formats a raw rating100 value for display, e.g. 87 -> "8.7". Returns
// "Unrated" when rating100 is null/undefined — `== null` (not truthy), since
// a genuine 0 is a legitimate floored rating and must render as "0.0",
// not "Unrated".
export function formatDisplayRating(rating100) {
  if (rating100 == null) return "Unrated";
  return (rating100 / 10).toFixed(1);
}

// Display name for an item of either battle type — performers have `name`,
// scenes have `title` (falling back to `Scene <id>` when untitled, since an
// empty title string is falsy).
export function displayName(item) {
  return item.name ?? (item.title || `Scene ${item.id}`);
}

// Unit system for height/weight chips — backed by xenith.yml's
// `UseCustomaryUnits` setting, metric by default.
export const UNITS = { METRIC: "metric", CUSTOMARY: "customary" };

// Resolves the raw `UseCustomaryUnits` plugin setting (a BOOLEAN, so
// possibly true/false/null/undefined) to a UNITS value. Metric is the
// default — Stash gives an unset BOOLEAN setting no manifest-level default
// (it reads back as null/undefined, same as an explicit `false`, and the
// settings UI renders it unchecked either way), so only an explicit `true`
// opts into customary. Pure so it's unit-testable without React; mirrors
// leaderboard-pagination.js's resolvePageSize.
export function resolveUnitSystem(setting) {
  return setting === true ? UNITS.CUSTOMARY : UNITS.METRIC;
}

// Formats a height in cm for the given unit system, e.g. 168 -> "168 cm"
// (metric) or "5′6″" (customary). Returns null for unset/0/NaN — 0 is not a
// real height, same "falsy but not legitimate" treatment as
// formatDisplayRating gives Unrated, just via `!cm` since 0 isn't a valid
// height the way 0 is a valid rating.
export function formatHeight(cm, units = UNITS.CUSTOMARY) {
  if (!cm || Number.isNaN(cm)) return null;
  if (units === UNITS.CUSTOMARY) {
    const totalInches = Math.round(cm / 2.54);
    const feet = Math.floor(totalInches / 12);
    const inches = totalInches % 12;
    return `${feet}′${inches}″`;
  }
  return `${Math.round(cm)} cm`;
}

// Formats a weight in kg for the given unit system, e.g. 63 -> "63 kg"
// (metric) or "139 lb" (customary). Same null-guard contract as
// formatHeight.
export function formatWeight(kg, units = UNITS.CUSTOMARY) {
  if (!kg || Number.isNaN(kg)) return null;
  if (units === UNITS.CUSTOMARY) {
    return `${Math.round(kg * 2.20462)} lb`;
  }
  return `${Math.round(kg)} kg`;
}

// Formats an age (in years) from a performer's birthdate — whole years
// between birthdate and the reference date below. Returns null for unset/unparseable/
// future-dated birthdates, same "nothing to show" contract as formatHeight.
// deathDate, when set, is used as the reference point instead of now (age at
// death) — matching what Stash's own native card computes, so the chip
// never contradicts the performer page. `now` defaults to the current date
// but is an injectable parameter so callers (tests) get a deterministic
// result; it's the one clock read in this otherwise pure module.
//
// Dates are parsed by splitting "YYYY-MM-DD" and comparing the numeric
// parts directly, not `new Date(str)` — that parses as UTC midnight, which
// would drift the computed age by a day against a local-time `now` in
// negative-offset zones, enough to misreport on a birthday.
export function formatAge(birthdate, deathDate, now = new Date()) {
  const birth = parseDateParts(birthdate);
  if (!birth) return null;
  const reference = deathDate ? parseDateParts(deathDate) : parseDateParts(now.toISOString().slice(0, 10));
  if (!reference) return null;

  let age = reference.y - birth.y;
  const birthdayPassed = reference.m > birth.m || (reference.m === birth.m && reference.d >= birth.d);
  if (!birthdayPassed) age -= 1;

  return age >= 0 ? age : null;
}

// Splits a "YYYY-MM-DD" string into numeric {y, m, d}, or null if it doesn't
// parse cleanly.
function parseDateParts(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const match = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  return { y, m, d };
}

// Stash's own resolution-label table (mirrored so the chip and the native
// SceneCard's .scene-specs-overlay can never disagree — extracted from
// Stash v0.31.1's own bundle, PluginApi exposes no formatter for this).
// Applied to min(width, height), the shorter side, so a vertical video
// still labels by its actual quality rather than its longer dimension.
// Returns null below 144p or for unset/NaN dimensions.
/** @type {Array<[number, string]>} */
const RESOLUTION_BUCKETS = [
  [6144, "HUGE"],
  [3840, "8K"],
  [3584, "7K"],
  [3000, "6K"],
  [2560, "5K"],
  [1920, "4K"],
  [1440, "1440p"],
  [1080, "1080p"],
  [720, "720p"],
  [540, "540p"],
  [480, "480p"],
  [360, "360p"],
  [240, "240p"],
  [144, "144p"],
];

export function formatResolution(width, height) {
  if (!width || !height || Number.isNaN(width) || Number.isNaN(height)) return null;
  const shorter = Math.min(width, height);
  for (const [min, label] of RESOLUTION_BUCKETS) {
    if (shorter >= min) return label;
  }
  return null;
}

// Formats a scene duration in seconds as a coarse bin, not an exact
// timestamp (e.g. "30 min", "1 hr 30 min") — the goal is a category chip,
// not a restatement of the native overlay's precise m:ss. Returns null for
// unset/0/negative/NaN.
export function formatDuration(seconds) {
  if (!seconds || Number.isNaN(seconds) || seconds < 0) return null;
  const totalMinutes = seconds / 60;
  if (totalMinutes < 1) return "< 1 min";
  if (totalMinutes < 60) return `${Math.max(5, Math.round(totalMinutes / 5) * 5)} min`;
  const hours = Math.floor(totalMinutes / 60);
  const remainder = Math.round((totalMinutes % 60) / 15) * 15;
  return remainder === 0 ? `${hours} hr` : `${hours} hr ${remainder} min`;
}

// Formats a file size in bytes as a coarse bin (e.g. "800 MB", "1.5 GB").
// Decimal GB/MB (1e9/1e6), matching Stash's own overlay rather than binary
// GiB. Returns null for unset/0/negative/NaN.
export function formatFileSize(bytes) {
  if (!bytes || Number.isNaN(bytes) || bytes < 0) return null;
  const gb = bytes / 1e9;
  if (gb < 1) {
    const mb = Math.max(100, Math.round((bytes / 1e6) / 100) * 100);
    return `${mb} MB`;
  }
  const roundedGb = Math.round(gb * 2) / 2;
  return `${roundedGb % 1 === 0 ? roundedGb.toFixed(0) : roundedGb.toFixed(1)} GB`;
}

// Formats a video bit rate in bits per second as a coarse bin (e.g.
// "3.5 Mbps"). Returns null for unset/0/negative/NaN.
export function formatBitRate(bps) {
  if (!bps || Number.isNaN(bps) || bps < 0) return null;
  const mbps = bps / 1e6;
  if (mbps < 1) return "< 1 Mbps";
  const rounded = Math.round(mbps * 2) / 2;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)} Mbps`;
}

// Formats a frame rate in fps as the nearest whole number, e.g. 29.97 ->
// "30 fps". Returns null for unset/0/negative/NaN.
export function formatFrameRate(fps) {
  if (!fps || Number.isNaN(fps) || fps < 0) return null;
  return `${Math.round(fps)} fps`;
}

// Formats a scene's date as just the year, e.g. "2021-03-14" -> "2021" —
// a year-level chip is enough signal without restating the full date.
// Reuses parseDateParts rather than a second date parser. Returns null for
// unset/unparseable.
export function formatYear(date) {
  const parsed = parseDateParts(date);
  return parsed ? String(parsed.y) : null;
}

// Stash's performer gender enum, with display labels. Single source of
// truth — Sidebar.jsx's gender picker and Gauntlet.jsx's placement/banner
// labels (formatGenderList below) both need the same value->label mapping,
// and this module (not a component) is where non-React callers like
// rank-cache.js/usePair.js can safely import display formatting from too.
export const GENDERS = [
  { value: "FEMALE", label: "Female" },
  { value: "MALE", label: "Male" },
  { value: "TRANSGENDER_MALE", label: "Trans Male" },
  { value: "TRANSGENDER_FEMALE", label: "Trans Female" },
  { value: "INTERSEX", label: "Intersex" },
  { value: "NON_BINARY", label: "Non-Binary" },
];

const GENDER_LABELS = Object.fromEntries(GENDERS.map((g) => [g.value, g.label]));

// Renders a selectedGenders array (state.js's persisted.selectedGenders
// shape, also stamped onto a Gauntlet run as run.genderFilter) as a
// short label for the Gauntlet placement screen/banner, e.g. "Female",
// "Female + Male", "3 genders". Returns null for an empty/absent selection
// (no filter — nothing to label) rather than an empty string, so callers
// can `{label && ...}` rather than checking length themselves. `null`/
// `undefined` also covers a run started before this field existed.
export function formatGenderList(selectedGenders) {
  if (!selectedGenders || selectedGenders.length === 0) return null;
  if (selectedGenders.length === 1) return GENDER_LABELS[selectedGenders[0]] ?? selectedGenders[0];
  if (selectedGenders.length === 2) {
    return selectedGenders.map((g) => GENDER_LABELS[g] ?? g).join(" + ");
  }
  return `${selectedGenders.length} genders`;
}
