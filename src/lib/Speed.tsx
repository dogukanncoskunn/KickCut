import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";

/*
 * The download speed cap, in bytes per second, with 0 meaning unlimited.
 *
 * Rust holds the authoritative value while a download runs; this side owns the
 * user's preference and pushes it down - on startup and on every change - so a
 * limit set yesterday still applies today. The steps are the ones a person
 * actually reaches for, not a free-form number: someone capping a download
 * wants "about half" or "leave me some", not 7.3 MB/s.
 */
export const SPEED_STEPS = [0, 1, 2, 5, 10, 20, 50] as const;

const STORAGE_KEY = "kickcut.speedLimit";
const MB = 1_000_000;

const Ctx = createContext<{ limit: number; setLimit: (mbPerSecond: number) => void } | null>(null);

export function SpeedProvider({ children }: { children: ReactNode }) {
  const [limit, setLimitState] = useState<number>(() => {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(saved) && saved >= 0 ? saved : 0;
  });

  // Pushed on mount as well as on change: a job resumed at startup has to be
  // capped from its first chunk, not from the first time the user opens this.
  useEffect(() => {
    void api.setSpeedLimit(Math.round(limit * MB)).catch(() => {
      /* The cap is a convenience; failing to set it must not break anything. */
    });
  }, [limit]);

  const value = useMemo(
    () => ({
      limit,
      setLimit: (mbPerSecond: number) => {
        localStorage.setItem(STORAGE_KEY, String(mbPerSecond));
        setLimitState(mbPerSecond);
      },
    }),
    [limit],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSpeedLimit() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSpeedLimit must be used inside <SpeedProvider>");
  return ctx;
}
