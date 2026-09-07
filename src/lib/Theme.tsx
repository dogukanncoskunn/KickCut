import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

/*
 * Dark or light, as an explicit choice.
 *
 * Dark is the default because that is what the app was drawn against and what
 * sits next to a stream. The light theme exists because not every desk is a
 * dark room, and it is a real theme rather than an inversion: the tokens in
 * styles.css move, and no component knows which one is running.
 *
 * The attribute goes on <html>, so the very first paint is already correct and
 * there is no flash of the wrong theme on startup.
 */
export type Theme = "dark" | "light";

const STORAGE_KEY = "kickcut.theme";

const Ctx = createContext<{ theme: Theme; setTheme: (t: Theme) => void } | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() =>
    localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,
      setTheme: (next: Theme) => {
        localStorage.setItem(STORAGE_KEY, next);
        setThemeState(next);
      },
    }),
    [theme],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
