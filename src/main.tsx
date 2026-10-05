import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ErrorBoundary } from "./lib/ErrorBoundary";
import { MiniWindow } from "./lib/MiniWindow";
import { LocaleProvider } from "./i18n";
import { MotionProvider } from "./lib/Motion";
import { ThemeProvider } from "./lib/Theme";
import { FfmpegProvider } from "./lib/Ffmpeg";
import { QueueProvider } from "./lib/Queue";
import { UndoProvider } from "./lib/Undo";
import { UpdaterProvider } from "./lib/Updater";
import { SpeedProvider } from "./lib/Speed";
import { SelectionProvider } from "./lib/Selection";
import "./styles.css";

/*
 * Two roots, one bundle.
 *
 * The detached download panel is a second Tauri window loading this same
 * index.html. It gets only the providers it actually reads - theme, language,
 * motion and the queue - because the rest (ffmpeg, the speed cap, the
 * selection, the undo toasts) belong to the main window's screens and would be
 * a second, confusing copy of that state.
 *
 * Which root to render is decided by the window's own label rather than by
 * anything on the URL. `WebviewUrl::App` takes a path, so a `?mini=1` marker
 * ends up inside the file name and the window serves nothing at all - a blank
 * white rectangle, which is exactly what the first attempt produced.
 */
const mini = (() => {
  try {
    return getCurrentWindow().label === "mini";
  } catch {
    return false;
  }
})();

createRoot(document.getElementById("root")!).render(
  mini ? (
    <StrictMode>
      <ThemeProvider>
        <LocaleProvider>
          <MotionProvider>
            <QueueProvider load={false}>
              {/*
                The second window has no screen to fall back to, so without
                this a throw anywhere in the tree leaves a bare dark rectangle
                with nothing to read - which is exactly how it failed while
                this was being built.
              */}
              <ErrorBoundary
                fallback={(message) => (
                  <p className="p-3 font-mono text-small text-rose-text">{message}</p>
                )}
              >
                <MiniWindow />
              </ErrorBoundary>
            </QueueProvider>
          </MotionProvider>
        </LocaleProvider>
      </ThemeProvider>
    </StrictMode>
  ) : (
  <StrictMode>
    <ThemeProvider>
      <LocaleProvider>
        <MotionProvider>
        <FfmpegProvider>
          <SpeedProvider>
            <QueueProvider>
              <UndoProvider>
                <UpdaterProvider>
                  <SelectionProvider>
                    <App />
                  </SelectionProvider>
                </UpdaterProvider>
              </UndoProvider>
            </QueueProvider>
          </SpeedProvider>
        </FfmpegProvider>
        </MotionProvider>
      </LocaleProvider>
    </ThemeProvider>
  </StrictMode>
  ),
);
