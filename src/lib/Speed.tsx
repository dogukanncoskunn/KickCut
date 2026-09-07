import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";

/*
 * The download speed cap.
 *
 * Typed, not chosen from a list. A fixed set of steps always turns out to be
 * missing the one someone wants - a 25 Mbit line wants 2.5 MB/s, not 2 or 5 -
 * so this works the way Steam's does: a switch that turns limiting on, and a
 * number in KB/s beside it. 8000 is 8 MB/s. Zero means unlimited even with the
 * switch on, so clearing the field never traps the download at nothing.
 *
 * Rust holds the authoritative value while a download runs; this side owns the
 * preference and pushes it down on startup and on every change, so a limit set
 * yesterday still applies today.
 */
const ENABLED_KEY = "kickcut.speedLimit.enabled";
const RATE_KEY = "kickcut.speedLimit.kb";

/** A visible starting point when the switch is first turned on. */
export const DEFAULT_KB = 8000;

type Value = {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Kilobytes per second as typed. 0 means no cap. */
  kbPerSecond: number;
  setKbPerSecond: (kb: number) => void;
  /** What is actually in force, in KB/s; 0 when unlimited. */
  effectiveKb: number;
};

const Ctx = createContext<Value | null>(null);

export function SpeedProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(() => localStorage.getItem(ENABLED_KEY) === "1");
  const [kbPerSecond, setKbState] = useState(() => {
    const saved = Number(localStorage.getItem(RATE_KEY));
    return Number.isFinite(saved) && saved >= 0 ? saved : DEFAULT_KB;
  });

  const effectiveKb = enabled ? kbPerSecond : 0;

  // Pushed on mount as well as on change: a job resumed at startup has to be
  // capped from its first chunk, not from the first time this screen is opened.
  useEffect(() => {
    void api.setSpeedLimit(Math.round(effectiveKb * 1000)).catch(() => {
      /* The cap is a convenience; failing to set it must not break anything. */
    });
  }, [effectiveKb]);

  const value = useMemo<Value>(
    () => ({
      enabled,
      setEnabled: (on: boolean) => {
        localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
        setEnabledState(on);
      },
      kbPerSecond,
      setKbPerSecond: (kb: number) => {
        const clean = Number.isFinite(kb) && kb > 0 ? Math.round(kb) : 0;
        localStorage.setItem(RATE_KEY, String(clean));
        setKbState(clean);
      },
      effectiveKb,
    }),
    [enabled, kbPerSecond, effectiveKb],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSpeedLimit() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSpeedLimit must be used inside <SpeedProvider>");
  return ctx;
}
