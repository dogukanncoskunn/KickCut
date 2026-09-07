import type { Vod } from "./api";

/*
 * Kick's metadata API is called from the webview, not from Rust.
 *
 * This is not a style choice. `kick.com/api/*` sits behind a Cloudflare WAF
 * rule that returns `403 {"error":"Request blocked by security policy."}` to
 * the Rust HTTP client no matter what it sends - verified 2026-09-07 with and
 * without a User-Agent, over HTTP/1.1 and HTTP/2, and on both the rustls and
 * the platform TLS stack, always with the same block reference. curl and Node
 * are answered 200 from the same machine, so the rule keys on the client
 * itself rather than on the request or the address.
 *
 * The fix is to stop pretending to be a browser and simply use the one this
 * app already ships. Kick allows it: the API reflects the caller's origin in
 * `access-control-allow-origin` (with `vary: Origin`), so a plain `fetch` from
 * the webview is a normal cross-origin request that Kick has opted into.
 *
 * `stream.kick.com` - the playlists and the video segments, which is all of
 * the actual traffic - is NOT behind that rule and stays in Rust, where the
 * downloader needs it. See `src-tauri/src/kick.rs`.
 */

const API = "https://kick.com/api";

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error("Could not reach Kick. Check your connection and try again.");
  }
  if (res.status === 404) {
    throw new Error("Kick has no record of that - the VOD may have expired or been deleted.");
  }
  if (!res.ok) throw new Error(`Kick answered ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new Error("Kick's response could not be read.");
  }
}

/*
 * Every field is read defensively. These endpoints are undocumented, and a
 * payload change should degrade one card rather than fail the whole request.
 */
type Raw = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Raw | null => (v && typeof v === "object" ? (v as Raw) : null);

/** Map one `livestream`-shaped record to the card the UI renders. */
function toVod(ls: Raw, channelHint: string, uuidHint?: string, sourceHint?: string): Vod | null {
  const masterUrl = str(sourceHint) ?? str(ls.source);
  const uuid = str(uuidHint) ?? str(obj(ls.video)?.uuid);
  if (!masterUrl || !uuid) return null;

  return {
    uuid,
    title: str(ls.session_title) ?? "Untitled broadcast",
    channel: str(obj(ls.channel)?.slug) ?? channelHint,
    startedAt: str(ls.start_time) ?? str(ls.created_at) ?? "",
    durationMs: Math.max(0, Math.round(num(ls.duration))),
    views: Math.max(0, Math.round(num(ls.views))),
    thumbnail: str(obj(ls.thumbnail)?.src),
    masterUrl,
  };
}

/**
 * Past broadcasts for a channel, newest first.
 *
 * The endpoint is not paginated - `?page=2` returns the same page - so this is
 * the most recent broadcasts and nothing older. Anything past that has to come
 * in through `resolveVod`.
 */
export async function channelVods(input: string): Promise<Vod[]> {
  // A pasted channel URL is a natural thing to type into a "channel" box.
  const slug = input.trim().replace(/\/+$/, "").split(/[/\s]/).pop()?.toLowerCase() ?? "";
  if (!slug) throw new Error("Type a channel name first.");

  const raw = await getJson(`${API}/v2/channels/${encodeURIComponent(slug)}/videos`);
  if (!Array.isArray(raw)) throw new Error(`No channel named "${slug}" was found on Kick.`);

  const vods = raw
    .map((entry) => (obj(entry) ? toVod(obj(entry)!, slug) : null))
    .filter((v): v is Vod => v !== null);

  if (vods.length === 0) {
    throw new Error(`"${slug}" has no downloadable past broadcasts right now.`);
  }
  return vods;
}

/**
 * Pull the video UUID out of anything a user might paste - a channel VOD page,
 * a short video link, or the bare id.
 *
 * Scans for the 8-4-4-4-12 shape anywhere in the input rather than matching URL
 * layouts, so a new Kick URL format does not break pasting.
 */
export function extractUuid(input: string): string | null {
  const m = input.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  return m ? m[0].toLowerCase() : null;
}

/** Resolve a pasted VOD reference to the same shape a library card carries. */
export async function resolveVod(input: string): Promise<Vod> {
  const uuid = extractUuid(input);
  if (!uuid) {
    throw new Error("That does not look like a Kick VOD link. Paste the address of the video page.");
  }

  const raw = obj(await getJson(`${API}/v1/video/${uuid}`));
  const ls = obj(raw?.livestream);
  if (!raw || !ls) {
    throw new Error("That VOD exists but carries no broadcast data, so it cannot be downloaded.");
  }

  const vod = toVod(ls, "", str(raw.uuid) ?? uuid, str(raw.source) ?? undefined);
  if (!vod) throw new Error("That VOD has no playable stream - it may still be processing.");
  return vod;
}
