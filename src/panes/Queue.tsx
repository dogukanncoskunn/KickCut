import { useT } from "../i18n";
import { useQueue } from "../lib/Queue";
import { EmptyState, Note } from "../lib/ui";
import { isActive, JobCard } from "./JobCard";

/*
 * Work in progress only. Anything finished or given up on moves to the
 * Downloads tab, so this list stays short enough to read at a glance during a
 * long download instead of growing with every job ever run.
 */
export function Queue() {
  const t = useT();
  const { jobs, error, pause, resume, cancel } = useQueue();
  const active = jobs.filter(isActive);

  if (active.length === 0 && !error) {
    return <EmptyState icon="queue">{t("empty.queue")}</EmptyState>;
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <Note kind="error">{error}</Note> : null}
      {active.map((job) => (
        <JobCard
          key={job.id}
          job={job}
          onPause={pause}
          onResume={resume}
          // Removing here throws away real work - possibly hours of it - so it
          // asks first. In the Downloads list the same button only forgets a
          // record, and says so.
          onRemove={(id) => {
            if (window.confirm(t("queue.remove.confirm"))) cancel(id, true);
          }}
        />
      ))}
    </div>
  );
}
