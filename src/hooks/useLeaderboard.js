const { React } = window.PluginApi;
import { getRankedItems } from "../rank-cache";
import { useXenithState } from "../state";

export function useLeaderboard() {
  const { battleType } = useXenithState();
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState(null);

  // Cancellation is needed here because Leaderboard unmounts outright on
  // tab switch (main.js's TABS lookup in XenithLayout), so a fetch that
  // resolves after unmount
  // would call setState on an unmounted component. A Record Type switch
  // mid-fetch (see the load() dep array below) re-runs this effect too,
  // so a superseded response from the old battleType must also be
  // discarded rather than clobbering the new one. A generation counter
  // fixes both: bumped on every load() call and again on unmount, so a
  // stale response is detected either way.
  const loadGenerationRef = React.useRef(0);

  const load = React.useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setError(null);
    try {
      // rank-cache.js already computes stats/tier/composite and sorts
      // by composite descending — this used to be done independently here.
      const ranked = await getRankedItems(battleType);
      if (loadGenerationRef.current !== generation) return; // superseded or unmounted
      setRows(ranked);
    } catch (e) {
      if (loadGenerationRef.current !== generation) return;
      setError(/** @type {any} */(e).message);
    }
  }, [battleType]);

  React.useEffect(() => {
    // battleType in the load() dep array means a Record Type switch mid-fetch
    // re-runs this effect — the generation counter above discards the
    // superseded response, so rows never briefly show the wrong battle
    // type's data.
    load();
    return () => {
      loadGenerationRef.current += 1; // invalidate any in-flight load() on unmount
    };
  }, [load]);

  return { rows, error, battleType };
}
