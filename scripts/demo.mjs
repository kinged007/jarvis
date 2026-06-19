#!/usr/bin/env node
/**
 * JARVIS BFF Reference CLI Client (demo.mjs)
 *
 * A standalone terminal client that connects to the JARVIS BFF exactly the
 * way the web UI does: REST login → WebSocket upgrade → command/event loop.
 *
 * Every ServerMessage received is dispatched to the terminal with
 * [gateway] and [bff] source tags. Raw PCM audio is piped to ffplay for
 * live playback.
 *
 * Usage:
 *   node scripts/demo.mjs
 *
 * Environment:
 *   JARVIS_BFF_ORIGIN   BFF base URL (default: http://localhost:3001)
 *   JARVIS_PASSWORD     Login password (prompted if unset)
 */

import * as readline from "node:readline";
import { spawn } from "node:child_process";

// ── Config ────────────────────────────────────────────────────────────────

const BFF_ORIGIN = (process.env.JARVIS_BFF_ORIGIN ?? "http://localhost:3001").replace(/\/+$/, "");
const PASSWORD = process.env.JARVIS_PASSWORD ?? null;

// ── ANSI colors matching LogModal taxonomy ────────────────────────────────

const C = {
  reset:     "\x1b[0m",
  dim:       "\x1b[2m",
  bold:      "\x1b[1m",
  green:     "\x1b[38;5;48m",
  cyan:      "\x1b[38;5;51m",
  red:       "\x1b[38;5;196m",
  grey:      "\x1b[38;5;245m",
  magenta:   "\x1b[38;5;213m",
  white:     "\x1b[38;5;255m",
  yellow:    "\x1b[38;5;82m",
};

// Source tags
const TAG = {
  gateway: `${C.dim}[${C.cyan}gateway${C.dim}]${C.reset}`,
  bff:     `${C.dim}[${C.grey}bff${C.dim}]${C.reset}`,
};

// ── Helpers ───────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function log(color, tag, msg) {
  console.log(`${C.dim}${timestamp()}${C.reset}  ${tag}  ${color}${msg}${C.reset}`);
}

// ── State ─────────────────────────────────────────────────────────────────

let gSocket = null;
let gRunActive = false;

/** Pending approval the user needs to respond to. Null when none. */
let gPendingApproval = null;

// tts:audio byte counter (throttled to once per second)
let gTtsBytes = 0;
let gLastTtsLog = 0;

// Audio playback via ffplay (raw 24kHz 16-bit mono PCM)
let gPlayer = null;
let gPlayerKillTimer = null;

function ensurePlayer() {
  if (gPlayer && !gPlayer.killed && gPlayer.stdin.writable) return;
  killPlayer();
  gPlayer = spawn("ffplay", [
    "-f", "s16le",
    "-ar", "24000",
    "-ac", "1",
    "-nodisp",
    "-autoexit",
    "-loglevel", "quiet",
    "pipe:0",
  ], { stdio: ["pipe", "ignore", "ignore"] });
  gPlayer.stdin.on("error", () => {}); // silence EPIPE when ffplay auto-exits
  gPlayer.on("exit", () => { gPlayer = null; });
  gPlayer.on("error", () => { gPlayer = null; });
}

function killPlayer() {
  if (gPlayerKillTimer) clearTimeout(gPlayerKillTimer);
  gPlayerKillTimer = null;
  if (gPlayer) {
    try { gPlayer.stdin.end(); } catch {}
    try { gPlayer.kill(); } catch {}
    gPlayer = null;
  }
}

function writeAudio(chunk) {
  if (!gPlayer || gPlayer.killed || !gPlayer.stdin.writable) {
    ensurePlayer();
  }
  if (gPlayer && !gPlayer.killed && gPlayer.stdin.writable) {
    try {
      gPlayer.stdin.write(Buffer.from(chunk));
    } catch {
      gPlayer = null;
      ensurePlayer();
      if (gPlayer && !gPlayer.killed && gPlayer.stdin.writable) {
        gPlayer.stdin.write(Buffer.from(chunk));
      }
    }
  }
}

// ── Server message dispatch ───────────────────────────────────────────────

function dispatchServerMessage(msg) {
  switch (msg.type) {

    case "system:heartbeat":
      break;

    case "system:status":
      log(C.grey, TAG.bff, `connected  agent:${msg.agentReady ? "ready" : "down"}  uptime:${Math.round(msg.uptime)}s`);
      break;

    // ── Gateway events ──────────────────────────────────────────

    case "agent:state": {
      const icons = { idle: "○", thinking: "◌", executing: "⚙", waiting: "⏳", error: "✕" };
      const colors = { idle: C.grey, thinking: C.cyan, executing: C.yellow, waiting: C.yellow, error: C.red };
      log(colors[msg.state] ?? C.grey, TAG.gateway, `${icons[msg.state] ?? ""} ${msg.state}`);
      break;
    }

    case "agent:commentary":
      gRunActive = true;
      log(C.cyan, TAG.gateway, `commentary: ${msg.text}`);
      break;

    case "agent:response_delta": {
      gRunActive = true;
      process.stdout.write(`${C.white}${msg.delta}${C.reset}`);
      break;
    }

    case "agent:response": {
      gRunActive = false;
      gPendingApproval = null;
      if (msg.text) {
        process.stdout.write("\n");
        log(C.grey, TAG.gateway, `response: ${msg.text}`);
      }
      break;
    }

    case "agent:run_complete": {
      gRunActive = false;
      gPendingApproval = null;
      process.stdout.write("\n");
      const usage = msg.usage ? `  tokens in:${msg.usage.inputTokens} out:${msg.usage.outputTokens}` : "";
      if (msg.status === "completed" || msg.status === "cancelled") {
        log(C.magenta, TAG.gateway, `run ${msg.status}${usage}`);
      } else {
        log(C.red, TAG.gateway, `run ${msg.status}  ${msg.error ?? ""}`);
      }
      break;
    }

    case "agent:tool_call": {
      const preview = msg.preview ? ` — ${msg.preview}` : "";
      log(C.cyan, TAG.gateway, `tool: ${msg.tool}${preview}`);
      break;
    }

    case "agent:tool_result": {
      let output = typeof msg.output === "string" ? msg.output : String(msg.output);
      if (output.length > 200) output = output.slice(0, 200) + `…`;
      log(C.grey, TAG.gateway, `result: ${msg.tool}  ${output}`);
      break;
    }

    case "agent:approval_request": {
      const choices = (msg.choices ?? []).join(", ");
      log(C.cyan, TAG.gateway, `approval: ${msg.tool ?? "?"}  choices: [${choices}]`);
      gPendingApproval = { runId: msg.runId, requestId: msg.requestId };
      showPrompt();
      break;
    }

    case "agent:approval_resolved":
      gPendingApproval = null;
      log(C.grey, TAG.gateway, `approval resolved: ${msg.choice}`);
      showPrompt();
      break;

    case "agent:browser_open":
      log(C.cyan, TAG.gateway, `browser: ${msg.url}`);
      break;

    // ── STT ─────────────────────────────────────────────────────

    case "stt:transcript":
      if (!msg.interim) log(C.grey, TAG.bff, `stt: ${msg.text}`);
      break;

    // ── TTS pipeline (BFF actions) ──────────────────────────────

    case "tts:utterance": {
      const text = msg.text.length > 80 ? msg.text.slice(0, 80) + "…" : msg.text;
      log(C.grey, TAG.bff, `tts speak  ${msg.kind}  ${msg.id.slice(0, 8)}  ${text}`);
      break;
    }

    case "tts:audio":
      if (msg.data) gTtsBytes += msg.data.byteLength ?? msg.data.length ?? 0;
      if (Date.now() - gLastTtsLog > 1000) {
        log(C.grey, TAG.bff, `tts audio  ${(gTtsBytes / 1024).toFixed(1)}kB`);
        gLastTtsLog = Date.now();
        gTtsBytes = 0;
      }
      // Pipe raw PCM to ffplay for audio output
      writeAudio(msg.data);
      break;

    case "tts:utterance_end":
      break;

    case "tts:queue": {
      const current = msg.currentId ? msg.currentId.slice(0, 8) : null;
      const parts = msg.items.map((it) => {
        const isCurrent = it.id.slice(0, 8) === current;
        return `${isCurrent ? C.green + "▶" + C.reset : ""}${it.kind}(${it.id.slice(0, 8)})`;
      });
      if (parts.length === 0) {
        log(C.grey, TAG.bff, "tts queue  (empty)");
        // Kill the player 500ms after queue empties so the last
        // audio buffers drain before the process stops.
        if (gPlayerKillTimer) clearTimeout(gPlayerKillTimer);
        gPlayerKillTimer = setTimeout(killPlayer, 500);
      } else {
        log(C.grey, TAG.bff, `tts queue [${msg.items.length}]: ${parts.join(" ")}`);
      }
      break;
    }

    case "tts:error": {
      log(C.red, TAG.bff, `tts error  ${msg.id.slice(0, 8)}  ${msg.message}${msg.provider ? ` (${msg.provider})` : ""}`);
      break;
    }

    // ── System ──────────────────────────────────────────────────

    case "server:cancelled_ack":
      gRunActive = false;
      log(C.grey, TAG.bff, "cancelled");
      break;

    case "error":
      gRunActive = false;
      log(C.red, TAG.bff, msg.message);
      break;

    default:
      log(C.red, TAG.bff, `unknown: ${msg.type ?? "(missing)"}`);
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────

async function login() {
  const password = PASSWORD ?? await promptPassword();
  const url = `${BFF_ORIGIN}/api/auth/login`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
  } catch (err) {
    console.error(`${C.red}failed to reach BFF at ${url}: ${err.message}${C.reset}`);
    process.exit(1);
  }

  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j?.error?.message ?? ""; } catch { /* */ }
    console.error(`${C.red}login failed (${res.status})${detail ? ": " + detail : ""}${C.reset}`);
    process.exit(1);
  }

  const jarvisCookie = res.headers.getSetCookie?.()
    ?.find((c) => c.startsWith("jarvis_session="))
    ?.split(";")[0];

  if (!jarvisCookie) {
    console.error(`${C.red}no session cookie in login response${C.reset}`);
    process.exit(1);
  }

  const body = await res.json().catch(() => ({}));
  console.log(`${C.grey}${timestamp()}  AUTH     authenticated as ${body.user ?? "owner"}${C.reset}`);
  return jarvisCookie;
}

function promptPassword() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question("Password: ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ── WebSocket connect ─────────────────────────────────────────────────────

function connect(cookie) {
  return new Promise((resolve, reject) => {
    const wsUrl = BFF_ORIGIN.replace(/^http/, "ws") + "/ws";

    const socket = new WebSocket(wsUrl, {
      headers: { Cookie: cookie },
    });
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
      gSocket = socket;
      log(C.grey, TAG.bff, "ws connected");
      resolve(socket);
    });

    socket.addEventListener("error", (err) => {
      console.error(`${C.red}${timestamp()}  WS-ERROR  ${err.message || "connection failed"}${C.reset}`);
    });

    socket.addEventListener("close", (ev) => {
      gSocket = null;
      gRunActive = false;
      killPlayer();
      const reason = ev.reason ? `  ${ev.reason}` : "";
      log(C.grey, TAG.bff, `ws closed  code:${ev.code}${reason}`);
      if (ev.code !== 1000 && ev.code !== 1001) {
        console.log(`${C.dim}  (re-run to reconnect)${C.reset}`);
      }
      process.exit(ev.code === 1000 ? 0 : 1);
    });

    socket.addEventListener("message", (ev) => {
      if (ev.data instanceof ArrayBuffer || ev.data instanceof Buffer) {
        dispatchServerMessage({ type: "tts:audio", data: ev.data });
        return;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        log(C.red, TAG.bff, `invalid JSON: ${String(ev.data).slice(0, 100)}`);
        return;
      }

      if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
        log(C.red, TAG.bff, "untyped message");
        return;
      }

      try {
        dispatchServerMessage(parsed);
      } catch (err) {
        log(C.red, TAG.bff, `dispatch error: ${err.message}`);
      }
    });

    setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket connection timed out"));
      }
    }, 10_000);
  });
}

// ── Send ──────────────────────────────────────────────────────────────────

function send(msg) {
  if (!gSocket || gSocket.readyState !== WebSocket.OPEN) {
    console.log(`${C.dim}  (not connected)${C.reset}`);
    return false;
  }
  gSocket.send(JSON.stringify(msg));
  return true;
}

// ── REPL ──────────────────────────────────────────────────────────────────

let gRl = null;

function showPrompt() {
  if (gPendingApproval) {
    process.stdout.write(`\n${C.yellow}[once / session / always / deny]${C.reset} ${C.dim}█${C.reset} `);
  } else {
    process.stdout.write(`${C.dim}█${C.reset} `);
  }
}

function startRepl() {
  gRl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  gRl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      showPrompt();
      return;
    }

    if (trimmed === "/quit" || trimmed === "/exit") {
      gracefulExit();
      return;
    }

    if (trimmed === "/cancel") {
      gPendingApproval = null;
      send({ type: "cancel" });
      console.log(`${C.dim}  cancel sent${C.reset}`);
      showPrompt();
      return;
    }

    if (trimmed === "/help") {
      console.log("");
      console.log(`${C.bold}Commands:${C.reset}`);
      console.log(`  <text>       Send a text command to the agent`);
      console.log(`  /cancel      Cancel the current run`);
      console.log(`  /quit        Disconnect and exit`);
      console.log(`  /help        Show this help`);
      console.log(`  ${C.green}once${C.reset} / ${C.red}deny${C.reset}    Respond to approval requests`);
      console.log("");
      showPrompt();
      return;
    }

    // Check if we have a pending approval — the user's line is the choice.
    if (gPendingApproval) {
      const choice = trimmed.toLowerCase();
      const validChoices = ["once", "session", "always", "deny"];
      if (validChoices.includes(choice)) {
        const payload = {
          type: "agent:approval_response",
          runId: gPendingApproval.runId,
          requestId: gPendingApproval.requestId,
          choice,
        };
        console.log(`${C.dim}  sending: ${JSON.stringify(payload)}${C.reset}`);
        send(payload);
        gPendingApproval = null;
      } else {
        console.log(`${C.red}  invalid choice — use once, session, always, or deny${C.reset}`);
      }
      showPrompt();
      return;
    }

    // Regular text command
    send({ type: "command", text: trimmed });
    console.log(`${C.dim}  → ${trimmed}${C.reset}`);
  });

  gRl.on("close", () => {
    gracefulExit();
  });

  showPrompt();
}

function gracefulExit() {
  gRunActive = false;
  killPlayer();
  if (gSocket && gSocket.readyState === WebSocket.OPEN) {
    gSocket.close(1000, "user quit");
  }
  setTimeout(() => process.exit(0), 500);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log(`${C.bold}JARVIS BFF Reference Client${C.reset}`);
  console.log(`${C.dim}Endpoint: ${BFF_ORIGIN}${C.reset}`);
  console.log(`${C.dim}Type /help for commands, /quit to exit${C.reset}`);
  console.log("");

  const cookie = await login();
  await connect(cookie);
  startRepl();
}

process.on("SIGINT", () => {
  gracefulExit();
});

main().catch((err) => {
  console.error(`${C.red}fatal: ${err.message}${C.reset}`);
  process.exit(1);
});
