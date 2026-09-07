/*
 * `invoke` rejects with whatever string the Rust command returned, but a thrown
 * JS error, a rejected fetch and a plain string all reach the UI through the
 * same catch. This flattens them to one human-readable line so screens never
 * render "[object Object]".
 */
export function cleanError(err: unknown): string {
  if (typeof err === "string") return err.trim();
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const maybe = err as { message?: unknown; error?: unknown };
    if (typeof maybe.message === "string") return maybe.message;
    if (typeof maybe.error === "string") return maybe.error;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through to the generic line below */
    }
  }
  return String(err);
}
