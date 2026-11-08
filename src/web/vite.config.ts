import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // The API runs locally with `npm run dev -w src/api` (in-memory data, no AWS).
    proxy: { "/api": "http://localhost:8787" },
  },
  preview: { port: 4173, strictPort: true },
  // The edge CSP only allows same-origin scripts and styles, and source maps are not published.
  build: { target: "es2022", sourcemap: false },
});
