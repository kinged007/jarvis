import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAgentStore } from "@/state/agentStore";
import { X, Minimize2, Maximize2, GripHorizontal } from "lucide-react";

type ModalPhase = "hidden" | "open" | "minimized";

/** Plugin interface — hook for future content transform plugins. */
interface RenderPlugin {
  name: string;
  detect: (code: string, language?: string) => boolean;
  component: React.ComponentType<{ code: string; language?: string }>;
}

/* ------------------------------------------------------------------ */
/*  Mermaid diagram (interactive: zoom + pan)                         */
/* ------------------------------------------------------------------ */

function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose" });
        const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) setSvg(rendered);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom((z) => Math.max(0.2, Math.min(5, z + delta)));
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    isPanning.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  const handlePointerUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  if (error) {
    return (
      <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400 font-mono">
        Mermaid error: {error}
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="flex items-center justify-center h-24 text-muted-foreground text-xs font-mono">
        rendering diagram...
      </div>
    );
  }

  return (
    <div className="relative group/diagram rounded-lg border border-border bg-black/40 overflow-hidden my-3">
      {/* zoom controls */}
      <div className="absolute top-2 right-2 z-10 flex gap-1 opacity-0 group-hover/diagram:opacity-100 transition-opacity">
        <button
          className="size-6 flex items-center justify-center rounded bg-background/80 text-foreground/70 hover:text-foreground text-xs font-mono border border-border"
          onClick={() => setZoom((z) => Math.min(5, z + 0.2))}
          title="Zoom in"
        >
          +
        </button>
        <button
          className="size-6 flex items-center justify-center rounded bg-background/80 text-foreground/70 hover:text-foreground text-xs font-mono border border-border"
          onClick={() => setZoom((z) => Math.max(0.2, z - 0.2))}
          title="Zoom out"
        >
          -
        </button>
        <button
          className="size-6 flex items-center justify-center rounded bg-background/80 text-foreground/70 hover:text-foreground text-xs font-mono border border-border"
          onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
          title="Reset"
        >
          r
        </button>
      </div>
      <div
        ref={containerRef}
        className="overflow-hidden cursor-grab active:cursor-grabbing"
        style={{ minHeight: 120 }}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <div
          className="w-full flex items-center justify-center p-4"
          dangerouslySetInnerHTML={{ __html: svg }}
          style={{
            transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
            transformOrigin: "center center",
            transition: isPanning.current ? "none" : "transform 0.15s ease-out",
          }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Markdown renderer                                                  */
/* ------------------------------------------------------------------ */

interface MarkdownRendererProps {
  text: string;
  /** Extension point: additional render plugins. */
  plugins?: RenderPlugin[];
}

function MarkdownRenderer({ text, plugins = [] }: MarkdownRendererProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const components: Components = useMemo(() => ({
    code: (({ node, className, children, ...props }: any) => {
      const match = /language-(\w+)/.exec(className ?? "");
      const language = match?.[1];
      const code = String(children).replace(/\n$/, "");

      for (const plugin of plugins) {
        if (plugin.detect(code, language)) {
          const PluginComp = plugin.component;
          return <PluginComp code={code} language={language} />;
        }
      }

      if (language === "mermaid") {
        return <MermaidDiagram code={code} />;
      }

      return (
        <pre className="rounded-lg border border-border bg-black/30 p-3 overflow-x-auto my-2 text-xs font-mono text-foreground/80">
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      );
    }) as Components["code"],
    table: ((props: any) => (
      <div className="overflow-x-auto my-3 rounded-lg border border-border">
        <table className="w-full text-xs border-collapse" {...props} />
      </div>
    )) as Components["table"],
    thead: ((props: any) => (
      <thead className="border-b border-border bg-muted/30" {...props} />
    )) as Components["thead"],
    th: ((props: any) => (
      <th className="px-3 py-2 text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground border-r border-border last:border-r-0" {...props} />
    )) as Components["th"],
    td: ((props: any) => (
      <td className="px-3 py-1.5 border-r border-border last:border-r-0 border-t border-border/50 text-foreground/90" {...props} />
    )) as Components["td"],
    img: ((props: any) => (
      <img {...props} className="max-w-full rounded-lg my-3 border border-border" loading="lazy" />
    )) as Components["img"],
    a: ((props: any) => (
      <a {...props} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2 decoration-blue-400/40 hover:decoration-blue-300" />
    )) as Components["a"],
    blockquote: ((props: any) => (
      <blockquote className="border-l-2 border-amber-500/40 pl-4 my-2 text-foreground/70 italic text-sm" {...props} />
    )) as Components["blockquote"],
    hr: ((props: any) => (
      <hr className="my-4 border-border" {...props} />
    )) as Components["hr"],
  }), [plugins]);

  return (
    <div className="prose prose-sm prose-invert max-w-none
      prose-headings:text-foreground prose-headings:font-mono prose-headings:tracking-wide
      prose-h1:text-lg prose-h2:text-base prose-h3:text-sm
      prose-p:text-sm prose-p:text-foreground/85 prose-p:leading-relaxed
      prose-li:text-sm prose-li:text-foreground/85
      prose-code:text-xs prose-code:font-mono prose-code:text-amber-400 prose-code:bg-amber-400/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
      prose-strong:text-foreground
      [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5
      space-y-2
    ">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Resize handle                                                      */
/* ------------------------------------------------------------------ */

function ResizeHandle({ onResize }: { onResize: (dx: number, dy: number) => void }) {
  const isResizing = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    isResizing.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isResizing.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    onResize(dx, dy);
  }, [onResize]);

  const onPointerUp = useCallback(() => {
    isResizing.current = false;
  }, []);

  return (
    <div
      className="absolute bottom-0 right-0 size-4 cursor-se-resize flex items-end justify-end z-20"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <GripHorizontal className="size-3 text-muted-foreground/40 rotate-45 translate-x-0.5 translate-y-0.5" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Modal window                                                       */
/* ------------------------------------------------------------------ */

interface ModalWindowProps {
  text: string;
  preview: string;
  phase: ModalPhase;
  onMinimize: () => void;
  onClose: () => void;
}

const MIN_WIDTH = 420;
const MIN_HEIGHT = 280;
const MAX_WIDTH_PCT = 0.92;
const MAX_HEIGHT_PCT = 0.88;

function ModalWindow({ text, preview: _preview, phase: _phase, onMinimize, onClose }: ModalWindowProps) {
  // Position: start centered, then user-dragged
  const [pos, setPos] = useState(() => ({
    x: Math.max(40, (window.innerWidth - 720) / 2),
    y: Math.max(40, (window.innerHeight - 500) / 2),
  }));
  const [size, setSize] = useState({ w: 720, h: 500 });

  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 });

  // Constrain position/size on mount
  useEffect(() => {
    const clamp = () => {
      const maxW = window.innerWidth * MAX_WIDTH_PCT;
      const maxH = window.innerHeight * MAX_HEIGHT_PCT;
      setSize((s) => ({
        w: Math.min(maxW, Math.max(MIN_WIDTH, s.w)),
        h: Math.min(maxH, Math.max(MIN_HEIGHT, s.h)),
      }));
      setPos((p) => ({
        x: Math.max(0, Math.min(window.innerWidth - 80, p.x)),
        y: Math.max(0, Math.min(window.innerHeight - 80, p.y)),
      }));
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  const handleResize = useCallback((dx: number, dy: number) => {
    setSize((s) => {
      const maxW = window.innerWidth * MAX_WIDTH_PCT;
      const maxH = window.innerHeight * MAX_HEIGHT_PCT;
      return {
        w: Math.min(maxW, Math.max(MIN_WIDTH, s.w + dx)),
        h: Math.min(maxH, Math.max(MIN_HEIGHT, s.h + dy)),
      };
    });
  }, []);

  // Title bar drag
  const onTitlePointerDown = useCallback((e: React.PointerEvent) => {
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, posX: pos.x, posY: pos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [pos]);

  const onTitlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPos({
      x: Math.max(-100, Math.min(window.innerWidth - 120, dragStart.current.posX + dx)),
      y: Math.max(-20, Math.min(window.innerHeight - 60, dragStart.current.posY + dy)),
    });
  }, []);

  const onTitlePointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  return (
    <>
      {/* Backdrop — click to minimize */}
      <motion.div
        className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={onMinimize}
      />

      {/* Window */}
      <motion.div
        className="fixed z-[101] flex flex-col rounded-[var(--rounded-widget)] border border-border bg-background shadow-2xl overflow-hidden"
        style={{
          left: pos.x,
          top: pos.y,
          width: size.w,
          height: size.h,
          boxShadow: "0 0 48px rgba(99, 102, 241, 0.12), inset 0 0 24px rgba(99, 102, 241, 0.03)",
          borderColor: "rgba(99, 102, 241, 0.25)",
        }}
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title bar */}
        <div
          className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/20 cursor-grab active:cursor-grabbing select-none shrink-0"
          onPointerDown={onTitlePointerDown}
          onPointerMove={onTitlePointerMove}
          onPointerUp={onTitlePointerUp}
          onPointerLeave={onTitlePointerUp}
        >
          <div className="flex items-center gap-2">
            <div className="size-2.5 rounded-full bg-indigo-400/60" />
            <span className="text-[11px] font-mono uppercase tracking-[0.15em] text-muted-foreground">
              Response
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              className="size-7 flex items-center justify-center rounded-md hover:bg-muted/40 text-muted-foreground hover:text-foreground transition-colors"
              onClick={(e) => { e.stopPropagation(); onMinimize(); }}
              title="Minimize"
            >
              <Minimize2 className="size-3.5" />
            </button>
            <button
              className="size-7 flex items-center justify-center rounded-md hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors"
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              title="Close"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <MarkdownRenderer text={text} />
        </div>

        {/* Resize handle */}
        <ResizeHandle onResize={handleResize} />
      </motion.div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Minimized floater                                                  */
/* ------------------------------------------------------------------ */

function MinimizedButton({ preview, onRestore }: { preview: string; onRestore: () => void }) {
  return (
    <motion.button
      className="fixed bottom-6 right-6 z-[110] flex items-center gap-2 px-4 py-2.5
        rounded-[var(--rounded-widget)] border border-indigo-500/30 bg-background
        shadow-lg hover:border-indigo-400/50 hover:shadow-indigo-500/10
        transition-colors cursor-pointer max-w-[320px] group"
      style={{
        boxShadow: "0 0 24px rgba(99, 102, 241, 0.15)",
      }}
      initial={{ opacity: 0, y: 16, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 16, scale: 0.9 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      onClick={(e) => { e.stopPropagation(); onRestore(); }}
    >
      <div className="size-2 rounded-full bg-indigo-400 animate-pulse shrink-0" />
      <span className="text-xs font-mono text-muted-foreground truncate group-hover:text-foreground transition-colors">
        {preview || "Response"}
      </span>
      <Maximize2 className="size-3 text-muted-foreground/40 group-hover:text-foreground/60 transition-colors shrink-0 ml-auto" />
    </motion.button>
  );
}

/* ------------------------------------------------------------------ */
/*  Public component                                                   */
/* ------------------------------------------------------------------ */

export function LongResponseModal() {
  const longResponse = useAgentStore((s) => s.longResponse);
  const clearLongResponse = useAgentStore((s) => s.clearLongResponse);
  const [phase, setPhase] = useState<ModalPhase>("hidden");

  // When a new long response arrives, open the modal.
  useEffect(() => {
    if (longResponse) {
      setPhase("open");
    }
  }, [longResponse]);

  // Also clear the store when the modal is fully closed.
  const handleClose = useCallback(() => {
    setPhase("hidden");
    clearLongResponse();
  }, [clearLongResponse]);

  const handleMinimize = useCallback(() => {
    setPhase("minimized");
  }, []);

  const handleRestore = useCallback(() => {
    setPhase("open");
  }, []);

  // Derive preview from first line break.
  const preview = useMemo(() => {
    if (!longResponse) return "";
    return longResponse.text.split("\n")[0]?.trim().slice(0, 80) ?? "";
  }, [longResponse]);

  const isVisible = phase !== "hidden" && longResponse !== null;

  return createPortal(
    <AnimatePresence>
      {isVisible && phase === "open" && (
        <ModalWindow
          key="modal-window"
          text={longResponse.text}
          preview={preview}
          phase={phase}
          onMinimize={handleMinimize}
          onClose={handleClose}
        />
      )}

      {isVisible && phase === "minimized" && (
        <MinimizedButton
          key="minimized-btn"
          preview={preview}
          onRestore={handleRestore}
        />
      )}
    </AnimatePresence>,
    document.body,
  );
}
