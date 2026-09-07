import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { DEFAULT_KB, useSpeedLimit } from "./Speed";
import { Input, Toggle } from "./ui";

/*
 * One implementation, used in Settings and in the download rail, so the two can
 * never drift into disagreeing about what the current cap is.
 *
 * The number is held as text while it is being typed: parsing every keystroke
 * would turn a half-typed "80" into a 80 KB/s cap on the way to 8000, and the
 * download would visibly stall as the user typed.
 */
export function SpeedControl({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const { enabled, setEnabled, kbPerSecond, setKbPerSecond } = useSpeedLimit();
  const [text, setText] = useState(() => String(kbPerSecond));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(String(kbPerSecond));
  }, [kbPerSecond, editing]);

  function commit() {
    setEditing(false);
    const parsed = Number(text.replace(/\s/g, ""));
    if (Number.isFinite(parsed) && parsed >= 0) setKbPerSecond(parsed);
    else setText(String(kbPerSecond));
  }

  return (
    <div className={compact ? "flex items-center gap-2.5" : "flex flex-col gap-3"}>
      <div className="flex items-center gap-2.5">
        <Toggle
          checked={enabled}
          label={t("speed.label")}
          onChange={(on) => {
            setEnabled(on);
            // Turning it on with nothing set would be a limit of zero, which
            // reads as unlimited - so it starts somewhere visible instead.
            if (on && kbPerSecond === 0) setKbPerSecond(DEFAULT_KB);
          }}
        />
        {!compact ? (
          <span className="text-body">{enabled ? t("speed.on") : t("speed.off")}</span>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={text}
          inputMode="numeric"
          disabled={!enabled}
          aria-label={t("speed.field")}
          onFocus={() => setEditing(true)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className={compact ? "h-7 w-24 font-mono text-small" : "w-32 font-mono"}
        />
        <span className={"shrink-0 text-muted " + (compact ? "text-small" : "text-body")}>KB/s</span>
      </div>

      {!compact ? (
        <p className="text-small text-muted">
          {enabled && kbPerSecond > 0
            ? t("speed.example", { mb: (kbPerSecond / 1000).toFixed(kbPerSecond % 1000 ? 1 : 0) })
            : t("speed.unlimited.hint")}
        </p>
      ) : null}
    </div>
  );
}
