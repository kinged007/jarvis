import type { WebSocket } from "ws";
import type { ServerMessage } from "@jarvis/shared";

/**
 * WebSocket client registry — Step 3.
 *
 * Tracks every live browser connection and provides broadcast primitives
 * for the rest of the BFF (agent events, STT transcripts, TTS audio,
 * system status…). The registry itself is dumb — it only owns the set of
 * sockets and the safe-send rules; routing logic lives in `router.ts`.
 *
 * Single-user deployment: every JWT carries the same `sub` ("owner"), so
 * `broadcastToUser` is effectively a no-op differentiator. We still keep
 * the API in case the architecture evolves to multi-tenant.
 */

export interface RegisteredClient {
  /** The live ws socket. */
  socket: WebSocket;
  /** Owner user id (decoded from the JWT). */
  userId: string;
  /** Wall-clock ms when the connection was registered. */
  connectedAt: number;
}

const clients = new Set<RegisteredClient>();

/**
 * Add a socket to the registry. Returns the RegisteredClient record so
 * callers can stash it on socket-bound state without an extra lookup.
 */
export function addClient(socket: WebSocket, userId: string): RegisteredClient {
  const record: RegisteredClient = {
    socket,
    userId,
    connectedAt: Date.now(),
  };
  clients.add(record);
  return record;
}

/**
 * Remove a socket from the registry. Safe to call with a socket that was
 * never registered (no-op) or that has already been removed.
 */
export function removeClient(socket: WebSocket): void {
  for (const record of clients) {
    if (record.socket === socket) {
      clients.delete(record);
      return;
    }
  }
}

/** Snapshot of currently-registered clients. Order is insertion order. */
export function getClients(): RegisteredClient[] {
  return Array.from(clients);
}

/** Number of live connections. */
export function getClientCount(): number {
  return clients.size;
}

/**
 * Send a message to every connected client. Skips sockets that aren't
 * `OPEN` (closing/closed sockets throw on send). Failures are swallowed —
 * the connection cleanup runs in the close handler.
 *
 * Pass `{ targetSocket }` to scope the broadcast to a single connection
 * (used by the agent event bridge, which knows the originating socket
 * for a per-run event stream).
 */
export function broadcast(message: ServerMessage, opts?: { targetSocket?: WebSocket }): void {
  for (const record of clients) {
    if (opts?.targetSocket && record.socket !== opts.targetSocket) continue;
    safeSend(record.socket, message);
  }
}

/**
 * Send a message to every connection owned by `userId`. With a single-user
 * deployment this is functionally identical to `broadcast`, but the API
 * is here for the day the auth model changes.
 */
export function broadcastToUser(userId: string, message: ServerMessage): void {
  for (const record of clients) {
    if (record.userId === userId) {
      safeSend(record.socket, message);
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Send a typed `ServerMessage` over a WebSocket. Binary `tts:audio` frames
 * go out as binary; everything else JSON-encoded as text. This split is
 * the one place we mix text/binary frames on the same channel — the client
 * discriminates via `event.data instanceof ArrayBuffer`.
 */
export function safeSend(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    if (message.type === "tts:audio") {
      socket.send(Buffer.from(message.data), { binary: true });
    } else {
      socket.send(JSON.stringify(message));
    }
  } catch {
    // Send failures are non-fatal — the close handler will clean up.
  }
}
