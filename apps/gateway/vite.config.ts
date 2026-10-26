// The dashboard is a static SPA built into dist/public and served by the gateway itself,
// so the browser talks to one origin and the session cookie stays first-party.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/public", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:18083" } },
});
