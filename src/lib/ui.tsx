import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/*
 * The whole component kit, hand-rolled. No component library, no icon package:
 * this app has about twenty distinct controls, and a dependency that ships a
 * thousand would cost more to keep aligned with the palette than it saves.
 *
 * The dominant pattern is a `Record<Variant, string>` of Tailwind classes -
 * every variant of a control stays legible in one place instead of spreading
 * into ternaries at the call sites.
 */

/* ---------------------------------------------------------------- icons -- */

/*
 * 16x16 viewBox, 1.5 stroke, currentColor. Paths only, so an icon inherits the
 * colour and the size of whatever it sits in.
 */
const ICONS = {
  library: "M2.5 3.5h3v9h-3zM7 3.5h3v9H7zM11.5 4.2l2.2 8.1",
  download: "M8 2.5v7.5M8 10l-3-3M8 10l3-3M2.5 13.5h11",
  queue: "M2.5 4h11M2.5 8h11M2.5 12h6",
  settings:
    "M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6",
  refresh: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3",
  search: "M7.2 12a4.8 4.8 0 1 0 0-9.6 4.8 4.8 0 0 0 0 9.6M10.8 10.8l2.7 2.7",
  play: "M5 3.2 12 8l-7 4.8z",
  pause: "M5.5 3.5v9M10.5 3.5v9",
  close: "M4 4l8 8M12 4l-8 8",
  check: "M3 8.4 6.4 12 13 4.6",
  warn: "M8 2.6 14.6 13.4H1.4zM8 6.6v3M8 11.4v.6",
  folder: "M1.8 4.2h4l1.2 1.6h7.2v6.6H1.8z",
  clock: "M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4M8 5.2V8l2 1.4",
  scissors:
    "M4 3l8 8.4M12 3 4 11.4M3.6 12.6a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8M12.4 12.6a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8",
  chevron: "M6 3.5 10.5 8 6 12.5",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a.9.9 0 0 0 .9.8h4a.9.9 0 0 0 .9-.8l.6-8.2M6.8 7v4M9.2 7v4",
  sun: "M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6M8 1.6v1.4M8 13v1.4M14.4 8H13M3 8H1.6M12.5 3.5l-1 1M4.5 11.5l-1 1M12.5 12.5l-1-1M4.5 4.5l-1-1",
  moon: "M13 9.4A5.4 5.4 0 0 1 6.6 3a5.6 5.6 0 1 0 6.4 6.4",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/* -------------------------------------------------------------- surface -- */

type CardKind = "primary" | "normal" | "plain";

const cardClass: Record<CardKind, string> = {
  primary: "rounded-lg border border-line/80 bg-raised/70 shadow-xl shadow-black/30",
  normal: "rounded-lg border border-line bg-surface/80 shadow-lg shadow-black/20",
  plain: "",
};

export function Card({
  kind = "normal",
  className = "",
  children,
}: {
  kind?: CardKind;
  className?: string;
  children: ReactNode;
}) {
  return <div className={cardClass[kind] + " " + className}>{children}</div>;
}

export function Section({
  title,
  hint,
  action,
  className = "",
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={"flex flex-col gap-3 " + className}>
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="font-display text-mid font-semibold text-body">{title}</h2>
          {hint ? <p className="mt-0.5 text-small text-muted">{hint}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/*
 * Grids size themselves from a minimum column width rather than from
 * breakpoints, because the root font size already moves with the viewport -
 * breakpoints layered on top of that would fight it.
 */
export function Columns({ children, min = "19rem" }: { children: ReactNode; min?: string }) {
  return (
    <div
      className="grid items-start gap-5"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(" + min + ", 1fr))" }}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------- buttons -- */

type ButtonKind = "primary" | "quiet" | "danger" | "warn" | "ghost";
type ButtonSize = "small" | "mid" | "large";

/*
 * A filled accent keeps the brand colour on either theme and puts dark ink on
 * top; an outlined one uses the accent's text twin, which the light theme
 * darkens so it stays readable on white.
 */
const buttonClass: Record<ButtonKind, string> = {
  primary: "bg-kick text-onkick hover:bg-kick/90 font-semibold",
  quiet: "border border-line bg-raised text-body hover:border-muted/40",
  danger: "border border-rose/40 bg-rose/10 text-rose-text hover:bg-rose/20",
  warn: "bg-amber text-onkick hover:bg-amber/90 font-semibold",
  ghost: "text-muted hover:bg-raised hover:text-body",
};

/*
 * The middle size is h-9 because that is what Input and Dropdown are. A button
 * sitting beside a field is the common case here - search boxes, the folder
 * picker - and an h-8 button next to an h-9 field reads as a mistake every
 * time, so the default matches rather than needing a class at each call site.
 */
const buttonSize: Record<ButtonSize, string> = {
  small: "h-7 px-2.5 text-small",
  mid: "h-9 px-3 text-body",
  large: "h-10 px-5 text-mid font-semibold",
};

export function Button({
  kind = "quiet",
  size = "mid",
  icon,
  className = "",
  children,
  ...rest
}: {
  kind?: ButtonKind;
  size?: ButtonSize;
  icon?: IconName;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-45";
  return (
    <button
      type="button"
      {...rest}
      className={[base, buttonClass[kind], buttonSize[size], className].join(" ")}
    >
      {icon ? <Icon name={icon} className="size-4" /> : null}
      {children}
    </button>
  );
}

/* --------------------------------------------------------------- inputs -- */

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-small font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="text-small text-muted/80">{hint}</span> : null}
    </label>
  );
}

const controlClass =
  "h-9 w-full rounded-md border border-line bg-ink px-2.5 text-body text-body placeholder:text-muted/60 transition-colors hover:border-muted/30 focus:border-muted/50 disabled:opacity-45";

/*
 * Forwards its ref, because a caller sometimes needs the element itself - the
 * timecode field attaches a non-passive wheel listener, which React's onWheel
 * cannot be.
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...rest }, ref) {
    return <input ref={ref} {...rest} className={controlClass + " " + className} />;
  },
);

export type Option = { value: string; label: string };

/*
 * A dropdown of our own rather than a native <select>.
 *
 * The native one draws its popup through the OS, which ignores the palette
 * entirely: on this dark theme it came up as a white list with washed-out
 * items, and no amount of CSS reaches inside it. So the menu is ours, rendered
 * into a portal - inside the layout it would be clipped by the header's own
 * overflow, and it has to be able to escape it.
 */
export function Dropdown({
  value,
  options,
  onChange,
  className = "",
  ariaLabel,
}: {
  value: string;
  options: readonly Option[];
  onChange: (value: string) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);

  const current = options.find((o) => o.value === value);

  // Measured before paint, so the menu never appears at the wrong place first.
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    setBox({ left: r.left, top: r.bottom + 4, width: Math.max(r.width, 140) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!anchor.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // A menu positioned once would drift away from its button on scroll or
    // resize, so it closes instead of chasing.
    const close = () => setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={
          // No width here on purpose: a dropdown should be as wide as its
          // caller says, not as wide as whatever box it lands in.
          "flex h-9 cursor-pointer items-center justify-between gap-2 rounded-md border border-line bg-ink px-2.5 text-body text-body transition-colors hover:border-muted/30 " +
          className
        }
      >
        <span className="truncate">{current?.label ?? value}</span>
        <Icon name="chevron" className={"size-3.5 shrink-0 text-muted transition-transform " + (open ? "-rotate-90" : "rotate-90")} />
      </button>

      {open && box
        ? createPortal(
            <div
              ref={menu}
              role="listbox"
              className="appear fixed z-50 overflow-hidden rounded-md border border-line bg-surface py-1 shadow-xl shadow-black/40"
              style={{ left: box.left, top: box.top, minWidth: box.width }}
            >
              {options.map((option) => {
                const on = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={on}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    className={
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-body transition-colors " +
                      (on ? "bg-raised font-medium text-body" : "text-muted hover:bg-raised/60 hover:text-body")
                    }
                  >
                    <Icon
                      name="check"
                      className={"size-3.5 shrink-0 " + (on ? "text-kick-text" : "opacity-0")}
                    />
                    <span className="truncate">{option.label}</span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={
        "relative h-5 w-9 shrink-0 rounded-full border transition-colors " +
        (checked ? "border-kick/50 bg-kick/30" : "border-line bg-ink")
      }
    >
      <span
        className={
          "absolute top-0.5 size-3.5 rounded-full transition-all " +
          (checked ? "left-4.5 bg-kick" : "left-0.5 bg-muted")
        }
      />
    </button>
  );
}

/* ---------------------------------------------------------------- notes -- */

type NoteKind = "error" | "warn" | "ok";

const noteClass: Record<NoteKind, string> = {
  error: "border-rose/40 bg-rose/10 text-rose-text",
  warn: "border-amber/40 bg-amber/10 text-amber-text",
  ok: "border-kick/40 bg-kick/10 text-kick-text",
};

const noteIcon: Record<NoteKind, IconName> = { error: "warn", warn: "warn", ok: "check" };

export function Note({ kind, children, action }: { kind: NoteKind; children: ReactNode; action?: ReactNode }) {
  return (
    <div
      className={
        "appear flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-body " + noteClass[kind]
      }
    >
      <Icon name={noteIcon[kind]} className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

export function Badge({ kind = "neutral", children }: { kind?: NoteKind | "neutral"; children: ReactNode }) {
  const tone = kind === "neutral" ? "border-line bg-raised text-muted" : noteClass[kind] + " bg-transparent";
  return (
    <span
      className={
        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-mini uppercase tracking-wide " +
        tone
      }
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------- signals -- */

export function EmptyState({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line px-6 py-14 text-center">
      <Icon name={icon} className="size-7 text-muted/50" />
      <p className="max-w-[28rem] text-body text-muted">{children}</p>
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={"overflow-hidden rounded bg-raised " + className} />;
}

export function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={"animate-spin " + className} aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/*
 * `value` is 0..1, or null for a stage that genuinely cannot report a
 * percentage (muxing, before ffmpeg has printed its first `time=`), which gets
 * a sweep instead of a lie about how far along it is.
 */
export function ProgressBar({ value, kind = "ok" }: { value: number | null; kind?: NoteKind }) {
  const fill: Record<NoteKind, string> = { ok: "bg-kick", warn: "bg-amber", error: "bg-rose" };
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
      {value === null ? (
        <div className={"bar-sweep h-full w-1/3 rounded-full " + fill[kind]} />
      ) : (
        <div
          className={"h-full rounded-full transition-[width] duration-300 " + fill[kind]}
          style={{ width: Math.max(0, Math.min(1, value)) * 100 + "%" }}
        />
      )}
    </div>
  );
}
