import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

/*
 * Motion on/off. The default comes from the OS, but an explicit choice made
 * here outranks it and persists - someone can want the animations on a machine
 * whose OS setting was flipped for something else entirely.
 */
const STORAGE_KEY = "kickcut.motion";

const Ctx = createContext<{ motion: boolean; setMotion: (v: boolean) => void } | null>(null);

export function MotionProvider({ children }: { children: ReactNode }) {
  const [motion, setMotionState] = useState<boolean>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "on") return true;
    if (saved === "off") return false;
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("motionless", !motion);
  }, [motion]);

  const value = useMemo(
    () => ({
      motion,
      setMotion: (v: boolean) => {
        localStorage.setItem(STORAGE_KEY, v ? "on" : "off");
        setMotionState(v);
      },
    }),
    [motion],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMotion() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMotion must be used inside <MotionProvider>");
  return ctx;
}
