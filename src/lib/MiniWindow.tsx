import { getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../i18n";
import { isActive, JobCard } from "../panes/JobCard";
import { api } from "./api";
import { useConfirmedCancel, useQueue } from "./Queue";
import { EmptyState, Icon } from "./ui";

/*
 * Everything the second window renders.
 *
 * It is the same `JobCard` the rest of the app uses, so a download cannot
 * describe itself one way here and another way on the download screen. What is
 * different is the frame: the window has no title bar of its own, so the strip
 * across the top is the title bar - it is what the pointer grabs to move the
 * window, and it carries the only control the frame would have given us.
 *
 * It stays up when the queue empties rather than closing itself. A window that
 * vanishes while you are looking at it is worse than one showing a line of
 * text saying there is nothing to show.
 */
export function MiniWindow() {
  const t = useT();
  const { jobs, pause, resume } = useQueue();
  const cancel = useConfirmedCancel();
  const job = jobs.find(isActive);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface">
      <div
        /*
         * The window has no frame, so this strip is the frame.
         * `startDragging` hands the move to the window manager, which is what
         * makes it feel like a real window rather than a div chasing the
         * pointer - but it takes the pointer with it, so a press that started
         * on the close button never becomes a click. The button sits in this
         * strip because that is where a title bar's controls belong; the guard
         * is what lets it keep working there.
         */
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest("button")) return;
          void getCurrentWindow().startDragging();
        }}
        className="flex shrink-0 cursor-grab touch-none select-none items-center justify-between gap-2 border-b border-line bg-raised px-3 py-1.5 active:cursor-grabbing"
      >
        <span className="flex items-center gap-2 text-small font-medium text-muted">
          {job ? <span className="dot-running size-1.5 rounded-full bg-kick" /> : null}
          {t("queue.floating")}
        </span>
        <button
          type="button"
          onClick={() => void api.closeMini()}
          title={t("queue.attach")}
          aria-label={t("queue.attach")}
          className="grid size-5 place-items-center rounded text-muted transition-colors hover:bg-surface hover:text-body"
        >
          <Icon name="close" className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden p-2">
        {job ? (
          <JobCard job={job} onPause={pause} onResume={resume} onCancel={cancel} compact />
        ) : (
          <EmptyState icon="download">{t("empty.queue")}</EmptyState>
        )}
      </div>
    </div>
  );
}
