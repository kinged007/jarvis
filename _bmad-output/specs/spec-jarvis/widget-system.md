# Widget System

## Overview

Dashboard widgets display visual data alongside voice responses. **Phase 1** includes only built-in permanent widgets (weather, system status). **Phase 2** introduces the full script-driven widget system with a defined DSL.

## Phase 1: Built-in Widgets

Two permanent widgets ship with the app:

1. **Weather** — Frontend-only widget. Fetches current conditions and temperature directly from a weather API (e.g., OpenWeatherMap). No agent involvement. Configurable location. Updates on an interval.
2. **System Status** — Agent connection state, uptime, heartbeat graph (last 60 minutes). Driven by WebSocket events from the BFF.

## Phase 2: Script-Driven Widget System

Widgets are driven by scripts whose output conforms to a defined DSL. Scripts produce structured JSON output; the frontend renders them with the predefined JARVIS theme.

### Widget DSL (Design)

Scripts output JSON to stdout matching this schema:

```json
{
  "widget": {
    "type": "chart-line | chart-bar | chart-pie | metric | status | text | table | image",
    "title": "Widget Title",
    "data": { ... },
    "theme": "jarvis",
    "permanent": false
  }
}
```

**Type-specific `data` shapes:**

| Widget Type | Data Shape |
|-------------|-----------|
| `chart-line` | `{ "labels": [...], "datasets": [{ "label": "...", "data": [...] }] }` |
| `chart-bar` | Same as chart-line |
| `chart-pie` | `{ "labels": [...], "values": [...] }` |
| `metric` | `{ "value": "23%", "label": "CPU Usage", "trend": "up|down|stable" }` |
| `status` | `{ "status": "ok|warning|error", "message": "...", "history": [...] }` |
| `text` | `{ "content": "markdown string" }` |
| `table` | `{ "headers": [...], "rows": [[...], ...] }` |
| `image` | `{ "url": "...", "alt": "..." }` |

### Widget Rendering

- All widgets render with the JARVIS dark neon theme applied
- `chart-*` types use a lightweight charting library (Chart.js or Recharts)
- `metric`, `status`, `text`, `table` use styled React components
- `image` renders an `<img>` tag with glow border styling

## Display Rules (Phase 1 & 2)

- **Max visible:** 6 widgets (configurable)
- **Default size:** Compact (~200×150px) — shows title + key data
- **Expanded:** Full panel width (~400×350px or larger) — shows full detail
- **Expand trigger:** Click on widget
- **Overflow:** If >max widgets, oldest temporary widget is displaced (with fade animation)
- **Ordering:** User can drag to reorder (persisted in localStorage)
- **Permanent widgets:** Survive page reload; stored in localStorage
- **Temporary widgets:** Removed on page reload or manual dismiss
