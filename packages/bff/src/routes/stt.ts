import type { FastifyInstance } from "fastify";
import { env } from "../env.js";

/**
 * POST /api/stt/transcribe — batch transcription via Deepgram REST API.
 *
 * Accepts raw linear16 PCM audio (16kHz mono) in the request body and
 * returns the full transcript in one shot. Used by the wakeword flow
 * where all audio arrives as a single buffer (pre-roll + command).
 *
 * Unlike the WebSocket streaming STT, this endpoint:
 *   - Handles complete audio buffers (no streaming required)
 *   - Returns a single final transcript (no interim results)
 *   - Is simpler and more reliable for batch audio
 */

const DEEPGRAM_REST_URL = "https://api.deepgram.com/v1/listen";

export async function sttRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/stt/transcribe", async (request, reply) => {
    const apiKey = env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      return reply.status(503).send({
        error: { code: "SERVICE_UNAVAILABLE", message: "DEEPGRAM_API_KEY not configured" },
      });
    }

    const audioBuffer = request.body as Buffer;
    if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "Request body must be raw linear16 PCM audio" },
      });
    }

    const params = new URLSearchParams({
      model: "nova-2",
      language: "en-US",
      smart_format: "true",
      profanity_filter: "false",
      detect_language: "true",
    });

    const url = `${DEEPGRAM_REST_URL}?${params.toString()}`;

    try {
      const dgRes = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "audio/wav",
        },
        body: audioBuffer,
      });

      if (!dgRes.ok) {
        const errText = await dgRes.text().catch(() => "unknown");
        app.log.error({ status: dgRes.status, body: errText.slice(0, 500) }, "deepgram rest stt failed");
        return reply.status(502).send({
          error: { code: "UPSTREAM_ERROR", message: `Deepgram returned ${dgRes.status}` },
        });
      }

      const result = (await dgRes.json()) as {
        results?: { channels?: { alternatives?: { transcript?: string; confidence?: number }[] }[] };
        transcript?: string;
      };

      // Deepgram REST returns: { results: { channels: [{ alternatives: [{ transcript }] }] } }
      const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";

      app.log.debug(
        { transcriptLen: transcript.length },
        "deepgram rest stt completed",
      );

      return { transcript };
    } catch (err) {
      app.log.error({ err: (err as Error).message }, "deepgram rest stt error");
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: (err as Error).message },
      });
    }
  });
}
