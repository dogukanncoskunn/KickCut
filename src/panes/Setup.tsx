import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useT } from "../i18n";
import { api } from "../lib/api";
import type { PlaylistSummary, RangePlan, Rendition } from "../lib/api";
import { cleanError } from "../lib/errors";
import { bytes, shortDate, timecode } from "../lib/format";
import { useSelection } from "../lib/Selection";
import { Card, EmptyState, Field, Note, Section, Select, Skeleton, Spinner, Toggle } from "../lib/ui";
import { RangePicker } from "./RangePicker";
import type { Range } from "./RangePicker";

export function Setup() {
  const t = useT();
  const { locale } = useLocale();
  const { vod } = useSelection();

  const [renditions, setRenditions] = useState<Rendition[] | null>(null);
  const [qualityName, setQualityName] = useState("");
  const [summary, setSummary] = useState<PlaylistSummary | null>(null);
  const [range, setRange] = useState<Range | null>(null);
  const [plan, setPlan] = useState<RangePlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const masterUrl = vod?.masterUrl ?? null;
  const quality = useMemo(
    () => renditions?.find((r) => r.name === qualityName) ?? null,
    [renditions, qualityName],
  );

  /* Qualities, once per broadcast. */
  useEffect(() => {
    if (!masterUrl) {
      setRenditions(null);
      return;
    }
    // A late answer for a broadcast the user has already moved away from must
    // not overwrite the current one.
    let live = true;
    setRenditions(null);
    setSummary(null);
    setRange(null);
    setPlan(null);
    setError(null);
    api
      .renditions(masterUrl)
      .then((list) => {
        if (!live) return;
        setRenditions(list);
        setQualityName(list[0]?.name ?? "");
      })
      .catch((err) => live && setError(cleanError(err)));
    return () => {
      live = false;
    };
  }, [masterUrl]);

  /* The playlist behind the chosen quality: real duration and break marks. */
  const playlistUrl = quality?.playlistUrl ?? null;
  useEffect(() => {
    if (!playlistUrl) return;
    let live = true;
    setSummary(null);
    setPlan(null);
    api
      .playlistSummary(playlistUrl)
      .then((s) => {
        if (!live) return;
        setSummary(s);
        // Whole broadcast is the sensible default, and the toggle below reads
        // as on until the user narrows it.
        setRange({ start: 0, end: s.totalSeconds });
      })
      .catch((err) => live && setError(cleanError(err)));
    return () => {
      live = false;
    };
  }, [playlistUrl]);

  /*
   * The plan is recomputed in Rust so the segment arithmetic has exactly one
   * implementation. Dragging a handle fires continuously, so it is debounced -
   * what the user watches while dragging is the clip length, which is local.
   */
  const planTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!playlistUrl || !range || !quality) return;
    window.clearTimeout(planTimer.current);
    planTimer.current = window.setTimeout(() => {
      api
        .planRange(playlistUrl, range.start, range.end, quality.bandwidth)
        .then(setPlan)
        .catch((err) => setError(cleanError(err)));
    }, 220);
    return () => window.clearTimeout(planTimer.current);
  }, [playlistUrl, range, quality]);

  if (!vod) return <EmptyState icon="scissors">{t("empty.setup")}</EmptyState>;

  const whole = summary !== null && range !== null && range.start === 0 && range.end === summary.totalSeconds;

  return (
    <div className="flex flex-col gap-8">
      <Section title={t("setup.vod")}>
        <Card className="flex gap-4 p-4">
          {vod.thumbnail ? (
            <img src={vod.thumbnail} alt="" className="h-20 w-36 shrink-0 rounded object-cover" />
          ) : null}
          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="truncate text-title font-semibold text-body" title={vod.title}>
              {vod.title}
            </h3>
            <p className="font-mono text-small text-muted">
              {vod.channel} · {shortDate(vod.startedAt, locale)} · {t("setup.length")}{" "}
              {timecode((summary?.totalSeconds ?? vod.durationMs / 1000) || 0)}
            </p>
          </div>
        </Card>
      </Section>

      {error ? <Note kind="error">{error}</Note> : null}

      <Section title={t("setup.quality")}>
        {!renditions && !error ? (
          <Card className="flex items-center gap-3 p-4">
            <Spinner className="size-4 text-muted" />
            <span className="text-small text-muted">{t("setup.quality.loading")}</span>
          </Card>
        ) : null}
        {renditions ? (
          <Card className="max-w-md p-4">
            <Field label={t("setup.quality")}>
              <Select value={qualityName} onChange={(e) => setQualityName(e.target.value)}>
                {renditions.map((r) => (
                  <option key={r.name} value={r.name}>
                    {t("setup.quality.option", {
                      name: r.name,
                      bitrate: (r.bandwidth / 1e6).toFixed(1),
                    })}
                  </option>
                ))}
              </Select>
            </Field>
          </Card>
        ) : null}
      </Section>

      {renditions ? (
        <Section
          title={t("setup.range")}
          action={
            summary && range ? (
              <label className="flex items-center gap-2.5 text-small text-muted">
                {t("setup.range.whole")}
                <Toggle
                  checked={whole}
                  label={t("setup.range.whole")}
                  onChange={(on) =>
                    on
                      ? setRange({ start: 0, end: summary.totalSeconds })
                      : // Narrowing from the whole broadcast needs somewhere to
                        // start; the middle half is a neutral first guess.
                        setRange({
                          start: summary.totalSeconds * 0.25,
                          end: summary.totalSeconds * 0.75,
                        })
                  }
                />
              </label>
            ) : undefined
          }
        >
          {!summary ? (
            <Card className="flex flex-col gap-4 p-5">
              <Skeleton className="h-2 w-full" />
              <Skeleton className="h-9 w-36" />
            </Card>
          ) : (
            <Card className="flex flex-col gap-5 p-5">
              {range ? (
                <RangePicker
                  total={summary.totalSeconds}
                  discontinuities={summary.discontinuitySeconds}
                  value={range}
                  onChange={setRange}
                />
              ) : null}
              {!summary.complete ? <Note kind="warn">{t("setup.warn.incomplete")}</Note> : null}
            </Card>
          )}
        </Section>
      ) : null}

      {plan ? (
        <Section title={t("setup.plan")}>
          <div className="flex flex-col gap-3">
            <Card className="flex flex-wrap items-end gap-x-10 gap-y-4 p-5">
              <Figure label={t("setup.plan.output")} value={timecode(plan.outputSeconds)} />
              <Figure label={t("setup.plan.size")} value={bytes(plan.estimatedBytes)} />
              <Figure
                label={t("setup.plan.segments", { count: plan.segmentCount })}
                value={`${plan.startIndex}–${plan.endIndex}`}
                quiet
              />
            </Card>
            {plan.downloadSeconds - plan.outputSeconds > 1 ? (
              <p className="text-small text-muted">
                {t("setup.plan.trim", {
                  extra: timecode(plan.downloadSeconds - plan.outputSeconds),
                })}
              </p>
            ) : null}
            {plan.crossesDiscontinuity ? (
              <Note kind="warn">{t("setup.warn.discontinuity")}</Note>
            ) : null}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

function Figure({ label, value, quiet }: { label: string; value: string; quiet?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-small font-medium text-muted">{label}</span>
      <span className={"font-mono " + (quiet ? "text-mid text-muted" : "text-title text-body")}>
        {value}
      </span>
    </div>
  );
}
