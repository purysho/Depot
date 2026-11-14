/// <reference types="vitest/config" />
import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Set by `tauri dev` when the webview runs on another device (mobile dev).
const host = process.env.TAURI_DEV_HOST;

// Mirrors the official create-tauri-app React template, plus Tailwind.
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Keep Rust compiler errors visible in the terminal.
  clearScreen: false,
  server: {
    // Tauri's devUrl points at this port, so fail rather than pick another.
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },

  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
