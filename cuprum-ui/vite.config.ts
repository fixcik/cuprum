import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// @tauri-apps/cli drives this; fixed port + no clearScreen so Tauri can attach.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        // Split heavy, independently-loaded vendors into their own chunks so the
        // startup graph stays lean and they cache separately. konva powers the 2D
        // canvas. The three.js renderer + react-three-fiber/drei now load lazily
        // with Board3D; three's core is still on the startup path via boardOutline
        // (SVGLoader) — see issue #369 to defer that too.
        manualChunks: {
          konva: ["konva", "react-konva"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
