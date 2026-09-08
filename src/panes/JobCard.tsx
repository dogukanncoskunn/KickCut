import { useT } from "../i18n";
import { api } from "../lib/api";
import type { JobProgress, JobState } from "../lib/api";
import { bytes, timecode } from "../lib/format";
import { Badge, Button, Card, Icon, Note, ProgressBar } from "../lib/ui";

/* A job's state decides its accent, so a list is scannable at a glance. */
const TONE: Record<JobState, "ok" | "warn" | "error" | "neutral"> = {
  queued: "neutral",
  downloading: "ok",
  paused: "neutral",
  muxing: "ok",
  done: "ok",
  failed: "error",
};

export function isActive(job: JobProgress): boolean {
  return job.state !== "done" && job.state !== "failed";
}

/*
 * One card, three places: the rail beside the download form, the floating
 * panel that follows you to other tabs, and the Downloads list. `compact`
 * drops the parts that do not fit in the floating panel; everything else is
 * driven by the job's own state, so the three can never disagree about what a
 * job is doing.
 */
export function JobCard({
  job,
  onPause,
  onResume,
  onRemove,
  onForget,
  compact = false,
}: {
  job: JobProgress;
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onRemove?: (id: string) => void;
  /** Drops the record and leaves the file alone. */
  onForget?: (id: string) => void;
  compact?: boolean;
}) {
  const t = useT();
  const running = job.state === "downloading";
  const muxing = job.state === "muxing";
  const fraction = muxing
    ? job.muxFraction
    : job.segmentsTotal > 0
      ? job.segmentsDone / job.segmentsTotal
      : 0;

  // The finished file when there is one, otherwise the folder it is headed for.
  const revealTarget = job.outputPath ?? job.outputDir;

  return (
    <Card
      kind={running || muxing ? "primary" : "normal"}
      className={"appear flex flex-col gap-3 " + (compact ? "p-3.5" : "p-5")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="truncate text-body font-medium text-body" title={job.fileName}>
            {job.fileName}
          </h3>
          <p className="truncate font-mono text-small text-muted">
            {job.channel} · {job.quality} · {timecode(job.outputSeconds)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {running || muxing ? <span className="dot-running size-2 rounded-full bg-kick" /> : null}
          <Badge kind={TONE[job.state]}>{t(`queue.state.${job.state}`)}</Badge>
        </div>
      </div>

      {isActive(job) ? (
        <div className="flex flex-col gap-2">
          <ProgressBar value={fraction} kind={job.state === "paused" ? "warn" : "ok"} />
          <div className="flex flex-wrap justify-between gap-x-5 gap-y-1 font-mono text-small text-muted">
            <span>
              {muxing
                ? t("queue.muxing")
                : t("queue.progress", { done: job.segmentsDone, total: job.segmentsTotal })}
              {!muxing && job.bytesDone > 0 ? ` · ${bytes(job.bytesDone)}` : ""}
            </span>
            {running ? (
              <span>
                {job.bytesPerSecond > 0 ? t("queue.speed", { speed: bytes(job.bytesPerSecond) }) : ""}
                {job.etaSeconds !== null
                  ? ` · ${t("queue.eta", { time: timecode(job.etaSeconds) })}`
                  : ""}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {job.error && !compact ? <Note kind="error">{job.error}</Note> : null}

      {/*
        Which minutes are missing, not which segment numbers. An index means
        nothing to someone deciding whether the gap matters.
      */}
      {job.failedSegments.length > 0 && !compact ? (
        <Note kind="warn">
          <p className="font-medium">
            {t("downloads.missing.title", { count: job.failedSegments.length })}
          </p>
          <ul className="mt-1.5 flex flex-col gap-0.5 font-mono text-small">
            {job.failedSegments.slice(0, 8).map((seg) => (
              <li key={seg.index}>
                {t("downloads.missing.row", {
                  index: seg.index,
                  from: timecode(seg.startSeconds),
                  to: timecode(seg.endSeconds),
                })}
              </li>
            ))}
            {job.failedSegments.length > 8 ? <li>…</li> : null}
          </ul>
          <p className="mt-1.5 text-small opacity-90">{t("downloads.missing.hint")}</p>
        </Note>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {running || job.state === "queued" ? (
          <Button size="small" icon="pause" onClick={() => onPause?.(job.id)}>
            {t("queue.pause")}
          </Button>
        ) : null}
        {job.state === "paused" || job.state === "failed" ? (
          <Button kind="primary" size="small" icon="play" onClick={() => onResume?.(job.id)}>
            {t("queue.resume")}
          </Button>
        ) : null}

        {/*
          One button, not two. There were separate "show file" and "open folder"
          actions; both went through a plugin permission that needs a path scope
          the app never granted, so both silently did nothing.
        */}
        <Button
          kind={job.state === "done" ? "primary" : "quiet"}
          size="small"
          icon="folder"
          onClick={() => void api.reveal(revealTarget).catch(() => {})}
        >
          {t("queue.reveal")}
        </Button>

        {onRemove ? (
          <Button kind="danger" size="small" icon="close" onClick={() => onRemove(job.id)}>
            {t("queue.remove")}
          </Button>
        ) : null}

        {/*
          Icon only, and last. It is the harmless one of the two - the row goes
          away, the recording stays - so it should not compete for attention
          with the button that deletes a file.
        */}
        {onForget ? (
          <button
            type="button"
            onClick={() => onForget(job.id)}
            title={t("downloads.forget")}
            aria-label={t("downloads.forget")}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-rose/10 hover:text-rose-text"
          >
            <Icon name="trash" className="size-4" />
          </button>
        ) : null}
      </div>
    </Card>
  );
}
