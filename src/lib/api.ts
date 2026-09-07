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

export const api = {
  channelVods: (slug: string) => invoke<Vod[]>("channel_vods", { slug }),
  resolveVod: (input: string) => invoke<Vod>("resolve_vod", { input }),
  renditions: (masterUrl: string) => invoke<Rendition[]>("renditions", { masterUrl }),
};
