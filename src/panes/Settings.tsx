import type { ReactNode } from "react";
import { useT } from "../i18n";
import { useFfmpeg } from "../lib/Ffmpeg";
import { bytes } from "../lib/format";
import { useMotion } from "../lib/Motion";
import { AutoResumeControl } from "../lib/AutoResume";
import { SpeedControl } from "../lib/SpeedControl";
import { Badge, Button, Card, Note, ProgressBar, Spinner, Toggle } from "../lib/ui";

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
 */
export function Settings() {
  const t = useT();
  const { motion, setMotion } = useMotion();

  return (
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
