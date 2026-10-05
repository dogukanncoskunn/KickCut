import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useT } from "../i18n";
import { Button } from "./ui";

/*
 * Removing something, with a few seconds to change your mind.
 *
 * The rule this exists to serve: a removal that only touches the list happens
 * silently and can be taken back, while anything that touches a file on disk
 * asks first and is final. A confirmation dialog in front of a harmless act is
 * a toll you pay on every single use for a mistake that costs nothing; a short
 * grace period costs nothing until the mistake actually happens.
 *
 * The row disappears the moment the button is pressed - the removal is real as
 * far as the screen is concerned - and the work behind it is held back for five
 * seconds. Nothing here is a queue of undo steps: each pending removal stands
 * on its own and the oldest is not disturbed by a newer one.
 *
 * The action itself lives in a ref rather than in state, because it is run
 * exactly once and React may call a state updater twice.
 */
const GRACE_MS = 5000;

/** What the toast shows while a removal is still being held back. */
type Pending = { key: number; label: string; ids: string[] };

type Value = {
  /** True while this id's removal is waiting, so the row can hide itself. */
  isPending: (id: string) => boolean;
  /** Hide `ids` now and run `act` in five seconds unless it is taken back. */
  schedule: (label: string, ids: string[], act: () => void) => void;
};

const Ctx = createContext<Value | null>(null);

export function UndoProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending[]>([]);
  const actions = useRef(new Map<number, () => void>());
  const timers = useRef(new Map<number, number>());
  const nextKey = useRef(0);

  const forget = useCallback((key: number) => {
    const timer = timers.current.get(key);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(key);
    actions.current.delete(key);
    setPending((current) => current.filter((p) => p.key !== key));
  }, []);

  const settle = useCallback(
    (key: number) => {
      const act = actions.current.get(key);
      forget(key);
      act?.();
    },
    [forget],
  );

  const schedule = useCallback(
    (label: string, ids: string[], act: () => void) => {
      const key = nextKey.current++;
      actions.current.set(key, act);
      timers.current.set(key, window.setTimeout(() => settle(key), GRACE_MS));
      setPending((current) => [...current, { key, label, ids }]);
    },
    [settle],
  );

  /*
   * A removal that is still waiting when the window goes is carried out, not
   * abandoned: the row is already gone from the screen and the user has been
   * told it is removed, so coming back to find it still listed would be the
   * app contradicting itself. The call is posted synchronously here; it is the
   * one moment where the IPC might be cut off mid-flight, in which case the
   * record survives and the only cost is pressing the button again.
   */
  useEffect(() => {
    const flush = () => {
      for (const act of actions.current.values()) act();
      actions.current.clear();
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, []);

  const value = useMemo<Value>(
    () => ({
      isPending: (id) => pending.some((p) => p.ids.includes(id)),
      schedule,
    }),
    [pending, schedule],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <Toasts pending={pending} onUndo={forget} />
    </Ctx.Provider>
  );
}

export function useUndo() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useUndo must be used inside <UndoProvider>");
  return ctx;
}

/*
 * Bottom centre, which is the one edge of the window nothing else claims: the
 * queue panel and the update notice both live bottom left, and the byline is
 * down there too.
 */
function Toasts({ pending, onUndo }: { pending: Pending[]; onUndo: (key: number) => void }) {
  if (pending.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex flex-col items-center gap-2">
      {pending.map((p) => (
        <Toast key={p.key} pending={p} onUndo={() => onUndo(p.key)} />
      ))}
    </div>
  );
}

function Toast({ pending, onUndo }: { pending: Pending; onUndo: () => void }) {
  const t = useT();
  /*
   * Counted in numerals rather than drained as a bar. A bar would be the
   * obvious choice, but both reduced-motion paths in the stylesheet force
   * every animation to finish in a hundredth of a millisecond - the bar would
   * read as empty while five seconds were still on the clock, which is the one
   * thing this must not get wrong.
   */
  const [left, setLeft] = useState(Math.round(GRACE_MS / 1000));
  useEffect(() => {
    const tick = window.setInterval(() => setLeft((n) => (n > 1 ? n - 1 : 1)), 1000);
    return () => window.clearInterval(tick);
  }, []);

  return (
    <div className="appear pointer-events-auto flex items-center gap-4 rounded-lg border border-line bg-raised px-4 py-2.5 shadow-2xl shadow-black/50">
      <span className="text-body text-body">{pending.label}</span>
      <span className="font-mono text-small text-muted tabular-nums">{left}</span>
      <Button kind="quiet" size="small" icon="refresh" onClick={onUndo}>
        {t("undo.action")}
      </Button>
    </div>
  );
}
