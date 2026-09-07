import { useState } from "react";
import type { FormEvent } from "react";
import { useLocale, useT } from "../i18n";
import { api } from "../lib/api";
import type { Vod } from "../lib/api";
import { cleanError } from "../lib/errors";
import { compactCount, shortDate, timecode } from "../lib/format";
import { useSelection } from "../lib/Selection";
import { Badge, Button, Card, Columns, EmptyState, Field, Icon, Input, Note, Skeleton } from "../lib/ui";

/*
 * Two ways in, on purpose. The channel box covers the normal case and removes
 * the DevTools step the old script needed; the link box covers the case the
 * channel box cannot, because Kick's videos endpoint is not paginated and only
 * returns the most recent broadcasts.
 */
export function Library() {
  const t = useT();
  const { locale } = useLocale();
  const { vod: selected, select } = useSelection();

  const [channel, setChannel] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<null | "channel" | "link">(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ channel: string; vods: Vod[] } | null>(null);

  async function listChannel(e: FormEvent) {
    e.preventDefault();
    if (!channel.trim() || busy) return;
    setBusy("channel");
    setError(null);
    try {
      const vods = await api.channelVods(channel);
      setResults({ channel: vods[0]?.channel || channel.trim(), vods });
    } catch (err) {
      setError(cleanError(err));
      setResults(null);
    } finally {
      setBusy(null);
    }
  }

  async function openLink(e: FormEvent) {
    e.preventDefault();
    if (!link.trim() || busy) return;
    setBusy("link");
    setError(null);
    try {
      const one = await api.resolveVod(link);
      setResults({ channel: one.channel, vods: [one] });
      select(one);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-end gap-4">
        <form onSubmit={listChannel} className="flex min-w-[18rem] flex-1 items-end gap-2">
          <div className="flex-1">
            <Field label={t("library.channel.label")} hint={t("library.channel.hint")}>
              <Input
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                placeholder={t("library.channel.placeholder")}
                spellCheck={false}
                autoFocus
              />
            </Field>
          </div>
          <Button
            type="submit"
            kind="primary"
            icon="search"
            disabled={!channel.trim() || busy !== null}
            className="mb-6"
          >
            {busy === "channel" ? t("common.loading") : t("library.channel.submit")}
          </Button>
        </form>

        <form onSubmit={openLink} className="flex min-w-[18rem] flex-1 items-end gap-2">
          <div className="flex-1">
            <Field label={t("library.link.label")}>
              <Input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder={t("library.link.placeholder")}
                spellCheck={false}
              />
            </Field>
          </div>
          <Button type="submit" disabled={!link.trim() || busy !== null}>
            {busy === "link" ? t("common.loading") : t("library.link.submit")}
          </Button>
        </form>
      </div>

      {error ? <Note kind="error">{error}</Note> : null}

      {busy === "channel" ? (
        <Columns>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Card key={i} className="overflow-hidden">
              <Skeleton className="aspect-video w-full rounded-none" />
              <div className="flex flex-col gap-2 p-3.5">
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-3 w-2/5" />
              </div>
            </Card>
          ))}
        </Columns>
      ) : null}

      {!busy && !results ? <EmptyState icon="search">{t("empty.library")}</EmptyState> : null}

      {!busy && results ? (
        <div className="flex flex-col gap-3">
          <p className="text-small text-muted">
            {t("library.results", { count: results.vods.length, channel: results.channel })}
          </p>
          <Columns>
            {results.vods.map((v) => (
              <VodCard
                key={v.uuid}
                vod={v}
                locale={locale}
                active={selected?.uuid === v.uuid}
                onSelect={() => select(v)}
                selectLabel={t("library.select")}
                selectedLabel={t("library.selected")}
                viewsLabel={t("library.views", { count: compactCount(v.views, locale) })}
              />
            ))}
          </Columns>
        </div>
      ) : null}
    </div>
  );
}

function VodCard({
  vod,
  locale,
  active,
  onSelect,
  selectLabel,
  selectedLabel,
  viewsLabel,
}: {
  vod: Vod;
  locale: string;
  active: boolean;
  onSelect: () => void;
  selectLabel: string;
  selectedLabel: string;
  viewsLabel: string;
}) {
  return (
    <Card
      kind={active ? "primary" : "normal"}
      className={
        "appear flex flex-col overflow-hidden transition-colors " +
        (active ? "border-kick/50" : "hover:border-muted/30")
      }
    >
      <div className="relative aspect-video bg-ink">
        {vod.thumbnail ? (
          <img
            src={vod.thumbnail}
            alt=""
            loading="lazy"
            className="size-full object-cover"
            // A pruned VOD keeps its record but loses its thumbnail; an alt-text
            // placeholder box looks broken, an empty frame does not.
            onError={(e) => {
              e.currentTarget.style.visibility = "hidden";
            }}
          />
        ) : null}
        <span className="absolute right-2 bottom-2 rounded bg-ink/85 px-1.5 py-0.5 font-mono text-mini text-body">
          {timecode(vod.durationMs / 1000)}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-3.5">
        <h3 className="line-clamp-2 text-body font-medium text-body" title={vod.title}>
          {vod.title}
        </h3>
        <div className="flex items-center gap-2 font-mono text-mini text-muted">
          <Icon name="clock" className="size-3.5" />
          <span>{shortDate(vod.startedAt, locale)}</span>
          <span aria-hidden="true">·</span>
          <span>{viewsLabel}</span>
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          {active ? <Badge kind="ok">{selectedLabel}</Badge> : <span />}
          <Button kind={active ? "quiet" : "primary"} size="small" icon="scissors" onClick={onSelect}>
            {selectLabel}
          </Button>
        </div>
      </div>
    </Card>
  );
}
