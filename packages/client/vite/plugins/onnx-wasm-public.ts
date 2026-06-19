/**
 * Vite plugin: serve the openWakeWord runtime assets from
 * `public/openwakeword/{models,ort}/` at /openwakeword/* with the
 * right Content-Type and Cross-Origin-Resource-Policy headers.
 *
 * Why this exists:
 *   - The dev server sets `Cross-Origin-Embedder-Policy: require-corp`
 *     (needed for SharedArrayBuffer / threading). With COEP=require-corp,
 *     every subresource — including the onnxruntime-web WASM binary,
 *     the .mjs loader, the ONNX models, and the AudioWorklet module —
 *     must be served with a `Cross-Origin-Resource-Policy` header.
 *     Without it the browser refuses to load them, firing `onerror`
 *     with an empty message.
 *   - Vite serves /public files as static assets, but it doesn't set
 *     CORP and won't serve .mjs files in /public as proper JS modules
 *     (the browser's AudioWorklet API needs a real .mjs with the right
 *     MIME type). This plugin handles the request in our own
 *     middleware ahead of Vite's handlers and returns the file with
 *     the right headers.
 *
 * In production builds, /public/openwakeword/* is copied to
 * dist/openwakeword/* and served as static assets. The hosting server
 * (Vite preview, or whatever serves dist/) must set the same CORP
 * header. The plugin also runs in `configurePreviewServer` to keep
 * preview parity with dev.
 *
 * Note: this is the SECOND-iteration plugin. The first one served
 * /models/* (worker.mjs + jsep WASM) for the openwakeword-js library.
 * That library was replaced by `openwakeword-wasm-browser`, which uses
 * a different layout: models in /openwakeword/models/ and ORT wasm in
 * /openwakeword/ort/. The old /models/* path is no longer used by any
 * code; the old public/models/ directory is kept as orphans and can
 * be deleted in a follow-up.
 */

import { stat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGES_CLIENT = resolve(__dirname, "../..");
const PUBLIC_OPENWAKEWORD = resolve(PACKAGES_CLIENT, "public/openwakeword");

// URL prefixes this plugin handles. Anything else falls through to Vite.
const HANDLED_PREFIXES = ["/openwakeword/"];

function isHandledUrl(url: string): boolean {
  return HANDLED_PREFIXES.some((p) => url.startsWith(p));
}

export default function onnxWasmPublicPlugin() {
  return {
    name: "jarvis:onnx-wasm-public",
    enforce: "pre" as const,

    // Mark any handled .mjs URL as external so Vite's optimizer
    // doesn't try to bundle or resolve it — the browser will fetch it
    // directly from our dev middleware.
    resolveId(id: string) {
      if (id.startsWith("/openwakeword/") && id.endsWith(".mjs")) {
        return { id, external: true };
      }
      return null;
    },

    configureServer(server: any) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = req.url;
        if (!url || !isHandledUrl(url)) {
          return next();
        }

        // Strip the prefix and any query string
        const relPath = url
          .split("?")[0]!
          .replace(/^\/openwakeword\//, "");
        const filePath = join(PUBLIC_OPENWAKEWORD, relPath);

        // Path safety: must resolve to PUBLIC_OPENWAKEWORD
        if (
          !filePath.startsWith(PUBLIC_OPENWAKEWORD + "/") &&
          filePath !== PUBLIC_OPENWAKEWORD
        ) {
          return next();
        }

        try {
          const s = await stat(filePath);
          if (!s.isFile()) return next();
          const content = await readFile(filePath);

          if (filePath.endsWith(".mjs")) {
            res.setHeader("Content-Type", "text/javascript; charset=utf-8");
          } else if (filePath.endsWith(".wasm")) {
            res.setHeader("Content-Type", "application/wasm");
          } else if (filePath.endsWith(".onnx")) {
            res.setHeader("Content-Type", "application/octet-stream");
          } else {
            // Let other middleware handle unknown extensions
            return next();
          }

          // COEP=require-corp requires every subresource to be served
          // with CORP. Without this the browser blocks the resource
          // (worker, WASM, ONNX) silently.
          res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          res.statusCode = 200;
          res.end(content);
        } catch {
          // File missing or unreadable — let Vite's 404 handler take over
          next();
        }
      });
    },

    // Production preview (`vite preview`) needs the same headers.
    configurePreviewServer(server: any) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = req.url;
        if (!url || !isHandledUrl(url)) {
          return next();
        }
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        if (url.endsWith(".mjs") || url.includes(".mjs?")) {
          res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        } else if (url.endsWith(".wasm") || url.includes(".wasm?")) {
          res.setHeader("Content-Type", "application/wasm");
        }
        next();
      });
    },
  };
}
