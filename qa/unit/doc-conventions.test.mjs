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
