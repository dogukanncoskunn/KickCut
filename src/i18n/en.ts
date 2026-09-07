/*
 * English is the source of truth for the message shape: `tr.ts` and `de.ts`
 * are typed against it, so a key added here fails the build until all three
 * carry it. Placeholders are `{name}` and substituted positionally by `t()`.
 */
export const en = {
  "app.name": "KickCut",

  "nav.library": "Library",
  "nav.setup": "Download",
  "nav.queue": "Queue",
  "nav.settings": "Settings",

  "pane.library.title": "Stream history",
  "pane.setup.title": "Download setup",
  "pane.queue.title": "Queue",
  "pane.settings.title": "Settings",

  "common.retry": "Try again",
  "common.refresh": "Refresh",
  "common.cancel": "Cancel",
  "common.loading": "Loading…",

  "settings.language": "Language",
  "settings.language.hint": "Applies immediately, remembered on this machine.",
  "settings.scale": "Interface size",
  "settings.motion": "Animations",
  "settings.motion.on": "On",
  "settings.motion.off": "Off",

  "error.title": "Something went wrong",
  "error.boundary": "This screen crashed. Switching tabs resets it.",

  "empty.library": "Type a channel name above to list its past broadcasts.",
  "empty.setup": "Pick a broadcast in Library first.",
  "empty.queue": "No downloads yet.",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
