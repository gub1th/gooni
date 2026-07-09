/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-vite-plugin";

export default defineConfig({
  plugins: [react(), TanStackRouterVite()],
  server: {
    port: 5173,
  },
  // FE test seam (ambient-loop v2 Slice 3 set the precedent): vitest +
  // RTL over jsdom. Keep it thin — one flow per surface, extend
  // incrementally. Run: npm test
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    globals: true,
  },
});
