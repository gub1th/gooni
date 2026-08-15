/**
 * Preload for the capture overlay.
 *
 * A narrow bridge on purpose: the capture page never sees a token, a URL or
 * `fetch`. It hands text to the main process and gets a reply back. That is
 * what lets the actual HTTP happen in Node, where the backend's CORS allowlist
 * (which does not include a `file://` origin, and should not be widened to)
 * is not in the way.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gooniCapture", {
  state: () => ipcRenderer.invoke("capture:state"),
  send: (text) => ipcRenderer.invoke("capture:send", text),
  hide: () => ipcRenderer.send("capture:hide"),
  openApp: () => ipcRenderer.send("capture:open-app"),
  resize: (height) => ipcRenderer.send("capture:resize", height),
  onOpened: (fn) => ipcRenderer.on("capture:opened", (_e, state) => fn(state)),
  onClosed: (fn) => ipcRenderer.on("capture:closed", () => fn()),
  onTheme: (fn) => ipcRenderer.on("capture:theme", (_e, theme) => fn(theme)),
});
