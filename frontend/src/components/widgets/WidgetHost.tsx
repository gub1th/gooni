import { Widget } from "./Widget";
import { WIDGETS } from "./registry";
import { useWidgetLayoutStore } from "../../stores/useWidgetLayoutStore";
import { useWidgetOverlayStore } from "../../stores/useWidgetOverlayStore";

// Renders the enabled widgets as draggable cards on the ambient home. Mounted
// inside AmbientHome (home-only surface). Enabled = explicit store override, or
// the registry's defaultEnabled when the user hasn't touched it.
export function WidgetHost() {
  const enabled = useWidgetLayoutStore((s) => s.enabled);
  const setEnabled = useWidgetLayoutStore((s) => s.setEnabled);
  const open = useWidgetOverlayStore((s) => s.open);

  const visible = WIDGETS.filter((w) => enabled[w.id] ?? w.defaultEnabled);

  return (
    <>
      {visible.map((w, i) => {
        const expand = w.Panel ? () => open(w.id, "week") : undefined;
        return (
          <Widget
            key={w.id}
            id={w.id}
            title={w.title}
            Icon={w.Icon}
            index={i}
            onExpand={expand}
            onHide={() => setEnabled(w.id, false)}
          >
            <w.Compact onExpand={expand ?? (() => {})} />
          </Widget>
        );
      })}
    </>
  );
}
