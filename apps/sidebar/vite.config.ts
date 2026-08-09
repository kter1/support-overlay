import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative paths: the built bundle is served from assets/ inside the Zendesk
  // app package, not from a domain root.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Flat output: the whole bundle is copied into the app package's assets/
    // directory, so a nested assets/assets/ adds a level for no reason.
    assetsDir: ".",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
