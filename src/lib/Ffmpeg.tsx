import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { FfmpegProgress, FfmpegStatus } from "./api";
import { cleanError } from "./errors";

/*
 * Whether ffmpeg is available, held in one place.
 *
 * Two screens need it and they need the same answer: Settings shows and
 * installs it, and the download flow has to refuse to start a job it cannot
 * finish - discovering ffmpeg is missing after an hour of downloading would be
 * the worst possible moment to find out.
 */
type Value = {
  status: FfmpegStatus | null;
  progress: FfmpegProgress | null;
  error: string | null;
  ready: boolean;
  install: () => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<Value | null>(null);

export function FfmpegProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<FfmpegStatus | null>(null);
  const [progress, setProgress] = useState<FfmpegProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.ffmpegStatus());
      setError(null);
    } catch (err) {
      setError(cleanError(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /*
   * The install runs in Rust and reports through an event rather than through
   * the command's return value, because a 106 MB download that shows nothing
   * for several minutes is indistinguishable from one that has hung.
   */
  useEffect(() => {
    const stop = listen<FfmpegProgress>("ffmpeg-install", (e) => setProgress(e.payload));
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  const install = useCallback(async () => {
    setError(null);
    setProgress({ stage: "downloading", received: 0, total: 0 });
    try {
      setStatus(await api.installFfmpeg());
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setProgress(null);
    }
  }, []);

  const value = useMemo<Value>(
    () => ({
      status,
      progress,
      error,
      ready: status !== null && status.source !== "missing",
      install,
      refresh,
    }),
    [status, progress, error, install, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFfmpeg() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFfmpeg must be used inside <FfmpegProvider>");
  return ctx;
}
