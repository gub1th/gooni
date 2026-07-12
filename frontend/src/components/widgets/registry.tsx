import { CalendarDays, type LucideIcon } from "lucide-react";
import type { WidgetView } from "../../stores/useWidgetOverlayStore";
import { CalendarCompact } from "./CalendarWidget";
import { CalendarPanel } from "./CalendarPanel";

// THE widget registry. Adding a widget = append one entry here + write its
// Compact (and optionally Panel) component. Everything downstream is derived:
// WidgetHost renders each enabled widget's Compact on the home screen, the app
// nav lists every widget that has a Panel, and Settings ▸ Widgets renders a
// toggle per entry. No other file needs to know a widget exists.

export interface WidgetCompactProps {
  /** Open this widget's full panel (no-op if the widget has no Panel). */
  onExpand: () => void;
}

export interface WidgetPanelProps {
  onClose: () => void;
  initialView: WidgetView;
}

export interface WidgetDef {
  id: string;
  title: string;
  Icon: LucideIcon;
  /** Shown on the home screen unless the user turns it off in Settings. */
  defaultEnabled: boolean;
  /** Small draggable card body. */
  Compact: React.FC<WidgetCompactProps>;
  /** Full frosted overlay (opened via expand / the nav). Optional. */
  Panel?: React.FC<WidgetPanelProps>;
}

export const WIDGETS: WidgetDef[] = [
  {
    id: "calendar",
    title: "Calendar",
    Icon: CalendarDays,
    defaultEnabled: true,
    Compact: CalendarCompact,
    Panel: CalendarPanel,
  },
];

export function getWidget(id: string | null): WidgetDef | undefined {
  return WIDGETS.find((w) => w.id === id);
}
