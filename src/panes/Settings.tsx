import { LOCALES, LOCALE_NAMES, useLocale, useT } from "../i18n";
import type { Locale } from "../i18n";
import { useFfmpeg } from "../lib/Ffmpeg";
import { bytes } from "../lib/format";
import { useMotion } from "../lib/Motion";
import { SPEED_STEPS, useSpeedLimit } from "../lib/Speed";
import { SCALE_MAX, SCALE_MIN, SCALE_STEP, useScale } from "../lib/Scale";
import { Badge, Button, Card, Field, Note, ProgressBar, Section, Select, Spinner, Toggle } from "../lib/ui";

export function Settings() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const { motion, setMotion } = useMotion();
  const { scale, setScale } = useScale();
  const speed = useSpeedLimit();

  return (
    <div className="flex flex-col gap-8">
      <Section title={t("ffmpeg.title")} hint={t("ffmpeg.hint")}>
        <FfmpegCard />
      </Section>

      <Section title={t("speed.label")} hint={t("speed.hint")}>
        <Card className="max-w-sm p-4">
          <Field label={t("speed.label")}>
            <Select value={String(speed.limit)} onChange={(e) => speed.setLimit(Number(e.target.value))}>
              {SPEED_STEPS.map((step) => (
                <option key={step} value={step}>
                  {step === 0 ? t("speed.unlimited") : `${step} MB/s`}
                </option>
              ))}
            </Select>
          </Field>
        </Card>
      </Section>

      <Section title={t("settings.language")} hint={t("settings.language.hint")}>
        <Card className="max-w-sm p-4">
          <Field label={t("settings.language")}>
            <Select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {LOCALE_NAMES[l]}
                </option>
              ))}
            </Select>
          </Field>
        </Card>
      </Section>

      <Section title={t("settings.scale")}>
        <Card className="flex max-w-sm items-center gap-4 p-4">
          <input
            type="range"
            min={SCALE_MIN}
            max={SCALE_MAX}
            step={SCALE_STEP}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            className="flex-1 accent-[var(--color-kick)]"
            aria-label={t("settings.scale")}
          />
          <span className="w-12 shrink-0 text-right font-mono text-body text-muted">
            {Math.round(scale * 100)}%
          </span>
        </Card>
      </Section>

      <Section title={t("settings.motion")}>
        <Card className="flex max-w-sm items-center justify-between gap-4 p-4">
          <span className="text-body">{motion ? t("settings.motion.on") : t("settings.motion.off")}</span>
          <Toggle checked={motion} onChange={setMotion} label={t("settings.motion")} />
        </Card>
      </Section>
    </div>
  );
}

function FfmpegCard() {
  const t = useT();
  const { status, progress, error, install } = useFfmpeg();

  if (progress) {
    // `total` is 0 until the first response header arrives, and for the
    // verifying and unpacking stages, which have no meaningful percentage.
    const fraction = progress.total > 0 ? progress.received / progress.total : null;
    return (
      <Card className="flex max-w-xl flex-col gap-3 p-5">
        <div className="flex items-center justify-between gap-4">
          <span className="text-body">{t(`ffmpeg.installing.${progress.stage}`)}</span>
          {fraction !== null ? (
            <span className="font-mono text-small text-muted">
              {bytes(progress.received)} / {bytes(progress.total)}
            </span>
          ) : null}
        </div>
        <ProgressBar value={fraction} />
        <p className="text-small text-muted">{t("ffmpeg.oneTime")}</p>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card className="flex max-w-xl items-center gap-3 p-5">
        <Spinner className="size-4 text-muted" />
        <span className="text-small text-muted">{t("ffmpeg.checking")}</span>
      </Card>
    );
  }

  const missing = status.source === "missing";
  const size = bytes(status.downloadBytes);

  return (
    <div className="flex max-w-xl flex-col gap-3">
      <Card className="flex flex-col gap-3.5 p-5">
        <div className="flex items-center justify-between gap-4">
          <Badge kind={missing ? "warn" : "ok"}>{t(`ffmpeg.${status.source}`)}</Badge>
          <Button kind={missing ? "primary" : "quiet"} icon="download" onClick={() => void install()}>
            {missing ? t("ffmpeg.install", { size }) : t("ffmpeg.reinstall", { size })}
          </Button>
        </div>

        {status.version ? (
          <p className="truncate font-mono text-small text-muted" title={status.path ?? undefined}>
            {status.version}
          </p>
        ) : (
          <p className="text-small text-muted">{t("ffmpeg.blocked")}</p>
        )}
      </Card>

      {error ? <Note kind="error">{error}</Note> : null}
    </div>
  );
}
