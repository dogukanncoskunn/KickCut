# KickCut

Download a Kick broadcast — all of it, or the three hours in the middle you
actually want — as an MP4 that opens cleanly in an editor.

## Install

Grab the latest `KickCut_x.y.z_x64-setup.exe` from
[Releases](https://github.com/dogukanncoskunn/KickCut/releases) and run it. It
installs for the current user, so Windows will not ask for administrator
rights.

On first launch, open **Settings** and install FFmpeg. It is a one-time 106 MB
download, pinned to a specific build and checked against its published
SHA-256; KickCut keeps it in its own folder and never touches your PATH. If
FFmpeg is already on your machine, KickCut finds it and downloads nothing.

## Using it

1. **Library** — type a channel name to list its recent broadcasts, or paste a
   VOD link. Kick's channel endpoint is not paginated, so it only reaches the
   most recent ones; anything older has to come in as a link.
2. **Download** — pick a quality, then set the range. Drag the ends of the
   timeline or type `02:00:00` and `05:30:00` into the boxes. Amber marks on
   the timeline are breaks in the broadcast (see below).
3. Choose a folder and a file name, then **add it to the queue**. Jobs run one
   at a time; the rail beside the form shows progress and has the pause button.
4. Pause whenever you like — including by closing the app. Reopen it and the
   job is waiting, and resuming carries on from the segment it reached.

There is a download speed limit in the rail header and in Settings. It applies
immediately, to a download already running.

## Why the output is different

The obvious way to do this — join the stream's segments and copy them into an
MP4 — produces a file that plays fine and then misbehaves in an editor: audio
artefacts, and a timeline that stutters or stalls part-way through. Three
things cause it, and KickCut fixes each:

- Audio inside a transport stream is framed differently from audio inside MP4.
  Copying it across without converting leaves the wrong header on every packet.
  Players tolerate that; editors do not.
- A broadcast's timestamps start wherever the encoder happened to be and jump
  at every break in the stream. They are rebuilt into one continuous run from
  zero.
- MPEG-TS counts time on a 90 kHz clock. The MP4 is written on the same one, so
  no rounding drift accumulates across an eight-hour recording.

**Breaks in the broadcast.** When a stream is interrupted the encoding can
change either side of the gap, and no amount of flags makes a stream copy span
that cleanly. KickCut marks these on the timeline and warns when your range
crosses one, and offers a re-encoding mode that dissolves the break and cuts on
the exact frame instead of the nearest keyframe. It takes hours instead of
minutes, so it is offered rather than imposed.

**Cut accuracy.** In the fast mode the start lands on the nearest keyframe at
or after the time you asked for — within about two seconds. Use the
editing-safe mode when you need the exact frame.

## Building it

```bash
npm install
npm run tauri:dev     # run it
npm run tauri:build   # produce the installer
```

Checks, all of which CI runs on every push:

```bash
npm run typecheck
npm run build
cd src-tauri && cargo test --lib && cargo clippy --lib -- -D warnings
```

Two tests are marked `#[ignore]` because they use the network — one downloads
FFmpeg end to end, the other checks Kick's endpoints still have the shape this
app expects. Run them deliberately with `cargo test -- --ignored` after
changing anything they cover.

## A note on what you download

This is a tool for keeping your own broadcasts, or content you have permission
to keep. It downloads what Kick already serves to any viewer and does not
circumvent any protection. What you do with the file is your responsibility.

---

made by unsatisfied0
