import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Vod } from "./api";

/*
 * The one piece of state Library and Setup share: which broadcast the user is
 * about to download. It is a context rather than a store because there is
 * exactly one value and exactly two readers - a state library here would be
 * more moving parts than the problem has.
 */
const Ctx = createContext<{ vod: Vod | null; select: (v: Vod | null) => void } | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [vod, select] = useState<Vod | null>(null);
  const value = useMemo(() => ({ vod, select }), [vod]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSelection() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSelection must be used inside <SelectionProvider>");
  return ctx;
}
