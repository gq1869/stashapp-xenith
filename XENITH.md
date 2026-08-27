# Xenith Elo Engine: Architectural & Algorithmic Whitepaper

Design reference for Xenith's rating, ranking, and matchmaking system — grounded in the real implementation (a Stash media server plugin), not a generic engine abstraction.

## 1. Executive Summary & Design Philosophy

The Xenith Elo Engine is the rating, ranking, and matchmaking system behind Xenith, a Stash plugin that lets a user triage their own media library — performers and scenes — through head-to-head comparison. Traditional competitive rating systems (standard Elo, TrueSkill) are built for matchmaking balance across an unbounded score range ($0\text{--}3000+$). Xenith adapts the same statistical foundations for rapid content triage on a strictly bounded $[0, 100]$ scale, chosen specifically because it's Stash's own native `rating100` range — the same field every other part of Stash already filters, sorts, and searches on.

The core design goal is balancing statistical efficiency against a frictionless, low-fatigue comparison workflow. Max-entropy pair selection, continuous K-factor decay, and uncertainty-discounted display ratings extract meaningful structure from a modest number of user clicks, while keeping every rating update a simple, synchronous GraphQL mutation — no background process, no batching layer, nothing that outlives the browser tab or the backend task that's currently running.

## 2. Core Principles & Human Factors

### 2.1 Bounded Scale $[0, 100]$ & Scale Factor ($D = 35.0$)

Standard Elo uses a logistic scale divisor of $D = 400$. Xenith scales $D$ down to $35.0$ to compress full dynamic range into `rating100`'s native $[0, 100]$ scale.

- **Sensitivity**: a 10-point rating difference yields a $\sim67\%$ expected win probability — enough rating movement per comparison to be meaningful without driving items instantly to the scale boundaries.
- **Native alignment**: ratings map directly onto the same field Stash's own UI, filters, and sort already use. No secondary conversion layer, no shadow rating system living outside Stash's data model.

### 2.2 Neutral Default Initialization ($R_0 = 50.0$)

Unrated performers and scenes enter the system at $R_0 = 50.0$ — inside the neutral C tier ($[31, 59]$, §5), not its center ($45$), but the midpoint of the full $[0, 100]$ scale and the least assumption-laden starting point.

- **Avoiding an F-tier handicap**: initializing at $0.0$ would create an immediate penalty that distorts lower-tier percentiles and forces extensive manual voting just to drag a decent item out of a bottom-tier culling queue.
- **Neutral prior**: $50.0$ assumes baseline neutrality until comparison data says otherwise.

**Performers first.** Every default and scaling parameter in this document that varies by content type (K-factor bounds, uncertainty calibration) is validated against the Performer battle type first. Scene-type behavior follows once Performer dynamics are confirmed in production — the two share the same math but draw from independently-sized pools, and there's no reason to gate one on the other.

### 2.3 Discrete Binary Outcomes (Win, Loss, Draw)

The comparison interface supports exactly three choices: Win ($1.0$), Loss ($0.0$), Draw ($0.5$, used for Skip).

- **Hick's Law & cognitive friction**: asking a reviewer to quantify *how much* better one item is than another (a 1–5 scale) introduces decision paralysis. Binary choice eliminates that.
- **Eliminating calibration drift**: a "4 out of 5" win on a Monday morning becomes a "3 out of 5" on a Friday evening for the same underlying preference. Binary outcomes remove that drift.
- **Throughput**: high-throughput binary voting converges on a true ordering faster than noisy multi-tier scoring, because the engine can process several binary decisions in the time a human spends deliberating on one fine-grained score.

## 3. Mathematical Specifications

### 3.1 Expected Score & Clamped Rating Update

For a candidate pair $(A, B)$ with ratings $R_A$, $R_B$:

**Expected win probability**:

$$E_A(R_A, R_B) = \frac{1}{1 + 10^{(R_B - R_A) / 35.0}}$$

**Score mapping**:

$$S_A \in \{1.0 \text{ (Win)}, 0.5 \text{ (Draw)}, 0.0 \text{ (Loss)}\}$$

**Bounded rating update**:

$$R_A' = \min\left(100.0, \max\left(0.0, R_A + K_A(m_A) \cdot (S_A - E_A)\right)\right)$$

Hard clamping keeps ratings strictly within $[0.0, 100.0]$ during extreme upsets at the scale boundaries.

### 3.2 Dynamic K-Factor: Continuous Decay, Per-Content-Type Scaling

K-factor decay is, and has always been, a continuous curve — new items move quickly, established items move slowly, with no discontinuity in between. What's new in this version is scaling the curve's own bounds to library size, computed **independently per content type**.

#### System parameter scaling

For a content type's item count $N$ (Performers or Scenes, resolved separately):

$$K_{\text{min}}(N) = \text{clamp}\left(\left\lfloor 8 + 3 \cdot \log_{10}\left(\frac{N}{100}\right) \right\rfloor, \; 8, \; 16\right)$$

$$K_{\text{max}}(N) = \text{clamp}\left(\left\lfloor 24 + 6 \cdot \log_{10}\left(\frac{N}{100}\right) \right\rfloor, \; 24, \; 40\right)$$

$$M_{\text{decay}}(N) = \text{clamp}\left(\left\lfloor 15 + 15 \cdot \log_{10}\left(\frac{N}{100}\right) \right\rfloor, \; 15, \; 50\right)$$

For a baseline library of $N \approx 2{,}500$: $K_{\text{max}} = 32$, $K_{\text{min}} = 12$, $M_{\text{decay}} = 35$ matches.

#### Instantaneous K-Factor

For an item with $m$ completed matches:

$$K(m) = K_{\text{max}} - (K_{\text{max}} - K_{\text{min}}) \cdot \min\left(1, \; \frac{m}{M_{\text{decay}}}\right)$$

- **Calibration horizon ($m < M_{\text{decay}}$)**: high initial velocity ($K \approx K_{\text{max}}$) rapidly separates new items from center-mass ratings.
- **Stabilized baseline ($m \ge M_{\text{decay}}$)**: residual volatility ($K \approx K_{\text{min}}$) filters single-match noise while staying flexible enough to bridge sparse comparison history.

**Implementation note.** The shipped decay curve is a sigmoid (midpoint 18 matches, not $M_{\text{decay}}$-driven) rather than the linear-with-cutoff shape above — only $K_{\text{min}}$/$K_{\text{max}}$ became dynamic when this was built; $M_{\text{decay}}$ is computed but not yet wired into the curve's own shape. See `src/elo.js`.

The sigmoid's asymptote is $K_{\text{max}} / 3$, not $K_{\text{max}} / 2$ — chosen so it sits at or below $K_{\text{min}}$ for every $N$ in the documented clamp range ($K_{\text{min}}/K_{\text{max}}$ ranges from $8/24 = 1/3$ at the smallest $N$ up to $16/40 = 2/5$ at the largest), so the code's own $[K_{\text{min}}, K_{\text{max}}]$ clamp actually reaches $K_{\text{min}}$ as $m$ grows, matching "stabilized baseline: $K \approx K_{\text{min}}$" above. An earlier asymptote of $K_{\text{max}}/2$ sat strictly above $K_{\text{min}}$ at every $N$, so stabilized items ran ~33% hotter than this spec promised — see `src/elo.js`'s `experienceFactor`.

**One dampening mechanism.** This is the only rating-velocity control in the engine — there is no separate multiplier that further reduces K for high-rated items. Elite-item stability comes from $K_{\text{min}}$'s floor plus D=35's own compression at small rating gaps (a match between two S-tier items produces a modest expected-score delta on its own, without needing a second layer to suppress it). A second, rating-tier-based dampening layer was considered and deliberately left out — simpler math, one thing to reason about instead of two interacting ones.

### 3.3 Underdog Loss Mitigation

To prevent a single misclick or a genuine high-disparity upset from producing an outsized rating swing, Xenith applies non-linear loss attenuation.

- **Trigger**: active on an upset — the higher-rated of the two paired candidates is the one losing — whenever $\vert\Delta R\vert > 15$ points between them. Draws are excluded: a draw has no winner or loser, so "the higher-rated candidate losing" can't structurally occur, and `calculateDrawOutcome` applies no attenuation regardless of rating gap.
- **Attenuation**: both sides are scaled down by the same factor as the gap widens — the higher-rated candidate's point loss *and* the lower-rated winner's point gain. Non-linear, bounded, continuous at the trigger gap, never reaching zero.
- **Shared factor, different magnitudes**: the two sides still move by different amounts, since they can carry different match counts and therefore different K-factors. It's the *attenuation factor* that's shared, not the resulting delta.

Attenuating only the loser was tried and rejected. Two reasons:

1. **It's a rating pump.** Damping one side leaves the winner's gain exceeding the loser's loss on every wide-gap upset. On a bounded $[0, 100]$ scale with a hard ceiling, that injected mass has nowhere to go but up, and it accumulates at 100 — inflating S-tier occupancy and compressing what a tier badge means.
2. **The misclick premise cuts both ways.** The justification above is that a wide-gap result is often noise rather than a genuine preference reversal. If it's noise, the underdog's gain is exactly as spurious as the favorite's loss. Protecting only the favorite disbelieves the result for one side while fully believing it for the other. Either it's noise (damp both) or it's signal (damp neither).

Genuine upsets still converge: the floor keeps every upset registering, and as a genuinely underrated item wins repeatedly the gap closes and attenuation relaxes back toward 1.

**What this does not make conservative.** Attenuation itself no longer creates net-positive rating mass, but the match as a whole still can — $K$ differs per side by match count, so a fresh high-$K$ underdog beating an established low-$K$ favorite is a net inflow. That's deliberate and separate (§4.1: new items need velocity), not an oversight in the attenuation design.

See §4.2 for why this doesn't overlap with K-factor decay or entropy-weighted selection, despite superficially sounding like it might.

### 3.4 Uncertainty Buffer & Display Rating

Xenith separates an item's raw rating $R_A$ from a conservative display rating, used to refine sort order and detail display — **not** tier assignment (see §5 for why tier assignment stays on raw `rating100`).

**Uncertainty estimate**:

$$\sigma_A(m_A) = \frac{15.0}{\sqrt{m_A + 1}}$$

**Conservative display rating**:

$$R_{\text{display}}(A) = \max\left(0.0, R_A - 1.645 \cdot \sigma_A(m_A)\right)$$

where $1.645$ is a standard 90% one-tailed confidence bound.

This value is what the Leaderboard sorts by and surfaces in its Score column — a lucky one-match win shouldn't outrank a 40-match veteran, even though the veteran's raw rating might be slightly lower. It does not affect what tier badge an item displays; that's governed by raw `rating100` directly, for reasons covered in §5.

### 3.5 Transitive Delta Propagation

**Status: designed, not yet implemented.** Documented here as the intended design for a future version, not as shipped behavior.

When item $A$ defeats item $B$, that result implicitly suggests $A$ is likely superior to items $B$ has previously lost to. A future batch pass would run a localized 2-hop propagation across the affected comparison subgraph:

$$\Delta R_{X \leftarrow A} = \Delta R_A \cdot \alpha^d \cdot \frac{1}{\sqrt{m_X + 1}}$$

- $\Delta R_A$: the direct rating adjustment from the triggering match.
- $\alpha = 0.25$: hop attenuation factor.
- $d \in \{1, 2\}$: distance in hops from the direct comparison.
- $m_X$: the target item's own match count, dampening the effect for well-established items.

This depends on the final K-factor, D-scale, and loss-mitigation formulas in this version being locked and validated in production first — propagated deltas need to be computed against final rating dynamics, not formulas still being tuned. See §7.

### 3.6 Max-Entropy Queue Selection

To maximize information gain per comparison, candidate pair priority is weighted by Shannon binary entropy, scaled by candidate uncertainty:

**Pair outcome entropy**:

$$H(A, B) = -E_A \log_2(E_A) - (1 - E_A) \log_2(1 - E_A)$$

**Priority score**:

$$P(A, B) = H(A, B) \cdot \left(1 + 0.5 \cdot \frac{\sigma_A + \sigma_B}{15}\right)$$

$\sigma$ is normalized against its own ceiling (15.0, the value at $m=0$) before the $0.5$ coefficient applies. The unnormalized form let uncertainty swing priority by up to 15x, dwarfing entropy's contribution and making this mechanism mostly a novelty score with an entropy tiebreaker rather than the intended entropy-led signal. Normalizing restores entropy as the dominant term.

This is the mechanism that decides which comparisons are worth surfacing, replacing an earlier design that fit a normal curve to the pool's own rating distribution and steered toward whichever tier looked under-represented against that curve. That tier-rotation cycle has been removed outright (no longer retained as a fallback) — entropy weighting is the sole driver of pairing priority now. It solves a more direct problem — prioritize the comparison that tells you the most — and is expected to naturally surface under-sampled tiers as a side effect of correlated uncertainty, without needing to fit a distribution first. No separate measurement of tier coverage has been done since removal.

### 3.7 Match-Count Queue Cooldown

Selection cooldowns are tracked by discrete match count, not wall-clock time, eliminating pacing artifacts from session breaks or variable comparison speed.

- **20-entry FIFO buffer**: a candidate that's just been compared enters a cooldown and is filtered out of the candidate pool entirely — binary eligibility, not a decaying weight — until it's evicted from the buffer. Each entry is one match (both participants pushed together), so 20 entries hold a true 20 matches of history.
- **Small-library fallback**: the filter is skipped when it would leave fewer than 2 eligible candidates, falling back to the unfiltered pool. Each buffered match blocks 2 IDs, so a full buffer can block up to ~40 IDs; in a library small enough that this is a large fraction of it, cooldown effectively stops applying rather than failing to produce a match.
- **Session-scoped, not persistent**: this buffer lives alongside the engine's other session-scoped signals (repeat-opponent penalties) and resets when the session ends. It is not a cross-session store.
- **Kept per content type**: Stash IDs aren't namespaced by entity type — a performer and a scene can share a numeric ID — so performers and scenes hold separate sub-buffers. The same split applies to the engine's other session-scoped stores (session match counts, the recency list) for the same reason.
- **Inference window alignment**: the buffer is sized to §3.5's 2-hop inference window, once that feature ships — a comparison edge should fully propagate through inference before the same item can generate a new one. That argument assumes a 20-*match* window, which the buffer now provides.

### 3.8 Gauntlet Placement: Bayesian Posterior Over Ladder Position

Gauntlet mode (a second matchmaking mode alongside continuous Swiss selection above) places one challenger against a frozen ladder snapshot over a run of matches. Every reference implementation in the ELO/H2H family (§1) does this as a linear climb/fall: win → face a higher-ranked opponent, lose → enter a "falling" phase testing progressively lower-ranked opponents. Xenith's engine does not use that shape, and does not use a hard-commit binary search bisection either — both were considered and rejected for the same underlying reason.

**Why not a bracket.** A binary search's bracket update (`hi = mid - 1` on a win, `lo = mid + 1` on a loss) commits irreversibly on a single comparison. But a single Elo match outcome is stochastic, not a reliable comparator: a well-anchored probe (the kind a good search naturally produces) sits near $E_A \approx 0.5$ — coin-flip odds by construction. One unlucky loss on the very first probe permanently caps the final placement in the bottom half of the ladder, with no way back. This is the same "misclick shouldn't be catastrophic" concern §3.3's underdog protection exists for, applied to a placement search instead of a single rating update.

**The posterior.** A run holds a probability distribution over which ladder position the challenger belongs at — one hypothesis per ladder entry, uniform prior. Each probe match updates every hypothesis by the same likelihood machinery §3.1/§3.6 already define, via `expectedScore`:

$$e_i = E(R_i, R_{\text{probe}})$$

$$\text{posterior}_i \mathrel{*}= \begin{cases} e_i & \text{win} \\ 1 - e_i & \text{loss} \\ \sqrt{e_i (1 - e_i)} & \text{draw} \end{cases}$$

then renormalized. The draw likelihood is the standard Bradley–Terry form — it peaks where $e_i \approx 0.5$ (a draw is most informative near a true tie) and carries no directional signal, which is the correct read of a draw: unlike a win or loss it doesn't say which side of the ladder the challenger belongs on.

Every probe is evidence that reshapes belief, never a commit that discards half the remaining ladder. An early surprising result still gets corrected by consistent evidence afterward — the property a bracket structurally cannot offer.

**Search axis: raw `rating100`, not composite.** The display-rating buffer (§3.4) subtracts an uncertainty term that shrinks purely as `matchCount` grows — and every probe in a run increments the challenger's own match count. Searching on composite would move the search axis on participation alone, independent of match outcomes: at the extreme, a 0-match challenger could gain roughly 18 composite points over a 14-match run from uncertainty decay alone, before accounting for any win or loss. Raw `rating100` has no such feedback loop, so it's what the ladder is built and searched on. The placement screen reports this rating-based rank explicitly alongside the Leaderboard's own composite-sorted rank, so the two don't read as contradicting each other.

**Probe selection.** The posterior's median (where its CDF crosses 0.5) is the max-entropy split of current belief — the direct analogue of a binary search's midpoint, but operating on belief mass instead of ladder position. To avoid the same gatekeeper item facing every run, the actual probe is drawn from the 5 ladder entries nearest that median, excluding anyone already faced this run, weighted by §3.6's outcome-entropy formula against the median hypothesis.

**Termination.** A run is $\ge 10$ and $\le 14$ matches (`MIN_MATCHES`/`MAX_MATCHES`, `src/gauntlet.js`) — long enough to be a real placement search regardless of how settled the challenger's prior rating was, short enough to stay a session-scale activity. It ends at the cap, or once past the minimum when the posterior's 80% credible interval has narrowed to $\le \max(5, \lceil L \times 0.02 \rceil)$ ladder positions, where $L$ is ladder size.

**No mode-specific rating math.** Consistent with §3.2's "one dampening mechanism" and §3.3's "shared factor, not a second layer" — Gauntlet introduces no K-factor multiplier and no streak dampener of its own (see §3.9 below for why Xenith's Champion mode needs neither, either). The challenger's own K already decays across the run via the existing sigmoid (§3.2) as its match count climbs during the run itself.

**Both battle types.** Gauntlet plays on both performers and scenes — the ladder and challenger pool are just `rank-cache.js`'s per-battle-type ranked ordering, so the same placement math above applies unmodified to either. The termination rule's target width scales with ladder size ($\max(5, \lceil L \times 0.02 \rceil)$ above), so a run against a much larger scenes library places more coarsely in absolute rank than the same run would on a smaller performers pool — expected behavior, not a regression.

**Gender-filtered ladder.** The ladder snapshot above is scoped to the live gender filter at run start (`startGauntletRun`, `src/matchmaking.js`), not the full per-battle-type ordering unmodified — scenes are exempt (no gender field to filter on). `L` in the termination rule above is therefore the *filtered* ladder's size, and the placement screen's rank is relative to that same filtered pool, labeled explicitly (alongside the pool-wide Leaderboard rank it's shown next to) rather than left to read as a mismatch. `rank-cache.js`'s own cache stays deliberately unfiltered and single-per-battle-type regardless — Leaderboard/badges/tooltips/match-stats all want the whole pool, so only Gauntlet's ladder-build step applies the filter, client-side, over rows already fetched for those other consumers.

A run below `MIN_LADDER` entries (`src/gauntlet.js`, equal to `MAX_MATCHES`) is refused outright rather than started: a run needs a distinct unfaced probe every match, so a shorter ladder can dead-end mid-run by construction, and — since the termination rule's own $\max(5, \dots)$ floor would then span the entire ladder — a tiny one would otherwise let the run announce a confident "Placed!" over what's essentially still a uniform posterior.

The ladder is otherwise **frozen for the run's whole duration**, same as the unfiltered case always was — a filter change mid-run does not rebuild it or remap the posterior, since each hypothesis is positional ($\text{posterior}_i$ corresponds to `ladder[i]`) and discarding that correspondence would invalidate every probe already played. Instead, a filter narrowed mid-run is enforced at *probe selection* time: `nextProbe` takes an optional `excludeIds` set (still pure, still gender-agnostic — it only ever sees ids), and `selectGauntletPair` computes it from the live filter against the frozen ladder on every call, so a probe that's fallen out of filter is never re-served, cached or otherwise. If narrowing exhausts every remaining in-filter, unfaced ladder entry before the run's own termination condition fires, the run surfaces that explicitly (`Gauntlet.jsx`) rather than silently returning no pair.

### 3.9 Champion Mode: Volatility Reduction Without a Mode-Scoped K-Factor

Champion mode is the third and simplest of the family's ladder-style modes: an incumbent stays on the stage defending against new challengers as long as it keeps winning, with no falling-placement phase — that's Gauntlet-only (§3.8). A hand-tuned rating dampener for this mode is a common pattern in the family (§1) — e.g. HotOrNotV2 documents a flat "0.5x K-factor (half the rating change of Swiss mode)." Xenith ships Champion with `src/elo.js` untouched instead.

**Why the family's dampener is redundant here.** The family's `0.5x` compensates for a linear or wide-scale expected-score curve, where a champion with a large lead still gains meaningfully per defense. Xenith's D=35 (§2.1) already collapses that gain as a function of the lead:

| Champion's lead over challenger | $E$ (champion) | Gain per defense |
| --- | --- | --- |
| +10 | 0.67 | $0.33K$ |
| +25 | 0.84 | $0.16K$ |
| +40 | 0.93 | $0.07K \approx$ 1–2 pts |

The marginal gain of the Nth defense self-extinguishes as the lead grows — the same effect the family's `0.5x` bolts on by hand, here derived from the scale factor rather than tuned. On top of this, every defense increments the champion's own match count, decaying its K toward $K_{\text{min}}$ via §3.2's sigmoid — a second, independent dampener already active before any mode-specific one would be added. Per §3.2/§3.3's "one mechanism, not two interacting ones," a third (mode-scoped) dampener here would stack redundantly on top of both rather than add anything.

**Inflation check.** A champion beating a fresh high-K challenger is net-*deflationary* — `loserLoss` uses the challenger's larger K against the same $1-E$. A challenger upsetting the champion is net-inflationary, but that is §4.1's deliberate new-item velocity, already attenuated symmetrically by §3.3's loss mitigation once the gap exceeds 15. Neither direction needs a mode-specific correction.

**Reign cap: `MAX_DEFENSES = 10` (`src/champion.js`).** An unbeaten champion produces progressively lower-entropy matches as $E \to 1$ (§3.6) — by that section's own metric, a dominant champion's Nth defense carries near-zero information. Every match in a reign also shares one endpoint, so a long reign is a star topology over the comparison graph — the structural cousin of the path-correlation concern Gauntlet's own run-length cap (§3.8) guards against. At the cap the reign retires and a fresh seed is drawn via ordinary Swiss selection; a challenger win at any point dethrones the champion immediately and re-roots the reign, resetting the defense count.

**Search/selection reuse, not a parallel path.** Unlike the family's separately hand-rolled "pick a random challenger" logic, Champion's opponent selection is Swiss's own two-stage flow with stage 1 (seed selection) pinned to the reigning champion; stage 2 (the entropy-weighted opponent search plus cross-tier/failover chain, §3.6) runs unmodified. Champion therefore inherits every future improvement to that shared selection path automatically. It also carries no ladder dependency the way Gauntlet does, so it plays on both battle types from its first release.

## 4. In-Depth Algorithmic & Statistical Rationales

### 4.1 Proportional K-Factor & Plasticity Floor

Scaling $K_{\text{max}}$ to library size keeps initial rating velocity properly tuned whether a content type has 500 items or 50,000. At baseline ($N \approx 2{,}500$, $K_{\text{max}} = 32$), a new item moves quickly out of the neutral tier and finds its initial tier boundary within its calibration horizon ($m < M_{\text{decay}} = 35$).

As noted in §3.2's implementation note, the shipped curve doesn't consume $M_{\text{decay}}$ directly — it's a sigmoid with a fixed midpoint (18 matches) whose asymptote depends only on $K_{\text{min}}/K_{\text{max}}$. $M_{\text{decay}} = 35$ is computed and describes where the linear model above would stabilize; it isn't the shipped curve's own inflection point.

Past that horizon, $K_{\text{min}} = 12$ preserves long-term plasticity — user taste evolves, and a solid floor lets established items reorder smoothly instead of freezing in place, without letting an isolated misclick cause a severe swing.

### 4.2 Underdog Loss Protection & Equilibrium

In pure zero-sum Elo, a high-disparity upset ($\vert\Delta R\vert > 15$) inflicts a severe penalty on the higher-rated candidate, since its win expectation was already close to $1.0$. In a human triage workflow, a high-disparity loss is just as often an unintentional misclick or a moment of fatigue as it is a genuine preference reversal. Damping the magnitude on wide-gap matches caps that penalty spike.

Both sides take the same damping factor (§3.3). Each still runs its own K-factor and expected score, so the two deltas differ in size — but the factor applied on top is shared, which is what keeps attenuation from injecting rating mass into the system on every upset.

**Why this isn't redundant with K-factor decay or entropy weighting**, despite operating in the same neighborhood:

- K-factor decay scales by *experience* — an established item moves less regardless of how surprising the result is. It offers a new item no protection at all; a brand-new item sits at or near $K_{\text{max}}$ precisely because it's new, which is the highest-volatility setting in the system.
- Entropy weighting (§3.6) shapes *which pairs get selected*, lowering the frequency of wide-gap matches — it doesn't eliminate them. Cross-tier events and the failover chain that widens the search window when a close match isn't available can still produce a wide-gap pairing.
- Underdog protection is the only mechanism that acts on *match surprise itself*, independent of who's playing or how the pair was chosen — which is exactly the case the other two mechanisms don't cover: a new item (high K, not protected by decay) landing in a wide-gap match (not fully prevented by entropy weighting).

This matters more under D=35 than it would have under D=400. At a 70-point gap, D=400 yields $E_A \approx 0.60$ — a mild surprise if the underdog wins. D=35 yields $E_A \approx 0.99$ — a near-maximal swing on a single result. Tightening $D$ to fit `rating100`'s native scale is what makes this protection necessary, not optional.

### 4.3 Culling Protection via Display Rating Buffer

On a $[0, 100]$ scale initialized at $50.0$, a starting standard deviation of $\sigma_0 = 15.0$ reflects uniform uncertainty across the middle tiers. Dividing by $\sqrt{m + 1}$ enforces standard statistical error decay as evidence accumulates.

Consider a fresh item ($R = 50.0$, $m = 0$) winning its first comparison against another $50.0$ item. Its raw rating jumps to $66.0$. Without an uncertainty discount, it would immediately outrank an established item with 40 matches sitting at $R = 53.0$ — on the Leaderboard, in this scenario.

Applying $R_{\text{display}} = R_A - 1.645 \cdot \sigma_A$:

- **New item ($m=1$)**: $R_{\text{display}} = 66.0 - 1.645 \cdot (15/\sqrt{2}) \approx 48.5$
- **Established veteran ($m=40$)**: $R_{\text{display}} = 53.0 - 1.645 \cdot (15/\sqrt{41}) \approx 49.1$

The veteran still edges out the lucky newcomer on sort order. This buffer is scoped to the Leaderboard's Score column and sort behavior only — it doesn't reach into tier assignment, which is deliberately kept on raw `rating100` for reasons in §5.

### 4.4 Graph Stability via Hop Attenuation ($\alpha = 0.25$) — future feature

*Applies to §3.5, not yet implemented.* Unattenuated iterative propagation across a comparison graph risks feedback loops and rating runaway. $\alpha = 0.25$ forces the geometric series $\sum \alpha^k$ to decay rapidly ($1 \to 0.25 \to 0.0625$), guaranteeing convergence.

Human preference is also stochastically non-transitive — $A > B$ and $B > C$ doesn't guarantee $A > C$ in real judgment. A 75%-per-hop attenuation reflects that indirect relationships carry exponentially less certainty than direct comparisons.

### 4.5 Entropy Maximization & Queue Cooldown Dynamics

Pure max-entropy pairing ($\vert R_A - R_B\vert \approx 0$) routes selection toward pairs with minimal rating delta, maximizing information gain per click and pushing the number of comparisons needed to sort a pool of $N$ items down from $O(N^2)$ toward something closer to $O(N \log N)$.

Unconstrained, this creates dense local clustering — the same close-rated pair gets resurfaced repeatedly. The FIFO cooldown (§3.7) decouples this from wall-clock time entirely, so cooldown state can't collapse during a fast session the way a time-based blackout would.

## 5. Skewed Static Tier Distribution

Tiers are calibrated once, offline, against a simulated population running the formulas in §3, then stored as static rating bounds — not recomputed live. The calibration targets these population percentiles:

| Tier | Percentile Target | System Function |
| --- | --- | --- |
| **S** | Top 3% ($\ge 97\text{th}$) | Pinnacle anchors; protected from culling |
| **A** | Next 12% ($85\text{th}\text{–}96\text{th}$) | Strong performers |
| **B** | Next 25% ($60\text{th}\text{–}84\text{th}$) | Above-average core |
| **C** | Next 30% ($30\text{th}\text{–}59\text{th}$) | Baseline default state |
| **D** | Next 20% ($10\text{th}\text{–}29\text{th}$) | Below-average performers |
| **F** | Bottom 10% ($< 10\text{th}$) | Primary culling target queue |

The actual rating cutoffs that hit these targets are simulation output, not hand-picked — a settled population under this version's real K-factor, D-scale, and loss-mitigation dynamics rarely spreads uniformly across $[0, 100]$; it clusters near the center like most pairwise-comparison systems do. Cutoffs are read off that settled distribution and stored as a static lookup table.

**Basis: raw `rating100`, not display rating.** This is a deliberate choice, not an oversight. `rating100` is Stash's own native field — every other Stash view, filter, and sort already keys off it. Calibrating tier bounds against it means a Xenith tier badge stays consistent with everything else Stash shows about that same item. The uncertainty-discounted display rating (§3.4) stays where it adds value — the Leaderboard's own Score column — rather than being pulled into a second, competing notion of "rating" that native Stash features can't see.

**Implementation note.** An earlier calibration run missed the S-tier target above (~6-7% vs. 3%). The root-cause hypothesis at the time — matchmaking anchors opponent selection on *current rating*, not true skill, so boundary-drifted candidates only ever face similarly-drifted neighbors — was correct as far as it went, but the calibration sim itself turned out to be the bigger factor: it never modeled the 10% forced cross-tier match real matchmaking performs, which is exactly the mechanism that pulls those drifted candidates back into competition with the rest of the pool. Adding cross-tier matches to the sim dropped ceiling occupancy to ~3.0-3.6% (floor ~3.4-4.0%), close to the 3% target, without any change to the K-factor/D-scale/attenuation formulas themselves — see the `TIER_BOUNDS` comment block in `src/elo.js`. Recalibrated again after removing the S-excludes-sub-B `canBattleByTier` matchmaking gate; bounds held unchanged since the gate barely bound production selection to begin with.

## 6. Real Execution Architecture

This section replaces the original design's fictional in-memory engine — no such process exists in a Stash plugin's execution model, and describing one obscured what actually happens.

**Frontend.** Rating updates are direct, synchronous GraphQL mutations (`performerUpdate` / `sceneUpdate`) fired per match — one write per side, no batching, no client-held cache standing in front of a write. (Reads are a different story: `src/rank-cache.js` holds a 60s-TTL cache of the full ranked list behind the Leaderboard/badges/tooltips/match-stats page, `matchmaking.js`'s system-config lookup is cached the same way, and `src/plugin-config.js` caches the plugin's settings object (`HideXenRankBadge`, `LeaderboardRowsPerPage`, `UseCustomaryUnits`, `HiddenChips`, `HiddenSceneChips`) with the same TTL — all invalidated on a committed match or expiring on their own, never stale for a write. `plugin-config.js` rejects on fetch failure rather than swallowing it, so each caller decides its own fail-open/fail-closed policy per setting.) Session-scoped signals — the FIFO cooldown buffer, repeat-opponent penalties — live in a single module-scope object that survives the comparison modal being closed and reopened, but not a full page reload. There is no persistent adjacency graph, no idle-timer flush, no engine process independent of the React tree currently mounted in the browser tab. `src/elo.js` stays GraphQL-free by design — anything needing a network call (e.g. a content type's live item count for K-factor scaling) resolves in `src/matchmaking.js` and is passed into `elo.js`'s pure functions as plain numbers.

**Backend.** The Python side is a raw-interface script, invoked fresh by Stash's task runner for each maintenance task (Wipe, Reset, Export, Import, Migrate) and exiting when the task completes. Nothing carries over between invocations beyond what's written back to Stash itself. A second, non-task entry path exists: `runPluginOperation` calls with `args.mode === "log"` (no `execArgs`, so `sys.argv[1]` is absent) route to `handle_log_operation` before a `StashInterface` is built — this is `src/stash-log.js`'s batched match-log flush (buffered at 10 lines or 5s idle, fire-and-forget), not a task.

**Real data shapes.** Match history lives in Stash's own `custom_fields`, as plain JSON — not a bespoke graph structure:

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

`opponent` is `"id:name"` for a performer opponent, `"id:title"` (falling back to `"id:Scene <id>"` when untitled) for a scene opponent — both battle types write `xenith_record`, via the shared `displayName` helper in `src/format.js`.

A skip is recorded as a draw entry — `draw: true`, no `won` field — rather than a `won: false` loss.

Both are read and written through the same GraphQL mutation as the rating update itself — one round trip, no separate persistence layer to keep in sync.

These keys were renamed from the original HotOrNot-era `hotornot_stats`/`performer_record` names. `src/matchmaking.js` reads the legacy keys as a fallback so an un-migrated library keeps working; the "Migrate Legacy Field Names" backend task (`task_migrate` in `backend/tasks.py`) copies existing data to the new keys and removes the old ones, taking its own pre-migration snapshot first.

## 7. Roadmap: Deferred & Future Work

- **Transitive delta propagation (§3.5, §4.4).** Designed, not built. Blocked on this version's K-factor, D-scale, and loss-mitigation formulas being locked and validated in production — building propagation against formulas still being tuned means redoing the math once they settle. Known implementation gap to address when this is picked up: propagated deltas have no winner/opponent to log against the current `xenith_stats`/`xenith_record` shape (§6), and `usePair.js`'s undo assumes exactly one winner and one loser per history entry. Propagation needs its own distinguishable history-entry type and should stay outside undo's scope.
- **Gauntlet mode (§3.8) usage follow-ups.** `qa/scripts/simulate-tier-bounds.mjs`'s calibration sim doesn't yet model Gauntlet runs — once there's real usage data, extend it with a gauntlet-share parameter to confirm the posterior search doesn't skew tier occupancy the way uncalibrated cross-tier matching once did (§5's implementation note).
- **Champion mode (§3.9) entropy-threshold retirement.** The current `MAX_DEFENSES = 10` cap is a flat, easily-retunable constant, chosen as the direct analogue of Gauntlet's own run-length cap. An entropy-threshold retirement rule (end a reign once its next-defense information gain drops below some bound, rather than at a fixed count) is the more principled version and is worth revisiting once there's usage data to calibrate against.
