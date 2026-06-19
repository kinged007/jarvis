# UX Vision

## Design Language

**Theme:** Dark, futuristic, neon — inspired by Tron, Ironman JARVIS HUD, and cyberpunk interfaces.

**Palette:**
- Background: Deep black (#0a0a0f) to near-black (#111122)
- Primary accent: Cyan/teal neon (#00f0ff, #00d4ff)
- Secondary accent: Warm amber/orange (#ff8c00, #ffaa00) for alerts/warnings
- Text: White (#e0e0e0) primary, dimmed cyan (#88ccdd) secondary
- Glow: Neon blue glow effects on interactive elements and the brain core

**Typography:** Monospace for data/logs (JetBrains Mono, Fira Code), clean sans-serif for labels (Inter, system-ui).

## Layout

Single-page dashboard with three zones:

```
┌──────────────────────────────────────────────┐
│  [STATUS BAR: time, weather, heartbeat •••]  │
├──────────┬───────────────────────┬───────────┤
│          │                       │           │
│  WIDGET  │     AI BRAIN          │  TEXT     │
│  PANEL   │     (center)          │  LOG      │
│  (left)  │                       │  (right)  │
│          │     Animated          │           │
│  -Weather│     neural core       │  Tool     │
│  -Status │     pulses with       │  calls    │
│  -Agent  │     state changes     │  Outputs  │
│   widgets│                       │           │
│          │  [TEXT INPUT BAR]     │           │
│          │  "Type a command..."  │           │
├──────────┴───────────────────────┴───────────┤
│  [VOICE STATUS: ● Listening / ◉ Active / ○ Idle] │
└──────────────────────────────────────────────┘
```

## AI Brain Visualization (Center)

A dynamic visualization that communicates state:
- **Idle:** Slow pulsing ring with subtle particle drift
- **Listening (wake word detected):** Ring expands, particles converge toward center, cyan glow intensifies
- **Processing:** Rotating geometric patterns, data streams flowing, occasional bright flashes
- **Speaking:** Waveform rings emanate outward in sync with audio
- **Executing tools:** Neural network nodes light up and connect; rapid data pulse effects

Implementation: Canvas 2D or WebGL with requestAnimationFrame loop. The brain state is driven by WebSocket events from the agent.

## Widget Panel (Left)

- Collapsible/expandable
- Widgets stack vertically, compact by default (~200px wide)
- Each widget: title bar, content area, resize handle
- Click to expand to full panel width
- Drag to reorder
- Dismiss button for temporary widgets
- Max 6 visible; overflow scrolls

## Text Log Panel (Right)

- Collapsible
- Real-time streaming log
- Each entry: timestamp, type icon (tool/response/error), content
- Color-coded: tool calls in dimmed cyan, outputs in white, errors in amber
- Auto-scroll with pause-on-hover

## Voice Status Bar (Bottom)

- Always visible
- Shows current voice state with icon + label
- Microphone level indicator (simple bar)
- Activation word hint: "Say 'JARVIS'..."

## Text Input Bar (Bottom Center)

- Compact single-line input
- Placeholder: "Type a command or say JARVIS..."
- Submit on Enter
- Auto-focuses when clicked; blurs after submit

## Animations & Micro-interactions

- Glow pulses on state transitions
- Particle trails following cursor near the brain
- Smooth widget expand/collapse
- Fade transitions on log entries
- Neon border glow on active elements
- Subtle grid line background (Tron-style)
- Scan line effect overlay (optional, toggleable)
