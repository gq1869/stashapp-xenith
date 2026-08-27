// Pure, GraphQL-free — same purity contract as elo.js/gauntlet.js/
// champion.js/match-stats.js (age is the one exception: it reads the clock
// transitively via formatAge's default `now` param, so it isn't a pure
// function of `item` alone — still no GraphQL, no state, no side effects).
// Builds the curated metadata-chip allowlist for h2h performer cards, and
// scene cards too (buildSceneChips below). Ordered short/reliable ->
// long/variable, so a fixed line budget (CardChips.jsx/xenith.css) fills
// with the highest-value chips first and the one unbounded category (Tags)
// is what overflows — age sits right after favorite, weight right after
// height, ahead of the rest of the physical-attribute run, since both are
// short and reliable whenever set — weight's `units` param was added
// afterward.
// Not a per-field picker (considered and rejected) — each allowlist is
// fixed and identical for everyone. A later addition layers coarse on/off
// visibility per chip via a HiddenChips-style plugin setting
// (parseHiddenChips/visibleChips below), still no localStorage or
// component state — the setting is read fresh (through plugin-config.js's
// shared cache) and filtering is a pure function of the chip list.

import {
  formatAge,
  formatBitRate,
  formatDisplayRating,
  formatDuration,
  formatFileSize,
  formatFrameRate,
  formatHeight,
  formatResolution,
  formatWeight,
  formatYear,
  UNITS,
} from "./format";

// tattoos/piercings are free-text Strings in Stash's schema (prose like
// "Left arm sleeve", or "No"/""), so a truthy check alone would render a
// chip for a performer whose field literally says "None". Exported for
// direct unit test.
const NEGATIVE_VALUES = new Set(["", "no", "none", "n/a", "na", "false", "0", "-", "unknown", "null"]);
export function isAffirmative(value) {
  return typeof value === "string" && !NEGATIVE_VALUES.has(value.trim().toLowerCase());
}

// The rating chip drops its "Rating " label when unrated — "Rating Unrated"
// reads as broken English, so an unrated item's chip just says "Unrated".
function formatRatingChipText(rating100) {
  if (rating100 == null) return "Unrated";
  return `Rating ${formatDisplayRating(rating100)}`;
}

// fake_tits is a closed enum in practice, not prose — a live 2.5k-performer
// library carries only "Natural", "Fake", and "" — so the NEGATIVE_VALUES
// blocklist above is the wrong shape here: "Natural" isn't in it, so the
// majority of the pool rendered a "Fake Tits" chip contradicting the field.
// Both populated values are real statements worth showing, so this
// classifies rather than gates. Scrapers phrase it a few ways (StashDB
// writes "Natural"/"Fake", hand-entry and older Stash forms write
// "Yes"/"No"), and anything unrecognized — "", "Unknown", any future
// phrasing — returns null and renders no chip, the safe direction to fail
// for a claim about someone's body.
const BREASTS_FAKE = new Set(["yes", "y", "true", "1", "fake", "enhanced", "augmented", "implants", "surgery"]);
const BREASTS_NATURAL = new Set(["no", "n", "false", "0", "natural", "real"]);

export function classifyBreasts(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (BREASTS_FAKE.has(v)) return "fake";
  if (BREASTS_NATURAL.has(v)) return "natural";
  return null;
}

function pluralize(n, singular, plural = `${singular}s`) {
  return n === 1 ? singular : plural;
}

// Configurable chip ids for the performer-side HiddenChips plugin setting —
// every chip buildPerformerChips can emit, except `rating`, which
// is pinned (see visibleChips below). Single source of truth for
// parseHiddenChips and for xenith.yml's HiddenChips description, so the two
// can't drift silently.
export const PERFORMER_CHIP_IDS = [
  "favorite", "age", "ethnicity", "height", "weight", "eye_color",
  "hair_color", "measurements", "breasts", "scene_count", "o_counter",
  "gallery_count", "tattoos", "piercings", "tags",
];

// Same role as PERFORMER_CHIP_IDS above, for the scene-side HiddenSceneChips
// setting. `performer:<id>`/`group:<id>` chips collapse to the
// plural `performers`/`groups` config keys, matching how `tag:<id>` already
// collapses to `tags` (see chipConfigKey below).
export const SCENE_CHIP_IDS = [
  "year", "duration", "resolution", "studio", "performers", "o_counter",
  "play_count", "marker_count", "gallery_count", "groups", "size",
  "video_codec", "audio_codec", "frame_rate", "bit_rate", "tags",
];

// fake_tits' chip id is `breasts` (see classifyBreasts above), which doesn't
// match either the Stash field name or its own label — the one real
// synonym worth accepting from a hand-typed setting. Performer-only: the
// scene allowlist has no such field.
const CHIP_ID_ALIASES = { fake_tits: "breasts" };

function normalizeChipToken(token) {
  return String(token).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Builds the normalized-token -> canonical-id lookup for one allowlist.
// Aliases are only applied when their target is actually in `validIds`, so
// the performer-only `fake_tits` alias can't leak into the scene lookup.
function buildNormalizedChipIds(validIds) {
  const normalized = new Map(validIds.map((id) => [normalizeChipToken(id), id]));
  for (const [alias, target] of Object.entries(CHIP_ID_ALIASES)) {
    if (validIds.includes(target)) normalized.set(normalizeChipToken(alias), target);
  }
  return normalized;
}

// Resolves a raw HiddenChips/HiddenSceneChips plugin setting (a STRING, so
// possibly a comma/whitespace-separated list, undefined, or garbage) into a
// Set of chip ids to hide, validated against `validIds` (PERFORMER_CHIP_IDS
// or SCENE_CHIP_IDS — each setting has its own list, so a scene-only id
// typed into the performer setting is dropped as unknown, and vice versa).
// Unknown tokens and `rating` are silently dropped — rating is pinned,
// and a typo should hide nothing rather than the wrong chip. Pure
// so it's unit-testable without React; mirrors resolveUnitSystem/
// resolvePageSize.
export function parseHiddenChips(raw, validIds) {
  if (typeof raw !== "string" || !raw.trim()) return new Set();
  const normalizedChipIds = buildNormalizedChipIds(validIds);
  const hidden = new Set();
  for (const token of raw.split(/[,\s]+/)) {
    const normalized = normalizeChipToken(token);
    if (!normalized) continue;
    const id = normalizedChipIds.get(normalized);
    if (id) hidden.add(id);
  }
  return hidden;
}

// Maps a built chip to the config key HiddenChips/HiddenSceneChips filters
// on — every `tag:<id>` chip collapses to `tags`, `performer:<id>` to
// `performers`, `group:<id>` to `groups`.
function chipConfigKey(chip) {
  if (chip.id.startsWith("tag:")) return "tags";
  if (chip.id.startsWith("performer:")) return "performers";
  if (chip.id.startsWith("group:")) return "groups";
  return chip.id;
}

// Filters a built chip list down to what HiddenChips/HiddenSceneChips
// allows. Returns the same array reference when nothing is hidden,
// so the default/common path (no setting configured) allocates nothing
// extra.
export function visibleChips(chips, hidden) {
  if (!hidden || hidden.size === 0) return chips;
  return chips.filter((chip) => !hidden.has(chipConfigKey(chip)));
}

// Sorted by a popularity count field desc, then name A-Z. Copies before
// sorting — the array is held in usePair's React state, and mutating it in
// a render-path function is a footgun. Missing count is treated as 0 (not
// skipped in arithmetic as NaN, which would make the sort non-
// deterministic). Shared by performer tags (performer_count), scene tags
// (scene_count), and scene performers (scene_count).
function sortByCountThenName(list, countField) {
  return [...(list ?? [])].sort((a, b) =>
    (b[countField] ?? 0) - (a[countField] ?? 0) ||
    String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" })
  );
}

// Codec label maps — allowlist-specific classification, same place
// classifyBreasts lives, not display formatting (format.js). Unrecognized
// codecs fall back to their raw value uppercased rather than being dropped,
// since an unlabeled codec is still worth showing.
const VIDEO_CODEC_LABELS = {
  h264: "H.264", hevc: "HEVC", mpeg4: "MPEG-4", mpeg2video: "MPEG-2",
  mpeg1video: "MPEG-1", wmv2: "WMV", wmv3: "WMV", vc1: "VC-1",
};
function formatVideoCodec(codec) {
  if (!codec) return null;
  return VIDEO_CODEC_LABELS[codec.toLowerCase()] ?? codec.toUpperCase();
}

const AUDIO_CODEC_LABELS = {
  aac: "AAC", mp3: "MP3", mp2: "MP2", ac3: "AC-3", wmav2: "WMA", wmapro: "WMA",
};
function formatAudioCodec(codec) {
  if (!codec) return null;
  return AUDIO_CODEC_LABELS[codec.toLowerCase()] ?? codec.toUpperCase();
}

export function buildPerformerChips(item, units = UNITS.CUSTOMARY) {
  const chips = [];

  chips.push({ id: "rating", text: formatRatingChipText(item.rating100), group: "accent" });

  if (item.favorite === true) {
    chips.push({ id: "favorite", text: "Favorite", group: "accent" });
  }

  const age = formatAge(item.birthdate, item.death_date);
  if (age != null) {
    chips.push({ id: "age", text: `Age ${age}`, group: "physical" });
  }

  if (item.ethnicity) {
    chips.push({ id: "ethnicity", text: item.ethnicity, group: "physical" });
  }

  const height = formatHeight(item.height_cm, units);
  if (height) {
    chips.push({ id: "height", text: height, group: "physical" });
  }

  const weight = formatWeight(item.weight, units);
  if (weight) {
    chips.push({ id: "weight", text: weight, group: "physical" });
  }

  if (item.eye_color) {
    chips.push({ id: "eye_color", text: `${item.eye_color} eyes`, group: "physical" });
  }

  if (item.hair_color) {
    chips.push({ id: "hair_color", text: `${item.hair_color} hair`, group: "physical" });
  }

  if (item.measurements) {
    chips.push({ id: "measurements", text: item.measurements, group: "physical" });
  }

  const breasts = classifyBreasts(item.fake_tits);
  if (breasts) {
    chips.push({ id: "breasts", text: breasts === "fake" ? "Fake Tits" : "Natural", group: "physical" });
  }

  if (item.scene_count > 0) {
    chips.push({ id: "scene_count", text: `${item.scene_count} ${pluralize(item.scene_count, "scene")}`, group: "activity" });
  }

  if (item.o_counter > 0) {
    chips.push({ id: "o_counter", text: `O-Count ${item.o_counter}`, group: "activity" });
  }

  if (item.gallery_count > 0) {
    chips.push({ id: "gallery_count", text: `${item.gallery_count} ${pluralize(item.gallery_count, "gallery", "galleries")}`, group: "activity" });
  }

  if (isAffirmative(item.tattoos)) {
    chips.push({ id: "tattoos", text: "Tattoos", group: "art" });
  }

  if (isAffirmative(item.piercings)) {
    chips.push({ id: "piercings", text: "Piercings", group: "art" });
  }

  for (const tag of sortByCountThenName(item.tags, "performer_count")) {
    chips.push({ id: `tag:${tag.id}`, text: tag.name, group: "neutral" });
  }

  return chips;
}

// Scene-side allowlist. No `units` param — nothing here is
// unit-dependent, unlike buildPerformerChips' height/weight. Resolution,
// duration and file size duplicate what the native SceneCard's
// .scene-specs-overlay already shows, but binned into categories (e.g.
// "30 min", "1.5 GB") rather than restating its exact values, so each chip
// still adds legibility rather than just repeating small overlay text. The
// five `tech` chips (size onward) are the lowest-value, highest-frequency
// run — ordered last among the always-populated fields so people/counts/tags
// aren't crowded out of the fixed line budget; a scene with all sixteen
// chips populated relies on HiddenSceneChips to trim the row.
export function buildSceneChips(item) {
  const chips = [];
  const file = item.files?.[0] ?? {};

  chips.push({ id: "rating", text: formatRatingChipText(item.rating100), group: "accent" });

  const year = formatYear(item.date);
  if (year) {
    chips.push({ id: "year", text: year, group: "physical" });
  }

  const duration = formatDuration(file.duration);
  if (duration) {
    chips.push({ id: "duration", text: duration, group: "physical" });
  }

  const resolution = formatResolution(file.width, file.height);
  if (resolution) {
    chips.push({ id: "resolution", text: resolution, group: "physical" });
  }

  if (item.studio?.name) {
    chips.push({ id: "studio", text: item.studio.name, group: "art" });
  }

  for (const performer of sortByCountThenName(item.performers, "scene_count")) {
    chips.push({ id: `performer:${performer.id}`, text: performer.name, group: "people" });
  }

  if (item.o_counter > 0) {
    chips.push({ id: "o_counter", text: `O-Count ${item.o_counter}`, group: "activity" });
  }

  if (item.play_count > 0) {
    chips.push({ id: "play_count", text: `${item.play_count} ${pluralize(item.play_count, "play")}`, group: "activity" });
  }

  const markerCount = item.scene_markers?.length ?? 0;
  if (markerCount > 0) {
    chips.push({ id: "marker_count", text: `${markerCount} ${pluralize(markerCount, "marker")}`, group: "activity" });
  }

  const galleryCount = item.galleries?.length ?? 0;
  if (galleryCount > 0) {
    chips.push({ id: "gallery_count", text: `${galleryCount} ${pluralize(galleryCount, "gallery", "galleries")}`, group: "activity" });
  }

  for (const entry of item.groups ?? []) {
    if (entry.group?.name) {
      chips.push({ id: `group:${entry.group.id}`, text: entry.group.name, group: "art" });
    }
  }

  const size = formatFileSize(file.size);
  if (size) {
    chips.push({ id: "size", text: size, group: "tech" });
  }

  const videoCodec = formatVideoCodec(file.video_codec);
  if (videoCodec) {
    chips.push({ id: "video_codec", text: videoCodec, group: "tech" });
  }

  const audioCodec = formatAudioCodec(file.audio_codec);
  if (audioCodec) {
    chips.push({ id: "audio_codec", text: audioCodec, group: "tech" });
  }

  const frameRate = formatFrameRate(file.frame_rate);
  if (frameRate) {
    chips.push({ id: "frame_rate", text: frameRate, group: "tech" });
  }

  const bitRate = formatBitRate(file.bit_rate);
  if (bitRate) {
    chips.push({ id: "bit_rate", text: bitRate, group: "tech" });
  }

  for (const tag of sortByCountThenName(item.tags, "scene_count")) {
    chips.push({ id: `tag:${tag.id}`, text: tag.name, group: "neutral" });
  }

  return chips;
}

// The fixed-line-budget fit calculation — the pure half of CardChips.jsx's
// measurement. `bottoms` is each chip's bottom edge in px, relative to the
// container's content-box top (already in render order); `containerHeight`
// is the container's own clientHeight, which CSS sets from
// --hon-chip-lines — so CSS stays the single source of truth for the
// budget, not a hardcoded line count here.
const FIT_EPSILON = 0.5; // absorbs sub-pixel getBoundingClientRect on HiDPI

export function planChipFit(bottoms, containerHeight, total) {
  let fits = 0;
  while (fits < bottoms.length && bottoms[fits] <= containerHeight + FIT_EPSILON) fits++;
  if (fits >= total) return { visible: total, overflow: 0 };
  // Reserve one slot on the last visible line for the "+N" chip itself.
  // Safe by construction: the dropped chip is the last on the final visible
  // line, so its width (>=~40px: padding + >=2 chars) plus the row gap
  // always exceeds the "+N" chip's own width (~34px for "+12") — worst
  // case this hides one chip that would have fit; it never clips and never
  // pushes "+N" onto a new line.
  const visible = Math.max(1, fits - 1);
  return { visible, overflow: total - visible };
}
