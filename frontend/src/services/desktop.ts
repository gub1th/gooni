// Is this bundle running inside the Electron shell?
//
// The SAME deployed bundle serves three hosts — a browser tab, the Chrome
// extension's new-tab frame, and `desktop/`'s window — so anything that is only
// meaningful in the last one has to ask. It asks for a POSITIVE signal that the
// shell's preload sets (`desktop/src/preload-app.js`) rather than sniffing the
// user agent: a wrong answer here is silent in both directions, and the shell
// is the one host that can tell us the truth for free.
//
// What currently depends on it: the window-drag region. A `titleBarStyle:
// hiddenInset` window has its title bar covered by web content, so unless the
// page volunteers a drag region the window cannot be moved at all — while in a
// browser tab the same region would be meaningless.

interface DesktopBridge {
  platform?: string;
  /** the theme the shell painted its window background from, this launch */
  openedTheme?: string | null;
}

function bridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __GOONI_DESKTOP__?: DesktopBridge };
  return w.__GOONI_DESKTOP__ ?? null;
}

export function isDesktopShell(): boolean {
  return bridge() != null;
}

/** macOS is the only platform with traffic lights inset over the content. */
export function isDesktopMac(): boolean {
  return bridge()?.platform === "darwin";
}

/**
 * `-webkit-app-region`, as a style object that is EMPTY off the desktop.
 *
 * Typed as a plain object rather than through React.CSSProperties because the
 * property is not in the DOM typings — and emitted only inside the shell, so a
 * browser tab never carries a rule it would have to ignore.
 */
export function dragRegion(value: "drag" | "no-drag"): React.CSSProperties {
  if (!isDesktopShell()) return {};
  return { WebkitAppRegion: value } as React.CSSProperties;
}
