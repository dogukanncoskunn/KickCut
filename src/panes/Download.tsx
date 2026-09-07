import { useT } from "../i18n";
import { SPEED_STEPS, useSpeedLimit } from "../lib/Speed";
import { Select } from "../lib/ui";
import { useQueue } from "../lib/Queue";
import { Setup } from "./Setup";
import { Queue } from "./Queue";

/*
 * Setting a download up and watching it run are one screen, not two.
 *
 * They were separate tabs, which meant queueing a job moved the thing you had
 * just started out of sight, and pausing it meant navigating back to a
 * different screen. Now the queue is a rail beside the form: the job you just
 * added appears next to the settings that produced it, with its pause button
 * already in reach.
 *
 * The rail only exists when there is something in it, so an empty queue costs
 * the form no width at all.
 */
export function Download() {
  const t = useT();
  const { jobs } = useQueue();

  return (
    <div className="flex flex-col items-start gap-8 lg:flex-row">
      <div className="min-w-0 flex-1">
        <Setup />
      </div>

      {jobs.length > 0 ? (
        <aside className="w-full shrink-0 lg:sticky lg:top-0 lg:w-[24rem]">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-mid font-semibold text-body">{t("queue.title")}</h2>
              <SpeedControl />
            </div>
            <Queue />
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function SpeedControl() {
  const t = useT();
  const { limit, setLimit } = useSpeedLimit();
  return (
    <label className="flex shrink-0 items-center gap-2 text-small text-muted">
      {t("speed.label")}
      <Select
        value={String(limit)}
        onChange={(e) => setLimit(Number(e.target.value))}
        className="h-7 w-28 text-small"
      >
        {SPEED_STEPS.map((step) => (
          <option key={step} value={step}>
            {step === 0 ? t("speed.unlimited") : `${step} MB/s`}
          </option>
        ))}
      </Select>
    </label>
  );
}
