/**
 * WebSocket send sinks — module-level primitives the rest of the
 * client uses to talk to the BFF.
 *
 * The transport layer (`useWebSocket.ts`) owns the live `WebSocket`
 * and writes it to `gSocket` on every connect. The sinks read from
 * `gSocket` on every send. This indirection lets the STT service and
 * the text-input flow both use the same send functions without
 * pulling in the React lifecycle of `useWebSocket`.
 *
 * The sinks are stateless from the caller's perspective — they check
 * `gSocket.readyState` and silently drop if the socket isn't open.
 * That matches the pre-refactor behaviour exactly.
 */

import type { ClientMessage } from "@jarvis/shared";

export type SendFn = (
  msg: ClientMessage | { type: "voice:chunk"; data: ArrayBuffer },
) => void;
export type SendBinaryFn = (data: ArrayBuffer) => void;

let gSocket: WebSocket | null = null;

export function setActiveSocket(socket: WebSocket | null): void {
  gSocket = socket;
}

export function getActiveSocket(): WebSocket | null {
  return gSocket;
}

export const sendMessage: SendFn = (msg) => {
  if (!gSocket || gSocket.readyState !== WebSocket.OPEN) return;
  if (msg.type === "voice:chunk") {
    gSocket.send(msg.data);
    return;
  }
  gSocket.send(JSON.stringify(msg));
};

export const sendBinary: SendBinaryFn = (data) => {
  if (!gSocket || gSocket.readyState !== WebSocket.OPEN) return;
  gSocket.send(data);
};
