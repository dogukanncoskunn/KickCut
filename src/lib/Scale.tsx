import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

/*
 * Manual zoom on top of the viewport-driven root size in styles.css. Which of
 * the two a given screen wants is a preference, not something CSS can measure,
 * so it is a knob rather than a curve. Range and step are deliberately coarse.
 */
export const SCALE_MIN = 0.8;
export const SCALE_MAX = 1.4;
export const SCALE_STEP = 0.1;

const STORAGE_KEY = "kickcut.scale";

const Ctx = createContext<{ scale: number; setScale: (v: number) => void } | null>(null);

function clamp(v: number) {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v * 10) / 10));
}

export function ScaleProvider({ children }: { children: ReactNode }) {
  const [scale, setScaleState] = useState<number>(() => {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(saved) && saved > 0 ? clamp(saved) : 1;
  });

  useEffect(() => {
    document.documentElement.style.setProperty("--scale", String(scale));
  }, [scale]);

  const value = useMemo(
    () => ({
      scale,
      setScale: (v: number) => {
        const next = clamp(v);
        localStorage.setItem(STORAGE_KEY, String(next));
        setScaleState(next);
      },
    }),
    [scale],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useScale() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useScale must be used inside <ScaleProvider>");
  return ctx;
}
