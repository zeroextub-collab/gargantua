import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { gargantua } from "./vite-plugin-gargantua.ts";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [gargantua()],
  server: { host: "127.0.0.1", port: 5178, strictPort: false },
  preview: { host: "127.0.0.1", port: 5179 },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 1500, assetsInlineLimit: 0 },
});
