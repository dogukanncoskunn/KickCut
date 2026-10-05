import { useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useLocale, useT } from "../i18n";
import { useQueue } from "../lib/Queue";
import { useUndo } from "../lib/Undo";
import { Button, Checkbox, EmptyState, Note } from "../lib/ui";
import { isActive, JobCard } from "./JobCard";

/*
 * The history: everything that finished, and everything that gave up.
 *
 * Failures belong here rather than cluttering the queue, because once the
 * automatic retries are spent there is nothing happening any more - the card is
 * a record, and the thing worth reading on it is which minutes of the broadcast
 * never arrived.
 *
 * Two different removals, and the difference is the file on disk - which is
 * also what decides how each one behaves. Taking a row out of the list changes
 * nothing anyone can lose, so it happens on one click and can be taken back
 * for five seconds. Deleting the video is final, so it asks first. That split
 * holds for the single-row buttons and for the bulk ones alike; it is the only
 * rule on this screen.
 *
 * The question has to come from the dialog plugin, not `window.confirm`. The
 * webview swallows the built-in one - no dialog appears and it answers as if
 * the user had cancelled - so the prompt was simply never reaching the screen.
 */
export function Downloads() {
  const t = useT();
  const { locale } = useLocale();
  const { jobs, error, resume, cancel } = useQueue();
  const { isPending, schedule } = useUndo();
  const [selected, setSelected] = useState<string[]>([]);

  const history = jobs
    .filter((job) => !isActive(job) && !isPending(job.id))
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

  // Anything that has left the list has left the selection with it.
  const marked = selected.filter((id) => history.some((job) => job.id === id));
  const allMarked = marked.length === history.length && history.length > 0;

  /** Take rows out of the list, keeping every video exactly where it is. */
  function forget(ids: string[]) {
    setSelected((current) => current.filter((id) => !ids.includes(id)));
    schedule(t("undo.removed", { count: ids.length }), ids, () => {
      for (const id of ids) void cancel(id, false);
    });
  }

  /** Delete the videos themselves. Final, so it asks and names the count. */
  function deleteFiles(ids: string[]) {
    void confirm(t("downloads.bulk.delete.confirm", { count: ids.length }), {
      title: t("downloads.delete"),
      kind: "warning",
      okLabel: t("downloads.bulk.delete.ok", { count: ids.length }),
      cancelLabel: t("action.cancel"),
    }).then((yes) => {
      if (!yes) return;
      setSelected((current) => current.filter((id) => !ids.includes(id)));
      for (const id of ids) void cancel(id, true);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <Note kind="error">{error}</Note> : null}

      {/*
        One row that is always there, so the tick boxes have a heading and the
        bulk actions have somewhere to appear without the list jumping when
        they do. The two buttons only exist once something is marked, because
        until then they have nothing to act on.
      */}
      <div className="flex min-h-9 flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2.5 text-small text-muted">
          <Checkbox
            checked={allMarked}
            onChange={(on) => setSelected(on ? history.map((job) => job.id) : [])}
            label={t("downloads.selectAll")}
          />
          {marked.length > 0 ? t("downloads.selected", { count: marked.length }) : t("downloads.selectAll")}
        </label>

        {marked.length > 0 ? (
          <div className="flex items-center gap-2">
            <Button kind="quiet" size="small" icon="trash" onClick={() => forget(marked)}>
              {t("downloads.forget")}
            </Button>
            <Button kind="danger" size="small" icon="close" onClick={() => deleteFiles(marked)}>
              {t("downloads.bulk.delete")}
            </Button>
          </div>
        ) : null}
      </div>

      {history.map((job) => (
        <div key={job.id} className="flex items-start gap-3">
          {/* Level with the file name on the card, not with the card's edge. */}
          <span className="mt-5 shrink-0">
            <Checkbox
              checked={marked.includes(job.id)}
              onChange={(on) =>
                setSelected((current) =>
                  on ? [...current, job.id] : current.filter((id) => id !== job.id),
                )
              }
              label={t("downloads.select")}
            />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
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
              onForget={(id) => forget([id])}
            />
            <span className="px-1 font-mono text-mini text-muted">
              {t("downloads.completed", { when: when(job.createdAt) })}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
