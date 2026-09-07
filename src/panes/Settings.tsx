import { LOCALES, LOCALE_NAMES, useLocale, useT } from "../i18n";
import type { Locale } from "../i18n";
import { useMotion } from "../lib/Motion";
import { SCALE_MAX, SCALE_MIN, SCALE_STEP, useScale } from "../lib/Scale";
import { Card, Field, Section, Select, Toggle } from "../lib/ui";

export function Settings() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const { motion, setMotion } = useMotion();
  const { scale, setScale } = useScale();

  return (
    <div className="flex flex-col gap-8">
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
