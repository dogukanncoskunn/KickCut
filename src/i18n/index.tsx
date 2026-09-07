import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { en } from "./en";
import type { MessageKey, Messages } from "./en";
import { tr } from "./tr";
import { de } from "./de";

export const LOCALES = ["tr", "en", "de"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_NAMES: Record<Locale, string> = {
  tr: "Türkçe",
  en: "English",
  de: "Deutsch",
};

const CATALOGS: Record<Locale, Messages> = { tr, en, de };

/*
 * The locale also lives in the Rust settings file, but reading that is async
 * and the first paint cannot wait for it - a flash of the wrong language on
 * every launch is worse than a duplicated value. localStorage answers
 * synchronously; the Rust side is the durable copy and is written alongside.
 */
const STORAGE_KEY = "kickcut.locale";

function initialLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && (LOCALES as readonly string[]).includes(saved)) return saved as Locale;
  const nav = navigator.language.slice(0, 2).toLowerCase();
  return (LOCALES as readonly string[]).includes(nav) ? (nav as Locale) : "tr";
}

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

const Ctx = createContext<{ locale: Locale; setLocale: (l: Locale) => void; t: Translate } | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLocaleState(next);
  }, []);

  const t = useCallback<Translate>(
    (key, vars) => {
      // Fall back to English rather than showing a raw key: a missing German
      // string should still leave the screen usable.
      const raw = CATALOGS[locale][key] ?? en[key] ?? key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in vars ? String(vars[name]) : whole,
      );
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLocale() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLocale must be used inside <LocaleProvider>");
  return ctx;
}

export function useT(): Translate {
  return useLocale().t;
}
