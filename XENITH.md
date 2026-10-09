# Xenith Ratings Explainer

How Xenith's rating and matchmaking system works. For how it differs from the plugin it forked, see [`docs/rating-differences.md`](docs/rating-differences.md).

## 1. Executive Summary & Design Philosophy

Xenith is a Stash plugin for rating your own library, performers and scenes both, by picking a winner in head-to-head matchups. Under the hood it runs a variant of Elo, the system chess uses to rank players: every comparison nudges both items' ratings based on who won and how surprising that was.

Standard Elo was built for an open-ended scale that runs into the thousands. Xenith adapts the same ideas to a scale fixed at 0 to 100, because that's Stash's own `rating100` field. Stash already sorts, filters and searches by it, so a Xenith rating is a real Stash rating, with no shadow value that only the plugin understands.

I wanted real signal out of few clicks, with no extra friction. Picking the most informative pairing, letting new items move fast while settled ones move slowly, and discounting a rating's display value until enough matches back it up all squeeze structure out of a modest amount of voting.

## 2. Core Principles & Human Factors

### 2.1 A Bounded 0–100 Scale, and Why D = 35

Elo predicts the odds from the rating gap using one tunable knob, a scale factor `D`. A smaller `D` makes the same gap predict a more lopsided result.

Standard Elo's $D = 400$ is tuned for ratings in the thousands; squeezed onto 0 to 100, the knob barely turns. Xenith sets $D = 35$. A 10-point gap now predicts the higher-rated item wins about two times out of three (65.9%), and a 40-point gap predicts 93.3%. See `docs/rating-differences.md` §2 for the $D = 400$ numbers.

### 2.2 Starting New Items at 50, Not 0

An unrated item enters at 50: dead center of the scale, inside the C tier (31 to 59, see §5), and the least assumptive starting point available. Starting at 0 would hand every new item an F-tier handicap and force manual voting just to drag a decent item out of the bottom.

### 2.3 Only Three Outcomes: Win, Loss, Draw

Every comparison resolves to a win (1.0), a loss (0.0) or a draw (0.5), which is what a skip records as.

Offering a "how much better" slider adds a second judgment on top of the first, and Hick's Law says more choices means more time deciding. Graded answers also drift: a strong win on Monday morning and a weak win for the same preference on Friday evening are one fact reported two ways. A binary choice can't drift like that, and more fast votes fit in a sitting than careful graded ones.

## 3. Mathematical Specifications

### 3.1 Expected Score and the Rating Update

For items A and B with ratings $R_A$ and $R_B$, A's expected score is the probability A wins:

$$
E_A = \frac{1}{1 + 10^{(R_B - R_A)/35}}
$$

Equal ratings give exactly 0.5. The actual outcome $S_A$ is 1.0, 0.5 or 0.0 (§2.3), and the new rating is the old one nudged by how far the outcome missed the expectation, scaled by a per-item K-factor (§3.2):

$$
R_A' = \operatorname{clamp}\bigl(R_A + K_A (S_A - E_A),\ 0,\ 100\bigr)
$$

An expected win barely moves the rating; a heavy underdog winning moves it a lot. The clamp keeps results on the scale.

### 3.2 K-Factor: How Fast a Rating Can Move

K is large for a new item, so it finds its level fast, and small for a settled one, so a fluke can't yank it around. It decays smoothly with match count.

The endpoints scale with library size, so a 500-item scene library and a 5,000-item performer library each get their own tuning. For a content type with $N$ items:

$$
\begin{aligned}
k_{\min}(N) &= \operatorname{clamp}\bigl(\lfloor 8 + 3\log_{10}(N/100) \rfloor,\ 8,\ 16\bigr) \\
k_{\max}(N) &= \operatorname{clamp}\bigl(\lfloor 24 + 6\log_{10}(N/100) \rfloor,\ 24,\ 40\bigr) \\
m_{\text{decay}}(N) &= \operatorname{clamp}\bigl(\lfloor 15 + 15\log_{10}(N/100) \rfloor,\ 15,\ 50\bigr)
\end{aligned}
$$

At roughly 2,500 items that's $k_{\max} = 32$, $k_{\min} = 12$, $m_{\text{decay}} = 35$: a brand-new item moves up to 32 points on an upset, a veteran at most 12.

The shipped curve is a sigmoid with a fixed midpoint at 18 matches. It replaced the straight line $K(m) = k_{\max} - (k_{\max} - k_{\min})\min(1, m/m_{\text{decay}})$ first spec'd. Only the endpoints are dynamic; $m_{\text{decay}}$ is computed but not wired into the curve's shape yet. The sigmoid's asymptote is $k_{\max}/3$: across every supported library size $k_{\min}$ sits between a third and two-fifths of $k_{\max}$, so $/3$ is the largest asymptote that still lets a settled item actually reach $k_{\min}$. See `src/elo.js`'s `experienceFactor`.

Decay is the only thing slowing high-rated items. There's no second tier-based brake; a match between two top-tier items already swings little because $D = 35$ compresses the expected-score gap at close ratings, and one mechanism is easier to reason about than two that interact.

### 3.3 Underdog Loss Mitigation

A lopsided loss is as often a misclick as a real reversal, so Xenith softens genuine upsets.

The trigger is a gap over 15 rating points where the higher-rated item loses. Draws never trigger it. Both the favorite's loss and the underdog's gain are scaled by the same factor, which decays smoothly from exactly 1 at a 15-point gap toward a floor as the gap widens, so a real upset always registers as some movement. A favorite winning as expected is never attenuated.

The factor is identical on both sides; the point totals can still differ because each side keeps its own K (§3.2).

I dampen both sides for two reasons. It's a one-way pump: the underdog gains more than the favorite loses, and on a scale capped at 100 that excess piles up at the ceiling until S tier means less. And the premise, "this result might be noise," applies equally to the underdog's gain; fully rewarding it while doubting the loss doesn't hold together.

_Caveat: a match can still net positive rating when the two sides carry different K-factors. A fresh, high-K underdog beating a settled favorite is a deliberate inflow, because new items should move fast (§4.1). Attenuation only guarantees it can't create rating by itself._

### 3.4 Uncertainty and the Display Rating

A single lucky win can spike a new item far above where it will settle. Xenith keeps the raw rating as the real number and computes a second, conservative one for display and sorting.

$$
\begin{aligned}
\sigma(m) &= \frac{15}{\sqrt{m + 1}} \\
\text{displayRating} &= \max\bigl(0,\ R - 1.645\,\sigma(m)\bigr)
\end{aligned}
$$

1.645 is the one-tailed 90% bound: the item's true rating is at least that likely to sit above the displayed value, given how few matches back it up. This is what the Leaderboard sorts by and shows in its Score column. It is deliberately not what decides tier, which stays on raw rating (§5). §4.3 has a worked example.

### 3.5 Transitive Delta Propagation

_Planned. Not built yet._

If A beats B, that's weak evidence A would also beat whatever B has lost to. A future pass would spread a fraction of each rating change to items up to two hops away in the comparison history:

$$
\Delta_{\text{prop}}(X \leftarrow A) = \Delta_{\text{direct}}(A) \cdot 0.25^{\text{hops}} \cdot \frac{1}{\sqrt{\text{matchCount}(X) + 1}}
$$

`hops` is one or two; the `0.25` shrinks the effect with distance and the match-count term dampens it for established items. It waits on the K-factor, D-scale and loss-mitigation formulas settling in production, since propagated deltas need stable dynamics to build against. See §7.

### 3.6 Picking the Most Informative Match

Two wildly mismatched items give a near-certain result and teach little; two close ones could go either way and teach more. Xenith weighs candidate pairings by Shannon entropy, which peaks at a coin flip and falls toward zero as the outcome becomes predictable:

$$
H(A, B) = -E_A \log_2 E_A - (1 - E_A)\log_2(1 - E_A)
$$

Undersampled items get a boost, since less is known about them:

$$
\text{priority}(A, B) = H(A, B)\left(1 + 0.5\cdot\frac{\sigma_A + \sigma_B}{15}\right)
$$

The $/15$ normalizes sigma against its maximum (a brand-new item's), so the $0.5$ weight applies to a 0-to-1 value. Unnormalized, uncertainty could outweigh entropy up to 15x and priority would mostly be a novelty score with entropy as a tiebreaker.

There's no tier-rotation or tier-balancing logic; entropy is the only driver of pairing priority. Items in a rarely-visited tier tend to carry high uncertainty, so undersampled tiers should get attention on their own. That expectation hasn't been measured separately.

### 3.7 Cooldown: Not Facing the Same Match Twice in a Row

Anyone who just played is dropped from the candidate pool entirely, a hard exclusion rather than a lower weight, until newer matches push them out of a 20-entry queue. Each entry is one full match with both participants, so the buffer holds 20 matches of history (up to 40 items).

If the exclusion would leave fewer than 2 candidates, it's skipped and the full pool is used. In a small enough library the buffer can block up to 40 IDs and cooldown stops mattering rather than blocking every match. Performers and scenes can share a numeric Stash ID, so each type keeps its own buffer. The buffer is session-only, like the repeat-opponent penalty.

Size is counted in matches rather than wall-clock time, so a fast session can't empty it and let the same pairs cluster back in (§4.5).

### 3.8 Gauntlet Mode: A Probability Distribution, Not a Bracket

Gauntlet places one challenger against a frozen snapshot of the ladder in a focused run, instead of letting it drift to its rank over hundreds of ordinary matches.

Other plugins use a climb-or-fall search: win and you face someone higher, lose and you enter a falling phase. A classic bisecting binary search is no better. Both commit hard on every result, and a well-chosen probe lands near a coin flip, so one unlucky first loss permanently caps the placement in the bottom half with no way back. It's the same "one bad result shouldn't wreck everything" concern as §3.3, applied to a placement search.

Instead, a run keeps a posterior over where on the ladder the challenger belongs. It starts flat, and each match multiplies in a likelihood using §3.1's expected score:

With $e_i$ the expected score of the ladder entry at position $i$ against the challenger, each posterior weight $p_i$ is multiplied by:

$$
p_i \leftarrow p_i \cdot
\begin{cases}
e_i & \text{challenger won} \\
1 - e_i & \text{challenger lost} \\
\sqrt{e_i (1 - e_i)} & \text{draw}
\end{cases}
$$

then renormalizes to sum to 1. The draw form (Bradley-Terry) peaks where the pair is evenly matched and carries no directional signal, which is the right read of a draw. Every match reshapes the whole distribution, so a surprising early result gets corrected by consistent evidence afterward.

The search runs on raw `rating100`, not the display rating. Display rating improves with match count, and every probe adds one to the challenger's, so a new challenger could gain roughly 18 display points over a 14-match run from uncertainty decay alone. Raw rating has no such feedback. The placement screen shows its rating-based rank beside the Leaderboard's display-sorted rank so the two don't read as contradicting.

The next probe comes from the 5 ladder entries nearest the posterior median (the most informative next test, a binary search's midpoint expressed as belief), excluding anyone already faced, weighted by §3.6's entropy. That keeps the same gatekeeper from being probed every run.

A run is at least 10 matches and at most 14 (`MIN_MATCHES`, `MAX_MATCHES` in `src/gauntlet.js`). It ends at the cap, or earlier once past the minimum when the posterior's 80% credible interval narrows to $\max(5, \lceil 0.02 \cdot \text{ladderSize} \rceil)$ positions or fewer. Because that target scales with ladder size, a larger library places more coarsely in absolute rank.

No gauntlet-specific K multiplier or streak dampener exists (same single-mechanism reasoning as §3.2/§3.9); the challenger's K decays through the normal sigmoid as its match count climbs.

Both content types work. If a gender filter is active at run start (performers only; scenes have no gender field), the ladder snapshot is scoped to it, the termination math uses the filtered size, and the placement screen labels its rank as relative to that pool. The shared rank cache stays unfiltered; only the ladder build filters, client-side.

A ladder below the minimum size is refused. A run needs a fresh opponent every match, and a short ladder would run out partway through while the termination floor spans the whole ladder, producing a confident "Placed!" over what is still a flat guess.

The ladder is frozen for the whole run, since each posterior position maps to a specific ladder slot. A filter change mid-run applies only at next-opponent selection: anyone outside the filter is excluded as a probe. If narrowing exhausts every eligible entry before termination, the run says so rather than failing silently.

### 3.9 Champion Mode: Staying on Top Without a Special-Cased K-Factor

One incumbent defends its spot against a stream of challengers for as long as it keeps winning. Unlike Gauntlet there's no falling phase; a reign ends by a loss or by hitting its cap.

Other plugins halve K for this mode so an unbeaten incumbent stops gaining at full speed. Xenith adds nothing; `src/elo.js` is untouched. $D = 35$ already shrinks the gain per win as the lead grows:

| Champion's rating lead | Expected score | Gain per win |
| --- | --- | --- |
| +10 | 0.67 | 0.33K |
| +25 | 0.84 | 0.16K |
| +40 | 0.93 | about 0.07K, or 1-2 points |

Each defense also adds to the champion's match count, decaying its K through §3.2's sigmoid. A third, mode-specific dampener would be redundant.

_Caveat: this doesn't inflate ratings the other way either. A champion beating a fresh, high-K challenger is rating-negative for the pool, since the loser's K is the bigger one. A dethrone is inflationary, but that's the deliberate new-item velocity from §4.1, already symmetrically dampened by §3.3 past a 15-point gap._

The reign cap is 10 defenses (`MAX_DEFENSES` in `src/champion.js`). An unbeaten champion's matches grow predictable as expected score climbs toward 1 (§3.6), so the tenth defense tells you almost nothing. A long reign also turns the comparison graph into a hub connected only through the champion, the same structural concern as Gauntlet's match cap. At the cap a fresh seed is drawn through ordinary matchmaking; a challenger win at any point starts a new reign at zero defenses.

Champion is ordinary matchmaking with the seed pinned: the champion is stage 1, and the entropy-weighted opponent search, cross-tier events and failover run verbatim. Any improvement to shared selection applies automatically. There's no ladder dependency, so both content types have supported it from day one.

## 4. In-Depth Algorithmic & Statistical Rationales

### 4.1 Why K-Factor Scales With Library Size

A fixed K would feel too fast in a small library and too slow in a large one. Scaling the upper bound keeps a new item's initial velocity right at 500 items or 50,000; at the 2,500-item reference ($k_{\max} = 32$), a new item leaves the neutral zone quickly and finds roughly its tier within its calibration window.

The $k_{\min}$ floor of 12 keeps long-term flexibility. Taste changes, and a real floor lets an established item's rank shift smoothly while a single fluke still can't cause a wild swing. The shipped curve doesn't use $m_{\text{decay}}$ directly (§3.2).

### 4.2 Why Underdog Protection Isn't Redundant

In zero-sum Elo, a big enough upset inflicts a severe penalty on a heavy favorite, precisely because their win expectation was near 1. In a casual workflow that loss is often a misclick. Dampening wide-gap swings caps the damage.

Two nearby mechanisms leave gaps:

1. K-factor decay (§3.2) scales by experience only. A brand-new item sits at maximum K, the most volatile setting, so decay protects it from nothing.
2. Entropy pairing (§3.6) makes wide-gap matches less frequent but still possible. Forced cross-tier events and the failover chain can both still produce one.

Attenuation is the only one of the three that reacts to how surprising the actual result was. It covers exactly the case the others miss: a new item, unprotected by decay, landing in a wide-gap match that pairing didn't prevent.

It matters more under $D = 35$. At a 70-point gap, $D = 400$ predicts about 60% for the favorite, a mild surprise if the underdog wins. $D = 35$ predicts about 99%, so an upset there would otherwise swing the rating hard.

### 4.3 Why the Display Rating Protects Against Lucky Streaks

An initial uncertainty of 15 reflects not knowing where in the middle tiers a fresh item belongs, and dividing by $\sqrt{\text{matches} + 1}$ is the standard shape for uncertainty shrinking as evidence arrives.

A fresh item at 50 wins its first match against another 50 and jumps to 66. Unadjusted, it would outrank a veteran with 40 matches settled at a raw 53. With §3.4's formula the newcomer displays at $66 - 1.645 \cdot 15/\sqrt{2}$, about 48.5, and the veteran at $53 - 1.645 \cdot 15/\sqrt{41}$, about 49.1. The veteran still edges out the newcomer. This affects only the Leaderboard's Score column and sort order, never tiers (§5).

### 4.4 Future Feature: Keeping Propagated Ratings From Spiraling

Spreading changes outward without decay risks feedback loops. §3.5's `0.25` per hop forces the ripple to die fast (a quarter strength one hop away, a sixteenth two hops away), which guarantees the total converges.

A steep drop-off also fits how preference works: liking A over B and B over C doesn't guarantee liking A over C. Indirect relationships carry less certainty than a direct comparison.

### 4.5 How Smart Pairing and Cooldown Work Together

Always picking the closest-rated pair maximizes information per click and, in principle, cuts the comparisons needed to sort a library from roughly its size squared toward size times log size. Left alone, though, it keeps resurfacing the same closely-rated pairs. The 20-match cooldown (§3.7) breaks that up by match count, so a fast session can't flush the buffer and let the clustering return.

## 5. Tier Distribution, Calibrated Rather Than Guessed

I wanted a tier letter to mean the same share of any library. The six cutoffs are calibrated once, offline, against a simulated population running §3's real formulas, then stored as a fixed lookup (`TIER_BOUNDS` in `src/elo.js`; simulation in `qa/scripts/simulate-tier-bounds.mjs`):

| Tier | Target | What it represents |
| --- | --- | --- |
| S | Top 3% (97th percentile and up) | The very best, effectively protected from culling |
| A | Next 12% (85th to 96th percentile) | Strong performers |
| B | Next 25% (60th to 84th percentile) | The above-average core |
| C | Next 30% (30th to 59th percentile) | The default, baseline pool |
| D | Next 20% (10th to 29th percentile) | Below average |
| F | Bottom 10% | The primary culling candidates |

Pairwise ratings cluster toward the middle, so the cutoffs are read off the settled distribution rather than spaced evenly. `docs/rating-differences.md` §1 shows what round-number cutoffs do to occupancy. Rerun the script and update this table whenever K, D or the attenuation formulas change.

Tiers key off the raw rating and ignore the discounted display rating. `rating100` is Stash's own field, so a Xenith badge always agrees with everything else Stash shows about that item. The uncertainty-discounted value stays where it's useful, the Leaderboard's Score column, instead of becoming a second notion of rating the rest of Stash can't see.

The simulation models the 10% forced cross-tier match that real matchmaking performs; it's what pulls drifted items back into real competition and lands S at about 3.0 to 3.6%, close to the 3% target. The `TIER_BOUNDS` comment block has the calibration history.

## 6. Execution Architecture

Xenith has no always-on engine. On the frontend, every rating update is one synchronous database write the moment you pick a winner: one per side, no batching, no local cache in front of it.

Reads are different. The full ranked list, the plugin's settings and a couple of other lookups are cached for 60 seconds behind the pages that need them (Leaderboard, badges, tooltips, match stats), and the cache clears the instant a match is recorded, so nothing is stale relative to your last write. The settings cache rejects on fetch failure rather than falling back quietly, so each reader decides what to assume. Session-only signals (the cooldown buffer, repeat-opponent penalties) live in memory while the panel stays open; they survive closing and reopening it but not a page reload. There's no persistent comparison graph and no background timer. `src/elo.js` never touches the network; anything live, like a type's item count for K scaling, is resolved elsewhere and passed in as a number.

On the backend, Python runs as a short-lived script started by Stash's task runner for each maintenance task (wipe, reset, export, import, migrate) and exits when it finishes. A second entry path handles batched match logging to Stash's debug log; it isn't a task and doesn't share task startup.

Match history lives in Stash's custom fields as plain JSON:

```json
// xenith_stats
{
  "total_matches": 12,
  "wins": 7,
  "losses": 4,
  "draws": 1,
  "current_streak": 2,
  "best_streak": 4,
  "worst_streak": -3,
  "last_match": "2026-07-30T18:42:00.000Z"
}
```

```json
// xenith_record (append-only, capped at 50 entries)
[
  {
    "date": "2026-07-30T18:42:00.000Z",
    "opponent": "1284:Jane Doe",
    "won": true,
    "ratingAfter": 61
  },
  {
    "date": "2026-07-30T18:45:00.000Z",
    "opponent": "1310:Alex Rivera",
    "draw": true,
    "ratingAfter": 60
  }
]
```

An opponent is `"id:name"` for a performer or `"id:title"` for a scene (generic label if untitled), written through one shared helper. A skip is a draw entry (`draw: true`, no `won` field), not a loss. Both fields are written in the same call as the rating update: one round trip, nothing to keep in sync.

These names replaced ones inherited from an earlier plugin. Old data is still read as a fallback, and a maintenance task migrates it over after taking its own safety snapshot.

## 7. Roadmap: Deferred & Future Work

Transitive delta propagation (§3.5, §4.4) is designed but unbuilt, and waits on the core formulas settling in production. One gap to solve first: a propagated change has no winner or opponent to log in the history format, and undo assumes every entry has exactly one of each. Propagation will need its own entry kind, probably not undoable the way a real match is.

Gauntlet (§3.8): the tier-bounds simulation doesn't yet model Gauntlet runs. With enough real usage, add a share-of-matches-via-Gauntlet parameter to confirm posterior placement doesn't skew tier occupancy the way unmodeled cross-tier matching once did (§5).

Champion (§3.9) retires a reign at a flat 10 defenses. A more principled rule ends it once the next defense's expected information gain drops below a threshold. Worth revisiting with real usage data to calibrate against.

## 8. How This Compares to Other Rating Plugins

Xenith began as a fork of [Ascension](https://github.com/Servbot91/Sakotos-Stash-Repo/tree/main/plugins/Ascension) v1.2.6 and rewrote most of the rating engine before its first release; `NOTICE` documents what carried over. The biggest change is §2.1 plus §3.3: a scale factor sized for 0 to 100, and an upset dampener that can't add rating to the pool. [`docs/rating-differences.md`](docs/rating-differences.md) has the side-by-side with exact functions and numbers.
