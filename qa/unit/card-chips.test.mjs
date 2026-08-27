// Coverage for card-chips.js's chip allowlist/order/gating and the fixed
// line-budget fit calculation (metadata chips on h2h performer cards
// and scene cards).
import { test, describe } from "vitest";
import assert from "node:assert/strict";

import {
  buildPerformerChips,
  buildSceneChips,
  isAffirmative,
  classifyBreasts,
  planChipFit,
  PERFORMER_CHIP_IDS,
  SCENE_CHIP_IDS,
  parseHiddenChips,
  visibleChips,
} from "../../src/card-chips.js";
import { UNITS } from "../../src/format.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FULL_PERFORMER = {
  id: "1",
  name: "Jane Doe",
  rating100: 87,
  favorite: true,
  birthdate: "1990-05-15",
  ethnicity: "Caucasian",
  height_cm: 168,
  weight: 63,
  eye_color: "Blue",
  hair_color: "Blonde",
  measurements: "34C-24-36",
  fake_tits: "Yes",
  scene_count: 12,
  o_counter: 5,
  gallery_count: 3,
  tattoos: "Left arm sleeve",
  piercings: "Navel",
  tags: [
    { id: "t1", name: "MILF", performer_count: 50 },
    { id: "t2", name: "Blonde", performer_count: 12 },
  ],
};

describe("buildPerformerChips — allowlist and order", () => {
  test("fully-populated performer produces the exact id sequence in order", () => {
    const chips = buildPerformerChips(FULL_PERFORMER);
    assert.deepEqual(chips.map((c) => c.id), [
      "rating",
      "favorite",
      "age",
      "ethnicity",
      "height",
      "weight",
      "eye_color",
      "hair_color",
      "measurements",
      "breasts",
      "scene_count",
      "o_counter",
      "gallery_count",
      "tattoos",
      "piercings",
      "tag:t1",
      "tag:t2",
    ]);
  });

  test("bare performer produces exactly one chip: Unrated", () => {
    const chips = buildPerformerChips({ id: "2", name: "Bare", rating100: null });
    assert.deepEqual(chips, [{ id: "rating", text: "Unrated", group: "accent" }]);
  });

  test("rating100 of 0 renders 0.0, not Unrated", () => {
    const chips = buildPerformerChips({ id: "3", name: "Zero", rating100: 0 });
    assert.equal(chips[0].text, "Rating 0.0");
  });

  test("excluded fields never leak into a chip's text", () => {
    const item = {
      id: "4",
      name: "Excluded",
      rating100: 50,
      gender: "FEMALE",
      country: "US",
      career_start: "2019",
      career_end: "2022",
      death_date: "2023-01-01",
      alias_list: ["Alias One"],
      group_count: 4,
      image_count: 9,
      urls: ["https://example.com"],
    };
    const chips = buildPerformerChips(item);
    const allText = chips.map((c) => c.text).join(" | ");
    for (const banned of ["FEMALE", "US", "2019", "2022", "2023-01-01", "Alias One", "example.com"]) {
      assert.ok(!allText.includes(banned), `expected "${banned}" to not appear in chip text, got: ${allText}`);
    }
    // group_count/image_count are numeric and could coincidentally match a
    // count chip's number — assert directly that no chip id is for them.
    assert.ok(!chips.some((c) => c.id === "group_count" || c.id === "image_count"));
  });

  test("favorite: false and undefined produce no favorite chip", () => {
    assert.ok(!buildPerformerChips({ id: "5", rating100: 50, favorite: false }).some((c) => c.id === "favorite"));
    assert.ok(!buildPerformerChips({ id: "6", rating100: 50 }).some((c) => c.id === "favorite"));
  });

  test("favorite: true produces a chip reading exactly Favorite", () => {
    const chip = buildPerformerChips({ id: "7", rating100: 50, favorite: true }).find((c) => c.id === "favorite");
    assert.equal(chip.text, "Favorite");
  });
});

describe("buildPerformerChips — age chip", () => {
  test("no birthdate produces no age chip", () => {
    const chips = buildPerformerChips({ id: "1", rating100: 50 });
    assert.ok(!chips.some((c) => c.id === "age"));
  });

  test("birthdate present produces an Age N chip", () => {
    const chips = buildPerformerChips({ id: "1", rating100: 50, birthdate: "1990-05-15" });
    const chip = chips.find((c) => c.id === "age");
    assert.ok(chip);
    assert.match(chip.text, /^Age \d+$/);
    assert.equal(chip.group, "physical");
  });

  test("death_date present still produces an age chip, computed at death", () => {
    const chips = buildPerformerChips({ id: "1", rating100: 50, birthdate: "1990-01-01", death_date: "2020-06-15" });
    const chip = chips.find((c) => c.id === "age");
    assert.equal(chip?.text, "Age 30");
  });
});

describe("buildPerformerChips — unit system", () => {
  const item = { id: "1", rating100: 50, height_cm: 168, weight: 63 };

  test("defaults to customary when no units argument is passed", () => {
    const chips = buildPerformerChips(item);
    assert.equal(chips.find((c) => c.id === "height").text, "5′6″");
    assert.equal(chips.find((c) => c.id === "weight").text, "139 lb");
  });

  test("UNITS.METRIC renders cm/kg", () => {
    const chips = buildPerformerChips(item, UNITS.METRIC);
    assert.equal(chips.find((c) => c.id === "height").text, "168 cm");
    assert.equal(chips.find((c) => c.id === "weight").text, "63 kg");
  });

  test("UNITS.CUSTOMARY renders feet/inches and lb", () => {
    const chips = buildPerformerChips(item, UNITS.CUSTOMARY);
    assert.equal(chips.find((c) => c.id === "height").text, "5′6″");
    assert.equal(chips.find((c) => c.id === "weight").text, "139 lb");
  });

  test("no weight set produces no weight chip", () => {
    const chips = buildPerformerChips({ id: "1", rating100: 50, height_cm: 168 }, UNITS.CUSTOMARY);
    assert.ok(!chips.some((c) => c.id === "weight"));
  });
});

describe("buildPerformerChips — affirmative gating (tattoos/piercings)", () => {
  const HIDDEN_VALUES = [undefined, null, "", "   ", "No", "no", "NO", "None", "n/a", "-", "0", "false"];
  const SHOWN_VALUES = ["Yes", "yes", "Both nipples", "Left arm sleeve", "Navel, tongue"];

  for (const field of ["tattoos", "piercings"]) {
    const chipId = field;

    for (const value of HIDDEN_VALUES) {
      test(`${field}=${JSON.stringify(value)} produces no chip`, () => {
        const chips = buildPerformerChips({ id: "1", rating100: 50, [field]: value });
        assert.ok(!chips.some((c) => c.id === chipId));
      });
    }

    for (const value of SHOWN_VALUES) {
      test(`${field}=${JSON.stringify(value)} produces a chip`, () => {
        const chips = buildPerformerChips({ id: "1", rating100: 50, [field]: value });
        assert.ok(chips.some((c) => c.id === chipId));
      });
    }
  }

  test("shown chip text is the label, not the raw value", () => {
    const item = { id: "1", rating100: 50, tattoos: "Left arm sleeve", piercings: "Navel, tongue" };
    const chips = buildPerformerChips(item);
    assert.equal(chips.find((c) => c.id === "tattoos").text, "Tattoos");
    assert.equal(chips.find((c) => c.id === "piercings").text, "Piercings");
  });

  // Prose containing the word "no" reads as negative to a naive substring
  // check, but tattoos/piercings are unbounded free text, not an enum — any
  // content means "has some" (an earlier audit found zero real negatives beyond
  // "" in a 2.5k-performer library). Locks in that this field keeps the
  // opposite shape from fake_tits below.
  test('prose containing "no" still produces a chip — not a negative match', () => {
    const item = {
      id: "1",
      rating100: 50,
      tattoos: 'Above left elbow, "No regrets"',
      piercings: "None visible except navel",
    };
    const chips = buildPerformerChips(item);
    assert.ok(chips.some((c) => c.id === "tattoos"));
    assert.ok(chips.some((c) => c.id === "piercings"));
  });
});

describe("isAffirmative", () => {
  test("non-string values are never affirmative", () => {
    assert.equal(isAffirmative(undefined), false);
    assert.equal(isAffirmative(null), false);
    assert.equal(isAffirmative(true), false);
    assert.equal(isAffirmative(1), false);
  });
});

describe("classifyBreasts", () => {
  test("non-string values classify as null", () => {
    assert.equal(classifyBreasts(undefined), null);
    assert.equal(classifyBreasts(null), null);
    assert.equal(classifyBreasts(true), null);
    assert.equal(classifyBreasts(1), null);
  });

  test("natural phrasings classify as natural", () => {
    for (const value of ["Natural", "natural", " Real ", "No", "false"]) {
      assert.equal(classifyBreasts(value), "natural", `expected ${JSON.stringify(value)} to classify natural`);
    }
  });

  test("fake phrasings classify as fake", () => {
    for (const value of ["Fake", "fake", "Yes", "enhanced", " Implants "]) {
      assert.equal(classifyBreasts(value), "fake", `expected ${JSON.stringify(value)} to classify fake`);
    }
  });

  test("blank/unrecognized values classify as null", () => {
    for (const value of ["", "   ", "Unknown", "n/a", "-"]) {
      assert.equal(classifyBreasts(value), null, `expected ${JSON.stringify(value)} to classify null`);
    }
  });
});

describe("buildPerformerChips — breasts chip", () => {
  test('fake_tits: "Natural" renders a Natural chip, not Fake Tits', () => {
    const chips = buildPerformerChips({ id: "1", rating100: 50, fake_tits: "Natural" });
    const chip = chips.find((c) => c.id === "breasts");
    assert.equal(chip?.text, "Natural");
  });

  test('fake_tits: "Fake" renders a Fake Tits chip', () => {
    const chips = buildPerformerChips({ id: "1", rating100: 50, fake_tits: "Fake" });
    const chip = chips.find((c) => c.id === "breasts");
    assert.equal(chip?.text, "Fake Tits");
  });

  for (const value of ["", "Unknown", undefined, null]) {
    test(`fake_tits=${JSON.stringify(value)} renders no breasts chip`, () => {
      const chips = buildPerformerChips({ id: "1", rating100: 50, fake_tits: value });
      assert.ok(!chips.some((c) => c.id === "breasts"));
    });
  }
});

describe("buildPerformerChips — count gating", () => {
  for (const field of ["scene_count", "o_counter", "gallery_count"]) {
    test(`${field}=0/null/undefined produces no chip`, () => {
      for (const value of [0, null, undefined]) {
        const chips = buildPerformerChips({ id: "1", rating100: 50, [field]: value });
        assert.ok(!chips.some((c) => c.id === field), `${field}=${value} should not produce a chip`);
      }
    });
  }

  test("scene_count/gallery_count singular vs plural text", () => {
    assert.equal(buildPerformerChips({ id: "1", rating100: 50, scene_count: 1 })[1].text, "1 scene");
    assert.equal(buildPerformerChips({ id: "1", rating100: 50, scene_count: 2 })[1].text, "2 scenes");
    assert.equal(buildPerformerChips({ id: "1", rating100: 50, gallery_count: 1 })[1].text, "1 gallery");
    assert.equal(buildPerformerChips({ id: "1", rating100: 50, gallery_count: 2 })[1].text, "2 galleries");
  });

  test("o_counter has no singular/plural distinction", () => {
    assert.equal(buildPerformerChips({ id: "1", rating100: 50, o_counter: 5 })[1].text, "O-Count 5");
  });
});

describe("buildPerformerChips — tag sort", () => {
  test("sorts by performer_count descending", () => {
    const item = { id: "1", rating100: 50, tags: [{ id: "a", name: "a", performer_count: 5 }, { id: "b", name: "b", performer_count: 50 }, { id: "c", name: "c", performer_count: 12 }] };
    const names = buildPerformerChips(item).filter((c) => c.id.startsWith("tag:")).map((c) => c.text);
    assert.deepEqual(names, ["b", "c", "a"]);
  });

  test("ties broken case-insensitively by name A-Z", () => {
    const item = { id: "1", rating100: 50, tags: [{ id: "a", name: "Zebra", performer_count: 10 }, { id: "b", name: "apple", performer_count: 10 }] };
    const names = buildPerformerChips(item).filter((c) => c.id.startsWith("tag:")).map((c) => c.text);
    assert.deepEqual(names, ["apple", "Zebra"]);
  });

  test("missing performer_count is treated as 0 and sorts last, not first", () => {
    const item = { id: "1", rating100: 50, tags: [{ id: "a", name: "a" }, { id: "b", name: "b", performer_count: 1 }] };
    const names = buildPerformerChips(item).filter((c) => c.id.startsWith("tag:")).map((c) => c.text);
    assert.deepEqual(names, ["b", "a"]);
  });

  test("does not mutate the input tags array", () => {
    const tags = [{ id: "a", name: "Zebra", performer_count: 1 }, { id: "b", name: "apple", performer_count: 5 }];
    const idsBefore = tags.map((t) => t.id);
    buildPerformerChips({ id: "1", rating100: 50, tags });
    assert.deepEqual(tags.map((t) => t.id), idsBefore);
  });

  test("empty and undefined tags produce no tag chips and don't throw", () => {
    assert.ok(!buildPerformerChips({ id: "1", rating100: 50, tags: [] }).some((c) => c.id.startsWith("tag:")));
    assert.doesNotThrow(() => buildPerformerChips({ id: "1", rating100: 50 }));
  });

  test("chip id is unique per tag id even with duplicate names", () => {
    const item = { id: "1", rating100: 50, tags: [{ id: "a", name: "Same" }, { id: "b", name: "Same" }] };
    const ids = buildPerformerChips(item).filter((c) => c.id.startsWith("tag:")).map((c) => c.id);
    assert.deepEqual(ids, ["tag:a", "tag:b"]);
  });
});

describe("planChipFit", () => {
  test("all chips fit within the container", () => {
    assert.deepEqual(planChipFit([20, 20, 44], 78, 3), { visible: 3, overflow: 0 });
  });

  test("one chip past the edge reserves a slot for the overflow chip", () => {
    // 4 chips, last one pushes past containerHeight=78.
    const result = planChipFit([20, 20, 44, 100], 78, 4);
    assert.equal(result.visible, 2); // fits=3, reserve one -> 2
    assert.equal(result.overflow, 2);
    assert.ok(result.overflow >= 2, "overflow should never be reported as +0 or +1 when a slot was reserved");
  });

  test("visible + overflow always equals total", () => {
    const result = planChipFit([20, 40, 60, 80, 100, 120], 78, 6);
    assert.equal(result.visible + result.overflow, 6);
  });

  test("degenerate: first chip alone exceeds container height, Rating never disappears", () => {
    const result = planChipFit([200, 220], 78, 2);
    assert.equal(result.visible, 1);
    assert.equal(result.overflow, 1);
  });

  test("sub-pixel bottoms within epsilon count as fitting", () => {
    assert.deepEqual(planChipFit([78.4], 78, 1), { visible: 1, overflow: 0 });
  });

  test("empty bottoms produces no visible chips and no throw", () => {
    assert.deepEqual(planChipFit([], 78, 0), { visible: 0, overflow: 0 });
  });
});

describe("parseHiddenChips — HiddenChips setting parsing", () => {
  for (const raw of [undefined, null, "", "   ", 42, {}]) {
    test(`${JSON.stringify(raw)} -> empty set`, () => {
      assert.deepEqual(parseHiddenChips(raw, PERFORMER_CHIP_IDS), new Set());
    });
  }

  test("comma-separated list", () => {
    assert.deepEqual(parseHiddenChips("measurements,piercings", PERFORMER_CHIP_IDS), new Set(["measurements", "piercings"]));
  });

  test("whitespace and mixed separators", () => {
    assert.deepEqual(parseHiddenChips(" measurements ,  piercings\n tags", PERFORMER_CHIP_IDS), new Set(["measurements", "piercings", "tags"]));
  });

  test("case and separator normalization", () => {
    assert.deepEqual(parseHiddenChips("Eye Color, eye-color, EYECOLOR", PERFORMER_CHIP_IDS), new Set(["eye_color"]));
  });

  test("fake_tits aliases to breasts", () => {
    assert.deepEqual(parseHiddenChips("fake_tits", PERFORMER_CHIP_IDS), new Set(["breasts"]));
  });

  test("rating is dropped — always pinned", () => {
    assert.deepEqual(parseHiddenChips("rating,age", PERFORMER_CHIP_IDS), new Set(["age"]));
  });

  test("unknown tokens are dropped", () => {
    assert.deepEqual(parseHiddenChips("bogus,age,typo", PERFORMER_CHIP_IDS), new Set(["age"]));
  });

  test("garbage string yields empty set", () => {
    assert.deepEqual(parseHiddenChips("!!!,,,---", PERFORMER_CHIP_IDS), new Set());
  });

  test("a scene-only id is dropped from the performer list", () => {
    assert.deepEqual(parseHiddenChips("bit_rate,age", PERFORMER_CHIP_IDS), new Set(["age"]));
  });

  test("a performer-only id is dropped from the scene list", () => {
    assert.deepEqual(parseHiddenChips("measurements,bit_rate", SCENE_CHIP_IDS), new Set(["bit_rate"]));
  });

  test("fake_tits alias does not apply to the scene list (no breasts field there)", () => {
    assert.deepEqual(parseHiddenChips("fake_tits", SCENE_CHIP_IDS), new Set());
  });
});

describe("visibleChips — chip filtering", () => {
  const chips = [
    { id: "rating", text: "Rating 8.7", group: "accent" },
    { id: "age", text: "Age 30", group: "physical" },
    { id: "tag:1", text: "Blonde", group: "neutral" },
    { id: "tag:2", text: "MILF", group: "neutral" },
  ];

  test("hides a plain chip", () => {
    const result = visibleChips(chips, new Set(["age"]));
    assert.ok(!result.some((c) => c.id === "age"));
    assert.equal(result.length, 3);
  });

  test("hiding tags removes every tag:* chip and nothing else", () => {
    const result = visibleChips(chips, new Set(["tags"]));
    assert.deepEqual(result.map((c) => c.id), ["rating", "age"]);
  });

  test("empty hidden set returns the same array reference", () => {
    assert.equal(visibleChips(chips, new Set()), chips);
    assert.equal(visibleChips(chips, null), chips);
  });

  test("rating is pinned by parseHiddenChips, not visibleChips — visibleChips itself has no rating special-case", () => {
    const result = visibleChips(chips, new Set(["rating"]));
    assert.ok(!result.some((c) => c.id === "rating"));
  });

  test("hides a tech chip on a scene chip list by name", () => {
    const sceneChips = [
      { id: "rating", text: "Rating 8.7", group: "accent" },
      { id: "bit_rate", text: "3.5 Mbps", group: "tech" },
    ];
    const result = visibleChips(sceneChips, new Set(["bit_rate"]));
    assert.deepEqual(result.map((c) => c.id), ["rating"]);
  });
});

const FULL_SCENE = {
  id: "100",
  rating100: 87,
  date: "2021-03-14",
  code: "ABC123",
  organized: true,
  stash_ids: [{ endpoint: "stashdb", stash_id: "abc" }],
  play_duration: 120,
  resume_time: 30,
  files: [
    { duration: 1800, width: 1920, height: 1080, size: 1.5e9, video_codec: "h264", audio_codec: "aac", frame_rate: 29.97, bit_rate: 3.48e6 },
  ],
  studio: { name: "Test Studio" },
  performers: [
    { id: "p1", name: "Jane Doe", scene_count: 50 },
    { id: "p2", name: "John Roe", scene_count: 10 },
  ],
  o_counter: 3,
  play_count: 2,
  scene_markers: [{ id: "m1" }, { id: "m2" }],
  galleries: [{ id: "g1" }],
  groups: [{ group: { id: "gr1", name: "Group One" } }],
  tags: [
    { id: "t1", name: "MILF", scene_count: 50 },
    { id: "t2", name: "Blonde", scene_count: 12 },
  ],
};

describe("buildSceneChips — allowlist and order", () => {
  test("fully-populated scene produces the exact id sequence in order", () => {
    const chips = buildSceneChips(FULL_SCENE);
    assert.deepEqual(chips.map((c) => c.id), [
      "rating",
      "year",
      "duration",
      "resolution",
      "studio",
      "performer:p1",
      "performer:p2",
      "o_counter",
      "play_count",
      "marker_count",
      "gallery_count",
      "group:gr1",
      "size",
      "video_codec",
      "audio_codec",
      "frame_rate",
      "bit_rate",
      "tag:t1",
      "tag:t2",
    ]);
  });

  test("bare scene produces exactly one chip: Unrated", () => {
    const chips = buildSceneChips({ id: "1", rating100: null });
    assert.deepEqual(chips, [{ id: "rating", text: "Unrated", group: "accent" }]);
  });

  test("rating100 of 0 renders 0.0, not Unrated", () => {
    const chips = buildSceneChips({ id: "1", rating100: 0 });
    assert.equal(chips[0].text, "Rating 0.0");
  });

  test("excluded fields never leak into a chip's text", () => {
    const chips = buildSceneChips(FULL_SCENE);
    const allText = chips.map((c) => c.text).join(" | ");
    for (const banned of ["ABC123", "stashdb", "abc"]) {
      assert.ok(!allText.includes(banned), `expected "${banned}" to not appear in chip text, got: ${allText}`);
    }
    for (const bannedId of ["code", "organized", "stash_ids", "play_duration", "resume_time"]) {
      assert.ok(!chips.some((c) => c.id === bannedId));
    }
  });

  test("year chip is year only, not the full date", () => {
    const chip = buildSceneChips({ id: "1", rating100: 50, date: "2021-03-14" }).find((c) => c.id === "year");
    assert.equal(chip.text, "2021");
  });
});

describe("buildSceneChips — count gating", () => {
  for (const [field, chipId] of [["o_counter", "o_counter"], ["play_count", "play_count"]]) {
    test(`${field}=0/null/undefined produces no chip`, () => {
      for (const value of [0, null, undefined]) {
        const chips = buildSceneChips({ id: "1", rating100: 50, [field]: value });
        assert.ok(!chips.some((c) => c.id === chipId), `${field}=${value} should not produce a chip`);
      }
    });
  }

  test("play_count singular vs plural text", () => {
    assert.equal(buildSceneChips({ id: "1", rating100: 50, play_count: 1 }).find((c) => c.id === "play_count").text, "1 play");
    assert.equal(buildSceneChips({ id: "1", rating100: 50, play_count: 2 }).find((c) => c.id === "play_count").text, "2 plays");
  });

  test("o_counter has no singular/plural distinction", () => {
    assert.equal(buildSceneChips({ id: "1", rating100: 50, o_counter: 5 }).find((c) => c.id === "o_counter").text, "O-Count 5");
  });

  test("marker_count/gallery_count derive from array length, 0/empty/missing produce no chip", () => {
    for (const value of [[], undefined]) {
      const chips = buildSceneChips({ id: "1", rating100: 50, scene_markers: value, galleries: value });
      assert.ok(!chips.some((c) => c.id === "marker_count"));
      assert.ok(!chips.some((c) => c.id === "gallery_count"));
    }
  });

  test("gallery_count singular vs plural text", () => {
    assert.equal(buildSceneChips({ id: "1", rating100: 50, galleries: [{ id: "g1" }] }).find((c) => c.id === "gallery_count").text, "1 gallery");
    assert.equal(buildSceneChips({ id: "1", rating100: 50, galleries: [{ id: "g1" }, { id: "g2" }] }).find((c) => c.id === "gallery_count").text, "2 galleries");
  });

  test("marker_count singular vs plural text", () => {
    assert.equal(buildSceneChips({ id: "1", rating100: 50, scene_markers: [{ id: "m1" }] }).find((c) => c.id === "marker_count").text, "1 marker");
    assert.equal(buildSceneChips({ id: "1", rating100: 50, scene_markers: [{ id: "m1" }, { id: "m2" }] }).find((c) => c.id === "marker_count").text, "2 markers");
  });
});

describe("buildSceneChips — performer chips, sorted by scene_count", () => {
  test("sorted by scene_count descending", () => {
    const item = { id: "1", rating100: 50, performers: [{ id: "a", name: "a", scene_count: 5 }, { id: "b", name: "b", scene_count: 50 }] };
    const names = buildSceneChips(item).filter((c) => c.id.startsWith("performer:")).map((c) => c.text);
    assert.deepEqual(names, ["b", "a"]);
  });

  test("ties broken case-insensitively by name A-Z", () => {
    const item = { id: "1", rating100: 50, performers: [{ id: "a", name: "Zebra", scene_count: 10 }, { id: "b", name: "apple", scene_count: 10 }] };
    const names = buildSceneChips(item).filter((c) => c.id.startsWith("performer:")).map((c) => c.text);
    assert.deepEqual(names, ["apple", "Zebra"]);
  });

  test("missing scene_count is treated as 0 and sorts last", () => {
    const item = { id: "1", rating100: 50, performers: [{ id: "a", name: "a" }, { id: "b", name: "b", scene_count: 1 }] };
    const names = buildSceneChips(item).filter((c) => c.id.startsWith("performer:")).map((c) => c.text);
    assert.deepEqual(names, ["b", "a"]);
  });

  test("does not mutate the input performers array", () => {
    const performers = [{ id: "a", name: "Zebra", scene_count: 1 }, { id: "b", name: "apple", scene_count: 5 }];
    const idsBefore = performers.map((p) => p.id);
    buildSceneChips({ id: "1", rating100: 50, performers });
    assert.deepEqual(performers.map((p) => p.id), idsBefore);
  });

  test("empty/undefined performers and no performer_count field produce no throw", () => {
    assert.ok(!buildSceneChips({ id: "1", rating100: 50, performers: [] }).some((c) => c.id.startsWith("performer:")));
    assert.doesNotThrow(() => buildSceneChips({ id: "1", rating100: 50 }));
  });

  test("chip id is unique per performer id even with duplicate names", () => {
    const item = { id: "1", rating100: 50, performers: [{ id: "a", name: "Same" }, { id: "b", name: "Same" }] };
    const ids = buildSceneChips(item).filter((c) => c.id.startsWith("performer:")).map((c) => c.id);
    assert.deepEqual(ids, ["performer:a", "performer:b"]);
  });
});

describe("buildSceneChips — tag sort (scene_count)", () => {
  test("sorts by scene_count descending", () => {
    const item = { id: "1", rating100: 50, tags: [{ id: "a", name: "a", scene_count: 5 }, { id: "b", name: "b", scene_count: 50 }] };
    const names = buildSceneChips(item).filter((c) => c.id.startsWith("tag:")).map((c) => c.text);
    assert.deepEqual(names, ["b", "a"]);
  });

  test("does not mutate the input tags array", () => {
    const tags = [{ id: "a", name: "Zebra", scene_count: 1 }, { id: "b", name: "apple", scene_count: 5 }];
    const idsBefore = tags.map((t) => t.id);
    buildSceneChips({ id: "1", rating100: 50, tags });
    assert.deepEqual(tags.map((t) => t.id), idsBefore);
  });
});

describe("buildSceneChips — group chips", () => {
  test("one chip per group, from groups[].group", () => {
    const item = { id: "1", rating100: 50, groups: [{ group: { id: "g1", name: "First" } }, { group: { id: "g2", name: "Second" } }] };
    const chips = buildSceneChips(item).filter((c) => c.id.startsWith("group:"));
    assert.deepEqual(chips.map((c) => c.id), ["group:g1", "group:g2"]);
    assert.deepEqual(chips.map((c) => c.text), ["First", "Second"]);
  });

  test("empty/undefined groups produce no chip and no throw", () => {
    assert.ok(!buildSceneChips({ id: "1", rating100: 50, groups: [] }).some((c) => c.id.startsWith("group:")));
    assert.doesNotThrow(() => buildSceneChips({ id: "1", rating100: 50 }));
  });
});

describe("buildSceneChips — codec labels", () => {
  test("recognized video codecs map to their display label", () => {
    const cases = { h264: "H.264", hevc: "HEVC", mpeg4: "MPEG-4", mpeg2video: "MPEG-2", mpeg1video: "MPEG-1", wmv2: "WMV", wmv3: "WMV", vc1: "VC-1" };
    for (const [codec, label] of Object.entries(cases)) {
      const chip = buildSceneChips({ id: "1", rating100: 50, files: [{ video_codec: codec }] }).find((c) => c.id === "video_codec");
      assert.equal(chip.text, label, `expected ${codec} -> ${label}`);
    }
  });

  test("recognized audio codecs map to their display label", () => {
    const cases = { aac: "AAC", mp3: "MP3", mp2: "MP2", ac3: "AC-3", wmav2: "WMA", wmapro: "WMA" };
    for (const [codec, label] of Object.entries(cases)) {
      const chip = buildSceneChips({ id: "1", rating100: 50, files: [{ audio_codec: codec }] }).find((c) => c.id === "audio_codec");
      assert.equal(chip.text, label, `expected ${codec} -> ${label}`);
    }
  });

  test("unrecognized codec falls back to the raw value uppercased", () => {
    const videoChip = buildSceneChips({ id: "1", rating100: 50, files: [{ video_codec: "prores" }] }).find((c) => c.id === "video_codec");
    assert.equal(videoChip.text, "PRORES");
    const audioChip = buildSceneChips({ id: "1", rating100: 50, files: [{ audio_codec: "flac" }] }).find((c) => c.id === "audio_codec");
    assert.equal(audioChip.text, "FLAC");
  });

  test("no file entry produces no codec chips and no throw", () => {
    assert.doesNotThrow(() => buildSceneChips({ id: "1", rating100: 50 }));
    assert.ok(!buildSceneChips({ id: "1", rating100: 50 }).some((c) => c.id === "video_codec" || c.id === "audio_codec"));
  });
});

describe("HiddenChips manifest drift guard", () => {
  test("every PERFORMER_CHIP_IDS entry appears in xenith.yml's HiddenChips description", () => {
    const yml = readFileSync(fileURLToPath(new URL("../../xenith.yml", import.meta.url)), "utf8");
    for (const id of PERFORMER_CHIP_IDS) {
      assert.ok(yml.includes(id), `xenith.yml's HiddenChips description is missing "${id}"`);
    }
  });

  test("every SCENE_CHIP_IDS entry appears in xenith.yml's HiddenSceneChips description", () => {
    const yml = readFileSync(fileURLToPath(new URL("../../xenith.yml", import.meta.url)), "utf8");
    for (const id of SCENE_CHIP_IDS) {
      assert.ok(yml.includes(id), `xenith.yml's HiddenSceneChips description is missing "${id}"`);
    }
  });
});
