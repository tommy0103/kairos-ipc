import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./web/src", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5176,
    proxy: {
      "/api": "http://127.0.0.1:5173",
      "/events": "http://127.0.0.1:5173",
    },
  },
});
