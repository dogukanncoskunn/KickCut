import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Vod } from "./api";

/*
 * Which broadcasts the user is about to download, and which of them is on
 * screen. Library writes it, the download screen reads it.
 *
 * It holds a list rather than a single broadcast because picking several at
 * once is the normal way to use this now - a channel streams most days, and
 * someone catching up wants four of them, not one. The list is the order they
 * were picked in, which is the order the rail shows and the order they are
 * queued in.
 *
 * Library does not write here while the user is still choosing. A broadcast
 * only arrives once they have committed to it, because landing on this context
 * is what moves the app to the download screen - a half-made selection that
 * changed tabs under you on the first ctrl-click would be unusable.
 */
type Value = {
  vods: Vod[];
  /** The one whose settings are showing, or null when nothing is selected. */
  active: Vod | null;
  /** Replace the whole selection with one broadcast, or clear it. */
  select: (v: Vod | null) => void;
  /** Replace the whole selection, keeping the given order. */
  selectMany: (list: Vod[]) => void;
  /** Bring one of the already-selected broadcasts to the front. */
  focus: (uuid: string) => void;
  /** Drop one broadcast from the selection. */
  remove: (uuid: string) => void;
};

const Ctx = createContext<Value | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [vods, setVods] = useState<Vod[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const selectMany = useCallback((list: Vod[]) => {
    setVods(list);
    setActiveId(list[0]?.uuid ?? null);
  }, []);

  const select = useCallback(
    (v: Vod | null) => selectMany(v ? [v] : []),
    [selectMany],
  );

  const remove = useCallback((uuid: string) => {
    setVods((current) => {
      const next = current.filter((v) => v.uuid !== uuid);
      // Dropping the one on screen hands the screen to its neighbour rather
      // than leaving the panel blank beside a rail that still has entries.
      setActiveId((id) => (id === uuid ? (next[0]?.uuid ?? null) : id));
      return next;
    });
  }, []);

  const value = useMemo<Value>(
    () => ({
      vods,
      active: vods.find((v) => v.uuid === activeId) ?? null,
      select,
      selectMany,
      focus: setActiveId,
      remove,
    }),
    [vods, activeId, select, selectMany, remove],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSelection() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSelection must be used inside <SelectionProvider>");
  return ctx;
}
