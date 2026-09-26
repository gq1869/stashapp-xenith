# How Xenith's ratings differ from Ascension

If you've looked at more than one Elo-style rating plugin for Stash, you've probably noticed they all look related. Same six-tier S–F badges, same head-to-head format, similar vocabulary. They are related: Xenith started as a fork of [Ascension](https://github.com/Servbot91/Sakotos-Stash-Repo/tree/main/plugins/Ascension) v1.2.6 on 2026-07-04, then rewrote most of the rating engine before its first release the next day. `NOTICE` lists what Xenith kept from that starting point. This doc covers what changed, and why.

Everything below compares Xenith as released (3.0.0 and later) against Ascension v1.2.6 specifically, the version Xenith actually forked from, read directly out of that commit's `ascension.js`. The two projects developed independently after the fork, so none of this describes what Ascension does today. It's an account of what Xenith started from and where it went a different direction. See the [ratings explainer](../XENITH.md) for how Xenith's own math works end to end.

## 1. Ratings react to the actual matchup

Ascension computes win probability the standard Elo way, with the standard Elo divisor: `D = 400` (`calculateMatchOutcome`). That divisor was designed for an unbounded rating scale running into the thousands. Squeezed onto Stash's 0–100 `rating100` field, it barely moves. Expected win probability spans only 50.0% to 64.0% across the entire scale. A 10-point rating gap reads as 51.4%, close to a coin flip, and even the most lopsided matchup possible, a 100-point gap, tops out at 64%.

Xenith uses `D = 35` instead. The same 10-point gap reads as 65.9%. A 40-point gap is 93.3%.

When the matchup itself carries almost no signal, the size of a rating change ends up decided by whatever multipliers are layered on top of it rather than by how mismatched the pair actually was. Tightening the divisor to fit the scale puts the two ratings back in charge of the outcome.

## 2. Wins and losses don't create rating out of nothing

Ascension stacks three things that push net rating upward on a wide-gap upset. `getUnderdogMultiplier` scales the underdog's gain up (1.1x, 1.3x, or 1.5x as the gap widens), while a separate function, `getChallengeProtectionMultiplier`, scales the favorite's loss down (0.9x, 0.85x, 0.8x, or 0.7x) on the same match, in the same direction. Every win is guaranteed at least one point (`Math.max(1, winnerGain)`), but no loss is guaranteed at all (`Math.max(0, loserLoss)`). And four to six of these adjustments are chained with `Math.ceil`, so each one rounds up and none of them can push a gain below 1.

Xenith applies one factor, `lossAttenuation`, to both sides of an upset equally, floors the winner's gain at 0 rather than 1, and rounds once at the end.

The difference shows up in a real number. Simulating 200,000 matches drawn from a settled, normally-distributed pool (favorite wins 65% of the time, both sides at equal experience): Ascension's math adds about 2.0 rating points to the pool on every match, on average. Xenith's adds exactly 0. Every matchup in the comparison nets to zero, win or upset. The worst individual case: a 50-rated performer beats an 85-rated one, and Ascension hands out +17/−5, a net of +12 created from one match.

`rating100` is bounded at 100. Rating mass that gets created has nowhere to go but the ceiling, so S-tier fills up over time and a tier badge stops telling you much. `XENITH.md` §3.3 already makes this argument; the number above is what backs it up.

## 3. One dampening mechanism instead of a stack of them

Counting through v1.2.6's `calculateMatchOutcome` and `getProgressiveKFactor`: two rating-band gain cuts (85 and up multiplies by 0.6, 70 and up by 0.8), a separate reduction for any rating over 60, experience decay, per-mode K multipliers (champion 0.85x, gauntlet 1.1x), and per-mode streak dampeners (gauntlet from streak 3, champion from 5 and again from 10). Several of those are doing the same job — damping a favorite's gain — and all of them multiply together.

Xenith ships two, and they don't overlap: experience decay, where K-factor falls as an item plays more matches, and the one symmetric attenuation from section 2 above.

One artifact of the stacked version is worth pointing at directly. At a 90-vs-88 matchup, about as close as two ratings get, Ascension gives the winner +4 and takes 7 from the loser, a net of −3. Routine wins near the top of the scale lose rating mass overall while wide-gap upsets lower down create it. Every equal-K matchup in Xenith nets to zero regardless of where on the scale it happens.

## 4. Tier cutoffs are calibrated against the real math

Ascension's tier floors in v1.2.6 land on round numbers — S starts at 85, and the rest step down evenly from there: A at 70, B at 55, C at 40, D at 25. Xenith's `TIER_BOUNDS` (S/A/B/C/D floors at 100, 84, 59, 31, 9) come out of a Monte Carlo simulation (`qa/scripts/simulate-tier-bounds.mjs`) run against Xenith's own rating formulas, targeting specific population percentiles described in `XENITH.md` §5.

The gap between a round number and a calibrated one isn't cosmetic. Feeding the same 2,500-performer settled population, produced by Xenith's own rating math, through both cutoff sets gives:

| | S | A | B | C | D | F |
|---|---|---|---|---|---|---|
| Xenith's calibrated bounds | 3.2% | 12.3% | 25.1% | 30.0% | 20.6% | 8.8% |
| Round-number bounds, same population | 14.5% | 15.1% | 15.8% | 15.6% | 15.1% | 24.0% |

A pairwise-comparison population settles clustered near the center of the scale rather than spread evenly across it. Evenly-spaced cutoffs land nearly one in six items in S-tier and almost a quarter in F, regardless of what "S-tier" is supposed to mean. Both approaches are static lookup tables at runtime. The difference is in how the numbers behind the lookup were chosen.

## 5. The leaderboard doesn't pay out twice for the same evidence

Ascension's display score (`compositeScore`) is `rating/100 + winRate * 0.5 + winMargin/1000 + totalMatches/10000`. The problem is that `rating100` already is the accumulated record of every win and loss. Adding `winRate * 0.5` back in re-counts that same evidence, at up to half the weight of the entire rating term, and the match-count term pays out again for volume on top of that. A performer who's won their only match can outrank one who's earned a strong rating over 40 matches.

Xenith's display score is `max(0, rating - 1.645 * sigma) / 100`, where sigma shrinks as match count grows. It's a one-sided 90% confidence bound that discounts a thin record instead of rewarding it. `XENITH.md` §4.3 works through the numbers: a fresh performer at 1 match with a raw rating of 66 displays at about 48.5. A 40-match veteran sitting at a raw 53 displays at about 49.1. The veteran still edges out the lucky newcomer.

## 6. Matches get picked for what they'll teach you rather than who's gone unseen lately

Ascension's candidate weighting is `getRecencyWeight(p)` cubed, on top of a tier-focus rotation that picks a random tier every 7 to 19 matches. That rotation needs at least 20 members in the target tier and an average recency weight of 0.8 to qualify, tries 10 times, then gives up and matches from anywhere. Anything inside the currently focused tier gets its weight doubled.

Xenith weights candidates by the Shannon entropy of the likely outcome, scaled by how little is known about each side (`priorityScore`), and has no tier-rotation mechanism at all.

Cubing recency optimizes for "it's been a while since this one played." That's a different question from "which comparison would tell us the most right now." A pair that's both well-established and evenly matched can still be highly informative; recency alone has no way to see that.

## 7. Session sampling: a smaller pool, refreshed far more often

Ascension pulls a pool of up to 800 items sorted by `updated_at`, with a 5% chance of pulling 200 at random instead, and reuses that exact sample for the next 50 matches before refreshing it. Xenith pulls up to 500 items sorted randomly, resampled on every single match.

Worth being direct about the tradeoff rather than just the difference: Xenith's cap is smaller, 500 against 800. What changes is randomness (random draw against a deterministic staleness order) and refresh rate (every match against every 50). On a library bigger than either cap, most of it goes unreached within any one sample either way. Xenith just reshuffles which slice you're drawing from far more often.

## 8. A bad early result doesn't cap where you place

Ascension's Gauntlet-equivalent mode is a climb-or-fall search: win, and you face someone ranked higher; lose, and you drop into a falling phase testing lower-ranked opponents. That's a hard commitment on a single result, and a single match outcome in this kind of system is inherently noisy rather than a sure verdict.

Xenith's Gauntlet mode keeps a probability distribution over where you belong on the ladder and updates it with every match instead of committing to half the ladder or the other. One unlucky loss shifts the odds; it doesn't lock in a placement. `XENITH.md` §3.8 has the full argument, including why a binary-search-style bisection was considered and rejected too.

## What Xenith kept

This isn't a from-scratch system, and `NOTICE` has the full accounting. The pieces carried over structurally from Ascension include the six-tier S/A/B/C/D/F frame itself — Xenith recalibrated the numeric bounds in section 4 while keeping the same tier count and ordering — plus the forced cross-tier match event and its trigger odds, the session repeat-opponent penalty and its weight bands, the recently-selected candidate tracking, the sigmoid shape of the K-factor experience curve (Xenith changed only its asymptote and made the endpoints library-scaled), and the top-N weighted seed pool concept.

## What Xenith doesn't claim

The pool sampling in section 7 is capped on both sides. Xenith's cap is smaller and its refresh is more frequent, but 500 items still leaves most of a large library out of reach in any one sample.

Xenith's math is also net-nonzero when the two sides carry different K-factors. A fresh, high-K underdog beating a settled, low-K favorite is a deliberate net inflow, since new items are meant to move fast. The equal-K comparison in section 2 isolates the attenuation mechanism specifically; the K-factor effect is symmetric in aggregate, roughly +3 one direction and −3 the other depending on who's fresher, and isn't part of that claim.

The attenuation curve's floor (0.15) and its decay scale (20) were picked for smooth, bounded, monotonic behavior. `src/elo.js` documents them plainly as starting constants rather than values derived from some outside requirement.

S-tier is a single point, `[100, 100]`, rather than a range, because it's a flat rating-keyed lookup — there's no wider band underneath the ceiling for it to split.

Transitive delta propagation, letting a result partially update items that weren't in the match, is designed in `XENITH.md` §3.5 and not built.

The K-factor curve computes a decay-horizon parameter (`mDecay`) that isn't actually wired into the shipped sigmoid yet. See §3.2's implementation note.
