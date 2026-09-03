const { React } = window.PluginApi;

// Generic mobile bottom sheet for "tap to open a menu, pick an option" —
// extracted from the gender-filter sheet Sidebar.jsx originally shipped
// so Record Type and Match Type pickers can reuse the same
// slide-in/backdrop/swipe-to-dismiss chrome instead of each growing their
// own. `multi: false` is single-select radio semantics (picking an option
// closes the sheet); `multi: true` is the original toggle-and-stay-open
// gender-filter behavior.
export function OptionSheet({ open, onClose, title, options, selected, onSelect, multi }) {
  // Swipe-to-dismiss — same shape as the original gender sheet: refs for
  // start position / move detection, state for the live drag offset, bound
  // only to .hon-sheet-handle (grabber + title) so a vertical drag there
  // doesn't fight the row list's own overflow-y: auto.
  const [dragY, setDragY] = React.useState(0);
  const [isDragging, setIsDragging] = React.useState(false);
  const touchStartY = React.useRef(0);
  const touchMoveDetected = React.useRef(false);

  function handleSheetTouchStart(e) {
    touchStartY.current = e.touches[0].clientY;
    touchMoveDetected.current = false;
    setIsDragging(true);
  }

  function handleSheetTouchMove(e) {
    if (!isDragging) return;
    const deltaY = e.touches[0].clientY - touchStartY.current;
    if (Math.abs(deltaY) > 8) {
      touchMoveDetected.current = true;
      // Downward only — the sheet lives at the bottom of the screen, so an
      // upward drag has nowhere to go and would just look broken.
      setDragY(Math.max(0, deltaY));
    }
  }

  function handleSheetTouchEnd() {
    if (!isDragging) return;
    setIsDragging(false);

    if (!touchMoveDetected.current) {
      setDragY(0);
      return;
    }

    // Same 80px threshold as SwipeStack's discard throw.
    if (dragY > 80) {
      // Batched: dropping the inline transform and closing in the same
      // commit means the sheet's existing 220ms CSS transform transition
      // (driven by the .open class) picks up smoothly from wherever the
      // finger let go, instead of snapping first.
      setDragY(0);
      onClose();
    } else {
      setDragY(0);
    }
  }

  function handleOptionClick(opt) {
    if (opt.disabled) return;
    onSelect(opt.value);
    if (!multi) onClose();
  }

  const isSelected = (opt) =>
    multi ? selected.includes(opt.value) : selected === opt.value;

  return (
    <>
      <div className={`hon-sheet-backdrop ${open ? "open" : ""}`} onClick={onClose} />
      <div
        className={`hon-sheet ${open ? "open" : ""}`}
        role={multi ? "group" : "radiogroup"}
        aria-label={title}
        aria-hidden={!open}
        style={isDragging ? { transform: `translateY(${dragY}px)`, transition: "none" } : undefined}
      >
        {/* Drag region for swipe-to-dismiss — scoped to the grabber + title
            rather than the whole sheet, so it doesn't fight the row list's
            own vertical scroll below. touch-action: none (xenith.css) stops
            the browser from treating the drag as a page scroll. */}
        <div
          className="hon-sheet-handle"
          onTouchStart={handleSheetTouchStart}
          onTouchMove={handleSheetTouchMove}
          onTouchEnd={handleSheetTouchEnd}
        >
          <div className="hon-sheet-grabber" />
          <div className="xen-sidebar-group-label">{title}</div>
        </div>
        {options.map((opt) => (
          <button
            type="button"
            key={opt.value}
            className={`hon-sheet-row ${isSelected(opt) ? "active" : ""}`}
            disabled={opt.disabled}
            aria-disabled={opt.disabled || undefined}
            {...(multi
              ? { "aria-pressed": isSelected(opt) }
              : { role: "radio", "aria-checked": isSelected(opt) })}
            onClick={() => handleOptionClick(opt)}
          >
            <span className="hon-sheet-check" aria-hidden="true">
              {multi ? (isSelected(opt) ? "☑" : "☐") : isSelected(opt) ? "✓" : ""}
            </span>
            {opt.icon && <span aria-hidden="true">{opt.icon}</span>}
            {opt.label}
            {opt.hint && <span className="hon-sheet-row-hint">{opt.hint}</span>}
          </button>
        ))}
      </div>
    </>
  );
}
