import { useEffect, useState } from "react";
import { LOCALES, LOCALE_NAMES, useLocale, useT } from "./i18n";
import type { Locale } from "./i18n";
import { ErrorBoundary } from "./lib/ErrorBoundary";
import { FloatingDownload } from "./lib/FloatingDownload";
import { useSelection } from "./lib/Selection";
import { useTheme } from "./lib/Theme";
import { UpdateNotice } from "./lib/Updater";
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

/*
 * Navigation is a row, not a column.
 *
 * A sidebar spent thirteen rem of every screen on four words, and the panes
 * paid for it by growing downwards - a narrow column of content with wide empty
 * margins either side and a scrollbar doing work the width should have done.
 * In the header the tabs cost nothing horizontally and no extra height either,
 * because the logo and the two controls were already on that row.
 */
const TABS: { id: TabId; icon: IconName; label: MessageKey; title: MessageKey; width: string }[] = [
  // The wide panes are capped only so text never runs edge to edge on a very
  // wide monitor; below that they use whatever the window gives them.
  { id: "library", icon: "library", label: "nav.library", title: "pane.library.title", width: "112rem" },
  { id: "download", icon: "scissors", label: "nav.download", title: "pane.setup.title", width: "112rem" },
  { id: "downloads", icon: "download", label: "nav.downloads", title: "pane.downloads.title", width: "84rem" },
  { id: "settings", icon: "settings", label: "nav.settings", title: "pane.settings.title", width: "84rem" },
];

export function App() {
  const t = useT();
  const [tab, setTab] = useState<TabId>("library");
  const { vod } = useSelection();

  // Choosing a broadcast is the start of setting up a download, so it moves
  // there rather than leaving the user to notice a tab has become useful.
  useEffect(() => {
    if (vod) setTab("download");
  }, [vod]);

  return (
    <div className="flex h-full flex-col bg-ink">
      {/*
        Three tracks, not a row of flexed items: the outer two are equal, so the
        tabs sit on the window's true centre no matter how wide the mark on the
        left or the controls on the right happen to be. Flexing them would put
        the group wherever the leftovers fell, and it would move every time the
        language changed the width of a label.
      */}
      <header className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-line bg-surface px-4">
        <Wordmark />

        <nav className="flex items-center gap-1">
          {TABS.map((x) => {
            const on = x.id === tab;
            return (
              <button
                key={x.id}
                type="button"
                onClick={() => setTab(x.id)}
                aria-current={on ? "page" : undefined}
                className={
                  "group relative flex h-8 shrink-0 items-center gap-2 rounded-md px-3.5 text-body transition-colors " +
                  (on
                    ? "bg-raised font-medium text-body"
                    : "text-muted hover:bg-raised/50 hover:text-body")
                }
              >
                <Icon
                  name={x.icon}
                  className={
                    "size-4 shrink-0 transition-colors " +
                    (on ? "text-kick-text" : "text-current group-hover:text-body")
                  }
                />
                <span>{t(x.label)}</span>
                {/*
                  A hairline on the header's own bottom edge. The pill says
                  which tab the pointer is near; this says which screen you are
                  actually on, and reads from across the room.
                */}
                <span
                  className={
                    "absolute inset-x-2 -bottom-2 h-0.5 rounded-full bg-kick transition-opacity duration-200 " +
                    (on ? "opacity-100" : "opacity-0")
                  }
                />
              </button>
            );
          })}
        </nav>

        {/*
          Language sits here rather than in Settings. It is the one preference
          someone may need on any screen - most often because the screen they
          are looking at is in the wrong language.
        */}
        <div className="flex items-center justify-end gap-1.5">
          <LanguagePicker />
          <ThemeSwitch />
        </div>
      </header>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {/*
          Every pane stays mounted and the inactive ones are hidden. Unmounting
          threw away their state, so switching tabs mid-setup wiped the quality,
          the range and the folder you had just chosen - and a channel you had
          searched for. Hiding costs one hidden subtree and keeps all of it.
        */}
        {TABS.map((pane) => (
          <div
            key={pane.id}
            className="mx-auto flex flex-col gap-5 px-6 pt-5 pb-12"
            style={pane.id === tab ? { maxWidth: pane.width } : { display: "none" }}
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

      {/*
        Pinned to the window rather than placed in a pane, so it is a mark on
        the app and not a line that scrolls away with whatever screen you are on.
        Click-through, because nothing about it is interactive.
      */}
      <span className="pointer-events-none fixed bottom-2.5 left-4 z-30 font-mono text-mini text-body/45 select-none">
        {t("app.madeBy")}
      </span>

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
      className="h-5 w-auto shrink-0 select-none"
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
      className="h-7 w-[6.5rem] border-transparent bg-transparent text-small hover:border-line"
    />
  );
}
