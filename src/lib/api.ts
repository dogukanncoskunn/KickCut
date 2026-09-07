import { invoke } from "@tauri-apps/api/core";

/*
 * Mirrors of the `#[derive(Serialize)]` structs in `src-tauri/src/kick.rs`.
 * Kept by hand rather than generated: there are three of them, and a codegen
 * step in the build would cost more than it saves at this size.
 */

export type Vod = {
  uuid: string;
  title: string;
  channel: string;
  startedAt: string;
  durationMs: number;
  views: number;
  thumbnail: string | null;
  masterUrl: string;
};

export type Rendition = {
  name: string;
  width: number;
  height: number;
  frameRate: number;
  bandwidth: number;
  playlistUrl: string;
};

/*
 * Only `stream.kick.com` work crosses into Rust. The `kick.com/api` metadata
 * calls live in `kickApi.ts` and run in the webview instead - see the comment
 * at the top of that file for why.
 */
/** What the range picker needs to draw the timeline. */
export type PlaylistSummary = {
  totalSeconds: number;
  segmentCount: number;
  /** Media times where the broadcast has a break, for marking the timeline. */
  discontinuitySeconds: number[];
  programStart: string | null;
  /** False while Kick is still writing the VOD - the end can still move. */
  complete: boolean;
};

/** The resolved consequences of a requested time range. */
export type RangePlan = {
  startIndex: number;
  endIndex: number;
  segmentCount: number;
  /** Seconds dropped from the first segment so the clip starts where asked. */
  trimOffset: number;
  outputSeconds: number;
  /** Media actually fetched: the clip plus the partial segments at each end. */
  downloadSeconds: number;
  estimatedBytes: number;
  crossesDiscontinuity: boolean;
};

export const api = {
  renditions: (masterUrl: string) => invoke<Rendition[]>("renditions", { masterUrl }),
  playlistSummary: (playlistUrl: string) => invoke<PlaylistSummary>("playlist_summary", { playlistUrl }),
  planRange: (playlistUrl: string, startSeconds: number, endSeconds: number, bandwidth: number) =>
    invoke<RangePlan>("plan_range", { playlistUrl, startSeconds, endSeconds, bandwidth }),
};
