import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./web/src", import.meta.url)),
      "@kairos-ipc/chromatix": fileURLToPath(new URL("../chromatix/src/index.ts", import.meta.url)),
      "@kairos-ipc/chromatix-vue": fileURLToPath(new URL("../chromatix-vue/src/index.ts", import.meta.url)),
      "@kairos-ipc/unocss-preset-chromatix": fileURLToPath(new URL("../chromatix-unocss/src/index.ts", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:5173",
      "/events": "http://127.0.0.1:5173",
    },
  },
});
