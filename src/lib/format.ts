/*
 * Formatting for the values the machine owns. All of these render into
 * `font-mono` slots, so they are fixed-width by construction: a duration is
 * always H:MM:SS, never 1:2:3.
 */

/** Seconds to `H:MM:SS`, or `MM:SS` under an hour. */
export function timecode(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Seconds to the zero-padded `HH:MM:SS` the range inputs accept. */
export function fullTimecode(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(pad).join(":");
}

/**
 * Parse `HH:MM:SS`, `MM:SS` or `SS` to seconds. Returns null for anything else
 * so a half-typed value shows as invalid rather than silently becoming 0.
 */
export function parseTimecode(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length === 0 || parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    total = total * 60 + Number(part);
  }
  return total;
}

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 MB";
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

/** Kick sends `2026-09-06 00:14:58` (UTC, no zone marker) on some fields. */
export function parseKickDate(raw: string): Date | null {
  if (!raw) return null;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function shortDate(raw: string, locale: string): string {
  const d = parseKickDate(raw);
  if (!d) return "";
  return d.toLocaleDateString(locale, { day: "2-digit", month: "short", year: "numeric" });
}

export function compactCount(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
