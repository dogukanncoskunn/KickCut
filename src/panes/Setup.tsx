import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useLocale, useT } from "../i18n";
import { api } from "../lib/api";
import type { NewJob, Vod } from "../lib/api";
import { cleanError } from "../lib/errors";
import { shortDate, timecode } from "../lib/format";
import { useSelection } from "../lib/Selection";
import { Button, Card, EmptyState, Icon, Note, Section } from "../lib/ui";
import { useConfirmedCancel, useQueue } from "../lib/Queue";
import { SpeedControl } from "../lib/SpeedControl";
import { isActive, JobCard } from "./JobCard";
import { VodSetup } from "./VodSetup";

/*
 * The output folder is remembered per machine. Someone downloading VODs is
 * almost always putting them in the same place, and re-picking it every time
 * is the kind of small friction that makes a tool annoying to live with. It is
 * also the one setting every selected broadcast shares, which is why it lives
 * up here rather than inside each panel.
 */
const FOLDER_KEY = "kickcut.outputDir";

/*
 * The download screen: a rail of the broadcasts picked in Library, and the
 * settings of whichever one is being looked at.
 *
 * Nothing here is applied to all of them. Choosing several is only a way of
 * carrying them over in one go - quality, range, file name and mux mode are
 * each broadcast's own decision, made in its own panel. The screen's job is to
 * hold the panels, keep their state alive while the user moves between them,
 * and do the queuing.
 */
export function Setup() {
  const t = useT();
  const { locale } = useLocale();
  const { vods, active, focus, remove } = useSelection();

  const [outputDir, setOutputDir] = useState(() => localStorage.getItem(FOLDER_KEY) ?? "");
  const [drafts, setDrafts] = useState<Record<string, NewJob | null>>({});
  const [queued, setQueued] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<{ kind: "error" | "warn"; text: string } | null>(null);

  /*
   * Every panel is built as soon as its broadcast is selected, and the ones
   * not being looked at are hidden rather than unmounted.
   *
   * Building them lazily was the first attempt and it was wrong: a panel that
   * has never been opened has no quality, no range and no plan, so "queue all"
   * could only ever queue the broadcasts you had happened to click on - which
   * is exactly the work selecting several was meant to save. Each one costs
   * two small requests to stream.kick.com, and Rust caches the playlists, so
   * the price of resolving them up front is a few text files.
   */

  // Whatever leaves the selection takes its draft and its mark with it.
  const picked = vods.map((v) => v.uuid).join();
  useEffect(() => {
    const live = new Set(picked ? picked.split(",") : []);
    const prune = <T,>(m: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(m).filter(([id]) => live.has(id)));
    setDrafts(prune);
    setQueued(prune);
  }, [picked]);

  // Stable, so a panel reporting an unchanged draft cannot loop this screen.
  const onDraft = useCallback((uuid: string, job: NewJob | null) => {
    setDrafts((current) => (current[uuid] === job ? current : { ...current, [uuid]: job }));
  }, []);

  async function chooseFolder() {
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: outputDir || undefined,
    });
    if (typeof picked === "string") {
      localStorage.setItem(FOLDER_KEY, picked);
      setOutputDir(picked);
    }
  }

  /*
   * One broadcast and all of them go through here, so the two can never queue
   * a job differently. They are sent in rail order, which is the order they
   * were listed in, and Rust runs them one after another.
   */
  async function addToQueue(ids: string[]) {
    const ready = ids.filter((id) => drafts[id]);
    const skipped = ids.length - ready.length;
    try {
      for (const id of ready) await api.enqueueJob(drafts[id]!);
      setQueued((current) => {
        const next = { ...current };
        for (const id of ready) next[id] = true;
        return next;
      });
      setNotice(
        skipped > 0 ? { kind: "warn", text: t("setup.queueAll.skipped", { count: skipped }) } : null,
      );
    } catch (err) {
      setNotice({ kind: "error", text: cleanError(err) });
    }
  }

  // No broadcast picked yet still leaves the downloads box on screen: it is
  // part of this tab, not part of the form, and a running job has to stay
  // reachable whether or not the next one has been set up.
  if (vods.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState icon="scissors">{t("empty.setup")}</EmptyState>
        <RunningDownloads />
        <SpeedLimitBox />
      </div>
    );
  }

  /*
   * Handed down to the panels rather than placed here, because the alignment
   * that puts each panel's save block level with the last box opposite only
   * holds when both ends sit in the same two-column grid. Only the panel on
   * show renders them, so there is one queue box however many are set up.
   */
  const screenBoxes = (
    <>
      <RunningDownloads />
      <SpeedLimitBox />
    </>
  );

  const panels = vods.map((v) => (
    <div key={v.uuid} style={v.uuid === active?.uuid ? undefined : { display: "none" }}>
      <VodSetup
        vod={v}
        visible={v.uuid === active?.uuid}
        outputDir={outputDir}
        onChooseFolder={() => void chooseFolder()}
        onDraft={onDraft}
        queued={queued[v.uuid] === true}
        onEnqueue={() => void addToQueue([v.uuid])}
        screenBoxes={screenBoxes}
      />
    </div>
  ));

  const readyCount = vods.filter((v) => drafts[v.uuid]).length;

  return (
    <div className="flex flex-col gap-4">
      {notice ? <Note kind={notice.kind}>{notice.text}</Note> : null}

      {vods.length > 1 ? (
        <div className="grid items-start gap-4 xl:grid-cols-[13rem_minmax(0,1fr)]">
          <Rail
            vods={vods}
            activeId={active?.uuid ?? null}
            locale={locale}
            state={(uuid) => (queued[uuid] ? "queued" : drafts[uuid] ? "ready" : "waiting")}
            onFocus={focus}
            onRemove={remove}
          />
          <div className="min-w-0">{panels}</div>
        </div>
      ) : (
        panels
      )}

      {vods.length > 1 ? (
        <Card className="flex flex-wrap items-center justify-between gap-4 p-3">
          <span className="text-small text-muted">
            {t("setup.queueAll.hint", { ready: readyCount, total: vods.length })}
          </span>
          <Button
            kind="primary"
            size="large"
            icon="download"
            disabled={readyCount === 0}
            onClick={() => void addToQueue(vods.map((v) => v.uuid))}
          >
            {t("setup.queueAll", { count: readyCount })}
          </Button>
        </Card>
      ) : null}
    </div>
  );
}

/*
 * The broadcasts carried over from Library, and which one is being set up.
 *
 * Deliberately terse: a date, a length and a mark. The title is the one thing
 * left out, because Kick stream titles are long and often identical from day
 * to day - in a narrow column they would wrap to three lines each and still
 * not tell the two apart. The date does.
 */
function Rail({
  vods,
  activeId,
  locale,
  state,
  onFocus,
  onRemove,
}: {
  vods: Vod[];
  activeId: string | null;
  locale: string;
  state: (uuid: string) => "queued" | "ready" | "waiting";
  onFocus: (uuid: string) => void;
  onRemove: (uuid: string) => void;
}) {
  const t = useT();
  return (
    <Section title={t("setup.rail", { count: vods.length })}>
      <Card className="flex flex-col gap-1 p-2">
        {vods.map((v) => {
          const on = v.uuid === activeId;
          const mark = state(v.uuid);
          return (
            <div
              key={v.uuid}
              className={
                "group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors " +
                (on ? "bg-raised" : "hover:bg-raised/60")
              }
            >
              <button
                type="button"
                onClick={() => onFocus(v.uuid)}
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
              >
                <span
                  className={
                    "truncate text-small " + (on ? "font-medium text-body" : "text-muted")
                  }
                >
                  {shortDate(v.startedAt, locale)}
                </span>
                <span className="font-mono text-mini text-muted/80">
                  {timecode(v.durationMs / 1000)}
                </span>
              </button>

              {mark === "queued" ? (
                <Icon name="check" className="size-3.5 shrink-0 text-kick-text" />
              ) : (
                <span
                  title={t(`setup.rail.${mark}`)}
                  className={
                    "size-1.5 shrink-0 rounded-full " + (mark === "ready" ? "bg-kick" : "bg-muted/50")
                  }
                />
              )}

              <button
                type="button"
                onClick={() => onRemove(v.uuid)}
                title={t("setup.rail.remove")}
                aria-label={t("setup.rail.remove")}
                className="grid size-5 shrink-0 place-items-center rounded text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-rose-text focus-visible:opacity-100"
              >
                <Icon name="close" className="size-3" />
              </button>
            </div>
          );
        })}
      </Card>
    </Section>
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
  const cancel = useConfirmedCancel();
  const running = jobs.filter(isActive);

  return (
    <Section title={t("setup.queue")}>
      {running.length === 0 ? (
        <EmptyState icon="download">{t("empty.queue")}</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {running.map((job) => (
            <JobCard key={job.id} job={job} onPause={pause} onResume={resume} onCancel={cancel} />
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
  /*
   * Anchored to the foot of its column, exactly as the save block is on the
   * other side. Which column is the taller one depends on the broadcast - a
   * range that crosses a break adds a warning to the right, a queue with two
   * jobs in it adds height to the left - so pushing only one of them down
   * aligns the pair for some VODs and not others. Measured at 997px against
   * 1004px on a 1915-segment VOD, where the right column was the longer one
   * and this box stopped short of it. Both ends float down; the shorter column
   * closes the gap, whichever it happens to be.
   */
  return (
    <Section title={t("speed.label")} hint={t("speed.hint")} className="mt-auto">
      <Card className="p-4">
        <SpeedControl />
      </Card>
    </Section>
  );
}
