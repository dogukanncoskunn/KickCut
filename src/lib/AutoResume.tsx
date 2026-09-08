import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { api } from "./api";
import { Toggle } from "./ui";

/*
 * Whether a download that came up short puts itself back in the queue.
 *
 * On by default. Leaving a multi-hour download running unattended is the normal
 * way to use this, and a transient failure two hours in should not mean coming
 * back to find it stopped - especially now that a retry re-fetches only the
 * segments that are actually missing.
 */
const STORAGE_KEY = "kickcut.autoResume";

export function AutoResumeControl() {
  const t = useT();
  const [on, setOn] = useState(() => localStorage.getItem(STORAGE_KEY) !== "0");

  // Pushed on mount too: Rust starts with its own default, and a preference
  // set yesterday has to reach it before anything is queued today.
  useEffect(() => {
    void api.setAutoResume(on).catch(() => {});
  }, [on]);

  return (
    <div className="flex items-center gap-2.5">
      <Toggle
        checked={on}
        label={t("queue.autoResume")}
        onChange={(next) => {
          localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
          setOn(next);
        }}
      />
      <span className="text-body">{on ? t("settings.motion.on") : t("settings.motion.off")}</span>
    </div>
  );
}
