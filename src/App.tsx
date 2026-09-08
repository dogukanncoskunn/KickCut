import { useEffect, useState } from "react";
import { LOCALES, LOCALE_NAMES, useLocale, useT } from "./i18n";
import type { Locale } from "./i18n";
import { ErrorBoundary } from "./lib/ErrorBoundary";
import { FloatingDownload } from "./lib/FloatingDownload";
import { useSelection } from "./lib/Selection";
import { UpdateNotice } from "./lib/Updater";
import { useTheme } from "./lib/Theme";
import { Dropdown, Icon, Note } from "./lib/ui";
import type { IconName } from "./lib/ui";
import { Library } from "./panes/Library";
import { Download } from "./panes/Download";
import { Downloads } from "./panes/Downloads";
import { Settings } from "./panes/Settings";
import type { MessageKey } from "./i18n/en";
import logoDark from "./assets/logo-dark.png";
import logoLight from "./assets/logo-light.png";

/*
 * Four screens, one useState. There is no router because there are no URLs
 * worth addressing in a desktop tool, and no state library because the only
 * things shared across panes are the selected broadcast and the job queue,
 * which have a small context each.
 */
type TabId = "library" | "download" | "downloads" | "settings";

const TABS: { id: TabId; icon: IconName; label: MessageKey; title: MessageKey; width: string }[] = [
  { id: "library", icon: "library", label: "nav.library", title: "pane.library.title", width: "78rem" },
  // Wider than the others because it carries the queue rail alongside the form.
  { id: "download", icon: "scissors", label: "nav.download", title: "pane.setup.title", width: "88rem" },
  { id: "downloads", icon: "download", label: "nav.downloads", title: "pane.downloads.title", width: "68rem" },
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
          are looking at is in the wrong language.
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
            <span className="mt-auto px-2.5 pb-1 font-mono text-mini text-body/70">
              {t("app.madeBy")}
            </span>
          ) : null}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto">
          {/*
            Every pane stays mounted and the inactive ones are hidden.
            Unmounting them threw away their state, so switching tabs mid-setup
            wiped the quality, the range and the folder you had just chosen -
            and a channel you had searched for. Hiding costs one hidden subtree
            and keeps all of it.
          */}
          {TABS.map((pane) => (
            <div
              key={pane.id}
              className="mx-auto flex flex-col gap-6 px-8 py-7"
              style={
                pane.id === tab
                  ? { maxWidth: pane.width }
                  : // Hidden rather than unmounted, so its state survives.
                    { display: "none" }
              }
            >
              <h1 className="font-display text-page font-semibold tracking-tight text-body">
                {t(pane.title)}
              </h1>
              <ErrorBoundary
                fallback={(message) => (
                  <Note kind="error">
                    <p className="font-medium">{t("error.boundary")}</p>
                    <p className="mt-1 font-mono text-small opacity-80">{message}</p>
                  </Note>
                )}
              >
                {pane.id === "library" ? <Library /> : null}
                {pane.id === "download" ? <Download /> : null}
                {pane.id === "downloads" ? <Downloads /> : null}
                {pane.id === "settings" ? <Settings /> : null}
              </ErrorBoundary>
            </div>
          ))}
        </main>
      </div>

      {/* On the Download tab the rail already shows it. */}
      <FloatingDownload hidden={tab === "download"} />
      <UpdateNotice />
    </div>
  );
}

/*
 * The mark is drawn in near-black ink, so it needs a variant per theme rather
 * than a filter: the light one is the artwork as drawn, the dark one has its
 * ink remapped to the body colour.
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

/*
 * A physical switch rather than a button that swaps its icon. The knob carries
 * the theme that is currently on and slides to the side that theme lives on, so
 * the control shows its state at rest instead of only announcing what a click
 * would do.
 */
function ThemeSwitch() {
  const t = useT();
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";
  const next = dark ? "light" : "dark";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      onClick={() => setTheme(next)}
      title={t(`theme.${next}`)}
      aria-label={t(`theme.${next}`)}
      className="relative h-6 w-11 shrink-0 rounded-full border border-line bg-ink transition-colors hover:border-muted/40"
    >
      <span
        className="absolute top-0.5 grid size-4.5 place-items-center rounded-full bg-raised text-body shadow transition-[left] duration-200 ease-out"
        style={{ left: dark ? "1.4rem" : "0.15rem" }}
      >
        <Icon
          name="sun"
          className={
            "absolute size-3 transition-opacity duration-200 " +
            (dark ? "opacity-0" : "text-amber-text opacity-100")
          }
        />
        <Icon
          name="moon"
          className={"absolute size-3 transition-opacity duration-200 " + (dark ? "opacity-100" : "opacity-0")}
        />
      </span>
    </button>
  );
}

function LanguagePicker() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  return (
    <Dropdown
      value={locale}
      options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
      onChange={(next) => setLocale(next as Locale)}
      ariaLabel={t("settings.language")}
      className="h-7 w-32 border-transparent bg-transparent text-small hover:border-line"
    />
  );
}
