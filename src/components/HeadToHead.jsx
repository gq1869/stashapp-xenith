// Swiss mode's screen. Also exports MatchView, the shared swipe/keyboard/
// action-button match UI Swiss, Gauntlet, and Champion all render from
// their own usePair() instance — the actual card-vs-card comparison markup
// lives here even though Gauntlet.jsx/Champion.jsx are the other two
// callers.
const { React } = window.PluginApi;
import { usePair } from "../hooks/usePair";
import { PerformerCard } from "./PerformerCard";
import { SceneCard } from "./SceneCard";
import { Gauntlet } from "./Gauntlet";
import { Champion } from "./Champion";
import { useXenithState } from "../state";
import { SkipIcon, UndoIcon } from "./Icons";


// True when the current focus target would consume the keystroke itself
// (a background input/textarea/select/contenteditable outside the modal,
// or inside it) — battle shortcuts must not steal input from those.
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

const MOBILE_PORTRAIT_QUERY = "(max-width: 900px) and (orientation: portrait)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

// Discard-throw duration. Shared by SwipeStack's inline transition and the
// timer that fires the cycle at the end of it — a single source so the two
// can't drift apart. The transition itself starts on the frame after its
// commit, so it can finish up to one frame after this timer fires; don't
// shorten the timer to "tighten" the feel, that just cycles the top card
// before the throw has actually cleared the screen.
const SWIPE_MS = 250;

// Generic media-query hook, initialized synchronously (not in an effect) so
// the first render already reflects reality — avoids a layout/motion flash
// on mount, same reasoning useIsMobilePortrait originally had standalone.
function useMatchMedia(query) {
  const [matches, setMatches] = React.useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  React.useEffect(() => {
    const media = window.matchMedia(query);

    const updateMatch = () => setMatches(media.matches);
    media.addEventListener("change", updateMatch);
    return () => media.removeEventListener("change", updateMatch);
  }, [query]);

  return matches;
}

function useIsMobilePortrait() {
  return useMatchMedia(MOBILE_PORTRAIT_QUERY);
}

// xenith.css's `@media (prefers-reduced-motion: reduce)` block can't reach
// SwipeStack's inline transform transition below (React inline styles
// aren't touchable by CSS media queries) — this is the JS-side half of that
// same accommodation.
function useReducedMotion() {
  return useMatchMedia(REDUCED_MOTION_QUERY);
}

export function HeadToHead() {
  const { battleType, selectedGenders, matchMode } = useXenithState();
  // key={battleType} forces a full remount on battle-type switch, so
  // usePair's internal state (pair, undo history) doesn't leak stale
  // performers/scenes into the other type. Gauntlet/Champion vs. h2h are
  // different component types in this slot, so React already
  // unmounts/remounts on its own when matchMode flips — each gets an
  // equivalently fresh usePair instance without needing matchMode folded
  // into the key too.
  if (matchMode === "gauntlet") {
    return <Gauntlet key={battleType} battleType={battleType} selectedGenders={selectedGenders} />;
  }
  if (matchMode === "champion") {
    return <Champion key={battleType} battleType={battleType} selectedGenders={selectedGenders} />;
  }
  return <HeadToHeadInner key={battleType} battleType={battleType} selectedGenders={selectedGenders} matchMode={matchMode} />;
}

function HeadToHeadInner({ battleType, selectedGenders, matchMode }) {
  const pairApi = usePair(battleType, selectedGenders, matchMode);
  return <MatchView battleType={battleType} {...pairApi} />;
}

// Shared by Swiss (HeadToHeadInner above) and Gauntlet (src/components/Gauntlet.jsx)
// — both drive this from their own usePair() instance and just differ in
// what wraps it (Gauntlet adds a run banner above it).
export function MatchView({ battleType, pair, ranks, loading, error, choose, skip, undo, canUndo, result }) {
  const isMobilePortrait = useIsMobilePortrait();
  const reducedMotion = useReducedMotion();

  const lastArrowDownRef = React.useRef(0);
  const lastArrowUpRef = React.useRef(0);

  React.useEffect(() => {
    function handleKeyDown(e) {
      // OS key-repeat fires this handler continuously while a key is
      // held, well before `result` is set (that's a full network round-trip
      // away) — without this, holding an arrow key fires many concurrent
      // choose() calls. usePair's submittingRef guard is the real fix, but
      // bail here too so a held key doesn't even attempt the extra calls.
      if (e.repeat) return;
      if (isTypingTarget(document.activeElement)) return;

      // Undo is handled before the pair-scoped guard below: unlike
      // choose/skip, undo doesn't act on the current `pair`, so it must
      // stay live during the ~1s outcome overlay (`result` truthy) — that's
      // exactly when a user just saw the outcome and wants to reverse it.
      // `loading` still blocks it, since undo restores `pair` and a
      // resolving loadPair() would immediately clobber that restore.
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const now = Date.now();
        if (now - lastArrowUpRef.current < 300) {
          if (canUndo && !loading) undo();
          lastArrowUpRef.current = 0;
        } else {
          lastArrowUpRef.current = now;
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (canUndo && !loading) undo();
        return;
      }

      // Bail while `result` is set: the outcome overlay is showing and the
      // pair is about to auto-advance, so shortcuts must not fire a second
      // choice against the stale pair.
      if (loading || !pair || result) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        choose(pair[0], pair[1]);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        choose(pair[1], pair[0]);
      } else if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        skip();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const now = Date.now();
        if (now - lastArrowDownRef.current < 300) {
          skip();
          lastArrowDownRef.current = 0;
        } else {
          lastArrowDownRef.current = now;
        }
      }
    }
    // Listener is on `document`, not a ref, because this component is
    // portal-mounted into Stash's native DOM tree — there's no reliable
    // local container to attach to, and shortcuts should work regardless of
    // where focus currently sits (guarded by isTypingTarget above).
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [pair, loading, choose, skip, undo, canUndo, result]);

  function outcomeFor(item) {
    if (!result) return null;
    if (result.isDraw) return "draw";
    if (item.id === result.winnerId) return "winner";
    if (item.id === result.loserId) return "loser";
    return null;
  }

  function deltaFor(item) {
    if (!result) return null;
    if (result.isDraw) {
      if (item.id === result.idA) return result.deltaA;
      if (item.id === result.idB) return result.deltaB;
      return null;
    }
    if (item.id === result.winnerId) return result.winnerGain;
    if (item.id === result.loserId) return -result.loserLoss;
    return null;
  }

  const leftCard = pair && (
    <CardFor
      battleType={battleType}
      item={pair[0]}
      side="left"
      rank={ranks[0]}
      onChoose={result ? undefined : () => choose(pair[0], pair[1])}
      outcome={outcomeFor(pair[0])}
      delta={deltaFor(pair[0])}
    />
  );

  const rightCard = pair && (
    <CardFor
      battleType={battleType}
      item={pair[1]}
      side="right"
      rank={ranks[1]}
      onChoose={result ? undefined : () => choose(pair[1], pair[0])}
      outcome={outcomeFor(pair[1])}
      delta={deltaFor(pair[1])}
    />
  );

  return (
    <div className="hon-h2h">
      {loading && <div className="hon-loading">Loading matchup...</div>}
      {error && <div className="hon-error">{error}</div>}

      {!loading && !error && pair && (
        isMobilePortrait ? (
          <SwipeStack pair={pair} reducedMotion={reducedMotion}>
            {leftCard}
            {rightCard}
          </SwipeStack>
        ) : (
          <div className="hon-vs-container">
            {leftCard}
            <div className="hon-vs-divider"><span className="hon-vs-text">VS</span></div>
            {rightCard}
          </div>
        )
      )}

      <div className="hon-actions">
        <div className="hon-action-group">
          {/* Label leads/trails the icon by direction of motion: skip moves
              forward (label, then icon), undo moves backward (icon, then
              label) — same convention as the reverse ordering below. */}
          <button type="button" className="hon-action-btn hon-action-btn-labeled" onClick={skip} disabled={loading || !!result} title="Skip" aria-label="Skip">
            <span className="hon-action-btn-label">Skip</span>
            <SkipIcon />
          </button>
          <span className="hon-hint"><strong>Space</strong> to Skip</span>
        </div>

        <div className="hon-action-group">
          <button type="button" className="hon-action-btn hon-action-btn-labeled" onClick={undo} disabled={!canUndo || loading} title="Undo" aria-label="Undo">
            <UndoIcon />
            <span className="hon-action-btn-label">Undo</span>
          </button>
          <span className="hon-hint"><strong>Ctrl+Z</strong> to Undo</span>
        </div>
      </div>
    </div>
  );
}

// topIndex lives here, merged into the same useState as dragX, rather than
// in MatchView: the end-of-throw cycle runs inside a setTimeout, which
// React 17 legacy mode does not batch, so two separate setStates there
// would commit twice — and the second commit would re-render MatchView,
// recreating leftCard/rightCard and forcing both Stash-native card
// subtrees to re-render on the first frame of the promote animation (no
// React.memo anywhere in this codebase). One merged state object makes the
// cycle a single commit that MatchView never participates in, so
// `children` keeps its element identity and React bails out on both cards.
function SwipeStack({ children, pair, reducedMotion }) {
  // exitingIndex/exitingDragX track the just-thrown card separately from
  // topIndex/dragX so the throw and the reveal run *concurrently* instead
  // of back-to-back. topIndex flips the instant the throw starts (so the
  // covered card's scale-up begins immediately), while the outgoing card
  // keeps animating to off-screen under its own exitingDragX until the
  // timer below clears it — rather than the covered card sitting static
  // and revealed-but-idle for the full 250ms throw before its own 250ms
  // scale-up even starts (that back-to-back sequencing was the actual
  // "hesitates" complaint reported after the first fix landed).
  const [stack, setStack] = React.useState({ topIndex: 0, dragX: 0, exitingIndex: null, exitingDragX: 0 });
  const [isDragging, setIsDragging] = React.useState(false);

  // Reset the stack during render (not in an effect) when the pair changes.
  // An effect would commit one frame of the new pair under the *old*
  // topIndex first, and that stale frame is a real transform change — it
  // fires a spurious 250ms scale-up on every new pair that arrives after an
  // odd number of swipes. A render-phase update is discarded before commit
  // (React's documented "adjusting state when a prop changes" pattern), so
  // the DOM never sees the stale frame and no transition starts.
  const [prevPair, setPrevPair] = React.useState(pair);
  if (pair !== prevPair) {
    setPrevPair(pair);
    setStack({ topIndex: 0, dragX: 0, exitingIndex: null, exitingDragX: 0 });
  }

  const isAnimating = React.useRef(false);
  const touchStartX = React.useRef(0);
  const touchMoveDetected = React.useRef(false);
  // Tracks "a touch is down on this card" independent of isDragging state —
  // see handleTouchStart below for why the two can't be the same
  // thing.
  const touchActive = React.useRef(false);
  const containerRef = React.useRef(null);

  // Mirrors usePair.js's resultTimer pattern — store the handle so
  // unmount (real scenario: portal-host.js unmounts on modal close,
  // key={battleType} remounts on battle-type change) can clear it, instead
  // of a pending setState firing on an unmounted component. Also cleared
  // whenever the pair changes: the action buttons stay live during the
  // 250ms throw, so a vote/skip landing mid-throw would otherwise let a
  // stale timer flip the *new* pair's top card out from under it.
  const cycleTimer = React.useRef(null);
  React.useEffect(() => {
    return () => {
      if (cycleTimer.current) {
        clearTimeout(cycleTimer.current);
        cycleTimer.current = null;
      }
    };
  }, []);
  React.useEffect(() => {
    if (cycleTimer.current) {
      clearTimeout(cycleTimer.current);
      cycleTimer.current = null;
    }
    isAnimating.current = false;
  }, [pair]);

  // isDragging is deliberately NOT set here, only touchActive. The
  // wrapper's inline transition below is gated on `!isDragging`, so setting
  // isDragging on touch-down alone would flip transition to "none" the
  // instant a finger lands — including mid-promote, snapping an in-flight
  // scale-up straight to its end value on nothing more than a tap. Real
  // drag intent isn't established until handleTouchMove sees the 8px
  // threshold, so that's where isDragging actually flips.
  const handleTouchStart = (e) => {
    if (isAnimating.current) return;
    touchStartX.current = e.touches[0].clientX;
    touchMoveDetected.current = false;
    touchActive.current = true;
  };

  const handleTouchMove = (e) => {
    if (!touchActive.current) return;
    const currentX = e.touches[0].clientX;
    const deltaX = currentX - touchStartX.current;

    if (Math.abs(deltaX) > 8) {
      touchMoveDetected.current = true;
      // Same commit as setStack below — React 17's synthetic-event
      // batching means this doesn't cost an extra render, it just delays
      // the transition teardown until drag intent is real.
      setIsDragging(true);
      setStack((prev) => ({ ...prev, dragX: deltaX }));
    }
  };

  // Also wired to onTouchCancel below: touch-action: pan-y lets the browser
  // take the gesture over for a vertical scroll or a system edge swipe,
  // which fires touchcancel and no touchend — without this the card would
  // sit stranded mid-drag (offset, rotated, transitions off) until the next
  // touch snapped it back.
  const handleTouchEnd = () => {
    if (!touchActive.current) return;
    touchActive.current = false;
    setIsDragging(false);

    if (!touchMoveDetected.current) {
      setStack((prev) => ({ ...prev, dragX: 0 }));
      return;
    }

    const threshold = 80;
    if (Math.abs(stack.dragX) > threshold) {
      // Throw distance derived from the container's own width so the
      // discarded card fully clears the screen rather than a hardcoded
      // 350px, which leaves ~11% of the card visible on a 393px viewport.
      const throwDistance = (containerRef.current?.offsetWidth || window.innerWidth) * 1.1;
      const finalDragX = stack.dragX > 0 ? throwDistance : -throwDistance;
      const outgoingIndex = stack.topIndex;
      const newTopIndex = outgoingIndex === 0 ? 1 : 0;

      if (reducedMotion) {
        // Nothing animates, so there's nothing to sequence — cycle instantly.
        setStack({ topIndex: newTopIndex, dragX: 0, exitingIndex: null, exitingDragX: 0 });
        return;
      }

      isAnimating.current = true;
      // Single setState: topIndex flips immediately, so the covered card
      // starts its scale-up in the same commit the outgoing card starts
      // its own continued throw to finalDragX — both run over the same
      // SWIPE_MS window instead of the promote waiting for the throw to
      // finish first.
      setStack({ topIndex: newTopIndex, dragX: 0, exitingIndex: outgoingIndex, exitingDragX: finalDragX });

      cycleTimer.current = setTimeout(() => {
        cycleTimer.current = null;
        isAnimating.current = false;
        setStack((prev) => ({ ...prev, exitingIndex: null, exitingDragX: 0 }));
      }, SWIPE_MS);
    } else {
      setStack((prev) => ({ ...prev, dragX: 0 }));
    }
  };

  return (
    <div
      ref={containerRef}
      className="hon-vs-container hon-swipe-stack"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {React.Children.map(children, (child, index) => {
        const isTop = index === stack.topIndex;
        const isExiting = index === stack.exitingIndex;
        const dragX = isExiting ? stack.exitingDragX : isTop ? stack.dragX : 0;
        return (
          <div
            key={index}
            className="hon-swipe-card-wrapper"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              // Exiting sits above the incoming top card while both animate
              // concurrently — it's still visually leaving the screen and
              // shouldn't be occluded by the card scaling up underneath it.
              zIndex: isExiting ? 3 : isTop ? 2 : 1,
              pointerEvents: isTop && !isExiting ? "auto" : "none",
              // One transform function list for every branch so they all
              // interpolate per-function rather than via matrix
              // decompose/recompose.
              transform: isExiting || isTop
                ? `translate3d(${dragX}px, 0, 0) rotate(${dragX * 0.04}deg) scale(1)`
                : `translate3d(0, 12px, 0) rotate(0deg) scale(0.95)`,
              // Exiting and (non-dragging) top both transition; the back
              // card is static except at the one moment it's being
              // promoted, which is exactly when it becomes isTop. Gating on
              // that makes a plain demotion snap to the back position
              // instead of animating back on-screen — the snap is
              // invisible, since at that instant the promoted card
              // occupies that exact geometry at a higher zIndex and only
              // grows from there.
              //
              // Crucially, the outgoing (exiting) and incoming (isTop)
              // cards transition over the *same* SWIPE_MS window, started
              // in the same commit — the throw and the reveal run
              // concurrently rather than the reveal waiting for the throw
              // to fully finish first (previously: 250ms throw, then a
              // static beat once the covered card was exposed, then a
              // separate 250ms scale-up — the "hesitates" gap).
              //
              // Going none -> a duration in the same commit as the
              // transform change still starts the transition — per CSS
              // Transitions, transition-property/duration are read from the
              // after-change style, not the before-change one. Both the
              // exiting card (before-change: mid-drag, transition none) and
              // the promoted card (before-change: static back position,
              // transition none) rely on exactly this.
              //
              // xenith.css's transition-duration override (@media
              // prefers-reduced-motion) can't reach an inline style, so the
              // reducedMotion term here is the JS-side half of that same
              // accommodation — see useReducedMotion above. Under reduced
              // motion the cycle is instant (handleTouchEnd skips the
              // exiting state entirely), so this branch never actually
              // needs to suppress a transition there, but stays as the
              // belt-and-suspenders JS-side guard.
              transition: (isExiting || (isTop && !isDragging)) && !reducedMotion
                ? `transform ${SWIPE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
                : "none",
              touchAction: "pan-y"
            }}
          >
            {child}
          </div>
        );
      })}
    </div>
  );
}

function CardFor({ battleType, item, side, rank, onChoose, outcome, delta }) {
  const Card = battleType === "scenes" ? SceneCard : PerformerCard;
  return <Card item={item} side={side} rank={rank} onChoose={onChoose} outcome={outcome} delta={delta} />;
}
