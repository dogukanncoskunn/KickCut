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
  EmptyState,
  Field,
  Input,
  Note,
  Section,
  Dropdown,
  Skeleton,
  Spinner,
  Toggle,
} from "../lib/ui";
import { useQueue } from "../lib/Queue";
import { SpeedControl } from "../lib/SpeedControl";
import { isActive, JobCard } from "./JobCard";
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
    api
      .playlistSummary(playlistUrl)
      .then((s) => {
        if (!live) return;
        setSummary(s);
        /*
         * Only when there is nothing to keep.
         *
         * Every rendition of a broadcast is the same recording at a different
         * bitrate, so the timeline a user has already picked out is still
         * exactly as valid after switching quality. Resetting it - which is
         * what this used to do, along with blanking the summary and making the
         * picker vanish and reappear - threw away a range someone may have
         * spent a minute getting right, for no reason at all.
         */
        setRange((current) => current ?? { start: 0, end: s.totalSeconds });
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

  // No broadcast picked yet still leaves the downloads box on screen: it is
  // part of this tab, not part of the form, and a running job has to stay
  // reachable whether or not the next one has been set up.
  if (!vod) {
    return (
      <div className="flex flex-col gap-5">
        <EmptyState icon="scissors">{t("empty.setup")}</EmptyState>
        <RunningDownloads />
        <SpeedLimitBox />
      </div>
    );
  }

  const whole = summary !== null && range !== null && range.start === 0 && range.end === summary.totalSeconds;

  return (
    <div className="flex flex-col gap-5">
      {/*
        The broadcast is context, not a decision, so it gets one slim strip
        rather than a section of its own - the height it used to take was height
        the choices below had to scroll for.
      */}
      <Card className="flex items-center gap-4 p-4">
        {vod.thumbnail ? (
          <img src={vod.thumbnail} alt="" className="h-[4.5rem] w-32 shrink-0 rounded object-cover" />
        ) : null}
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="truncate text-mid font-semibold text-body" title={vod.title}>
            {vod.title}
          </h3>
          <p className="truncate font-mono text-small text-muted">
            {vod.channel} · {shortDate(vod.startedAt, locale)} · {t("setup.length")}{" "}
            {timecode((summary?.totalSeconds ?? vod.durationMs / 1000) || 0)}
          </p>
        </div>
      </Card>

      {error ? <Note kind="error">{error}</Note> : null}

      {/*
        Two columns instead of one long stack.

        Everything here used to be full width and stacked, so a screen with room
        to spare on both sides still needed scrolling to reach the download
        button. The timeline is the one control that genuinely wants width, so
        it keeps the wide column; the choices that are just a list of options
        read perfectly well in a narrow one beside it.
      */}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(22rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
      <Section title={t("setup.quality")}>
        {!renditions && !error ? (
          <Card className="flex items-center gap-3 p-4">
            <Spinner className="size-4 text-muted" />
            <span className="text-small text-muted">{t("setup.quality.loading")}</span>
          </Card>
        ) : null}
        {renditions ? (
          <Card className="p-4">
            <Field label={t("setup.quality")}>
              <Dropdown
                value={qualityName}
                onChange={setQualityName}
                className="w-full"
                ariaLabel={t("setup.quality")}
                options={renditions.map((r, i) => ({
                  value: r.name,
                  label:
                    t("setup.quality.option", {
                      name: r.name,
                      bitrate: (r.bandwidth / 1e6).toFixed(1),
                    }) +
                    /*
                      Kick publishes no separate source rendition, so the top
                      rung is always the best available. It is only called the
                      source when its encoding shows it was passed through
                      rather than transcoded; otherwise it is just the highest.
                    */
                    (i === 0 ? ` (${t(r.isSource ? "quality.source" : "quality.highest")})` : ""),
                }))}
              />
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

      <RunningDownloads />
      <SpeedLimitBox />
        </div>

        {/* What the choices on the left add up to, and the button that acts. */}
        <div className="flex min-w-0 flex-col gap-5">
          {plan ? (
            <Section title={t("setup.plan")}>
              <div className="flex flex-col gap-3">
                <Card className="flex flex-wrap items-end gap-x-8 gap-y-4 p-4">
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
              {/* Stacked, not side by side: the column is narrow, and these are
                  two paragraphs to read rather than two things to compare. */}
              <div className="flex flex-col gap-3">
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
              </div>
            </Section>
          ) : null}

          {/*
            The save block is anchored to the foot of the rail.

            The left column is the taller of the two - it carries the range, the
            queue and the speed cap - so this one used to stop short and leave
            the button floating in the middle of an empty half-column while the
            left side ran on past it. Pushing this block down puts the action on
            the same baseline as the last box opposite, and the slack collects
            in one deliberate gap instead of a ragged edge.
          */}
          {plan ? (
            <Section title={t("setup.output")} className="mt-auto">
              <div className="flex flex-col gap-3">
                <Card className="flex flex-col gap-3 p-4">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-small font-medium text-muted">
                      {t("setup.output.folder")}
                    </span>
                    <div className="flex gap-2">
                      <Input
                        value={outputDir}
                        readOnly
                        placeholder="…"
                        className="min-w-0 flex-1 font-mono text-small"
                        title={outputDir}
                      />
                      <Button icon="folder" onClick={() => void chooseFolder()}>
                        {t("setup.output.choose")}
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
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
                  ffmpeg has to exist before a job is queued, not after it
                  finishes. Downloading for an hour and only then discovering
                  there is nothing to mux with is the one failure this app must
                  never produce.
                */}
                {!ffmpeg.ready && ffmpeg.status ? (
                  <Note kind="warn">{t("ffmpeg.blocked")}</Note>
                ) : null}

                <div className="flex items-center gap-3">
                  <Button
                    kind="primary"
                    size="large"
                    icon="download"
                    disabled={!outputDir || !fileName.trim() || !ffmpeg.ready}
                    onClick={() => void addToQueue()}
                    className="flex-1"
                  >
                    {t("setup.start")}
                  </Button>
                </div>
                {queued ? (
                  <span className="appear text-body text-kick-text">{t("setup.queued")}</span>
                ) : null}
              </div>
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/*
 * The running downloads, with a permanent place on this screen.
 *
 * This is where a download is started, so this is where it should appear -
 * under its own heading, in a box that is part of the layout rather than a
 * panel that materialises over the form the moment a job begins and shoves the
 * page around. The box is here before there is anything in it and stays after
 * the last job leaves, so the screen does not change shape while it is used.
 *
 * The floating panel still exists, but only once you have gone somewhere else:
 * on this screen it would be a second copy of what is already on the page.
 */
function RunningDownloads() {
  const t = useT();
  const { jobs, pause, resume } = useQueue();
  const running = jobs.filter(isActive);

  return (
    <Section title={t("setup.queue")}>
      {running.length === 0 ? (
        <EmptyState icon="download">{t("empty.queue")}</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {running.map((job) => (
            <JobCard key={job.id} job={job} onPause={pause} onResume={resume} />
          ))}
        </div>
      )}
    </Section>
  );
}

/*
 * The speed cap, within reach of the download it applies to.
 *
 * It lives in Settings too, and both are the same control over the same value -
 * one context, pushed straight to Rust - so neither can show a cap the other
 * disagrees with. The reason for the second copy is when it gets used: the
 * moment somebody notices a download eating the connection is the moment they
 * are watching it here, and Settings is two tabs away from that.
 */
function SpeedLimitBox() {
  const t = useT();
  return (
    <Section title={t("speed.label")} hint={t("speed.hint")}>
      <Card className="p-5">
        <SpeedControl />
      </Card>
    </Section>
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
