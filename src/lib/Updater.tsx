import { useEffect, useState } from "react";
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
 */
type Stage =
  | { kind: "idle" }
  | { kind: "available"; update: Update }
  | { kind: "installing"; received: number; total: number }
  | { kind: "restarting" }
  | { kind: "failed"; message: string };

export function UpdateNotice() {
  const t = useT();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Once, on startup. Nagging on a timer would interrupt a download for no
    // reason - a version that appeared ten minutes ago can wait for the next
    // launch.
    let live = true;
    check()
      .then((update) => {
        if (live && update) setStage({ kind: "available", update });
      })
      .catch(() => {
        // Offline, or the endpoint is unreachable. An update check failing is
        // not something to put in front of someone.
      });
    return () => {
      live = false;
    };
  }, []);

  if (dismissed || stage.kind === "idle") return null;

  async function install(update: Update) {
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
      setStage({ kind: "failed", message: cleanError(err) });
    }
  }

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
              <Button kind="primary" size="small" onClick={() => void install(stage.update)}>
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
