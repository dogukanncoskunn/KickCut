import { useEffect, useState } from "react";
import { LOCALES, LOCALE_NAMES, useLocale, useT } from "./i18n";
import type { Locale } from "./i18n";
import { ErrorBoundary } from "./lib/ErrorBoundary";
import { useSelection } from "./lib/Selection";
import { Icon, Note, Select } from "./lib/ui";
import type { IconName } from "./lib/ui";
import { Library } from "./panes/Library";
import { Download } from "./panes/Download";
import { Settings } from "./panes/Settings";
import type { MessageKey } from "./i18n/en";
import { useTheme } from "./lib/Theme";
import logoDark from "./assets/logo-dark.png";
import logoLight from "./assets/logo-light.png";

/*
 * Three screens, one useState. There is no router because there are no URLs
 * worth addressing in a desktop tool, and no state library because the only
 * things shared across panes are the selected broadcast and the job queue,
 * which have a small context each.
 */
type TabId = "library" | "download" | "settings";

const TABS: { id: TabId; icon: IconName; label: MessageKey; title: MessageKey; width: string }[] = [
  { id: "library", icon: "library", label: "nav.library", title: "pane.library.title", width: "78rem" },
  // Wider than the others because it carries the queue rail alongside the form.
  { id: "download", icon: "download", label: "nav.download", title: "pane.setup.title", width: "88rem" },
  // Wide enough for three setting cards on one row.
  { id: "settings", icon: "settings", label: "nav.settings", title: "pane.settings.title", width: "68rem" },
];

export function App() {
  const t = useT();
  const [tab, setTab] = useState<TabId>("library");
  const [navOpen, setNavOpen] = useState(true);
  const { vod } = useSelection();

  // Choosing a broadcast is the start of setting up a download, so it moves
  // there rather than leaving the user to notice a tab has become useful.
  useEffect(() => {
    if (vod) setTab("download");
  }, [vod]);

  const active = TABS.find((x) => x.id === tab)!;

  return (
    <div className="flex h-full flex-col bg-ink">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
        <button
          type="button"
          onClick={() => setNavOpen((v) => !v)}
          aria-label="Menu"
          className="grid size-7 place-items-center rounded text-muted transition-colors hover:bg-raised hover:text-body"
        >
          <Icon name="queue" className="size-4" />
        </button>
        <Wordmark />
        {/*
          Language sits here rather than in Settings. It is the one preference
          someone may need on any screen - most often because the screen they
          are looking at is in the wrong language - and making them find
          Settings first is exactly the wrong place for it.
        */}
        <div className="ml-auto flex items-center gap-1.5">
          <LanguagePicker />
          <ThemeSwitch />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          className="flex shrink-0 flex-col gap-1 border-r border-line bg-surface p-2 transition-[width] duration-200"
          style={{ width: navOpen ? "13rem" : "3.25rem" }}
        >
          {TABS.map((x) => {
            const on = x.id === tab;
            return (
              <button
                key={x.id}
                type="button"
                onClick={() => setTab(x.id)}
                title={navOpen ? undefined : t(x.label)}
                className={
                  "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-body transition-colors " +
                  (on ? "bg-raised font-medium text-body" : "text-muted hover:bg-raised/60 hover:text-body")
                }
              >
                <Icon
                  name={x.icon}
                  className={"size-4 shrink-0 " + (on ? "text-kick-text" : "text-current")}
                />
                {navOpen ? <span className="truncate">{t(x.label)}</span> : null}
              </button>
            );
          })}

          {navOpen ? (
            <span className="mt-auto px-2.5 pb-1 font-mono text-mini text-muted/60">
              {t("app.madeBy")}
            </span>
          ) : null}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex flex-col gap-6 px-8 py-7" style={{ maxWidth: active.width }}>
            <h1 className="font-display text-page font-semibold tracking-tight text-body">
              {t(active.title)}
            </h1>
            {/* Keyed by tab so a crashed pane resets by switching away and back. */}
            <ErrorBoundary
              key={tab}
              fallback={(message) => (
                <Note kind="error">
                  <p className="font-medium">{t("error.boundary")}</p>
                  <p className="mt-1 font-mono text-small opacity-80">{message}</p>
                </Note>
              )}
            >
              {tab === "library" ? <Library /> : null}
              {tab === "download" ? <Download /> : null}
              {tab === "settings" ? <Settings /> : null}
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}

/*
 * The mark is drawn in near-black ink, so it needs a variant per theme rather
 * than a filter: the light one is the artwork as drawn, the dark one has its
 * ink remapped to the body colour. Both are exported at three times the height
 * they render at, so they stay sharp on a HiDPI screen.
 */
function Wordmark() {
  const t = useT();
  const { theme } = useTheme();
  return (
    <img
      src={theme === "light" ? logoLight : logoDark}
      alt={t("app.name")}
      className="h-5 w-auto select-none"
      draggable={false}
    />
  );
}

function ThemeSwitch() {
  const t = useT();
  const { theme, setTheme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      // Shows the theme it will switch to, which is what makes a single-button
      // toggle readable without a label.
      title={t(`theme.${next}`)}
      aria-label={t(`theme.${next}`)}
      className="grid size-7 place-items-center rounded text-muted transition-colors hover:bg-raised hover:text-body"
    >
      <Icon name={next === "light" ? "sun" : "moon"} className="size-4" />
    </button>
  );
}

function LanguagePicker() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  return (
    <Select
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      aria-label={t("settings.language")}
      className="h-7 w-32 border-transparent bg-transparent text-small hover:border-line"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_NAMES[l]}
        </option>
      ))}
    </Select>
  );
}
