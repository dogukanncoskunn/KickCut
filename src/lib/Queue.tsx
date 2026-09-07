import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { JobProgress } from "./api";
import { cleanError } from "./errors";

/*
 * The queue, mirrored from Rust.
 *
 * Rust owns it outright and pushes the whole list on every change rather than
 * deltas. The list is a handful of small records, and sending all of it means
 * this side can never be holding a job the backend has already finished,
 * removed, or failed - which is exactly the drift a delta protocol invites.
 */
type Value = {
  jobs: JobProgress[];
  error: string | null;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
};

const Ctx = createContext<Value | null>(null);

export function QueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<JobProgress[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stop = listen<JobProgress[]>("queue", (e) => setJobs(e.payload));
    // Jobs left over from a previous run are read back from disk; anything
    // that was mid-download returns as paused, ready to resume.
    void api.loadJobs().catch((err) => setError(cleanError(err)));
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  const value = useMemo<Value>(() => {
    const act = (fn: (id: string) => Promise<void>) => async (id: string) => {
      try {
        await fn(id);
        setError(null);
      } catch (err) {
        setError(cleanError(err));
      }
    };
    return {
      jobs,
      error,
      pause: act(api.pauseJob),
      resume: act(api.resumeJob),
      cancel: act(api.cancelJob),
    };
  }, [jobs, error]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useQueue() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useQueue must be used inside <QueueProvider>");
  return ctx;
}
