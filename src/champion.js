// Champion mode's reign reducer: an incumbent stays on the stage defending
// against a stream of new challengers as long as it keeps winning. Pure and
// GraphQL-free, same contract as elo.js and gauntlet.js — nothing here
// touches the network or the DOM. src/matchmaking.js resolves the candidate
// pool and passes plain data in.
//
// No mode-specific K-factor or streak dampener lives here — see the design
// note on Champion mode and XENITH.md §3.9. D=35 already collapses the
// marginal gain of a long win streak, and the champion's own match count
// decays its K via the existing sigmoid, so a second dampening layer would
// be redundant with (and risk stacking on top of) elo.js's single mechanism.

// Flat cap on successful defenses before a reign retires and a fresh seed is
// drawn via ordinary Swiss selection. See XENITH.md §3.9 for why a capped
// reign beats an unbounded one — a long win streak both approaches
// zero-entropy matches (§3.6) and forms a star topology over the comparison
// graph, the structural cousin of Gauntlet's own run-length cap.
export const MAX_DEFENSES = 10;

export function createReign(championId) {
  return { championId, defenses: 0 };
}

// Applies one match's outcome, relative to the champion (1 = champion won,
// 0 = challenger won, 0.5 = draw/skip) — same convention gauntlet.js's
// applyResult uses relative to its challenger. Never mutates the input.
//
//   win  -> defenses + 1; returns null once MAX_DEFENSES is reached
//           (caller reads null as "reign retired, seed fresh next time").
//   loss -> a new reign rooted at the challenger, defenses reset to 0.
//           Dethroning naturally breaks the star topology above.
//   draw -> unchanged. The incumbent holds, but a draw isn't a defense.
export function applyReignResult(run, { outcome, challengerId }) {
  if (outcome === 1) {
    const defenses = run.defenses + 1;
    return defenses >= MAX_DEFENSES ? null : { ...run, defenses };
  }
  if (outcome === 0) {
    return createReign(challengerId);
  }
  return run;
}

export function reignStatus(run) {
  return { defenses: run.defenses, remaining: MAX_DEFENSES - run.defenses };
}
