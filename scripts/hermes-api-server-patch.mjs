#!/usr/bin/env node
/**
 * Idempotently patch the jarvis Hermes profile's `config.yaml` to enable
 * the `api_server` platform. Used by `scripts/setup.sh`.
 *
 * Behaviour:
 *   1. Read `HERMES_API_KEY` from the root `.env` (or the env). If empty,
 *      generate a fresh 32-byte hex (64 chars) and write it back to the
 *      `.env` as `HERMES_API_KEY=...`. Print `KEY=<hex>` to stdout so
 *      the caller can pick it up.
 *   2. Load `~/.hermes/profiles/jarvis/config.yaml`. If the file does
 *      not exist, exit 0 with a warning (the profile is created by
 *      `hermes profile create` earlier in setup.sh).
 *   3. Ensure `platforms.api_server` exists as a dict with `enabled: true`
 *      and an `extra` dict containing:
 *        - `host`:     "127.0.0.1"
 *        - `port`:     8642
 *        - `key`:      the 64-char hex
 *        - `cors_origins`: ["http://localhost:5174"]
 *      Existing keys are preserved (we only set fields if missing or
 *      matching the default). Re-running does NOT rotate the key.
 *   4. Write the file back, preserving the original document order for
 *      the rest of the tree (we splice `platforms` in at the original
 *      `platforms` location if it exists, else at the top level).
 *
 * Idempotency: re-running on an already-patched file is a no-op (the
 * `platforms.api_server` block already exists with the same shape).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// `js-yaml` is a dep of @jarvis/bff. Resolve it from the BFF's
// node_modules so the script can run standalone (no separate install).
const __dirname = dirname(fileURLToPath(import.meta.url));
const bffNodeModules = resolve(__dirname, "..", "packages", "bff", "node_modules");
const require = createRequire(import.meta.url);
const yamlPath = require.resolve("js-yaml", { paths: [bffNodeModules] });
const { load, dump } = await import(yamlPath);

const PROFILE_CONFIG = resolve(
  process.env["HOME"] ?? "/tmp",
  ".hermes/profiles/jarvis/config.yaml",
);
const ENV_FILE = resolve(process.cwd(), ".env");
const API_KEY_NAME = "HERMES_API_KEY";
const KEY_LEN = 64; // 32 bytes hex

// --- 1. Resolve API key ---------------------------------------------------

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeEnvFile(path, env) {
  const keys = Object.keys(env);
  const lines = keys.map((k) => `${k}=${env[k]}`);
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

function genHex(bytes) {
  // 32 bytes → 64 hex chars. crypto.randomBytes is sync-only via the
  // node: built-in; we just use it.
  return require("node:crypto").randomBytes(bytes).toString("hex");
}

const env = readEnvFile(ENV_FILE);
let key = (env[API_KEY_NAME] ?? process.env[API_KEY_NAME] ?? "").trim();
let generated = false;
if (!/^[0-9a-f]{64}$/i.test(key)) {
  key = genHex(32);
  generated = true;
  env[API_KEY_NAME] = key;
  writeEnvFile(ENV_FILE, env);
  process.stderr.write(`[hermes-patch] generated fresh ${API_KEY_NAME}\n`);
} else {
  process.stderr.write(`[hermes-patch] reusing existing ${API_KEY_NAME}\n`);
}

// --- 2. Patch the profile yaml -------------------------------------------

if (!existsSync(PROFILE_CONFIG)) {
  process.stderr.write(
    `[hermes-patch] profile config not found at ${PROFILE_CONFIG} — skipping (run 'hermes profile create jarvis' first)\n`,
  );
  // Still print the key so setup.sh can echo it.
  process.stdout.write(`KEY=${key}\nGENERATED=${generated ? 1 : 0}\n`);
  process.exit(0);
}

let doc;
try {
  doc = load(readFileSync(PROFILE_CONFIG, "utf8"), { filename: PROFILE_CONFIG });
} catch (err) {
  process.stderr.write(`[hermes-patch] failed to parse ${PROFILE_CONFIG}: ${err.message}\n`);
  process.exit(2);
}
if (doc === null || doc === undefined || typeof doc !== "object") {
  doc = {};
}

if (!doc["platforms"] || typeof doc["platforms"] !== "object" || Array.isArray(doc["platforms"])) {
  doc["platforms"] = {};
}

let apiServer = doc["platforms"]["api_server"];
if (!apiServer || typeof apiServer !== "object" || Array.isArray(apiServer)) {
  apiServer = {};
}
doc["platforms"]["api_server"] = apiServer;

if (apiServer["enabled"] !== true) {
  apiServer["enabled"] = true;
}

let extra = apiServer["extra"];
if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
  extra = {};
}
apiServer["extra"] = extra;

if (extra["host"] !== "127.0.0.1") extra["host"] = "127.0.0.1";
if (extra["port"] !== 8642) extra["port"] = 8642;
if (typeof extra["key"] !== "string" || !/^[0-9a-f]{64}$/i.test(extra["key"])) {
  extra["key"] = key;
}
if (!Array.isArray(extra["cors_origins"]) || extra["cors_origins"].length === 0) {
  extra["cors_origins"] = ["http://localhost:5174"];
}

// Preserve key order at the top level: keep the `platforms` key in
// its existing position by re-inserting it at the same index. yaml
// dump reorders by insertion order.
const orderedTop = {};
const topKeys = Object.keys(doc);
const platformsIdx = topKeys.indexOf("platforms");
if (platformsIdx === -1) {
  orderedTop["platforms"] = doc["platforms"];
  for (const k of topKeys) {
    if (k !== "platforms") orderedTop[k] = doc[k];
  }
} else {
  for (let i = 0; i < topKeys.length; i++) {
    if (i === platformsIdx) {
      orderedTop["platforms"] = doc["platforms"];
    } else {
      const k = topKeys[i];
      if (k !== "platforms") orderedTop[k] = doc[k];
    }
  }
}

// Preserve key order within the api_server block too.
const orderedApiServer = { enabled: true, extra };
for (const k of Object.keys(apiServer)) {
  if (k !== "enabled" && k !== "extra") orderedApiServer[k] = apiServer[k];
}

// Same for `platforms` at the parent level.
orderedTop["platforms"]["api_server"] = orderedApiServer;

const out = dump(orderedTop, {
  lineWidth: 120,
  noRefs: true,
  sortKeys: false,
  quotingType: '"',
});
writeFileSync(PROFILE_CONFIG, out, "utf8");

process.stdout.write(`KEY=${key}\nGENERATED=${generated ? 1 : 0}\nPATCHED=${PROFILE_CONFIG}\n`);
