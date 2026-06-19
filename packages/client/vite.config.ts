import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import onnxWasmPublic from "./vite/plugins/onnx-wasm-public";

export default defineConfig({
  // Load .env files from the workspace root (shared with the BFF) instead
  // of the client package root. Only VITE_* vars are exposed to client code,
  // so BFF-only secrets in the same file are not leaked.
  envDir: path.resolve(__dirname, "../.."),
  plugins: [onnxWasmPublic(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@jarvis/shared": path.resolve(__dirname, "../shared/src"),
      "react/jsx-dev-runtime": path.resolve(__dirname, "src/jsx-dev-shim.ts"),
    },
  },
  optimizeDeps: {
    exclude: ["@jarvis/shared"],
  },
  server: {
    host: "0.0.0.0",
    port: 5174,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
    },
  },
  preview: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
