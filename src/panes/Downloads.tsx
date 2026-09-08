import { confirm } from "@tauri-apps/plugin-dialog";
import { useLocale, useT } from "../i18n";
import { useQueue } from "../lib/Queue";
import { EmptyState, Note } from "../lib/ui";
import { isActive, JobCard } from "./JobCard";

/*
 * The history: everything that finished, and everything that gave up.
 *
 * Failures belong here rather than cluttering the queue, because once the
 * automatic retries are spent there is nothing happening any more - the card is
 * a record, and the thing worth reading on it is which minutes of the broadcast
 * never arrived.
 *
 * Two different removals, and the difference is the file on disk. The trash
 * icon forgets the record and leaves the MP4 alone; "remove" deletes the video
 * itself, so it asks first and says plainly what is about to happen.
 *
 * The question has to come from the dialog plugin, not `window.confirm`. The
 * webview swallows the built-in one - no dialog appears and it answers as if
 * the user had cancelled - so the prompt was simply never reaching the screen.
 */
export function Downloads() {
  const t = useT();
  const { locale } = useLocale();
  const { jobs, error, resume, cancel } = useQueue();

  const history = jobs
    .filter((job) => !isActive(job))
    .sort((a, b) => b.createdAt - a.createdAt);

  if (history.length === 0 && !error) {
    return <EmptyState icon="download">{t("empty.downloads")}</EmptyState>;
  }

  const when = (ms: number) =>
    new Date(ms).toLocaleString(locale, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div className="flex flex-col gap-4">
      {error ? <Note kind="error">{error}</Note> : null}
      {history.map((job) => (
        <div key={job.id} className="flex flex-col gap-1.5">
          <JobCard
            job={job}
            onResume={resume}
            onRemove={(id) => {
              void confirm(t("downloads.delete.confirm"), {
                title: t("downloads.delete"),
                kind: "warning",
                okLabel: t("downloads.delete.ok"),
                cancelLabel: t("action.cancel"),
              }).then((yes) => {
                if (yes) void cancel(id, true);
              });
            }}
            onForget={(id) => cancel(id, false)}
          />
          <span className="px-1 font-mono text-mini text-muted">
            {t("downloads.completed", { when: when(job.createdAt) })}
          </span>
        </div>
      ))}
    </div>
  );
}
