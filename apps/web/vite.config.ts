import { defineConfig } from "vite";

export default defineConfig({
  // file renderers (mermaid, katex, shiki, charts) are lazy chunks; only the entry is on the startup path
  build: { chunkSizeWarningLimit: 700 },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
