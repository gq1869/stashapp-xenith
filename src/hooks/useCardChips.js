const { React } = window.PluginApi;
import { getPluginConfig } from "../plugin-config";
import { resolveUnitSystem } from "../format";
import {
  buildPerformerChips,
  buildSceneChips,
  parseHiddenChips,
  PERFORMER_CHIP_IDS,
  SCENE_CHIP_IDS,
  visibleChips,
} from "../card-chips";

// Resolves an item into its ready-to-render card chip list. `kind` picks
// which allowlist and which HiddenChips-style setting apply — performers
// read UseCustomaryUnits and HiddenChips; scenes read
// HiddenSceneChips, with no unit setting (buildSceneChips has
// nothing unit-dependent). Both settings come off plugin-config.js's shared
// 60s-TTL cache. Fail-open on both: first render (and any fetch failure)
// shows every chip, performers in metric units, same shape as
// Leaderboard.jsx's usePageSize. `item` may be null/undefined (e.g.
// Gauntlet before a challenger is chosen) -> returns [].
export function useCardChips(item, kind = "performers") {
  const [config, setConfig] = React.useState({ UseCustomaryUnits: null, HiddenChips: "", HiddenSceneChips: "" });

  React.useEffect(() => {
    let cancelled = false;
    getPluginConfig()
      .then((c) => { if (!cancelled) setConfig(c); })
      .catch(() => {}); // metric + nothing hidden (config stays default) on failure
    return () => { cancelled = true; };
  }, []);

  const isScenes = kind === "scenes";
  const units = resolveUnitSystem(config.UseCustomaryUnits);
  const hidden = React.useMemo(
    () => parseHiddenChips(isScenes ? config.HiddenSceneChips : config.HiddenChips, isScenes ? SCENE_CHIP_IDS : PERFORMER_CHIP_IDS),
    [isScenes, config.HiddenChips, config.HiddenSceneChips]
  );

  return React.useMemo(
    () => (item ? visibleChips(isScenes ? buildSceneChips(item) : buildPerformerChips(item, units), hidden) : []),
    [item, isScenes, units, hidden]
  );
}
