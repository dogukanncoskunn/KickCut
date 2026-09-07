import { useT } from "../i18n";
import { openPath } from "@tauri-apps/plugin-opener";
import type { JobProgress, JobState } from "../lib/api";
import { bytes, timecode } from "../lib/format";
import { useQueue } from "../lib/Queue";
import { Badge, Button, Card, EmptyState, Note, ProgressBar } from "../lib/ui";

/* A job's state decides its accent, so the queue is scannable at a glance. */
const TONE: Record<JobState, "ok" | "warn" | "error" | "neutral"> = {
  queued: "neutral",
  downloading: "ok",
  paused: "neutral",
  downloaded: "ok",
  failed: "error",
};

export function Queue() {
  const t = useT();
  const { jobs, error, pause, resume, cancel } = useQueue();

  if (jobs.length === 0 && !error) {
    return <EmptyState icon="queue">{t("empty.queue")}</EmptyState>;
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <Note kind="error">{error}</Note> : null}
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} onPause={pause} onResume={resume} onCancel={cancel} />
      ))}
    </div>
  );
}

function JobCard({
  job,
  onPause,
  onResume,
  onCancel,
}: {
  job: JobProgress;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const t = useT();
  const running = job.state === "downloading";
  const fraction = job.segmentsTotal > 0 ? job.segmentsDone / job.segmentsTotal : 0;

  return (
    <Card kind={running ? "primary" : "normal"} className="appear flex flex-col gap-3.5 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="truncate text-body font-medium text-body" title={job.title}>
            {job.fileName}
          </h3>
          <p className="truncate font-mono text-small text-muted">
            {job.channel} · {job.quality} · {timecode(job.outputSeconds)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {running ? <span className="dot-running size-2 rounded-full bg-kick" /> : null}
          <Badge kind={TONE[job.state]}>{t(`queue.state.${job.state}`)}</Badge>
        </div>
      </div>

      {job.state !== "failed" ? (
        <div className="flex flex-col gap-2">
          <ProgressBar value={fraction} kind={job.state === "paused" ? "warn" : "ok"} />
          <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 font-mono text-small text-muted">
            <span>
              {t("queue.progress", { done: job.segmentsDone, total: job.segmentsTotal })}
              {job.bytesDone > 0 ? ` · ${bytes(job.bytesDone)}` : ""}
            </span>
            {running ? (
              <span>
                {job.bytesPerSecond > 0
                  ? t("queue.speed", { speed: bytes(job.bytesPerSecond) })
                  : ""}
                {job.etaSeconds !== null
                  ? ` · ${t("queue.eta", { time: timecode(job.etaSeconds) })}`
                  : ""}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {job.error ? <Note kind="error">{job.error}</Note> : null}

      <div className="flex flex-wrap gap-2">
        {running ? (
          <Button size="small" icon="pause" onClick={() => onPause(job.id)}>
            {t("queue.pause")}
          </Button>
        ) : null}
        {job.state === "paused" || job.state === "failed" ? (
          <Button kind="primary" size="small" icon="play" onClick={() => onResume(job.id)}>
            {t("queue.resume")}
          </Button>
        ) : null}
        {job.state === "queued" ? (
          <Button size="small" icon="pause" onClick={() => onPause(job.id)}>
            {t("queue.pause")}
          </Button>
        ) : null}
        <Button size="small" icon="folder" onClick={() => void openPath(job.outputDir)}>
          {t("queue.open")}
        </Button>
        <Button
          kind="danger"
          size="small"
          icon="close"
          // Removing throws away real work - possibly hours of it - so it asks
          // first. Every other action here is reversible; this one is not.
          onClick={() => {
            if (window.confirm(t("queue.remove.confirm"))) onCancel(job.id);
          }}
        >
          {t("queue.remove")}
        </Button>
      </div>
    </Card>
  );
}
