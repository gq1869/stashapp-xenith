// Enforces this repo's documentation convention: permanent comments cite
// file:symbol, never a line number — a line-number citation rots the moment
// the cited file is edited, silently pointing at the wrong code. Prior
// docs sweeps found and fixed the same class of drift more than once, so
// it's now a hard fail rather than something the next sweep has to
// rediscover by grepping.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "../../src");

// Matches e.g. "Gauntlet.jsx:139", "xenith.css:341", "main.js:34" — a
// filename with one of these extensions, a colon, then digits. Deliberately
// broad on the filename (any word chars) so it also catches citations to
// files outside src/ (backend/tasks.py:284, a qa script) made from within a
// src/ comment.
const LINE_CITATION = /\b[\w-]+\.(?:js|jsx|css|py|mjs)\s*:\s*\d+\b/g;

function findSourceFiles(root) {
  return globSync("**/*.{js,jsx,css}", { cwd: root }).map((rel) =>
    path.join(root, rel)
  );
}

describe("doc conventions: no line-number citations in src/ comments", () => {
  test("every src/ file is free of file.ext:NN style citations", () => {
    const offenses = [];
    for (const file of findSourceFiles(srcRoot)) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
        const matches = line.match(LINE_CITATION);
        if (matches) {
          for (const m of matches) {
            offenses.push(`${path.relative(srcRoot, file)}:${idx + 1} — "${m}" in: ${line.trim()}`);
          }
        }
      });
    }
    assert.deepEqual(
      offenses,
      [],
      `Found line-number citations (cite file:symbol instead):\n${offenses.join("\n")}`
    );
  });
});

// Enforces the other half of the same convention: a permanent `XENITH.md §N`
// citation is only as durable as the section it points at. A rewrite that
// drops or renumbers a heading silently strands every comment that cites it
// — this test catches that at the same time a line-number citation would be
// caught, rather than leaving it for someone to notice the doc and the code
// have drifted apart.
const xenithPath = path.resolve(here, "../../XENITH.md");

// Matches "## 5. Title" or "### 3.9 Title" — the two heading levels XENITH.md
// uses for numbered sections. Captures just the number (e.g. "5", "3.9").
const XENITH_HEADING = /^#{2,3}\s+(\d+(?:\.\d+)?)\b/;

// Matches one or more "§N" / "§N.N" tokens on a line that also mentions
// XENITH.md — e.g. "XENITH.md §3.9" or "`XENITH.md` §3.3/§4.2". Requires
// "XENITH.md" earlier on the same line so an unrelated "§4.2" elsewhere
// isn't misread as a citation.
const SECTION_REF = /§(\d+(?:\.\d+)?)/g;

function findXenithSections(text) {
  const sections = new Set();
  for (const line of text.split("\n")) {
    const match = line.match(XENITH_HEADING);
    if (match) sections.add(match[1]);
  }
  return sections;
}

describe("doc conventions: XENITH.md § citations resolve to real headings", () => {
  test("every XENITH.md §N cited from src/ matches an existing section", () => {
    const validSections = findXenithSections(readFileSync(xenithPath, "utf8"));
    const offenses = [];
    for (const file of findSourceFiles(srcRoot)) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
        if (!line.includes("XENITH.md")) return;
        const matches = [...line.matchAll(SECTION_REF)];
        for (const m of matches) {
          const section = m[1];
          if (!validSections.has(section)) {
            offenses.push(
              `${path.relative(srcRoot, file)}:${idx + 1} — cites XENITH.md §${section}, no such heading exists: ${line.trim()}`
            );
          }
        }
      });
    }
    assert.deepEqual(
      offenses,
      [],
      `Found XENITH.md § citations with no matching heading (update the citation or restore the section):\n${offenses.join("\n")}`
    );
  });
});
