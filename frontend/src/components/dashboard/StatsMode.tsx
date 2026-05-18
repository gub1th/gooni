// StatsMode — placeholder shim. Phase 1 of the dashboard restructure
// renames Pulse → Stats. Phase 3 will replace the body with a merged
// view that absorbs the old sidebar StatsView (Whoop / LeetCode /
// Dev Take / Usage / Activity counters) on top of the existing pulse
// grid, organized in a clear visual hierarchy. For now this just
// forwards to PulseMode so the rename is non-functional.
export { PulseMode as StatsMode } from "./PulseMode";
