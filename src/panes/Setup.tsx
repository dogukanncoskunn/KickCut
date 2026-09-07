import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useLocale, useT } from "../i18n";
import { api } from "../lib/api";
import type { MuxMode, PlaylistSummary, RangePlan, Rendition } from "../lib/api";
import { cleanError } from "../lib/errors";
import { bytes, parseKickDate, shortDate, timecode } from "../lib/format";
import { useFfmpeg } from "../lib/Ffmpeg";
import { useSelection } from "../lib/Selection";
import {
  Badge,
  Button,
  Card,
  Columns,
  EmptyState,
  Field,
  Input,
  Note,
  Section,
  Select,
  Skeleton,
  Spinner,
  Toggle,
} from "../lib/ui";
import { RangePicker } from "./RangePicker";
import type { Range } from "./RangePicker";

/*
 * The output folder is remembered per machine. Someone downloading VODs is
 * almost always putting them in the same place, and re-picking it every time
 * is the kind of small friction that makes a tool annoying to live with.
 */
const FOLDER_KEY = "kickcut.outputDir";

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
  const [outputDir, setOutputDir] = useState(() => localStorage.getItem(FOLDER_KEY) ?? "");
  const [fileName, setFileName] = useState("");
  const [muxMode, setMuxMode] = useState<MuxMode>("copy");
  const [queued, setQueued] = useState(false);
  const ffmpeg = useFfmpeg();

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

  useEffect(() => {
    if (plan) setMuxMode(plan.crossesDiscontinuity ? "reencode" : "copy");
  }, [plan?.crossesDiscontinuity]);

  /*
   * A default name that is useful in a folder full of these: who streamed it
   * and when. The stream title is not used - they are long, emoji-heavy and
   * often identical from day to day, which is the opposite of what a file name
   * is for. The user can still type whatever they like.
   */
  useEffect(() => {
    if (!vod) return;
    const day = parseKickDate(vod.startedAt);
    const stamp = day ? day.toISOString().slice(0, 10) : "";
    setFileName([vod.channel, stamp].filter(Boolean).join(" "));
    setQueued(false);
  }, [vod]);

  async function chooseFolder() {
    const picked = await open({ directory: true, multiple: false, defaultPath: outputDir || undefined });
    if (typeof picked === "string") {
      localStorage.setItem(FOLDER_KEY, picked);
      setOutputDir(picked);
    }
  }

  async function addToQueue() {
    if (!vod || !plan || !quality) return;
    try {
      await api.enqueueJob({
        title: vod.title,
        channel: vod.channel,
        quality: quality.name,
        playlistUrl: quality.playlistUrl,
        startIndex: plan.startIndex,
        endIndex: plan.endIndex,
        trimOffset: plan.trimOffset,
        outputSeconds: plan.outputSeconds,
        crossesDiscontinuity: plan.crossesDiscontinuity,
        outputDir,
        fileName,
        muxMode,
        frameRate: quality.frameRate,
      });
      setQueued(true);
      setError(null);
    } catch (err) {
      setError(cleanError(err));
    }
  }

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
                {renditions.map((r, i) => (
                  <option key={r.name} value={r.name}>
                    {t("setup.quality.option", {
                      name: r.name,
                      bitrate: (r.bandwidth / 1e6).toFixed(1),
                    })}
                    {/*
                      Kick publishes no separate source rendition, so the top
                      rung is always the best available. It is only called the
                      source when its encoding shows it was passed through
                      rather than transcoded; otherwise it is just the highest.
                    */}
                    {i === 0 ? ` (${t(r.isSource ? "quality.source" : "quality.highest")})` : ""}
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

      {plan ? (
        <Section title={t("setup.mux")}>
          <Columns min="24rem">
            {(["copy", "reencode"] as const).map((mode) => (
              <ModeCard
                key={mode}
                active={muxMode === mode}
                suggested={plan.crossesDiscontinuity === (mode === "reencode")}
                title={t(`setup.mux.${mode}`)}
                hint={t(`setup.mux.${mode}.hint`)}
                suggestedLabel={t("setup.mux.suggested")}
                onPick={() => setMuxMode(mode)}
              />
            ))}
          </Columns>
        </Section>
      ) : null}

      {plan ? (
        <Section title={t("setup.output")}>
          <div className="flex flex-col gap-4">
            <Card className="flex flex-wrap items-end gap-4 p-5">
              <div className="flex min-w-[20rem] flex-1 flex-col gap-1.5">
                <span className="text-small font-medium text-muted">{t("setup.output.folder")}</span>
                <div className="flex gap-2">
                  <Input
                    value={outputDir}
                    readOnly
                    placeholder="…"
                    className="min-w-0 flex-1 font-mono"
                    title={outputDir}
                  />
                  <Button icon="folder" onClick={() => void chooseFolder()}>
                    {t("setup.output.choose")}
                  </Button>
                </div>
              </div>
              <div className="flex min-w-[16rem] flex-1 flex-col gap-1.5">
                <label htmlFor="file-name" className="text-small font-medium text-muted">
                  {t("setup.output.name")}
                </label>
                <Input
                  id="file-name"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  spellCheck={false}
                />
              </div>
            </Card>

            {/*
              ffmpeg has to exist before a job is queued, not after it finishes.
              Downloading for an hour and only then discovering there is nothing
              to mux with is the one failure this app must never produce.
            */}
            {!ffmpeg.ready && ffmpeg.status ? <Note kind="warn">{t("ffmpeg.blocked")}</Note> : null}

            <div className="flex items-center gap-4">
              <Button
                kind="primary"
                size="large"
                icon="download"
                disabled={!outputDir || !fileName.trim() || !ffmpeg.ready}
                onClick={() => void addToQueue()}
              >
                {t("setup.start")}
              </Button>
              {queued ? <span className="appear text-body text-kick">{t("setup.queued")}</span> : null}
            </div>
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

/*
 * A choice between two real costs - time against exactness - so both are
 * stated rather than hidden behind a label. The suggestion follows the plan:
 * a range that spans a break in the broadcast is the case where a stream copy
 * is most likely to disappoint.
 */
function ModeCard({
  active,
  suggested,
  title,
  hint,
  suggestedLabel,
  onPick,
}: {
  active: boolean;
  suggested: boolean;
  title: string;
  hint: string;
  suggestedLabel: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={
        "flex h-full flex-col gap-2 rounded-lg border p-4 text-left transition-colors " +
        (active
          ? "border-kick/60 bg-raised/70"
          : "border-line bg-surface/60 hover:border-muted/30")
      }
    >
      <span className="flex items-center gap-2">
        <span
          className={
            "size-3.5 shrink-0 rounded-full border-2 " +
            (active ? "border-kick bg-kick" : "border-muted")
          }
        />
        <span className="text-body font-medium text-body">{title}</span>
      </span>
      <span className="text-small text-muted">{hint}</span>
      {suggested ? (
        <span className="mt-auto pt-1">
          <Badge kind="ok">{suggestedLabel}</Badge>
        </span>
      ) : null}
    </button>
  );
}
