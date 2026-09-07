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

/** Where ffmpeg was found. `managed` means this app installed it. */
export type FfmpegSource = "managed" | "system" | "missing";

export type FfmpegStatus = {
  source: FfmpegSource;
  /** First line of `ffmpeg -version`, or null when nothing was found. */
  version: string | null;
  path: string | null;
  downloadBytes: number;
  downloadVersion: string;
};

/** Payload of the `ffmpeg-install` event. */
export type FfmpegProgress = {
  stage: "downloading" | "verifying" | "extracting" | "done";
  received: number;
  total: number;
};

export type JobState = "queued" | "downloading" | "paused" | "downloaded" | "failed";

/** A queued job flattened together with what is actually on disk. */
export type JobProgress = {
  id: string;
  title: string;
  channel: string;
  quality: string;
  playlistUrl: string;
  startIndex: number;
  endIndex: number;
  trimOffset: number;
  outputSeconds: number;
  crossesDiscontinuity: boolean;
  outputDir: string;
  fileName: string;
  state: JobState;
  createdAt: number;
  error: string | null;
  segmentsDone: number;
  segmentsTotal: number;
  bytesDone: number;
  /** Measured from this session's start, so a resumed job reports honestly. */
  bytesPerSecond: number;
  etaSeconds: number | null;
};

/** What the Setup screen hands over to start a download. */
export type NewJob = {
  title: string;
  channel: string;
  quality: string;
  playlistUrl: string;
  startIndex: number;
  endIndex: number;
  trimOffset: number;
  outputSeconds: number;
  crossesDiscontinuity: boolean;
  outputDir: string;
  fileName: string;
};

export const api = {
  loadJobs: () => invoke<void>("load_jobs"),
  enqueueJob: (job: NewJob) => invoke<string>("enqueue_job", { job }),
  pauseJob: (id: string) => invoke<void>("pause_job", { id }),
  resumeJob: (id: string) => invoke<void>("resume_job", { id }),
  cancelJob: (id: string) => invoke<void>("cancel_job", { id }),
  ffmpegStatus: () => invoke<FfmpegStatus>("ffmpeg_status"),
  installFfmpeg: () => invoke<FfmpegStatus>("install_ffmpeg"),
  renditions: (masterUrl: string) => invoke<Rendition[]>("renditions", { masterUrl }),
  playlistSummary: (playlistUrl: string) => invoke<PlaylistSummary>("playlist_summary", { playlistUrl }),
  planRange: (playlistUrl: string, startSeconds: number, endSeconds: number, bandwidth: number) =>
    invoke<RangePlan>("plan_range", { playlistUrl, startSeconds, endSeconds, bandwidth }),
};
