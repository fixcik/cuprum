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
        // startup graph stays lean and they cache separately. three lands in the
        // lazy Board3D chunk (loaded only when the 3D view opens); konva powers
        // the 2D canvas.
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
