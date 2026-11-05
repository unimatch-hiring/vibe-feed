import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Minimal config. Dev server on :5173.
// Served under /vibe-feed/ (Cloudflare Pages; the path is kept from GitHub Pages so old links map 1:1). Local dev is unaffected.
export default defineConfig({
  base: "/vibe-feed/",
  plugins: [react()],
});