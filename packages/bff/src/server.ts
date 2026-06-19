import { buildServer, buildBffLogger } from "./app.js";
import { env } from "./env.js";
import { createBffAgentService, type AgentService } from "./services/agent/index.js";
import type { FastifyBaseLogger } from "fastify";

const start = async (): Promise<void> => {
  // Build the logger first (independent of the Fastify app) so we can
  // wire it into the agent service before constructing the app.
  const logger = await buildBffLogger();
  const log = logger as unknown as FastifyBaseLogger;

  // Noop TTS stand-in. The real TTS service is constructed lazily by
  // the WS layer (ws/handler.ts) and installed on the agent service
  // via `setTts()` on first connect. Until then, `tts.enqueue()` is
  // a no-op so the agent bridge doesn't crash if it tries to voice
  // something during the pre-WS window.
  const ttsForAgent = {
    enqueue: () => "",
    enqueueText: () => [],
    clear: () => {},
    setBroadcast: () => {},
    get depth() { return 0; },
    get isBusy() { return false; },
  };

  const hermesArgs = ["-p", env.HERMES_PROFILE, "gateway", "run", "--accept-hooks"];
  const agentService: AgentService = createBffAgentService({
    deps: {
      hermesCmd: env.HERMES_CMD,
      hermesArgs,
      hermesApiUrl: env.HERMES_API_URL,
      hermesApiKey: env.HERMES_API_KEY,
      tts: ttsForAgent,
      broadcast: (msg) => log.debug({ type: msg.type }, "agent: broadcast (pre-ws)"),
      logger: log,
      ttsCommentaryEnabled: env.TTS_COMMENTARY_ENABLED,
      longResponseThreshold: env.LONG_RESPONSE_THRESHOLD_WORDS,
    },
  });
  log.info({ cmd: env.HERMES_CMD, args: hermesArgs, apiUrl: env.HERMES_API_URL }, "agent service constructed");

  // Build the app with the agent service wired in via decorator.
  const app = await buildServer({ agentService });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await agentService.stop();
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, "agent stop failed");
    }
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === "EADDRINUSE") {
      app.log.error(
        { port: env.PORT },
        "port already in use — kill the existing process: lsof -ti:%s | xargs kill -9",
        env.PORT,
      );
    } else {
      app.log.error(err, "failed to start");
    }
    process.exit(1);
  }

  try {
    await agentService.start();
  } catch (err) {
    app.log.error({ err: (err as Error).message }, "agent start failed");
  }
};

void start();
