# Xenith Ratings Explainer

How Xenith's rating and matchmaking system actually works, grounded in the real code rather than a generic description of "an Elo engine."

## 1. Executive Summary & Design Philosophy

Xenith is a Stash plugin for triaging your own library, performers and scenes both, by picking a winner in head-to-head matchups. Under the hood it runs a variant of Elo, the rating system chess uses to rank players. Every comparison nudges both items' ratings based on who won and how surprising that result was.

Standard Elo (and TrueSkill, its more modern cousin) were built for competitive ranking on an open-ended scale that can run into the thousands. Xenith adapts the same statistical ideas to a scale fixed at 0 to 100, because that's Stash's own `rating100` field. Every other part of Stash already sorts by it, filters on it, and searches with it. Using that same field directly means a Xenith rating is a real Stash rating, so nothing needs a second, shadow value that only Xenith understands.

The goal throughout is getting real statistical signal out of a small number of clicks without adding extra friction for the person doing the clicking. Picking the most informative pairing, letting new items' ratings move fast while settled items' ratings move slow, and discounting a rating's display value until enough matches back it up all pull structure out of a modest amount of voting. Every rating update is also just one direct database write the moment you pick a winner. There's no background job, no batch process, nothing running after you close the tab.

## 2. Core Principles & Human Factors

### 2.1 A Bounded 0–100 Scale, and Why D = 35

Elo predicts how likely one side is to win from the ratings alone, using a formula with one tunable knob: a scale factor (usually written D) that controls how much a given rating gap should move the predicted odds. A smaller D means the same point gap predicts a more lopsided outcome.

Standard Elo uses D = 400, tuned for ratings that range into the thousands. Squeezed onto a 0-to-100 scale, that knob barely turns at all. See `docs/rating-differences.md` for what happens when a 0-to-100 system keeps D = 400 unchanged. Xenith sets D = 35 instead, sized for the scale it actually runs on.

In practice, a 10-point rating gap under D = 35 predicts the higher-rated item wins about two times out of three. That's enough movement to feel meaningful without rocketing an item straight to 0 or 100 after a single match.

It also means Xenith never needs an internal rating that only it understands. The number stored in `rating100` is the real rating, the same one Stash's own interface already uses everywhere else, in its filters and its search alike.

### 2.2 Starting New Items at 50, Not 0

An unrated performer or scene enters at 50, dead center of the 0-to-100 scale and inside the neutral C tier (31 to 59, see §5), though not that tier's own midpoint. It's the least assumptive starting point available: no claim about whether the item is good or bad until comparisons say otherwise.

Starting at 0 instead would hand every new item an automatic F-tier handicap. That skews the low end of the scale and forces a lot of manual voting just to drag a perfectly decent item out of the bottom before it's had a fair shake.

Every parameter in this document that's tuned per content type, K-factor bounds and uncertainty calibration in particular, gets validated against performers before scenes. The two run on identical math but draw from independently sized pools, so there's no reason one has to wait on the other beyond wanting to confirm the numbers work in practice first.

### 2.3 Only Three Outcomes: Win, Loss, Draw

Every comparison in Xenith resolves to exactly one of three values: a win worth 1.0, a loss worth 0.0, or a draw worth 0.5, which is what a skip records as.

There's a real cost to offering more granularity than that, and it's worth explaining why Xenith doesn't. Asking someone to rate how much better one item is, on a 1-to-5 scale say, adds a second judgment call on top of the first one. Psychology calls the resulting slowdown Hick's Law: more choices, more time spent deciding. A binary choice skips that entirely. It also avoids drift over time: a strong win on a Monday morning and a weak win for the same underlying preference on a Friday evening are the same fact reported two different ways, and a plain win can't drift like that. Fast binary decisions also add up to a stable ordering faster than a smaller number of carefully weighed fine-grained scores, simply because more of them fit in the same amount of time.

## 3. Mathematical Specifications

### 3.1 Expected Score and the Rating Update

Here's the actual arithmetic behind every match. For two items A and B with ratings `R_A` and `R_B`, Elo first computes A's expected score: the probability A should win, based purely on the rating gap.

```
E_A = 1 / (1 + 10^((R_B - R_A) / 35))
```

That's the D = 35 formula from §2.1. If the two ratings are equal, `E_A` comes out to exactly 0.5, a coin flip, as it should be.

The actual outcome (`S_A`) is one of the three values from §2.3: 1.0 for a win, 0.5 for a draw, 0.0 for a loss. The new rating is the old one nudged by how far the actual outcome missed the expectation, scaled by a per-item multiplier called the K-factor (`K_A`, covered next in §3.2):

```
R_A' = clamp(R_A + K_A * (S_A - E_A), 0, 100)
```

If A was expected to win and did, `S_A - E_A` is small and the rating barely moves. If A was a heavy underdog and won anyway, `S_A - E_A` is close to 1 and the rating jumps. The clamp just means the result never goes below 0 or above 100, even in an extreme upset right at the edge of the scale.

### 3.2 K-Factor: How Fast a Rating Can Move

The K-factor is the "how much" in the formula above. It's a multiplier that's large for a brand-new item, so it finds its real level quickly, and small for a well-established one, so a single fluky result can't yank it around. It shrinks smoothly as an item plays more matches, with no sudden jump partway through.

What's new in this version is that the endpoints of that shrink, how fast a new item starts and how slow a veteran ends up, scale with how many items you actually have. Performers and scenes are counted separately, so a 500-item scene library and a 5,000-item performer library each get their own tuning.

For a content type with `N` items:

```
kMin(N) = clamp(floor(8 + 3*log10(N/100)), 8, 16)
kMax(N) = clamp(floor(24 + 6*log10(N/100)), 24, 40)
mDecay(N) = clamp(floor(15 + 15*log10(N/100)), 15, 50)
```

For a library of roughly 2,500 items, that works out to `kMax = 32`, `kMin = 12`, `mDecay = 35` matches. In plain terms: a brand-new item in a 2,500-item library moves by up to 32 points on a single upset, while a veteran with 35 or more matches moves by at most 12.

The shape of the curve between those two numbers, for an item with `m` completed matches, was originally spec'd as a straight line down to a cutoff:

```
K(m) = kMax - (kMax - kMin) * min(1, m/mDecay)
```

What's actually shipped is a sigmoid curve instead, an S-shaped curve with a fixed midpoint at 18 matches, rather than that straight-line version. Only the endpoints (`kMin` and `kMax`) ended up dynamic; `mDecay` gets computed but isn't wired into the curve's shape yet. See `src/elo.js`.

The sigmoid's flat asymptote sits at `kMax / 3` rather than the more conventional `kMax / 2`. That's deliberate. Across every library size this system supports, `kMin` works out somewhere between a third and two-fifths of `kMax`, so a `/3` floor is the largest asymptote that still lets a long-established item's K-factor actually reach `kMin` instead of getting stuck above it. An earlier version used `/2`, which sat above `kMin` at every library size, meaning settled items had been moving about a third faster than this document claimed. See `src/elo.js`'s `experienceFactor`.

K-factor decay is the only thing controlling how fast ratings can move. There's no second multiplier that further slows down high-rated items specifically. A match between two top-tier items already produces a small rating swing on its own, just from D = 35 compressing the expected-score gap at close ratings. A second, tier-based brake on top was considered and left out on purpose. One mechanism is easier to reason about than two that interact.

### 3.3 Underdog Loss Mitigation

Sometimes a comparison result is a misclick, or a moment of fatigue, rather than a real judgment. Xenith softens the rating swing on results like that, but only when the result is a genuine upset.

The trigger is whenever the two paired items sit more than 15 rating points apart and the higher-rated one loses. Draws never trigger this: there's no winner or loser in a draw, so "the higher-rated one loses" can't happen, and `calculateDrawOutcome` never applies it regardless of the rating gap.

What happens then is that both sides of the match get scaled down by the same factor as the gap widens: the favorite's point loss and the underdog's point gain, together. The scaling is smooth, with no sudden jump right at the 15-point trigger, and it never reaches all the way to zero. A real upset always moves the ratings by some amount, just a dampened one.

"Both sides scaled by the same factor" doesn't mean both sides move by the same number of points. Each side still has its own K-factor from §3.2, so the actual point totals can differ. It's the dampening factor itself that's identical on both sides, and that turns out to matter a lot.

An earlier version only dampened the loser's side, protecting the favorite from an inflated loss while leaving the underdog's gain untouched. That was tried and dropped for two reasons. First, it's a one-way pump: on every wide-gap upset, the underdog gains more than the favorite loses, and since the scale is capped at 100, that excess has nowhere to go but up. It piles up at the ceiling and makes S tier mean less over time. Second, the reasoning behind dampening in the first place, that this result might just be noise, applies equally to both sides. If it's noise, the underdog's gain is exactly as suspect as the favorite's loss. Believing the result enough to fully reward the underdog while doubting it enough to protect the favorite doesn't hold together.

None of this stops a real upset from being recognized. The dampening floor keeps every genuine upset registering as some rating movement, and as a truly underrated item keeps winning, the gap between it and its opponents narrows and the dampening eases off on its own.

Worth being precise about: dampening an upset doesn't make the system conservative overall. It only guarantees the dampening step itself can't manufacture rating out of thin air. A match can still add net rating to the pool for an unrelated reason, since the two sides can carry different K-factors. A brand-new underdog beating a settled favorite is a real, intentional net gain (see §4.1 on why new items are meant to move fast). See §4.2 for why this mechanism doesn't just duplicate what K-factor decay or entropy-weighted pairing (§3.6) already do.

### 3.4 Uncertainty and the Display Rating

A raw rating and a trustworthy rating aren't the same thing. A single lucky win can spike a brand-new item's number well past what its long-run rating will settle at. Xenith keeps the raw rating as the real number, the one everything else in this document uses, but computes a second, more conservative number just for display and sorting.

The uncertainty estimate, `sigma`, shrinks as an item plays more matches:

```
sigma(m) = 15 / sqrt(m + 1)
```

The display rating then discounts the raw rating by that uncertainty:

```
displayRating = max(0, R - 1.645 * sigma(m))
```

The 1.645 comes from statistics. It's the standard multiplier for a one-tailed 90% confidence bound, meaning the resulting number is a value the item's true rating is at least 90% likely to sit above, given how few matches back it up. In practice, the fewer matches an item has, the more its raw rating gets discounted before it's allowed to compete on the Leaderboard's sort order.

This value is what the Leaderboard sorts by and shows in its Score column. It's deliberately not what decides an item's tier. Tier assignment stays keyed to the raw, undiscounted rating, and §5 explains why.

### 3.5 Transitive Delta Propagation

This section describes a planned feature. It hasn't been built yet.

If item A beats item B, that result is weak evidence that A would also beat anything B has previously lost to, even though A never actually played those items. A planned future pass would spread a fraction of every rating change out to nearby items in the comparison history, two steps removed at most:

```
propagatedDelta(X, from A) = directDelta(A) * 0.25^hops * 1/sqrt(matchCount(X) + 1)
```

`directDelta(A)` is the rating change from the actual match. `hops` is how many steps removed X is from that match, one or two. The `0.25` shrinks the effect sharply with distance, and the match-count term dampens it further for well-established items.

This is waiting on the current K-factor, D-scale, and loss-mitigation formulas getting locked down and validated in production first. Propagated deltas need to be computed against rating dynamics that have actually settled, since building against formulas still being tuned means redoing the math once they change. See §7 for where this sits on the roadmap.

### 3.6 Picking the Most Informative Match

Not every possible pairing teaches you the same amount. Two wildly mismatched items produce a near-certain outcome and barely update anything, while two closely-rated items could go either way and move the needle more. Xenith weighs candidate pairings by how much each one is expected to teach, using a concept from information theory called Shannon entropy. It's a way of measuring how uncertain an outcome is, peaking exactly at a coin flip and dropping toward zero as the outcome becomes more predictable.

For a given expected score `E_A` (from §3.1), the entropy of that matchup is:

```
H(A, B) = -E_A * log2(E_A) - (1 - E_A) * log2(1 - E_A)
```

That value then gets scaled up further when either side is undersampled, meaning it still holds a high `sigma` from §3.4. Those items get an extra boost, since less is known about them and there's more to learn:

```
priority(A, B) = H(A, B) * (1 + 0.5 * (sigma_A + sigma_B) / 15)
```

The `/15` normalizes sigma against its own maximum value, which is 15, what a brand-new item's sigma starts at, before the `0.5` weight applies. Without that normalization, uncertainty alone could swing priority by up to 15x, dwarfing entropy and turning this into mostly a pick-the-newest-thing score with entropy as an afterthought. Normalizing keeps entropy as the main driver, with uncertainty only breaking ties in favor of undersampled items.

This replaced an earlier design that tried to actively balance which tier got matches, by fitting a curve to the current rating distribution and steering toward whichever tier looked underrepresented. That tier-rotation logic has been removed entirely, with nothing kept in reserve as a fallback. Entropy weighting is the only thing driving pairing priority. The reasoning is that it solves the more direct problem of picking whichever comparison is most worth making right now, and undersampled tiers are expected to naturally get more attention anyway, since items in a rarely-visited tier tend to also be the ones carrying high uncertainty. That expectation hasn't been separately measured since the old mechanism was removed.

### 3.7 Cooldown: Not Facing the Same Match Twice in a Row

To keep a session from repeatedly resurfacing the same pairing, Xenith tracks a rolling history of recent matches and won't offer either participant again until they've cycled out of it.

Anyone who's just been in a match is dropped entirely from the candidate pool, a hard exclusion rather than a lower weight, until enough newer matches have pushed them out of a 20-entry queue. Each entry is one full match with both participants, so the buffer holds 20 matches worth of history rather than 20 individual items. If excluding everyone currently in the buffer would leave fewer than 2 eligible candidates, the filter is skipped and the full pool is used instead; since each match blocks 2 IDs, a full buffer can block up to 40, enough that in a small enough library, cooldown effectively stops mattering rather than blocking every possible match.

This buffer resets whenever the session ends, alongside the other session-only signals like repeat-opponent penalties. Nothing here is saved between visits. Performers and scenes can also share the same numeric Stash ID, so each content type keeps its own buffer, avoiding one accidentally blocking the other.

The 20-match size is meant to line up with §3.5's two-hop propagation once that ships. The idea is that a comparison's effects should fully ripple outward before the same item comes back up for a new one, and that reasoning only makes sense measured in matches, which is exactly what this buffer counts.

### 3.8 Gauntlet Mode: A Probability Distribution, Not a Bracket

Gauntlet is a second way to play matches, alongside the continuous pairing described above. Instead of drifting toward its true rank over hundreds of ordinary matches, one challenger runs a focused series of matches against a frozen snapshot of the ladder to find its placement quickly.

Every earlier plugin Xenith knows of that does something like this uses a straightforward climb-or-fall approach: win, and you face someone ranked higher; lose, and you enter a falling phase testing lower-ranked opponents. Xenith uses neither that shape nor a classic bisecting binary search. Both were considered and rejected for the same reason.

A binary search commits hard on every comparison. Win, and the bottom half of the search space is discarded for good; lose, and the top half is. But a single match result here is inherently noisy rather than a reliable verdict. A well-chosen probe naturally lands close to a coin flip, so one unlucky loss on the very first probe would permanently cap the final placement in the bottom half of the ladder, with no way to recover. That's the same "one bad result shouldn't wreck everything" concern behind §3.3's underdog protection, applied here to a placement search instead of a single rating update.

Instead, a run keeps a posterior, meaning a probability distribution updated as evidence comes in, over which position on the ladder the challenger actually belongs at. It starts as a flat guess where every position is equally likely, and each match updates every position's likelihood using the same expected-score math from §3.1:

```
e_i = expectedScore(ladderRating_i, challengerRating)

posterior_i *= e_i          if the challenger won
posterior_i *= (1 - e_i)    if the challenger lost
posterior_i *= sqrt(e_i * (1 - e_i))    if it was a draw
```

The whole distribution is then renormalized so it still sums to 1. The draw case uses a standard form (Bradley-Terry) that peaks exactly where the two are evenly matched and carries no directional signal either way, which is the right read of a draw, since unlike a win or a loss it doesn't say which side of the ladder the challenger belongs on.

Every match is evidence that reshapes the whole distribution, never a commit that throws half the ladder away. A surprising early result still gets corrected by consistent evidence afterward, which a hard-commit bracket search can't do by design.

The search itself runs on raw `rating100`, not the display rating from §3.4. The display rating's uncertainty discount shrinks purely from playing more matches, and every probe in a run adds to the challenger's own match count. Searching on the display rating would let the search axis drift just from participation, independent of whether the challenger actually won or lost. At the extreme, a brand-new challenger could gain roughly 18 display-rating points over one 14-match run from uncertainty decay alone. Raw rating has no such feedback loop. The placement screen shows this rating-based rank right alongside the Leaderboard's own display-rating-sorted rank, so the two don't read as contradicting each other.

Choosing which opponent to probe next comes down to the posterior's median, the point where half the probability mass sits above it and half below. That's the single most informative next test, the direct equivalent of a binary search's midpoint but expressed as belief instead of ladder position. To avoid the same one or two ladder entries getting probed in every run, the actual opponent is drawn from the 5 ladder entries nearest that median, excluding anyone already faced this run, weighted by the same entropy calculation from §3.6.

Every run is at least 10 matches and at most 14 (`MIN_MATCHES` and `MAX_MATCHES` in `src/gauntlet.js`), long enough to be a real search regardless of how well-established the challenger's starting rating was, short enough to still fit in one sitting. It ends at the 14-match cap no matter what, or earlier, once past the 10-match minimum, once the posterior's 80% credible interval (informally, the range of ladder positions it's 80% confident the true placement falls within) narrows to `max(5, ceil(ladderSize * 0.02))` positions or fewer.

Gauntlet doesn't introduce its own K-factor multiplier or streak dampener, following the same single-mechanism reasoning as §3.2 and §3.3 (see §3.9 below for why Champion mode needs neither either). The challenger's own K-factor already decays through the normal sigmoid from §3.2 as its match count climbs during the run.

Gauntlet works identically on both performers and scenes. The ladder and challenger pool are just each type's ranked ordering (`rank-cache.js`). Since the termination rule's target width scales with ladder size, a run against a much larger library places more coarsely in absolute rank than the same run against a smaller one. That's expected, since a bigger ladder simply has more positions competing for the same confidence budget.

If a gender filter is active when a run starts, the ladder snapshot is scoped to it (scenes have no gender field, so this only applies to performers). The termination math above then uses the filtered ladder's size, and the placement screen labels its rank as relative to that filtered pool, shown next to the pool-wide Leaderboard rank so the two don't look like they disagree. The underlying cache Gauntlet reads from stays unfiltered and shared, since the Leaderboard and the other consumers reading from it all want the full pool; only Gauntlet's own ladder-build step applies the filter, client-side, over rows already fetched for everyone else.

A run below the minimum ladder size is refused outright rather than started. A run needs a fresh, unfaced opponent every single match, so a too-short ladder would run out partway through, and the termination rule's own floor would end up spanning the entire ladder anyway, letting the run claim a confident "Placed!" over what's really still close to a flat, uninformed guess.

The ladder itself stays frozen for the whole run, same as it always has. A filter change mid-run doesn't rebuild it or remap the posterior, since each position in the distribution corresponds to a specific ladder slot, and reshuffling the ladder underneath would invalidate every match already played. A filter that narrows mid-run instead gets enforced only at the next-opponent-selection step: anyone who's fallen out of the current filter is simply excluded from being offered as the next probe. If narrowing the filter exhausts every remaining eligible ladder entry before the run's own termination condition fires, the run says so explicitly rather than silently failing to offer a match.

### 3.9 Champion Mode: Staying on Top Without a Special-Cased K-Factor

Champion is the third and simplest mode. One incumbent defends its spot against a stream of new challengers for as long as it keeps winning. Unlike Gauntlet, there's no falling phase. A reign only ends by losing or by hitting its cap.

A hand-tuned rating dampener for exactly this situation is common among earlier plugins in this space. One example flatly halves the K-factor for this mode, on the reasoning that an unbeaten incumbent shouldn't keep gaining at full speed forever. Xenith doesn't add anything like that. `src/elo.js` is completely untouched by Champion mode.

The family's dampener compensates for a wide-scale expected-score curve, one where even a big lead still yields a meaningful gain per win. Xenith's D = 35 (§2.1) already shrinks that gain sharply as the lead grows on its own:

| Champion's rating lead | Expected score | Gain per win |
| --- | --- | --- |
| +10 | 0.67 | 0.33K |
| +25 | 0.84 | 0.16K |
| +40 | 0.93 | about 0.07K, or 1-2 points |

The bigger the lead, the smaller each additional win's payoff gets. That's the same effect a flat 0.5x multiplier is trying to approximate by hand, except here it falls directly out of the scale factor rather than being tuned separately. On top of that, every defense adds to the champion's own match count, which decays its K-factor toward the floor through the ordinary sigmoid from §3.2 regardless of mode. Stacking a third, mode-specific dampener on top of both of those would just be redundant.

It's worth checking this doesn't quietly inflate ratings in the other direction. A champion beating a fresh, high-K challenger is actually rating-negative for the pool overall, since the loser's K-factor, used to size their loss, is the bigger number in that matchup. A challenger dethroning the champion is inflationary, but that's the same deliberate new-item velocity discussed in §4.1, and it's already symmetrically dampened by §3.3's upset protection once the gap passes 15 points. Neither direction needs anything mode-specific added.

The reign cap is 10 defenses (`MAX_DEFENSES` in `src/champion.js`). An unbeaten champion produces increasingly predictable, low-information matches as its expected score climbs toward 1 (§3.6). The 10th straight defense tells you almost nothing new. Every match in a long reign also shares the same champion as one side, so a long enough reign starts to look like a hub with everything connected only through it rather than a well-mixed comparison graph, the same structural concern behind Gauntlet's own match cap in §3.8. At the cap, the reign ends and a fresh seed is drawn through ordinary matchmaking. A challenger win at any earlier point ends the reign immediately and starts a new one from zero defenses.

Where some earlier plugins build separate logic just for picking a Champion-mode challenger, Xenith's Champion mode is ordinary matchmaking with one side pinned: the champion is the seed, and everything downstream, the entropy-weighted opponent search, cross-tier events, failover, runs exactly as it does for a normal match. Any future improvement to that shared selection logic applies to Champion mode automatically. It also has no ladder dependency the way Gauntlet does, so both content types have supported it from day one.

## 4. In-Depth Algorithmic & Statistical Rationales

### 4.1 Why K-Factor Scales With Library Size

Scaling the K-factor's upper bound to library size keeps a new item's initial rating velocity properly tuned whether the library has 500 items or 50,000, without it, the same fixed K would feel too fast in a small library and too slow in a large one. At the reference size of roughly 2,500 items (`kMax = 32`), a new item moves quickly out of the neutral zone and finds roughly the right tier well within its calibration window.

As §3.2 covers, the shipped curve doesn't actually use `mDecay` directly. It's a sigmoid with a fixed midpoint at 18 matches, and its flat asymptote depends only on the ratio between `kMin` and `kMax`. `mDecay` describes where a simpler straight-line version of the curve would have leveled off. It isn't the shipped curve's own turning point.

Past that early window, a `kMin` floor of 12 keeps long-term flexibility intact. People's taste changes over time, and a real floor lets an established item's rank shift smoothly instead of freezing in place, while still keeping a single fluky result from causing a wild swing.

### 4.2 Why Underdog Protection Isn't Redundant

In an unmodified, zero-sum Elo system, one where whatever the winner gains, the loser loses in equal measure, a big enough upset inflicts a severe penalty on the side that was heavily favored, precisely because their win expectation was already close to 1. In a casual comparison workflow, a lopsided loss is just as often an accidental misclick or a moment of inattention as it is a genuine reversal of preference. Dampening the swing on wide-gap matches caps how bad that accidental penalty can get.

Both sides of an upset get the same dampening factor (§3.3). Each still has its own K-factor and its own expected score, so the actual point totals differ, but the factor applied on top is identical, and that's specifically what keeps this mechanism from injecting rating into the system on every upset.

It's worth being clear about why this isn't just doing the same job as two other mechanisms that operate in the same neighborhood. K-factor decay (§3.2) scales purely by experience regardless of how surprising a given result was, so it offers a new item zero protection, since a brand-new item sits at or near the maximum K-factor precisely because it's new, the single most volatile setting in the whole system. Entropy-weighted pairing (§3.6) shapes which matches get offered in the first place, cutting down how often a wide-gap match happens, but it doesn't prevent them outright: forced cross-tier events and the failover chain that widens the search when no close match is available can both still produce one. Underdog protection is the only one of the three that reacts to how surprising the actual result was, independent of who was playing or how the pairing came about. That covers exactly the gap the other two leave open: a brand-new item, unprotected by decay because it's new, landing in a wide-gap match that entropy weighting didn't fully prevent.

This matters more under D = 35 than it would have under the standard D = 400. At a 70-point rating gap, D = 400 predicts about a 60% win chance for the favorite, a mild surprise if the underdog wins. D = 35 predicts about 99%, a near-guaranteed win, so an upset there is a huge surprise and would otherwise swing the rating hard. Tightening D to fit the 0-to-100 scale is exactly what makes this protection something the system actually needs.

### 4.3 Why the Display Rating Protects Against Lucky Streaks

On a 0-to-100 scale that starts everyone at 50, an initial uncertainty of 15 reflects genuinely not knowing where in the middle tiers a fresh item belongs. Dividing that by the square root of one plus match count is the standard way statistical uncertainty shrinks as more evidence comes in: fast at first, more slowly later.

Here's a concrete case. A fresh item at rating 50 wins its very first comparison, against another item also at 50. Its raw rating jumps to 66. Without any adjustment for how little that result actually proves, it would immediately outrank an established item that's played 40 matches and settled at a raw rating of 53.

Applying the display-rating formula from §3.4 to both tells a different story. The lucky newcomer, at 1 match and a raw 66, displays at 66 minus 1.645 times 15 over root 2, which comes out to about 48.5. The established veteran, at 40 matches and a raw 53, displays at 53 minus 1.645 times 15 over root 41, about 49.1.

The veteran still edges out the newcomer in sort order, which is the whole point. This only affects the Leaderboard's Score column and sort order. It has no bearing on tier assignment, which is decided from the unmodified rating for the reasons covered in §5.

### 4.4 Future Feature: Keeping Propagated Ratings From Spiraling

This section describes §3.5's not-yet-built feature. Spreading a rating change out to nearby items without any decay risks feedback loops, where a change ripples outward, comes back around, and amplifies itself. The planned 0.25-per-hop attenuation forces that ripple to die out fast: full strength at the direct match, a quarter as strong one hop away, a sixteenth as strong two hops away, and so on, which mathematically guarantees the total effect converges rather than growing without bound.

There's also a real-world reason a steep drop-off makes sense beyond just guaranteeing convergence. Human preference isn't fully transitive. Preferring A over B and B over C doesn't guarantee actually preferring A over C when it comes down to it. A sharp per-hop attenuation reflects that indirect relationships carry a lot less certainty than a direct, actual comparison.

### 4.5 How Smart Pairing and Cooldown Work Together

Picking only the closest-rated pairs available, the pure entropy-maximizing case from §3.6, routes selection toward matches with the smallest possible rating gap. That squeezes the most information out of each click, and in principle brings the number of comparisons needed to sort a whole library down from roughly the square of its size toward something closer to size times its logarithm, a much smaller number for any library worth mentioning.

Left alone, though, that same logic creates dense clustering: the same pair of closely-rated items would keep coming back up over and over. The 20-match cooldown buffer from §3.7 breaks that up by match count rather than by wall-clock time, so a fast session can't accidentally empty the buffer out and let the clustering happen anyway.

## 5. Tier Distribution, Calibrated Rather Than Guessed

Tier bounds, the actual rating cutoffs for each of the six letter tiers, are calibrated once, offline, against a simulated population running the real formulas from §3, then stored as a fixed lookup table rather than recomputed on the fly. The calibration targets specific slices of a settled population:

| Tier | Target | What it represents |
| --- | --- | --- |
| S | Top 3% (97th percentile and up) | The very best, effectively protected from culling |
| A | Next 12% (85th to 96th percentile) | Strong performers |
| B | Next 25% (60th to 84th percentile) | The above-average core |
| C | Next 30% (30th to 59th percentile) | The default, baseline pool |
| D | Next 20% (10th to 29th percentile) | Below average |
| F | Bottom 10% | The primary culling candidates |

The actual rating numbers that hit those targets come out of simulation rather than a guess. A settled population under this system's real math doesn't spread evenly across the scale. Like most systems built on repeated pairwise comparisons, it clusters toward the middle. The cutoffs are read straight off that settled, clustered distribution and locked in as a static table. `docs/rating-differences.md` shows what happens to tier occupancy when round numbers are used for the cutoffs instead of calibrated ones.

Tiers are deliberately based on the raw rating rather than the discounted display rating from §3.4. `rating100` is Stash's own field, and every other view in the app filters and sorts on it too, so calibrating tiers against it means a Xenith badge always agrees with everything else Stash shows about that same item. The uncertainty-discounted display rating stays exactly where it's useful, the Leaderboard's Score column, instead of becoming a second, competing notion of rating that the rest of Stash has no way to see.

One implementation note worth recording: an earlier calibration run missed the S-tier target badly, landing around 6 to 7% instead of the intended 3%. Two things contributed. Matchmaking anchors opponent selection on an item's current rating rather than its true underlying skill, so an item that's drifted toward a tier boundary tends to keep facing similarly drifted neighbors. That was real, but not the biggest factor. The calibration simulation itself turned out to matter more, since it hadn't been modeling the 10% forced cross-tier match that real matchmaking actually performs, and that forced match is exactly the mechanism that pulls drifted items back into real competition with the rest of the pool. Adding it to the simulation dropped ceiling occupancy to about 3.0 to 3.6%, close to the 3% target, with no change to the underlying K-factor, D-scale, or attenuation formulas. See the `TIER_BOUNDS` comment block in `src/elo.js`. Recalibrating again after later removing an old tier-eligibility restriction in matchmaking left the bounds unchanged, since that restriction had barely affected real matchmaking to begin with.

## 6. Real Execution Architecture

This section describes what Xenith actually runs as, replacing an earlier draft that described a hypothetical always-on engine process. No such thing exists in how a Stash plugin actually runs, and pretending otherwise obscured what's really happening.

On the frontend, every rating update is a direct, synchronous database write the moment you pick a winner: one write per side, no batching, no local cache sitting in front of it. Reads work a little differently. The full ranked list, the plugin's own settings, and a couple of other lookups are cached for 60 seconds at a time behind the pages that need them (Leaderboard, badges, tooltips, match stats), and that cache gets cleared the instant a new match is recorded, so nothing you see is ever stale relative to a write you just made. The settings cache specifically fails loudly, rejecting outright rather than quietly falling back to a default if the fetch fails, so each piece of code that reads a setting gets to decide for itself what to assume when that happens. A handful of session-only signals, the cooldown buffer and repeat-opponent penalties among them, live in memory for as long as the plugin's panel stays open, surviving it being closed and reopened but not a full page reload. There's no persistent graph of past comparisons sitting somewhere, no background timer flushing anything, no process running independent of the browser tab you're looking at. The core rating math (`src/elo.js`) never talks to the network directly. Anything that needs a live number, like a content type's current item count for K-factor scaling, gets resolved elsewhere and handed in as a plain number.

On the backend, the Python side runs as a short-lived script, started fresh by Stash's own task runner each time a maintenance task (wipe, reset, export, import, migrate) is triggered, and exiting the moment that task finishes. Nothing persists between runs except whatever got written back to Stash itself. There's also a second, separate entry path used for logging match activity to Stash's own debug log in batches rather than one call per vote. That path isn't a task and doesn't go through the same startup as one.

Match history lives inside Stash's own custom fields as plain JSON, no purpose-built graph structure required:

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

An opponent is recorded as `"id:name"` for a performer or `"id:title"` for a scene, falling back to a generic label if the scene has no title. Both content types write to the same field through one shared formatting helper.

A skip is logged as a draw entry, `draw: true` with no `won` field at all, rather than as a loss.

Both fields are read and written in the same database call as the rating update itself. There's one round trip, nothing separate to keep in sync.

These field names replaced older ones inherited from an earlier plugin in this lineage. Older, un-migrated data is still read as a fallback so nothing silently breaks, and a dedicated maintenance task migrates the old data over to the new field names, taking its own safety snapshot first.

## 7. Roadmap: Deferred & Future Work

Transitive delta propagation (§3.5, §4.4) is designed but not built. It's waiting on the current K-factor, D-scale, and loss-mitigation formulas getting locked down and validated in production first, since propagated deltas need to be computed against dynamics that have actually settled. One known gap to solve when this gets picked up: a propagated change has no clear winner or opponent to log against the existing match-history format, and the undo feature currently assumes every history entry has exactly one winner and one loser. Propagation will need its own distinct kind of history entry, and probably shouldn't be undoable the same way a real match is.

Gauntlet mode (§3.8) has a follow-up worth noting: the tier-bounds calibration simulation doesn't yet account for Gauntlet runs specifically. Once there's enough real usage, it's worth extending the simulation with a share-of-matches-played-via-Gauntlet parameter, to confirm the posterior-based placement search doesn't skew tier occupancy the way the old, unmodeled cross-tier matching once did (see §5's implementation note for that earlier incident).

Champion mode (§3.9) currently retires a reign at a flat 10-defense cap, a simple, easy-to-retune constant chosen as the direct counterpart to Gauntlet's own match cap. A more principled version would end a reign once its next defense's expected information gain drops below some threshold, rather than at a fixed count. That's worth revisiting once there's real usage data to calibrate against.

## 8. How This Compares to Other Rating Plugins

Xenith isn't the first Elo-style rating plugin for Stash, and it didn't start from a blank page. It began as a fork of [Ascension](https://github.com/Servbot91/Sakotos-Stash-Repo/tree/main/plugins/Ascension) v1.2.6, and most of the rating engine described above was rewritten before Xenith's first release. `NOTICE` documents what specifically carried over.

The biggest single change is the one covered in §2.1 and §3.3 above: a scale factor actually sized to fit a 0-to-100 range, paired with an upset dampener that can't quietly add rating to the pool. For the full comparison, exact functions and exact numbers measured side by side against the version Xenith forked from, see [`docs/rating-differences.md`](docs/rating-differences.md).
