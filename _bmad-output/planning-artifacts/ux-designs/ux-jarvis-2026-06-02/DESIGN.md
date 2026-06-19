/usr/bin/bash: warning: setlocale: LC_ALL: cannot change locale (en_GB.UTF-8): No such file or directory
---
design_system: custom
components:
  brain-visualization:
    tokens: [colors.neon.cyan, colors.bg.deep, shapes.glow]
  widget-frame:
    tokens: [colors.neon.cyan, colors.bg.panel, spacing.widget, rounded.widget, shapes.border-glow]
  dashboard-layout:
    tokens: [spacing.layout, colors.bg.deep]
  voice-status-bar:
    tokens: [colors.neon.cyan, colors.bg.panel, typography.mono]
  log-panel:
    tokens: [colors.bg.panel, typography.mono, spacing.log]
  auth-gate:
    tokens: [colors.bg.deep, colors.neon.cyan, typography.ui]
  text-input:
    tokens: [colors.bg.panel, colors.neon.cyan, typography.ui]
colors:
  bg:
    deep: '#0a0a0f'
    panel: '#111122'
    elevated: '#1a1a2e'
  neon:
    cyan: '#00f0ff'
    cyan-dim: '#88ccdd'
    amber: '#ff8c00'
    amber-warn: '#ffaa00'
    red: '#ff3344'
  text:
    primary: '#e0e0e0'
    secondary: '#88ccdd'
    muted: '#556677'
  state:
    idle: '#1a3a4a'
    listening: '#00f0ff'
    thinking: '#0088cc'
    speaking: '#00cc88'
    error: '#ff3344'
typography:
  mono:
    family: 'JetBrains Mono, Fira Code, monospace'
    sizes: { xs: 11px, sm: 12px, base: 13px, lg: 15px }
    weight: 400
    line-height: 1.4
  ui:
    family: 'Inter, system-ui, sans-serif'
    sizes: { xs: 11px, sm: 13px, base: 14px, lg: 16px, xl: 20px, title: 24px }
    weight: { body: 400, medium: 500, bold: 600 }
    line-height: 1.3
rounded:
  widget: 8px
  panel: 6px
  button: 6px
  input: 6px
  brain-core: 50%
spacing:
  layout: { gutter: 12px, margin: 16px, panel-gap: 8px }
  widget: { pad-x: 12px, pad-y: 10px, title-pad: 8px, content-gap: 6px }
  log: { entry-pad-x: 10px, entry-pad-y: 4px, entry-gap: 2px }
shapes:
  border-glow: '1px solid {colors.neon.cyan}'
  border-panel: '1px solid rgba(0,240,255,0.15)'
  border-input: '1px solid rgba(0,240,255,0.3)'
  border-input-focus: '1px solid {colors.neon.cyan}'
  glow-soft: '0 0 8px rgba(0,240,255,0.15)'
  glow-medium: '0 0 16px rgba(0,240,255,0.3)'
  glow-strong: '0 0 24px rgba(0,240,255,0.5)'
  scanline: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.05) 2px, rgba(0,0,0,0.05) 4px)'
status: final
updated: '2026-06-02'
---

# JARVIS — Design Tokens & Visual Identity

## Brand & Style

Dark neon dashboard inspired by Tron, Ironman JARVIS HUD, and cyberpunk interfaces. Deep black backgrounds with cyan neon accents. Glow effects on interactive and active elements. Futuristic, alive, data-dense but not cluttered. The AI brain is the visual anchor — everything orbits it.

## Colors

**Background hierarchy:**
- `bg.deep` (`#0a0a0f`) — full page background, maximized viewport fill
- `bg.panel` (`#111122`) — widget frames, log panel, status bar, panels
- `bg.elevated` (`#1a1a2e`) — hover states, expanded widgets, focused inputs

**Neon accents:**
- `neon.cyan` (`#00f0ff`) — primary accent: active borders, brain core, status indicators, focus states
- `neon.cyan-dim` (`#88ccdd`) — secondary text, inactive borders, subtle highlights
- `neon.amber` (`#ff8c00`) — system warnings, heartbeat anomalies
- `neon.amber-warn` (`#ffaa00`) — error states
- `neon.red` (`#ff3344`) — critical errors, disconnect indicator, cancel

**Text:**
- `text.primary` (`#e0e0e0`) — body text, widget content, log output
- `text.secondary` (`#88ccdd`) — labels, muted info, timestamps
- `text.muted` (`#556677`) — placeholder text, disabled elements

**State colors** (applied to brain visualization and status indicators):
- `state.idle` (`#1a3a4a`) — passive listening, dim pulse
- `state.listening` (`#00f0ff`) — activated, bright cyan
- `state.thinking` (`#0088cc`) — processing, deeper blue
- `state.speaking` (`#00cc88`) — voice output, green-cyan
- `state.error` (`#ff3344`) — failure, red pulse

## Typography

Two families: monospace for data, sans-serif for UI.

**Monospace** (`typography.mono`) — JetBrains Mono (falls back to Fira Code, monospace):
- Log entries, tool output, code, timestamps, metrics, status text
- Sizes: xs (11px) for dense data, sm (12px) for standard logs, base (13px) for labels

**UI** (`typography.ui`) — Inter (falls back to system-ui, sans-serif):
- Widget titles, buttons, status bar, input text, auth form
- Sizes: xs (11px) for micro-labels, sm (13px) for secondary text, base (14px) for body, lg (16px) for emphasis

No serif fonts. No italic for UI (monospace italic allowed for log differentiation).

## Layout & Spacing

**Desktop viewport constraint:** All content must fit within a single viewport (no scroll). Assume minimum 1280×720px, target 1920×1080px.

**Three-zone grid:**
```
┌─────────────────────────────────────────────────────┐
│  [STATUS BAR: weather · heartbeat · time]   32px    │
├──────────┬──────────────────────────┬───────────────┤
│ WIDGET   │                          │   LOG PANEL   │
│ PANEL    │      AI BRAIN            │   (collapsible)
│ 280px    │      (fills remaining)   │   320px       │
│          │                          │               │
├──────────┴──────────────────────────┴───────────────┤
│  [VOICE STATUS BAR · mic level · state label] 40px  │
│  [TEXT INPUT                    ] 36px              │
└─────────────────────────────────────────────────────┘
```

- Status bar: 32px fixed height, full width
- Widget panel: 280px fixed width, scrolls internally if >6 widgets
- Log panel: 320px fixed width, collapsible to 0 (animated slide)
- Brain: fills remaining horizontal space, vertical center
- Voice bar + input: 76px total at bottom
- All gutters: 12px (`spacing.layout.gutter`)
- Page margin: 16px (`spacing.layout.margin`)

**Responsive breakpoints:**
- ≥1280px: full 3-zone layout
- 768–1279px: log panel auto-collapsed; brain fills center; widgets 240px
- <768px: single column; brain reduced; widgets + log stacked below; scrolling allowed

## Elevation & Depth

Flat design with glow-based depth — no traditional shadows.

- **Base (z-0):** `bg.deep` — page background, grid lines
- **Panel (z-1):** `bg.panel` + `shapes.border-panel` — widgets, panels, status bars
- **Elevated (z-2):** `bg.elevated` + `shapes.glow-soft` — hover states, expanded widgets, focused input
- **Active (z-3):** `shapes.glow-medium` — brain core during activity, active voice state
- **Peak (z-4):** `shapes.glow-strong` — transient overlays, critical alerts

Layered via CSS `z-index` and `box-shadow` glow — no 3D transforms.

## Shapes

- **Widgets:** `rounded.widget` (8px), `shapes.border-glow` when active, `shapes.border-panel` when idle
- **Panels:** `rounded.panel` (6px), `shapes.border-panel`
- **Brain core:** `rounded.brain-core` (50%) — circular, centered. Pulsing glow animation.
- **Inputs:** `rounded.input` (6px), `shapes.border-input` → `shapes.border-input-focus` on focus
- **Buttons:** `rounded.button` (6px), neon border, glow on hover
- **Scanline overlay:** Optional `shapes.scanline` — subtle horizontal line effect across the entire page (togglable)

## Components

### Brain Visualization

The centerpiece. Occupies the center zone, anchored vertically and horizontally. Rendered via Web Worker + OffscreenCanvas for performance isolation.

**States** (mapped from voice state machine):
- **Idle:** Slow (~0.5Hz) radial pulse. Core: `state.idle`. Subtle particle drift outward. Dim cyan ring.
- **Listening:** Fast (~2Hz) convergence pulse. Core: `state.listening`. Particles converge inward. Ring expands and brightens. "Listening..." label below.
- **Thinking:** Rotating geometric rings (~1 rotation/3s). Core: `state.thinking`. Data stream particles flowing horizontally. "Working..." label.
- **Speaking:** Waveform rings emanate outward in sync with audio amplitude. Core: `state.speaking`. Pulse matches speech cadence. No label — the voice is the output.
- **Error:** Rapid flicker pulse. Core: `state.error`. Ring fragments. "Error" label.

**Transition duration:** 400ms ease-in-out between states. Core color shifts immediately; particles and rings fade between.

### Widget Panel

Left zone. Scrollable internally. Each widget in a `WidgetFrame`.

**Layout:** Vertical stack, 8px gap. Widgets default to compact (full 280px width × auto height, max 180px). One widget expanded at a time (click to expand, fills panel to 350px height, others below).

**Weather widget:** Compact shows icon + temp + condition. Expanded shows 5-day forecast, humidity, wind.

**System status widget:** Compact shows connection dot + uptime. Expanded shows heartbeat graph (last 60 min, line chart), agent status, memory/CPU if available.

**Empty state:** "No widgets" in `text.muted` when panel is empty (only possible in Phase 2 when widgets are removable).

### Log Panel

Right zone. Collapsible via toggle button in top-right corner (animated slide to 0px width, 300ms ease). When collapsed, a thin tab remains to re-expand.

**Content:** Real-time streaming log entries. Each entry: timestamp (`typography.mono.xs`, `text.secondary`) + type icon + content (`typography.mono.sm`, `text.primary`). Color-coded by source:
- Tool calls: `neon.cyan-dim` icon, dim border-left
- Tool output: `text.primary`
- Agent commentary: `neon.cyan` icon
- Errors: `neon.red` icon + text
- System: `text.muted`

Auto-scrolls to bottom. Pauses on hover (manual scroll mode). "Paused" indicator at top while scrolled up.

### Voice Status Bar

Bottom of viewport, full width, 40px height. Always visible.

**Left:** Microphone state icon + label:
- "● Listening..." (`state.listening`, pulsing dot)
- "◉ Active" (`state.listening`, solid)
- "◎ Idle" (`state.idle`, static)
- "✕ Muted" (`text.muted`)

**Center:** Last recognized transcript or current status text (`typography.ui.sm`).

**Right:** Mic level meter (3-segment bar: 33% `neon.cyan-dim`, 66% `neon.cyan`, 100% `neon.amber`).

### Text Input

Below voice status bar, 36px height. Single-line input with neon border. Placeholder: "Type a command or say JARVIS..." in `text.muted`. On focus: border → `shapes.border-input-focus`, subtle glow. Submit on Enter. Clears after submit.

### Auth Gate

Full-viewport overlay. Centered card (400×280px) on `bg.deep` with `shapes.glow-soft`. "JARVIS" title in `typography.ui.title`, `neon.cyan`. Password input + "Enter" button. Error shake animation on wrong password. Fade-out transition (500ms) on success into dashboard.

### Tron Grid Background

Subtle perspective grid lines on `bg.deep` — `rgba(0,240,255,0.03)`. Fixed position, behind all content. Does not animate. Gives depth without distraction.

## Do's and Don'ts

**Do:**
- Use neon glow sparingly — only on active/focused elements
- Keep text contrast at least 3:1 for body text (personal dashboard, not public)
- Animate state transitions, not static elements
- Let the brain visualization be the loudest visual element
- Collapse panels when not needed (log panel especially)

**Don't:**
- Add borders without glow — flat borders look dead in this theme
- Use pure white text — `#e0e0e0` is the ceiling
- Animate the grid background — it's atmosphere, not content
- Overflow the viewport on desktop — scroll is failure
- Mix warm and cool glows on the same element
