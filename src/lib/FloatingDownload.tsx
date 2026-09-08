import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { isActive, JobCard } from "../panes/JobCard";
import { useQueue } from "./Queue";
import { Icon } from "./ui";

/*
 * The running download, following you around the app.
 *
 * Starting a download and then navigating away used to put it out of sight, so
 * pausing it meant finding your way back to the tab it lived on. This is the
 * same card, floating - the way a video keeps playing in a corner when you
 * scroll past it - and it is draggable because wherever it defaults to will be
 * over something someone wants to read.
 *
 * It is not rendered on the Download tab, where the rail already shows it.
 *
 * It sits bottom left by default because that corner is otherwise dead space -
 * every pane's content hangs from the top - and because arriving there reads as
 * docked rather than as something that slid in over what you were reading. It
 * is still draggable; the position is remembered once it has been moved.
 */
const POSITION_KEY = "kickcut.floating";
const MARGIN = 12;

type Point = { x: number; y: number };

export function FloatingDownload({ hidden }: { hidden: boolean }) {
  const t = useT();
  const { jobs, pause, resume } = useQueue();
  const [collapsed, setCollapsed] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const grab = useRef<Point | null>(null);

  const [at, setAt] = useState<Point | null>(() => {
    try {
      const saved = localStorage.getItem(POSITION_KEY);
      return saved ? (JSON.parse(saved) as Point) : null;
    } catch {
      return null;
    }
  });

  // Dragging is tracked on the window: a pointer moving faster than React
  // re-renders would otherwise slip off the panel and strand the drag.
  const onMove = useCallback((e: PointerEvent) => {
    if (!grab.current || !panel.current) return;
    const box = panel.current.getBoundingClientRect();
    const next = {
      x: Math.min(
        Math.max(MARGIN, e.clientX - grab.current.x),
        window.innerWidth - box.width - MARGIN,
      ),
      y: Math.min(
        Math.max(MARGIN, e.clientY - grab.current.y),
        window.innerHeight - box.height - MARGIN,
      ),
    };
    setAt(next);
  }, []);

  useEffect(() => {
    const stop = () => {
      if (!grab.current) return;
      grab.current = null;
      setAt((current) => {
        if (current) localStorage.setItem(POSITION_KEY, JSON.stringify(current));
        return current;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [onMove]);

  // A window that shrank can leave a saved position off-screen.
  useEffect(() => {
    const clamp = () => {
      const box = panel.current?.getBoundingClientRect();
      if (!box) return;
      setAt((current) =>
        current
          ? {
              x: Math.min(current.x, Math.max(MARGIN, window.innerWidth - box.width - MARGIN)),
              y: Math.min(current.y, Math.max(MARGIN, window.innerHeight - box.height - MARGIN)),
            }
          : current,
      );
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  const job = jobs.find(isActive);
  if (hidden || !job) return null;

  return (
    <div
      ref={panel}
      className="fixed z-40 w-[22rem] max-w-[calc(100vw-1.5rem)]"
      style={at ? { left: at.x, top: at.y } : { left: "1rem", bottom: "2.25rem" }}
    >
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-2xl shadow-black/50">
        <div
          onPointerDown={(e) => {
            const box = panel.current?.getBoundingClientRect();
            if (!box) return;
            grab.current = { x: e.clientX - box.left, y: e.clientY - box.top };
            // Once dragged, the panel is positioned rather than anchored.
            setAt({ x: box.left, y: box.top });
          }}
          className="flex cursor-grab touch-none select-none items-center justify-between gap-2 border-b border-line bg-raised px-3 py-1.5 active:cursor-grabbing"
        >
          <span className="flex items-center gap-2 text-small font-medium text-muted">
            <span className="dot-running size-1.5 rounded-full bg-kick" />
            {t("queue.floating")}
          </span>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={t("queue.floating")}
            className="grid size-5 place-items-center rounded text-muted transition-colors hover:bg-surface hover:text-body"
          >
            <Icon name="chevron" className={"size-3.5 " + (collapsed ? "-rotate-90" : "rotate-90")} />
          </button>
        </div>

        {!collapsed ? (
          <div className="p-2">
            <JobCard job={job} onPause={pause} onResume={resume} compact />
          </div>
        ) : null}
      </div>
    </div>
  );
}
