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
export const api = {
  renditions: (masterUrl: string) => invoke<Rendition[]>("renditions", { masterUrl }),
};
