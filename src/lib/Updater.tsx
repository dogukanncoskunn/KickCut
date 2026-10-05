import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useT } from "../i18n";
import { bytes } from "./format";
import { cleanError } from "./errors";
import { Button, Icon, ProgressBar } from "./ui";

/*
 * Updating without going and finding the download page.
 *
 * How a copy of the app arrived - a release page, or a file someone sent over
 * chat - makes no difference here: the check happens inside the installed app,
 * so a friend who was handed an .exe once never has to be handed one again.
 *
 * The update is only applied if it carries a signature made with our private
 * key, which the bundled public key verifies. That is what stops a compromised
 * download host from pushing code to everyone running this.
 *
 * There are two ways in - the notice that appears by itself on startup, and
 * the button in Settings for people who want to go and look - and they share
 * one state, so pressing check while the startup notice is on screen cannot
 * start a second download of the same thing.
 */
type Stage =
  /** Nothing asked yet. */
  | { kind: "idle" }
  | { kind: "checking" }
  /** Asked, and this is the newest there is. */
  | { kind: "current" }
  | { kind: "available"; update: Update }
  | { kind: "installing"; received: number; total: number }
  | { kind: "restarting" }
  /** `while` decides whether this is worth interrupting someone over. */
  | { kind: "failed"; message: string; while: "check" | "install" };

type Value = {
  stage: Stage;
  /** The running build, as the installer wrote it. */
  version: string;
  check: () => void;
  install: () => void;
};

const Ctx = createContext<Value | null>(null);

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [version, setVersion] = useState("");

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const look = useCallback(() => {
    setStage({ kind: "checking" });
    check()
      .then((update) => setStage(update ? { kind: "available", update } : { kind: "current" }))
      .catch((err) => setStage({ kind: "failed", message: cleanError(err), while: "check" }));
  }, []);

  // Once, on startup. Nagging on a timer would interrupt a download for no
  // reason - a version that appeared ten minutes ago can wait for the next
  // launch, or for someone to press the button in Settings.
  useEffect(look, [look]);

  const install = useCallback(() => {
    if (stage.kind !== "available") return;
    const update = stage.update;
    void (async () => {
      setStage({ kind: "installing", received: 0, total: 0 });
      try {
        let received = 0;
        let total = 0;
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") total = event.data.contentLength ?? 0;
          else if (event.event === "Progress") received += event.data.chunkLength;
          setStage({ kind: "installing", received, total });
        });
        setStage({ kind: "restarting" });
        await relaunch();
      } catch (err) {
        setStage({ kind: "failed", message: cleanError(err), while: "install" });
      }
    })();
  }, [stage]);

  const value = useMemo<Value>(
    () => ({ stage, version, check: look, install }),
    [stage, version, look, install],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUpdater() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useUpdater must be used inside <UpdaterProvider>");
  return ctx;
}

/*
 * The one thing worth putting in front of someone unasked: a new version
 * exists. A check that failed is not - that is only interesting to somebody
 * who went looking, and Settings tells them there.
 */
export function UpdateNotice() {
  const t = useT();
  const { stage, install } = useUpdater();
  const [dismissed, setDismissed] = useState(false);

  const show =
    stage.kind === "available" ||
    stage.kind === "installing" ||
    stage.kind === "restarting" ||
    (stage.kind === "failed" && stage.while === "install");
  if (dismissed || !show) return null;

  return (
    <div className="appear fixed bottom-6 left-6 z-50 w-[24rem] max-w-[calc(100vw-3rem)]">
      <div className="flex flex-col gap-3 rounded-lg border border-kick/40 bg-surface p-4 shadow-2xl shadow-black/50">
        <div className="flex items-start gap-2.5">
          <Icon name="download" className="mt-0.5 size-4 shrink-0 text-kick-text" />
          <div className="min-w-0 flex-1">
            <p className="text-body font-medium text-body">
              {stage.kind === "available"
                ? t("update.available", { version: stage.update.version })
                : stage.kind === "installing"
                  ? t("update.installing")
                  : stage.kind === "restarting"
                    ? t("update.restarting")
                    : t("update.failed")}
            </p>
            {stage.kind === "failed" ? (
              <p className="mt-1 font-mono text-small text-rose-text">{stage.message}</p>
            ) : null}
          </div>
        </div>

        {stage.kind === "installing" ? (
          <div className="flex flex-col gap-1.5">
            <ProgressBar value={stage.total > 0 ? stage.received / stage.total : null} />
            {stage.total > 0 ? (
              <span className="font-mono text-small text-muted">
                {bytes(stage.received)} / {bytes(stage.total)}
              </span>
            ) : null}
          </div>
        ) : null}

        {stage.kind === "available" || stage.kind === "failed" ? (
          <div className="flex gap-2">
            {stage.kind === "available" ? (
              <Button kind="primary" size="small" onClick={install}>
                {t("update.install")}
              </Button>
            ) : null}
            <Button size="small" onClick={() => setDismissed(true)}>
              {t("update.later")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
