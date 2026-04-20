// Minimal service worker — makes the app installable as a PWA.
// No offline caching for now; all requests go straight to the network.
self.addEventListener("fetch", () => {});
