import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { fullTimecode, parseTimecode, timecode } from "../lib/format";
import { Input } from "../lib/ui";

/*
 * Picking a range out of an eight-hour broadcast.
 *
 * Two controls for one value, on purpose. The timecode boxes are how someone
 * says "02:00:00 to 05:30:00" - the exact thing the tool was asked for - and
 * they stay authoritative. The track is how they see where that lands, which
 * matters most for the discontinuity marks: whether a break falls inside the
 * cut decides which mux mode to use, and no pair of numbers shows that.
 */

const MIN_SPAN = 1;

export type Range = { start: number; end: number };

export function RangePicker({
  total,
  discontinuities,
  value,
  onChange,
}: {
  total: number;
  discontinuities: number[];
  value: Range;
  onChange: (next: Range) => void;
}) {
  const t = useT();

  return (
    <div className="flex flex-col gap-4">
      <Track
        total={total}
        discontinuities={discontinuities}
        value={value}
        onChange={onChange}
        startLabel={t("setup.range.startHandle")}
        endLabel={t("setup.range.endHandle")}
      />

      <div className="flex flex-wrap items-start gap-4">
        <TimeBox
          label={t("setup.range.start")}
          invalid={t("setup.range.invalid")}
          seconds={value.start}
          max={total}
          onCommit={(s) => onChange({ start: Math.min(s, value.end - MIN_SPAN), end: value.end })}
        />
        <TimeBox
          label={t("setup.range.end")}
          invalid={t("setup.range.invalid")}
          seconds={value.end}
          max={total}
          onCommit={(s) => onChange({ start: value.start, end: Math.max(s, value.start + MIN_SPAN) })}
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-muted">{t("setup.plan.output")}</span>
          <span className="flex h-9 items-center font-mono text-mid text-body">
            {timecode(value.end - value.start)}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- track -- */

type Handle = "start" | "end";

function Track({
  total,
  discontinuities,
  value,
  onChange,
  startLabel,
  endLabel,
}: {
  total: number;
  discontinuities: number[];
  value: Range;
  onChange: (next: Range) => void;
  startLabel: string;
  endLabel: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<Handle | null>(null);

  const pct = (seconds: number) => (total > 0 ? (seconds / total) * 100 : 0);

  const secondsAt = useCallback(
    (clientX: number) => {
      const box = trackRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return 0;
      const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
      return ratio * total;
    },
    [total],
  );

  const move = useCallback(
    (handle: Handle, seconds: number) => {
      // Handles cannot cross; the one being dragged is stopped a second short
      // of the other rather than swapping roles under the pointer.
      if (handle === "start") onChange({ start: Math.min(seconds, value.end - MIN_SPAN), end: value.end });
      else onChange({ start: value.start, end: Math.max(seconds, value.start + MIN_SPAN) });
    },
    [onChange, value.start, value.end],
  );

  /*
   * Dragging is tracked on the window, not on the handle: a pointer moving
   * faster than React re-renders leaves the element behind, and releasing
   * outside the window would otherwise strand the drag in progress.
   */
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => move(dragging, secondsAt(e.clientX));
    const onUp = () => setDragging(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, move, secondsAt]);

  function onTrackDown(e: React.PointerEvent) {
    const seconds = secondsAt(e.clientX);
    // Clicking the track moves whichever end is nearer, which is what a click
    // between the handles is almost always meant to do.
    const handle: Handle =
      Math.abs(seconds - value.start) <= Math.abs(seconds - value.end) ? "start" : "end";
    move(handle, seconds);
    setDragging(handle);
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={trackRef}
        onPointerDown={onTrackDown}
        className="relative h-9 cursor-pointer touch-none select-none py-3.5"
      >
        <div className="h-2 w-full rounded-full bg-line" />

        <div
          className="absolute top-3.5 h-2 rounded-full bg-kick/70"
          style={{ left: `${pct(value.start)}%`, width: `${pct(value.end - value.start)}%` }}
        />

        {/*
          Breaks in the broadcast. Amber because the cost of one is time - it is
          the difference between a fast copy and a re-encode - and it is drawn
          over the selection so a mark inside the range stays visible.
        */}
        {discontinuities.map((seconds) => (
          <div
            key={seconds}
            className="absolute top-2 h-5 w-0.5 -translate-x-1/2 rounded bg-amber"
            style={{ left: `${pct(seconds)}%` }}
            title={timecode(seconds)}
          />
        ))}

        <Grip position={pct(value.start)} label={startLabel} seconds={value.start} total={total}
              onGrab={() => setDragging("start")} onNudge={(d) => move("start", value.start + d)} />
        <Grip position={pct(value.end)} label={endLabel} seconds={value.end} total={total}
              onGrab={() => setDragging("end")} onNudge={(d) => move("end", value.end + d)} />
      </div>

      <div className="flex justify-between font-mono text-mini text-muted">
        <span>0:00</span>
        <span>{timecode(total)}</span>
      </div>
    </div>
  );
}

function Grip({
  position,
  label,
  seconds,
  total,
  onGrab,
  onNudge,
}: {
  position: number;
  label: string;
  seconds: number;
  total: number;
  onGrab: () => void;
  onNudge: (delta: number) => void;
}) {
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.round(seconds)}
      aria-valuetext={fullTimecode(seconds)}
      onPointerDown={(e) => {
        e.stopPropagation();
        onGrab();
      }}
      onKeyDown={(e) => {
        // Coarse and fine nudges, because a whole broadcast is too long to walk
        // a second at a time and a cut point is too precise to move a minute.
        const step = e.shiftKey ? 60 : 1;
        if (e.key === "ArrowLeft") onNudge(-step);
        else if (e.key === "ArrowRight") onNudge(step);
        else return;
        e.preventDefault();
      }}
      className="absolute top-1.5 size-6 -translate-x-1/2 cursor-grab rounded-full border-2 border-kick bg-ink transition-colors hover:bg-raised active:cursor-grabbing"
      style={{ left: `${position}%` }}
    />
  );
}

/* -------------------------------------------------------------- timebox -- */

/*
 * Held as text while it is being typed. Parsing on every keystroke would fight
 * the user - "02:" is not a time yet - so the value is only pushed out on blur
 * or Enter, and rejected input stays on screen with the field marked instead of
 * silently snapping back.
 */
function TimeBox({
  label,
  invalid,
  seconds,
  max,
  onCommit,
}: {
  label: string;
  invalid: string;
  seconds: number;
  max: number;
  onCommit: (seconds: number) => void;
}) {
  const [text, setText] = useState(() => fullTimecode(seconds));
  const [editing, setEditing] = useState(false);

  // While the track is being dragged this field is an output, so it follows.
  useEffect(() => {
    if (!editing) setText(fullTimecode(seconds));
  }, [seconds, editing]);

  const parsed = parseTimecode(text);
  const bad = parsed === null || parsed > max;

  function commit() {
    setEditing(false);
    if (parsed !== null) onCommit(Math.min(parsed, max));
    else setText(fullTimecode(seconds));
  }

  return (
    <label className="flex w-36 flex-col gap-1.5">
      <span className="text-small font-medium text-muted">{label}</span>
      <Input
        value={text}
        inputMode="numeric"
        spellCheck={false}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className={"font-mono " + (bad ? "border-rose/60" : "")}
      />
      <span className={"text-small " + (bad ? "text-rose" : "text-muted/80")}>
        {bad ? invalid : " "}
      </span>
    </label>
  );
}
