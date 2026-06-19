/**
 * Widget store — Step 4 client skeleton (Phase 2 surface).
 *
 * The widget panel is a flat list of typed entries with one expanded
 * at a time (CAP-15, CAP-16). The store is intentionally minimal: it
 * tracks the set of mounted widgets and the expanded id. Rendering,
 * dragging, and the widget DSL are all Phase 2 work that will live
 * in components/.
 *
 * `MAX_WIDGETS` (lib/constants.ts) bounds the list. `addWidget` is a
 * no-op once the cap is hit.
 */

import { create } from "zustand";
import { MAX_WIDGETS } from "../lib/constants";

export type WidgetKind = "weather" | "system-status" | "browser" | "custom";

export interface WidgetInstance {
  id: string;
  kind: WidgetKind;
  title: string;
  /** Optional opaque payload for the widget renderer (e.g. weather coords). */
  config?: Record<string, unknown>;
  createdAt: number;
}

export interface WidgetState {
  widgets: WidgetInstance[];
  expandedWidgetId: string | null;
}

export interface WidgetActions {
  addWidget: (widget: Omit<WidgetInstance, "id" | "createdAt">) => string | null;
  removeWidget: (id: string) => void;
  updateWidget: (id: string, patch: Partial<Omit<WidgetInstance, "id">>) => void;
  setExpanded: (id: string | null) => void;
  clearWidgets: () => void;
}

export type WidgetStore = WidgetState & WidgetActions;

let widgetCounter = 0;
function nextWidgetId(): string {
  widgetCounter += 1;
  return `widget-${Date.now()}-${widgetCounter}`;
}

const initialState: WidgetState = {
  widgets: [],
  expandedWidgetId: null,
};

export const useWidgetStore = create<WidgetStore>((set) => ({
  ...initialState,

  addWidget(widget) {
    let created: string | null = null;
    set((state) => {
      if (state.widgets.length >= MAX_WIDGETS) return state;
      const instance: WidgetInstance = {
        id: nextWidgetId(),
        kind: widget.kind,
        title: widget.title,
        config: widget.config,
        createdAt: Date.now(),
      };
      created = instance.id;
      return { widgets: [...state.widgets, instance] };
    });
    return created;
  },

  removeWidget(id) {
    set((state) => ({
      widgets: state.widgets.filter((w) => w.id !== id),
      expandedWidgetId: state.expandedWidgetId === id ? null : state.expandedWidgetId,
    }));
  },

  updateWidget(id, patch) {
    set((state) => ({
      widgets: state.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    }));
  },

  setExpanded(id) {
    set({ expandedWidgetId: id });
  },

  clearWidgets() {
    set({ widgets: [], expandedWidgetId: null });
  },
}));
