import type { ReactNode } from "react";
import { useT } from "../i18n";
import { useFfmpeg } from "../lib/Ffmpeg";
import { bytes } from "../lib/format";
import { useMotion } from "../lib/Motion";
import { AutoResumeControl } from "../lib/AutoResume";
import { SpeedControl } from "../lib/SpeedControl";
import { useUpdater } from "../lib/Updater";
import { Badge, Button, Card, Icon, Note, ProgressBar, Spinner, Toggle } from "../lib/ui";

/*
 * Settings as a row of cards rather than a column of sections.
 *
 * Stacked, each setting was a heading, a hint and a lone control marooned in
 * the middle of a wide empty screen - a tall list of small things. Each one is
 * now a card that carries its own title, and they sit on one uniform grid: same
 * width, and the same height because grid rows stretch. Nothing is allowed to
 * be a different shape from its neighbours.
 *
 * The column count steps 1 -> 2 -> 4 and deliberately skips 3. Letting the
 * grid fit as many as would go stranded the fourth card alone on a second row,
 * which is the one arrangement of four things that reads as a mistake. Four
 * across or two by two are both square; three and a spare is not.
 *
 * Updating is not a fifth card for the same reason: five on that grid strands
 * one. It is also not the same kind of thing - the four are preferences you
 * set and leave, this is an action you take - so it gets a strip of its own
 * across the foot, which reads as deliberate rather than as a leftover.
 */
export function Settings() {
  const t = useT();
  const { motion, setMotion } = useMotion();

  return (
    <div className="flex flex-col gap-5">
    <div className="grid items-stretch gap-5 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
      <SettingCard title={t("ffmpeg.title")} hint={t("ffmpeg.hint")}>
        <FfmpegSetting />
      </SettingCard>

      <SettingCard title={t("speed.label")} hint={t("speed.hint")}>
        <SpeedControl />
      </SettingCard>

      <SettingCard title={t("queue.autoResume")} hint={t("queue.autoResume.hint")}>
        <AutoResumeControl />
      </SettingCard>

      <SettingCard title={t("settings.motion")} hint={t("settings.motion.hint")}>
        <div className="flex items-center gap-2.5">
          <Toggle checked={motion} onChange={setMotion} label={t("settings.motion")} />
          <span className="text-body">
            {motion ? t("settings.motion.on") : t("settings.motion.off")}
          </span>
        </div>
      </SettingCard>
    </div>

    <UpdateSetting />
    </div>
  );
}

/*
 * The whole point of this strip: nobody should have to go back to a release
 * page. The app knows what it is running and what is published, so the only
 * honest thing to put here is both of those and one button.
 */
function UpdateSetting() {
  const t = useT();
  const { stage, version, check, install } = useUpdater();

  const status =
    stage.kind === "checking"
      ? t("update.checking")
      : stage.kind === "current"
        ? t("update.current")
        : stage.kind === "available"
          ? t("update.available", { version: stage.update.version })
          : stage.kind === "installing"
            ? t("update.installing")
            : stage.kind === "restarting"
              ? t("update.restarting")
              : stage.kind === "failed"
                ? stage.message
                : "";

  const busy = stage.kind === "checking" || stage.kind === "installing" || stage.kind === "restarting";

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Icon name="download" className="size-4 shrink-0 text-muted" />
          <div className="flex min-w-0 flex-col">
            <span className="text-body font-medium text-body">
              {t("settings.update")}
              {version ? <span className="ml-2 font-mono text-small text-muted">{version}</span> : null}
            </span>
            <span
              className={
                "truncate text-small " +
                (stage.kind === "failed"
                  ? "text-rose-text"
                  : stage.kind === "available"
                    ? "text-kick-text"
                    : "text-muted")
              }
            >
              {status || t("settings.update.hint")}
            </span>
          </div>
        </div>

        {stage.kind === "available" ? (
          <Button kind="primary" icon="download" onClick={install}>
            {t("update.install")}
          </Button>
        ) : (
          <Button kind="quiet" icon="refresh" disabled={busy} onClick={check}>
            {t("update.check")}
          </Button>
        )}
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
    </Card>
  );
}

function SettingCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <Card className="flex h-full flex-col gap-4 p-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-mid font-semibold text-body">{title}</h2>
        <p className="text-small text-muted">{hint}</p>
      </div>
      {/* Pushed to the bottom so every card's control sits on the same line. */}
      <div className="mt-auto">{children}</div>
    </Card>
  );
}

function FfmpegSetting() {
  const t = useT();
  const { status, progress, error, install } = useFfmpeg();

  if (progress) {
    // `total` is 0 until the first response header arrives, and for the
    // verifying and unpacking stages, which have no meaningful percentage.
    const fraction = progress.total > 0 ? progress.received / progress.total : null;
    return (
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-body">{t(`ffmpeg.installing.${progress.stage}`)}</span>
          {fraction !== null ? (
            <span className="font-mono text-small text-muted">
              {bytes(progress.received)} / {bytes(progress.total)}
            </span>
          ) : null}
        </div>
        <ProgressBar value={fraction} />
        <p className="text-small text-muted">{t("ffmpeg.oneTime")}</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center gap-2.5">
        <Spinner className="size-4 text-muted" />
        <span className="text-small text-muted">{t("ffmpeg.checking")}</span>
      </div>
    );
  }

  const missing = status.source === "missing";
  const size = bytes(status.downloadBytes);

  return (
    <div className="flex flex-col gap-3">
      <Badge kind={missing ? "warn" : "ok"}>{t(`ffmpeg.${status.source}`)}</Badge>

      {status.version ? (
        <p className="truncate font-mono text-small text-muted" title={status.path ?? undefined}>
          {status.version}
        </p>
      ) : (
        <p className="text-small text-muted">{t("ffmpeg.blocked")}</p>
      )}

      <Button
        kind={missing ? "primary" : "quiet"}
        icon="download"
        onClick={() => void install()}
        className="w-full"
      >
        {missing ? t("ffmpeg.install", { size }) : t("ffmpeg.reinstall", { size })}
      </Button>

      {error ? <Note kind="error">{error}</Note> : null}
    </div>
  );
}
