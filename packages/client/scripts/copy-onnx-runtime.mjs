/**
 * Stage openWakeWord runtime assets into packages/client/public/
 * so Vite can serve them. Run automatically via the `postinstall` script
 * in package.json. Idempotent — overwrites the destination only when
 * contents differ.
 *
 * What this stages:
 *
 *   1. ONNX wakeword models  →  public/openwakeword/models/
 *      hey_jarvis_v0.1.onnx, embedding_model.onnx, melspectrogram.onnx,
 *      silero_vad.onnx. Copied from the `openwakeword-wasm-browser`
 *      package (which ships them in its own `models/`).
 *
 *   2. onnxruntime-web WASM  →  public/openwakeword/ort/
 *      ort-wasm-simd-threaded.mjs / .wasm. Copied from the installed
 *      onnxruntime-web package. Self-hosted because the dev server
 *      sets COEP=require-corp, which blocks the default CDN.
 *
 * The WakeWordEngine from `openwakeword-wasm-browser` reads:
 *   - baseAssetUrl: '/openwakeword/models' (where the .onnx files live)
 *   - ortWasmPath:  '/openwakeword/ort/'  (where the ORT wasm lives)
 */

import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGES_CLIENT = resolve(__dirname, "..");
const REPO_ROOT = resolve(PACKAGES_CLIENT, "../..");

async function findDir(pnpmSubpath) {
  const pnpmRoot = join(REPO_ROOT, "node_modules/.pnpm");
  try {
    const entries = await readdir(pnpmRoot);
    for (const entry of entries) {
      if (entry.startsWith(pnpmSubpath + "@")) {
        return join(pnpmRoot, entry, "node_modules", pnpmSubpath, ...(arguments[1] || []));
      }
    }
  } catch {
    // .pnpm doesn't exist
  }
  return null;
}

async function findOwwModels() {
  return findDir("openwakeword-wasm-browser", ["models"]);
}

async function findOrtDist() {
  return findDir("onnxruntime-web", ["dist"]);
}

const REQUIRED_ONNX_MODELS = [
  "hey_jarvis_v0.1.onnx",
  "melspectrogram.onnx",
  "embedding_model.onnx",
  "silero_vad.onnx",
];

// ORT's loader picks the best available variant at runtime. The
// default order is:
//   1. ort-wasm-simd-threaded.jsep.mjs/.wasm  (if WebGPU is available)
//   2. ort-wasm-simd-threaded.mjs/.wasm       (threaded, no WebGPU)
//   3. ort-wasm-simd.mjs/.wasm                (SIMD, no threads)
//   4. ort-wasm.mjs/.wasm                     (basic)
// We stage the two SIMD+threaded variants. The jsep one is bigger
// (~24MB vs ~12MB) but we need it because ORT's loader does NOT
// fall back gracefully when the jsep file is missing — it errors
// out with "no available backend found" instead of trying the
// non-jsep variant. So: ship both, let ORT pick at runtime.
const REQUIRED_ORT_FILES = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
];

const PUBLIC_OPENWAKEWORD = join(PACKAGES_CLIENT, "public/openwakeword");
const PUBLIC_MODELS = join(PUBLIC_OPENWAKEWORD, "models");
const PUBLIC_ORT = join(PUBLIC_OPENWAKEWORD, "ort");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sameContents(a, b) {
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  return sa.size === sb.size;
}

async function copyIfChanged(srcDir, file, destDir) {
  const from = join(srcDir, file);
  const to = join(destDir, file);

  if (!(await exists(from))) {
    console.warn(`[stage-oww-assets] missing source: ${from}`);
    return "missing";
  }

  if ((await exists(to)) && (await sameContents(from, to))) {
    return "unchanged";
  }

  await mkdir(destDir, { recursive: true });
  await copyFile(from, to);
  console.log(`[stage-oww-assets] copied: ${join(destDir.replace(PACKAGES_CLIENT + "/", ""), file)}`);
  return "copied";
}

async function main() {
  const modelsSrc = await findOwwModels();
  const ortSrc = await findOrtDist();

  if (!modelsSrc) {
    console.warn(
      "[stage-oww-assets] openwakeword-wasm-browser not found in node_modules — " +
        "skipping model copy. Run `pnpm install` first, then re-run.",
    );
    return;
  }

  await mkdir(PUBLIC_MODELS, { recursive: true });
  await mkdir(PUBLIC_ORT, { recursive: true });

  let copied = 0;
  let unchanged = 0;

  for (const file of REQUIRED_ONNX_MODELS) {
    const r = await copyIfChanged(modelsSrc, file, PUBLIC_MODELS);
    if (r === "copied") copied += 1;
    else if (r === "unchanged") unchanged += 1;
  }

  if (ortSrc) {
    for (const file of REQUIRED_ORT_FILES) {
      const r = await copyIfChanged(ortSrc, file, PUBLIC_ORT);
      if (r === "copied") copied += 1;
      else if (r === "unchanged") unchanged += 1;
    }
  } else {
    console.warn(
      "[stage-oww-assets] onnxruntime-web not found in node_modules — " +
        "skipping ORT wasm copy.",
    );
  }

  console.log(
    `[stage-oww-assets] done (changed: ${copied}, up-to-date: ${unchanged})`,
  );
}

main().catch((err) => {
  console.error("[stage-oww-assets] failed:", err);
  // Don't fail `pnpm install` if this script errors — better to have a
  // working install with a missing model file than a broken install.
  process.exit(0);
});
