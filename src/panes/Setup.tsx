import { useEffect, useState } from "react";
import { useLocale, useT } from "../i18n";
import { api } from "../lib/api";
import type { Rendition } from "../lib/api";
import { cleanError } from "../lib/errors";
import { shortDate, timecode } from "../lib/format";
import { useSelection } from "../lib/Selection";
import { Card, EmptyState, Field, Note, Section, Select, Skeleton } from "../lib/ui";

export function Setup() {
  const t = useT();
  const { locale } = useLocale();
  const { vod } = useSelection();

  const [renditions, setRenditions] = useState<Rendition[] | null>(null);
  const [quality, setQuality] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const masterUrl = vod?.masterUrl ?? null;

  useEffect(() => {
    if (!masterUrl) {
      setRenditions(null);
      return;
    }
    // A late answer for a VOD the user has already moved away from must not
    // overwrite the current one.
    let live = true;
    setRenditions(null);
    setError(null);
    api
      .renditions(masterUrl)
      .then((list) => {
        if (!live) return;
        setRenditions(list);
        setQuality(list[0]?.name ?? "");
      })
      .catch((err) => live && setError(cleanError(err)));
    return () => {
      live = false;
    };
  }, [masterUrl]);

  if (!vod) return <EmptyState icon="scissors">{t("empty.setup")}</EmptyState>;

  return (
    <div className="flex flex-col gap-8">
      <Section title={t("setup.vod")}>
        <Card className="flex gap-4 p-4">
          {vod.thumbnail ? (
            <img src={vod.thumbnail} alt="" className="h-20 w-36 shrink-0 rounded object-cover" />
          ) : null}
          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="truncate text-title font-semibold text-body" title={vod.title}>
              {vod.title}
            </h3>
            <p className="font-mono text-small text-muted">
              {vod.channel} · {shortDate(vod.startedAt, locale)} · {t("setup.length")}{" "}
              {timecode(vod.durationMs / 1000)}
            </p>
          </div>
        </Card>
      </Section>

      <Section title={t("setup.quality")}>
        {error ? <Note kind="error">{error}</Note> : null}
        {!error && !renditions ? (
          <Card className="flex items-center gap-3 p-4">
            <Skeleton className="h-9 w-64" />
            <span className="text-small text-muted">{t("setup.quality.loading")}</span>
          </Card>
        ) : null}
        {renditions ? (
          <Card className="max-w-md p-4">
            <Field label={t("setup.quality")}>
              <Select value={quality} onChange={(e) => setQuality(e.target.value)}>
                {renditions.map((r) => (
                  <option key={r.name} value={r.name}>
                    {t("setup.quality.option", {
                      name: r.name,
                      bitrate: (r.bandwidth / 1e6).toFixed(1),
                    })}
                  </option>
                ))}
              </Select>
            </Field>
          </Card>
        ) : null}
      </Section>
    </div>
  );
}
