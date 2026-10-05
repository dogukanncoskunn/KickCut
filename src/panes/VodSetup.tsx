import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useT } from "../i18n";
import { api } from "../lib/api";
import type { MuxMode, NewJob, PlaylistSummary, RangePlan, Rendition, Vod } from "../lib/api";
import { cleanError } from "../lib/errors";
import { bytes, parseKickDate, shortDate, timecode } from "../lib/format";
import { useFfmpeg } from "../lib/Ffmpeg";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Note,
  Section,
  Dropdown,
  Skeleton,
  Spinner,
  Toggle,
} from "../lib/ui";
import { RangePicker } from "./RangePicker";
import type { Range } from "./RangePicker";

/*
 * One broadcast's settings: quality, range, name, mux mode.
 *
 * This used to be the whole download screen. It became a component of its own
 * when several broadcasts could be set up at once, because each of them needs
 * its own quality, its own timeline and its own file name - and the state that
 * holds those has to survive switching between them. The screen mounts one of
 * these per selected broadcast and hides the ones not being looked at, exactly
 * as the app shell does with its tabs, for exactly the same reason: unmounting
 * would throw away a range somebody spent a minute getting right.
 *
 * It computes a job but never queues one. The finished `NewJob` is reported
 * upwards and the screen above does the queuing, so that one broadcast and all
 * of them go through the same call - a separate "queue all" path would be a
 * second place for the arithmetic to be wrong.
 */
export function VodSetup({
  vod,
  visible,
  outputDir,
  onChooseFolder,
  onDraft,
  queued,
  onEnqueue,
  screenBoxes,
}: {
  vod: Vod;
  /** The screen-level boxes render only in the panel on show; see below. */
  visible: boolean;
  outputDir: string;
  onChooseFolder: () => void;
  /** Null while this broadcast is not ready to be queued. */
  onDraft: (uuid: string, job: NewJob | null) => void;
  queued: boolean;
  onEnqueue: () => void;
  screenBoxes: React.ReactNode;
}) {
  const t = useT();
  const { locale } = useLocale();

  const [renditions, setRenditions] = useState<Rendition[] | null>(null);
  const [qualityName, setQualityName] = useState("");
  const [summary, setSummary] = useState<PlaylistSummary | null>(null);
  const [range, setRange] = useState<Range | null>(null);
  const [plan, setPlan] = useState<RangePlan | null>(null);
  /*
   * True from the moment the range changes until Rust has answered with the
   * segments it means.
   *
   * Without it the download button acts on the plan from before the change.
   * The time fields commit on blur, and clicking the button is what blurs
   * them, so typing an end time and going straight for the button queued the
   * range you had typed over. That is the worst kind of bug this app can
   * have - it is not a wrong number on screen, it is silently downloading
   * hours of the wrong video, which on a metered connection is somebody's
   * data. Measured here on 2026-10-05: a one-minute clip was asked for and a
   * five-hour broadcast started, 1.8 GB of it before it was stopped.
   */
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState(() => defaultName(vod));
  const [muxMode, setMuxMode] = useState<MuxMode>("copy");
  const ffmpeg = useFfmpeg();

  const masterUrl = vod.masterUrl;
  const quality = useMemo(
    () => renditions?.find((r) => r.name === qualityName) ?? null,
    [renditions, qualityName],
  );

  /* Qualities, once per broadcast. */
  useEffect(() => {
    let live = true;
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
    setStale(true);
    window.clearTimeout(planTimer.current);
    planTimer.current = window.setTimeout(() => {
      api
        .planRange(playlistUrl, range.start, range.end, quality.bandwidth)
        .then((next) => {
          setPlan(next);
          setStale(false);
        })
        .catch((err) => {
          setError(cleanError(err));
          // Cleared either way, or a failed plan locks the button for good.
          setStale(false);
        });
    }, 220);
    return () => window.clearTimeout(planTimer.current);
  }, [playlistUrl, range, quality]);

  useEffect(() => {
    if (plan) setMuxMode(plan.crossesDiscontinuity ? "reencode" : "copy");
  }, [plan?.crossesDiscontinuity]);

  /*
   * Memoised so its identity only changes when one of the choices does.
   * Rebuilding it every render would make the effect below fire every render,
   * and the screen above re-render on each one.
   */
  const draft = useMemo<NewJob | null>(() => {
    if (stale || !plan || !quality || !outputDir || !fileName.trim() || !ffmpeg.ready) return null;
    return {
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
    };
  }, [stale, plan, quality, outputDir, fileName, muxMode, ffmpeg.ready, vod]);

  useEffect(() => {
    onDraft(vod.uuid, draft);
  }, [draft, onDraft, vod.uuid]);

  const whole =
    summary !== null && range !== null && range.start === 0 && range.end === summary.totalSeconds;

  return (
    <div className="flex flex-col gap-4">
      {/*
        The broadcast is context, not a decision, so it gets one slim strip
        rather than a section of its own - the height it used to take was height
        the choices below had to scroll for.
      */}
      <Card className="flex items-center gap-4 p-3">
        {vod.thumbnail ? (
          <img src={vod.thumbnail} alt="" className="h-14 w-24 shrink-0 rounded object-cover" />
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
      {/*
        The columns stretch to the taller of the two. They used to be top
        aligned, which meant the right one was only as tall as its own content
        and the save block at its foot had no free space to be pushed into - so
        the rail stopped short and the button sat opposite the middle of the
        left column instead of level with the box that ends it.
      */}
      <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(22rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
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
                <Card className="flex flex-col gap-3 p-4">
                  <Skeleton className="h-2 w-full" />
                  <Skeleton className="h-9 w-36" />
                </Card>
              ) : (
                <Card className="flex flex-col gap-4 p-4">
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

          {/*
            The queue and the speed cap belong to the screen, not to this
            broadcast - but they have to sit inside this grid, because the
            alignment that puts the save block level with the last box on the
            left only works when both ends are in the same two columns. They
            are handed down from above and rendered only by the panel on show,
            so there is one of each however many broadcasts are set up.
          */}
          {visible ? screenBoxes : null}
        </div>

        {/* What the choices on the left add up to, and the button that acts. */}
        <div className="flex min-w-0 flex-col gap-4">
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
                      <Button icon="folder" onClick={onChooseFolder}>
                        {t("setup.output.choose")}
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor={`file-name-${vod.uuid}`}
                      className="text-small font-medium text-muted"
                    >
                      {t("setup.output.name")}
                    </label>
                    <Input
                      id={`file-name-${vod.uuid}`}
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
                    disabled={!draft}
                    onClick={onEnqueue}
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
 * A default name that is useful in a folder full of these: who streamed it
 * and when. The stream title is not used - they are long, emoji-heavy and
 * often identical from day to day, which is the opposite of what a file name
 * is for. The user can still type whatever they like.
 */
export function defaultName(vod: Vod): string {
  const day = parseKickDate(vod.startedAt);
  return [vod.channel, day ? day.toISOString().slice(0, 10) : ""].filter(Boolean).join(" ");
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
