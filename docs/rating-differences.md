# How Xenith's ratings differ from Ascension's

If you've looked at more than one rating plugin for Stash, you've probably noticed they are all related. Xenith started as a fork of [Ascension](https://github.com/Servbot91/Sakotos-Stash-Repo/tree/main/plugins/Ascension) v1.2.6, then diverged: I rewrote the rating engine and the interface against different design principles.

Two principles drove most of it. I wanted the source code fully transparent, even before bundling, and I wanted to reuse as many of Stash's native components as possible.

Xenith kept a lot from that fork: the forced cross-tier match event and its trigger odds, the session repeat-opponent penalty and its weight bands, recently-selected candidate tracking, the sigmoid shape of the K-factor curve (with a new asymptote and library-scaled endpoints), and the top-N weighted seed pool. `NOTICE` has the full accounting. This doc covers what changed and why. It compares against v1.2.6 only and will not be updated for anything Ascension has done since.

See the [ratings explainer](../XENITH.md) for how Xenith's own math works end to end.

## 1. A tier letter should mean the same thing in every library

I wanted a tier letter to mean the same share of any library. Ascension's v1.2.6 floors are round numbers: S at 85, then A at 70, B at 55, C at 40, D at 25. Xenith's (`TIER_BOUNDS`: 100, 84, 59, 31, 9) come out of a Monte Carlo simulation (`qa/scripts/simulate-tier-bounds.mjs`) run against Xenith's own rating math, targeting the percentiles in `XENITH.md` §5.

Pairwise-comparison ratings settle clustered near the middle of the scale, so evenly spaced cutoffs land far from the intended shares. Running the same 2,500-performer settled population through both sets:

| | S | A | B | C | D | F |
|---|---:|---:|---:|---:|---:|---:|
| Xenith's calibrated bounds | 3.2% | 12.3% | 25.1% | 30.0% | 20.6% | 8.8% |
| Round-number bounds, same population | 14.5% | 15.1% | 15.8% | 15.6% | 15.1% | 24.0% |

## 2. The rating gap should decide the odds

I wanted to keep using Stash's native 0–100 `rating100`. Standard Elo runs on an unbounded scale into the thousands, and Ascension computed win probability with its standard divisor, `D = 400`.

That means the favorite's expected win probability ranges from 50.0% to 64.0% across any possible matchup. A 10-point rating gap has an expected win probability of 51.4%, close to a coin flip, and even the most lopsided matchup, a 100-point gap, tops out at 64%.

Xenith uses `D = 35` instead. The same 10-point gap reads as 65.9%, and a 40-point gap reads as 93.3%. The gap between two ratings now decides how surprising a result is, so a rating change reflects how mismatched the pair was.

## 3. Each click should teach something

I wanted every comparison to teach as much as possible. Ascension weights candidates by recency cubed (`getRecencyWeight`), plus a tier-focus rotation that picks a random tier every 7 to 19 matches and doubles the weight of anything inside it.

Xenith weights candidates by the Shannon entropy of the likely outcome, scaled by how little is known about each side (`priorityScore`), and has no tier rotation.

Recency answers "it's been a while since this one played." Entropy answers "which comparison would tell us the most right now." An evenly matched pair of well-known items can still be very informative, and recency alone can't see that.

This builds on section 2. Under `D = 400` every pair sits between 50% and 64%, so outcome entropy is near its maximum everywhere and can't tell pairs apart. `D = 35` spreads the odds enough for entropy to discriminate.

## 4. A match shouldn't create rating out of nothing

On a scale capped at 100, I wanted every match to be zero-sum: whatever one side gains, the other loses.

Ascension v1.2.6 leans the other way on a wide-gap upset. It scales the underdog's gain up (`getUnderdogMultiplier`, up to 1.5x) and the favorite's loss down (`getChallengeProtectionMultiplier`, down to 0.7x) on the same match. Every win is also guaranteed at least one point (`Math.max(1, winnerGain)`), and the chained `Math.ceil` steps round every adjustment up.

Xenith applies one factor, `lossAttenuation`, to both sides of an upset equally, and rounds once at the end.

Over 200,000 simulated matches from a settled pool, with both sides at equal experience and the favorite winning 65% of the time, Ascension's math adds about 2.0 rating points to the pool per match. Xenith's adds exactly 0. The worst single case: a 50-rated performer beats an 85-rated one, and Ascension hands out +17/−5, a net +12 from one match.

Rating that gets created has nowhere to go but the ceiling, so S-tier fills up over time and a tier badge stops telling you much. `XENITH.md` §3.3 has the longer argument.

_Caveat: Xenith can still net positive rating when the two sides carry different K-factors. A fresh, high-K underdog beating a settled favorite is a deliberate inflow, since new items should move fast. The comparison above uses equal K._

## 5. Fewer knobs

I wanted the rating engine simpler, with fewer knobs and no overlapping adjustments. v1.2.6 stacks rating-band gain cuts, a rating-over-60 K reduction, experience decay, per-mode K multipliers, and per-mode streak dampeners. Many of them damp the same favorite's gain, and they all multiply together.

Xenith ships two that don't overlap:

1. Experience decay, where K falls as an item plays more matches
2. Symmetric attenuation of upsets (from section 4)

The stack leaves visible artifacts. At a 90-vs-88 matchup, Ascension gives the winner +4 and takes 7 from the loser, a net of −3, so routine wins near the top lose rating while upsets lower down create it. Every equal-K matchup in Xenith nets to zero wherever it falls on the scale.

## 6. A lucky first win shouldn't top the board

Ascension's display score (`compositeScore`) is `rating/100 + winRate * 0.5 + winMargin/1000 + totalMatches/10000`. But `rating100` already is the accumulated record of every win and loss, so adding win rate re-counts it, and the match-count term pays out again for volume. A performer who won their only match can outrank one with a strong rating over 40 matches.

Xenith's is `max(0, rating - 1.645 * sigma) / 100`, where sigma shrinks as match count grows: a one-sided 90% confidence bound that discounts a thin record. In `XENITH.md` §4.3's example, a fresh performer at 1 match and a raw 66 displays at about 48.5, while a 40-match veteran at a raw 53 displays at about 49.1. The veteran still edges out the newcomer.

## 7. A smaller pool, redrawn every match

Ascension pulls up to 800 items sorted by `updated_at`, with a 5% chance of pulling 200 at random instead, and reuses that sample for the next 50 matches. Xenith pulls up to 500 items at random and resamples on every match.

Xenith's cap is the smaller one. On a library bigger than either cap, most of it goes unreached in any one sample either way. What differs is that Xenith's sample is random and redrawn every match.

## 8. One noisy result shouldn't lock a placement

Ascension's Gauntlet-style mode is a climb-or-fall search: win and you face someone higher, lose and you drop into a falling phase. That commits to a direction on a single match.

Xenith's Gauntlet keeps a probability distribution over where you belong on the ladder and updates it after every match. One unlucky loss shifts the odds without fixing the placement. `XENITH.md` §3.8 has the full argument, including why a binary-search bisection was rejected too.
