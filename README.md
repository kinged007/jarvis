# JARVIS

Voice-first AI assistant dashboard inspired by Iron Man's JARVIS.

## Prerequisites

- **Node.js** 20+ and **pnpm**
- **[Hermes](https://github.com/nousresearch/hermes)** — must be installed and on your PATH. The agent runs inside a dedicated `jarvis` profile at `~/.hermes/profiles/jarvis`.
- **Deepgram API key** — for speech-to-text and text-to-speech

## Quick Start

```bash
# 1. Run the setup script
bash scripts/setup.sh

# 2. Set your login password
pnpm hash-password "your-password"
# Copy the hash to JARVIS_PASSWORD in .env

# 3. Add your Deepgram API key to .env
# DEEPGRAM_API_KEY=<your-key>

# 4. Configure the jarvis profile's AI model
hermes -p jarvis setup

# 5. Start
pnpm dev
```

Open `http://localhost:5174` and log in with your password.

## What the setup script does

- Checks prerequisites (node, pnpm, hermes)
- Creates `.env` from `.env.example` and generates a `JWT_SECRET`
- Creates the `jarvis` Hermes profile at `~/.hermes/profiles/jarvis`
- Copies `SOUL.md` and the `jarvis` plugin into the profile
- Installs npm dependencies

## Development

```bash
pnpm dev
```

Starts the BFF (Fastify, port 3001) and client (Vite, port 5174).

## Architecture

```
┌──────────────┐     WS      ┌──────────┐   JSONL/stdin   ┌────────────────┐
│  React/Vite  │ ◄─────────► │  Fastify  │ ◄─────────────► │  Hermes Agent  │
│  client      │             │  BFF      │                │  (jarvis prof) │
└──────────────┘             └──────────┘                └────────────────┘
                                    │
                              ┌─────┴─────┐
                              │  Deepgram  │
                              │  STT / TTS │
                              └───────────┘
```

| Package | Purpose |
|---------|---------|
| `packages/bff` | Fastify server: WebSocket gateway, Deepgram proxy, agent subprocess manager |
| `packages/client` | React frontend: voice pipeline, AI visualization, text input |
| `packages/shared` | TypeScript types shared between BFF and client |
| `SOUL.md` | Agent persona (JARVIS voice style) — synced to the jarvis Hermes profile |
| `.hermes/plugins/jarvis` | Hermes plugin providing the `client_browser` tool |
| `scripts/setup.sh` | One-command bootstrap script |
