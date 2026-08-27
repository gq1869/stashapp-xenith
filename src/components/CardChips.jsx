const { React } = window.PluginApi;
import { planChipFit } from "../card-chips";

// Fixed 3-line chip row — takes a plain `chips` array, not a
// performer, so a future scenes chip set is a call-site swap with zero
// changes here or in the CSS. Renders every chip once measured; the
// measurement loop below decides how many fit inside the container's own
// fixed height (--hon-chip-lines in xenith.css) and truncates with a
// static "+N" overflow chip rather than letting the row grow — see
// planChipFit's own comment in card-chips.js for why this is measured
// against real geometry instead of estimated from chip text length.
export function CardChips({ chips }) {
  const ref = React.useRef(null);
  const [fit, setFit] = React.useState(null); // null = "unmeasured; render everything"

  // New pair (or the chip list itself changed) -> re-measure from scratch.
  React.useLayoutEffect(() => {
    setFit(null);
  }, [chips]);

  // Runs right after the "render everything" commit above, before paint —
  // useLayoutEffect (not useEffect) so there's no one-frame flash of the
  // untruncated list. Exactly two commits: this only measures once
  // (fit !== null bails out), and truncation can only remove a suffix of a
  // wrap layout, which can't move earlier chips — so there's no
  // measure/re-measure oscillation to guard against.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || fit !== null) return;
    const top = el.getBoundingClientRect().top;
    const bottoms = Array.from(el.children).map((c) => c.getBoundingClientRect().bottom - top);
    setFit(planChipFit(bottoms, el.clientHeight, chips.length));
  }, [fit, chips]);

  // Re-measure on a real width change only — the container's height is
  // fixed by CSS and can't change, so guarding on width alone is enough
  // and avoids any feedback loop with the fit-driven re-render above.
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth;
        setFit(null);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = fit ? chips.slice(0, fit.visible) : chips;

  return (
    <div className="hon-card-chips" ref={ref}>
      {visible.map((chip) => (
        <span key={chip.id} className={`hon-chip hon-chip-${chip.group}`}>{chip.text}</span>
      ))}
      {fit?.overflow > 0 && (
        <span className="hon-chip hon-chip-overflow">+{fit.overflow}</span>
      )}
    </div>
  );
}
