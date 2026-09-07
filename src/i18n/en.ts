/*
 * English is the source of truth for the message shape: `tr.ts` and `de.ts`
 * are typed against it, so a key added here fails the build until all three
 * carry it. Placeholders are `{name}` and substituted by `t()`.
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

  "library.channel.label": "Channel",
  "library.channel.placeholder": "e.g. unsatisfied0",
  "library.channel.hint": "Kick only serves the most recent broadcasts. For an older one, paste its link.",
  "library.channel.submit": "List broadcasts",
  "library.link.label": "Or paste a VOD link",
  "library.link.placeholder": "kick.com/channel/videos/…",
  "library.link.hint": "Reaches any broadcast, including ones older than the list above.",
  "library.link.submit": "Open",
  "library.results": "{count} broadcasts from {channel}",
  "library.select": "Select",
  "library.selected": "Selected",
  "library.views": "{count} views",

  "setup.vod": "Broadcast",
  "setup.quality": "Quality",
  "setup.quality.loading": "Reading available qualities…",
  "setup.quality.option": "{name} · {bitrate} Mbps",
  "setup.length": "Full length",
  "setup.range": "Range",
  "setup.range.whole": "Whole broadcast",
  "setup.range.start": "Start",
  "setup.range.end": "End",
  "setup.range.invalid": "Use HH:MM:SS",
  "setup.range.startHandle": "Range start",
  "setup.range.endHandle": "Range end",
  "setup.plan": "What will be downloaded",
  "setup.plan.output": "Clip length",
  "setup.plan.size": "Estimated size",
  "setup.plan.segments": "{count} segments",
  "setup.plan.trim": "Fetches {extra} extra, trimmed off during muxing.",
  "setup.warn.discontinuity": "This range crosses a break in the broadcast. Stream copy can leave a stutter there; the editing-safe mode re-encodes past it.",
  "setup.warn.incomplete": "Kick is still writing this broadcast, so the end may move.",

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
