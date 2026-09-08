//! Turning downloaded segments into one MP4 an editor can work with.
//!
//! Two things matter here, and the first is not a flag.
//!
//! **The segments are joined into one transport stream before ffmpeg sees
//! them.** Handing ffmpeg's concat demuxer a list of segment files instead is
//! the obvious approach, and it stamps 60 fps content as 59.95 fps - a 0.08%
//! error that an editor turns into progressive audio desync, about nine seconds
//! across three hours. See `join_segments` for the measurements. This was found
//! by someone editing a real recording, not by reading the code.
//!
//! **`-bsf:a aac_adtstoasc`** is the flag that is genuinely needed. AAC inside
//! a transport stream is framed as ADTS and MP4 expects a raw
//! AudioSpecificConfig; copying the frames across without converting leaves an
//! ADTS header on every packet. Players tolerate that, editors do not.
//!
//! `-movflags +faststart` moves the index to the front so an editor can open
//! the file without reading to the end first.
//!
//! Nothing else rewrites timestamps. `+genpts`, `-avoid_negative_ts` and
//! `-video_track_timescale` used to be here and are deliberately gone: they
//! existed to correct artefacts the concat demuxer introduced, and with one
//! continuous input there is nothing to correct. The stream already carries the
//! timestamps the broadcaster's encoder wrote.
//!
//! Where a copy still cannot win is across a discontinuity that changes the
//! encode itself. For that there is the re-encode mode, offered whenever the
//! chosen range spans a break.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::ffmpeg::Tools;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum MuxMode {
    /// Stream copy. Minutes for a long clip, and no generational quality loss.
    #[default]
    Copy,
    /// Re-encode to constant frame rate. Slow, but it dissolves a discontinuity
    /// completely and cuts on the exact frame rather than the nearest keyframe.
    Reencode,
}

/// Join the segments into one continuous transport stream.
///
/// This is the difference between an MP4 an editor is happy with and one whose
/// audio slides out of sync over hours, and it took a real report to find.
///
/// The obvious approach - hand ffmpeg's concat demuxer a list of the segment
/// files - is what this used to do, and it stretches the video clock. Measured
/// on 39 real 720p60 segments, both methods produced byte-identical content -
/// 23400 video frames, 18282 audio frames - but with different timestamps:
///
///   concat demuxer   video 390.314 s   =>  59.9517 fps
///   joined stream    video 390.000 s   =>  60.0001 fps
///
/// The audio is unaffected either way; its length follows from the sample count
/// at 48 kHz and came out identical to the millisecond. So the video runs 0.08%
/// slow against it, and that is a rate error, not an offset: it accumulates.
/// Over a three-hour recording it is roughly nine seconds.
///
/// The cause is that the demuxer rebases every entry by the duration its
/// container *reports*, and an MPEG-TS segment reports slightly more than it
/// holds - about 7.6 ms per segment here. A player never shows it, because a
/// player honours each frame's own timestamp. An editor does, because it
/// conforms the video to a constant rate: Premiere divides 23400 frames by
/// 390.314 s, lays them out at 59.95 fps, and runs the audio at its true rate
/// beside them. That is the progressive drift that was reported - correct at
/// the start, obviously wrong hours in.
///
/// Concatenating the bytes avoids the question entirely. MPEG-TS is built to be
/// joined this way: it is a sequence of fixed 188-byte packets, Kick's segments
/// come from one continuous encode, and their timestamps already run on across
/// the boundaries. ffmpeg sees one file carrying the timestamps the
/// broadcaster's encoder wrote, and has nothing to rebase.
pub async fn join_segments(dir: &Path, start: usize, end: usize) -> Result<PathBuf, String> {
    use tokio::io::AsyncWriteExt;

    let joined = dir.join("joined.ts");
    let file = tokio::fs::File::create(&joined)
        .await
        .map_err(|e| format!("The joined stream could not be created: {e}"))?;
    // Buffered: writing a few hundred megabytes ten at a time through unbuffered
    // syscalls is needlessly slow.
    let mut out = tokio::io::BufWriter::with_capacity(1 << 20, file);

    for index in start..=end {
        let part = dir.join(format!("{index}.ts"));
        let bytes = tokio::fs::read(&part).await.map_err(|_| {
            format!("Segment {index} is missing, so this clip cannot be assembled. Resume the download.")
        })?;
        out.write_all(&bytes)
            .await
            .map_err(|e| format!("Segment {index} could not be appended: {e}"))?;
    }

    out.flush()
        .await
        .map_err(|e| format!("The joined stream could not be finished: {e}"))?;
    Ok(joined)
}

/// Pick a path that does not overwrite anything.
///
/// Downloading the same broadcast twice is normal - a different range, a
/// different quality - and silently replacing the first file would destroy work
/// the user may not have noticed was at risk.
pub fn free_output_path(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.mp4"));
    if !first.exists() {
        return first;
    }
    for n in 2..1000 {
        let candidate = dir.join(format!("{stem} ({n}).mp4"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem} ({}).mp4", std::process::id()))
}

/// Everything about one assembly except where the binaries are.
///
/// These six travelled as loose parameters and it was three too many to read
/// at a call site - two `f64` seconds in a row is exactly the shape that gets
/// silently swapped. Grouped, the caller has to name each one.
#[derive(Debug, Clone)]
pub struct MuxRequest {
    /// The joined transport stream to read.
    pub source: PathBuf,
    pub output: PathBuf,
    pub mode: MuxMode,
    /// Seconds to drop from the front of the first segment.
    pub trim_offset: f64,
    /// Length of the finished file.
    pub output_seconds: f64,
    /// Only used when re-encoding, to pin a constant frame rate.
    pub frame_rate: f64,
}

/// Build the argument list.
///
/// Split out from the run so the flag choices above can be asserted in tests
/// rather than only discovered when a file misbehaves in an editor.
pub fn build_args(request: &MuxRequest) -> Vec<String> {
    let MuxRequest {
        source,
        output,
        mode,
        trim_offset,
        output_seconds,
        frame_rate,
    } = request;
    let (mode, trim_offset, output_seconds, frame_rate) =
        (*mode, *trim_offset, *output_seconds, *frame_rate);
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into()];

    /*
     * Input-side seek, on a single continuous stream.
     *
     * Both halves of that matter. The input is one joined transport stream
     * rather than a concat list, so there is no per-file timestamp rebasing to
     * accumulate into audio drift - see `join_segments`. And the seek is before
     * -i, so ffmpeg jumps to a keyframe and copies from there rather than
     * reading the whole timeline and re-stamping the part it keeps.
     *
     * Nothing here rewrites timestamps. The stream carries the ones the
     * broadcaster's encoder wrote, and they are correct; the flags that used to
     * be here - +genpts, -avoid_negative_ts, -video_track_timescale - existed
     * to paper over artefacts of the concat demuxer that no longer occur.
     */
    if trim_offset > 0.05 {
        args.push("-ss".into());
        args.push(format!("{trim_offset:.3}"));
    }
    args.push("-i".into());
    args.push(source.display().to_string());

    if output_seconds > 0.0 {
        args.push("-t".into());
        args.push(format!("{output_seconds:.3}"));
    }

    match mode {
        MuxMode::Copy => {
            args.extend(["-c".into(), "copy".into()]);
            // The audio fix: ADTS framing out, AudioSpecificConfig in.
            args.extend(["-bsf:a".into(), "aac_adtstoasc".into()]);
        }
        MuxMode::Reencode => {
            args.extend([
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "medium".into(),
                "-crf".into(),
                "18".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
                // Constant frame rate is the whole point of this mode: a
                // variable-rate file is what makes an editor's playhead drift.
                "-fps_mode".into(),
                "cfr".into(),
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "192k".into(),
            ]);
            if frame_rate > 0.0 {
                args.push("-r".into());
                args.push(format!("{frame_rate:.3}"));
            }
        }
    }

    args.extend([
        "-movflags".into(),
        "+faststart".into(),
        // Machine-readable progress on stdout, so nothing has to scrape the
        // human status line off stderr.
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output.display().to_string(),
    ]);
    args
}

/// Run ffmpeg, reporting progress as a 0..1 fraction.
pub async fn run(
    tools: &Tools,
    request: &MuxRequest,
    cancel: &AtomicBool,
    progress: &(impl Fn(f64) + Send + Sync),
) -> Result<(), String> {
    let args = build_args(request);
    let output = request.output.as_path();

    let mut command = tokio::process::Command::new(&tools.ffmpeg);
    command
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = command
        .spawn()
        .map_err(|e| format!("ffmpeg could not be started: {e}"))?;

    let stdout = child.stdout.take().ok_or("ffmpeg produced no progress output")?;
    let stderr = child.stderr.take().ok_or("ffmpeg produced no error output")?;

    // ffmpeg says why it failed on stderr and nowhere else, so the tail is kept
    // to put a real reason in front of the user instead of an exit code.
    let tail = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut kept: Vec<String> = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            kept.push(line);
            if kept.len() > 12 {
                kept.remove(0);
            }
        }
        kept
    });

    let total_us = (request.output_seconds * 1_000_000.0).max(1.0);
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_file(output).await;
            return Err("Cancelled.".into());
        }
        // `-progress` emits key=value lines; out_time_us is the one that matters.
        if let Some(value) = line.strip_prefix("out_time_us=") {
            if let Ok(done) = value.trim().parse::<f64>() {
                progress((done / total_us).clamp(0.0, 1.0));
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("ffmpeg did not finish: {e}"))?;
    if !status.success() {
        let reason = tail.await.unwrap_or_default().join("\n");
        let _ = tokio::fs::remove_file(output).await;
        return Err(format!("ffmpeg could not assemble this clip.\n{reason}"));
    }
    Ok(())
}

/// What ffprobe reports about a finished file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verified {
    pub seconds: f64,
    pub has_video: bool,
    pub has_audio: bool,
    /// Frames divided by the video stream's own duration.
    ///
    /// Reported for diagnosis, not used as a pass mark. It sits below the
    /// declared rate whenever the broadcast itself had gaps, which on Kick's
    /// transcoded rungs is normal - see the note in `verify`.
    pub implied_fps: f64,
    pub declared_fps: f64,
}

/// Check the output before telling anyone it is ready.
///
/// A zero-length file, or one that lost its audio track to a bad bitstream
/// filter, exits ffmpeg with status 0. The only way to know the clip is real is
/// to read it back.
pub async fn verify(tools: &Tools, output: &Path, expected_seconds: f64) -> Result<Verified, String> {
    let mut command = tokio::process::Command::new(&tools.ffprobe);
    command.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        &output.display().to_string(),
    ]);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    let out = command
        .output()
        .await
        .map_err(|e| format!("The finished file could not be checked: {e}"))?;
    if !out.status.success() {
        return Err("The finished file could not be read back, so it is probably damaged.".into());
    }

    let parsed: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("The finished file could not be checked: {e}"))?;

    let seconds = parsed["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    let streams = parsed["streams"].as_array().cloned().unwrap_or_default();
    let kind = |want: &str| streams.iter().any(|s| s["codec_type"].as_str() == Some(want));
    let video = streams.iter().find(|s| s["codec_type"].as_str() == Some("video"));

    // "60/1" as ffprobe writes it.
    let ratio = |raw: Option<&str>| -> f64 {
        raw.and_then(|r| r.split_once('/'))
            .and_then(|(n, d)| Some(n.parse::<f64>().ok()? / d.parse::<f64>().ok()?.max(1.0)))
            .unwrap_or(0.0)
    };
    let frames = video
        .and_then(|v| v["nb_frames"].as_str())
        .and_then(|n| n.parse::<f64>().ok())
        .unwrap_or(0.0);
    let video_seconds = video
        .and_then(|v| v["duration"].as_str())
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);

    let result = Verified {
        seconds,
        has_video: kind("video"),
        has_audio: kind("audio"),
        implied_fps: if video_seconds > 0.0 { frames / video_seconds } else { 0.0 },
        declared_fps: ratio(video.and_then(|v| v["r_frame_rate"].as_str())),
    };

    if !result.has_video {
        return Err("The finished file has no video track.".into());
    }
    if !result.has_audio {
        return Err("The finished file has no audio track.".into());
    }
    /*
     * The rate is recorded, not enforced.
     *
     * This check used to reject anything more than 0.05% off the declared rate,
     * which was the right bound for the drift it was written against but the
     * wrong thing to measure. Kick's transcoded rungs have real gaps in them -
     * the encoder stalls during a live broadcast and simply emits no frames for
     * a while - and a faithful copy of a gappy source is itself gappy.
     *
     * Measured on beskok's 2026-09-07 VOD, 360p30, segments 1260-1349:
     *
     *     raw source     32728 frames / 1127.333 s  =>  29.03 fps, declared 30
     *     our output     31808 frames / 1096.666 s  =>  29.00 fps, declared 30
     *
     * The output matches the input to within a frame's worth. There was nothing
     * wrong with the file; a 27-minute download was being thrown away over a
     * property of the broadcast. A shorter span of the same rendition measured
     * 30.0004 fps, which is why this only ever showed up on real clips.
     *
     * Nothing else can be concluded from this number either: a gapped source
     * and a stretched timeline both read as fewer frames than the duration
     * implies, so no threshold separates them. What guards the drift the module
     * was rewritten for is the shape of the command - one joined stream, no
     * timestamp rewriting - and that is pinned by the tests below.
     *
     * The bound kept here is only for a file that is obviously not what was
     * asked for; half the declared rate is far past any stall.
     */
    if result.declared_fps > 0.0 && result.implied_fps > 0.0 {
        let ratio = result.implied_fps / result.declared_fps;
        if ratio < 0.5 {
            return Err(format!(
                "The finished file holds {:.4} fps of picture against a declared {:.4}, so most of the video is missing.",
                result.implied_fps, result.declared_fps
            ));
        }
    }

    // A stream copy cuts on a keyframe, so a couple of seconds either way is
    // expected; anything past that means the wrong media was assembled.
    let drift = (seconds - expected_seconds).abs();
    if expected_seconds > 0.0 && drift > 5.0 && drift / expected_seconds > 0.01 {
        return Err(format!(
            "The finished file is {seconds:.0} s long but should be about {expected_seconds:.0} s."
        ));
    }
    Ok(result)
}

/// Progress of the mux stage, shared with the queue.
pub type MuxProgress = AtomicU64;

/// Store a 0..1 fraction in an atomic as parts per million.
pub fn store_fraction(slot: &MuxProgress, fraction: f64) {
    slot.store((fraction.clamp(0.0, 1.0) * 1_000_000.0) as u64, Ordering::Relaxed);
}

pub fn load_fraction(slot: &MuxProgress) -> f64 {
    slot.load(Ordering::Relaxed) as f64 / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_of(mode: MuxMode, trim: f64) -> Vec<String> {
        build_args(&MuxRequest {
            source: PathBuf::from("C:/parts/x/joined.ts"),
            output: PathBuf::from("C:/out/clip.mp4"),
            mode,
            trim_offset: trim,
            output_seconds: 12600.0,
            frame_rate: 60.0,
        })
    }

    /// A copy carries the one bitstream filter it needs, and nothing else.
    #[test]
    fn a_stream_copy_converts_the_audio_framing_and_leaves_the_rest_alone() {
        let args = args_of(MuxMode::Copy, 1.3).join(" ");
        assert!(args.contains("-bsf:a aac_adtstoasc"), "ADTS to ASC conversion missing");
        assert!(args.contains("-movflags +faststart"), "faststart missing");
        assert!(args.contains("-c copy"), "should not re-encode");
    }

    /// The regression this module was rewritten for.
    ///
    /// Every one of these rewrites timestamps, and every one of them was here
    /// to correct something the concat demuxer did. With a single joined input
    /// there is nothing to correct, and re-adding them would quietly bring back
    /// the audio drift that made the output unusable in Premiere - a symptom
    /// that only appears hours into a recording, which is far too late to
    /// discover it.
    #[test]
    fn nothing_rewrites_timestamps() {
        for mode in [MuxMode::Copy, MuxMode::Reencode] {
            let args = args_of(mode, 1.3).join(" ");
            for flag in [
                "+genpts",
                "-avoid_negative_ts",
                "-video_track_timescale",
                "-copyts",
                "-start_at_zero",
                "-reset_timestamps",
                "-itsoffset",
                "-output_ts_offset",
                "-async",
                "-af aresample",
            ] {
                assert!(!args.contains(flag), "{flag} is back in {mode:?} mode");
            }
        }
    }

    /// The input must be one file, not a list of them.
    #[test]
    fn the_input_is_a_single_joined_stream() {
        let args = args_of(MuxMode::Copy, 0.0);
        assert!(!args.iter().any(|a| a == "concat"), "concat demuxer is back");
        let input = args.iter().position(|a| a == "-i").expect("-i");
        assert!(args[input + 1].ends_with("joined.ts"), "input is {}", args[input + 1]);
    }

    /// -ss before -i seeks the input and copies from a keyframe. After -i it
    /// would read the whole timeline and re-stamp what it keeps, which is the
    /// kind of timestamp rewriting this module now avoids on purpose.
    #[test]
    fn the_trim_seeks_the_input() {
        let args = args_of(MuxMode::Copy, 1.3);
        let input = args.iter().position(|a| a == "-i").expect("-i");
        let ss = args.iter().position(|a| a == "-ss").expect("-ss");
        assert!(ss < input, "-ss must precede -i");
        assert_eq!(args[ss + 1], "1.300");
    }

    #[test]
    fn a_zero_offset_adds_no_seek_at_all() {
        assert!(!args_of(MuxMode::Copy, 0.0).contains(&"-ss".to_string()));
    }

    #[test]
    fn re_encoding_forces_a_constant_frame_rate() {
        let args = args_of(MuxMode::Reencode, 0.0).join(" ");
        assert!(args.contains("-c:v libx264"));
        assert!(args.contains("-fps_mode cfr"), "variable frame rate is the thing being fixed");
        assert!(args.contains("-r 60.000"));
        assert!(!args.contains("-c copy"));
        // The audio bitstream filter is meaningless when the audio is rebuilt.
        assert!(!args.contains("aac_adtstoasc"));
    }

    #[test]
    fn a_second_download_of_the_same_clip_does_not_overwrite_the_first() {
        let dir = std::env::temp_dir().join("kickcut-free-path-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        assert_eq!(free_output_path(&dir, "clip"), dir.join("clip.mp4"));
        std::fs::write(dir.join("clip.mp4"), b"x").unwrap();
        assert_eq!(free_output_path(&dir, "clip"), dir.join("clip (2).mp4"));
        std::fs::write(dir.join("clip (2).mp4"), b"x").unwrap();
        assert_eq!(free_output_path(&dir, "clip"), dir.join("clip (3).mp4"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn segments_are_joined_in_order_and_a_gap_stops_the_mux() {
        let dir = std::env::temp_dir().join("kickcut-join-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("0.ts"), b"AAA").unwrap();
        std::fs::write(dir.join("2.ts"), b"CCC").unwrap();

        // Segment 1 is absent. Joining 0 and 2 would silently drop ten seconds
        // out of the middle, which is worse than failing.
        let err = join_segments(&dir, 0, 2).await.expect_err("should refuse");
        assert!(err.contains("Segment 1"), "unhelpful message: {err}");

        std::fs::write(dir.join("1.ts"), b"BBB").unwrap();
        let joined = join_segments(&dir, 0, 2).await.expect("should succeed");
        // Byte for byte, in order. A transport stream is a sequence of packets,
        // and appending them is exactly what keeps the encoder's own timestamps
        // running on across the boundaries.
        assert_eq!(std::fs::read(&joined).unwrap(), b"AAABBBCCC");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole point of the app, end to end, with nothing faked.
    ///
    /// Real segments off Kick's CDN, the real ffmpeg, the real flags, and the
    /// result read back with ffprobe. Everything else in this file checks the
    /// arguments we *intend* to pass; this is the only thing that proves they
    /// produce a file - that the concat script resolves, that
    /// `aac_adtstoasc` accepts Kick's audio, and that the trim lands where it
    /// should.
    ///
    /// `#[ignore]`d: it needs the network and a real ffmpeg. Run with
    ///   KICKCUT_TEST_PLAYLIST=<a media playlist url>
    ///   KICKCUT_TEST_FFMPEG_DIR=<folder with ffmpeg and ffprobe>
    ///   cargo test -- --ignored assembles_real_segments
    ///
    /// Frames actually present in a file, over the span it covers. Counting
    /// them means decoding, which is why this only appears in a manual test.
    async fn probe_implied_fps(tools: &Tools, path: &Path) -> f64 {
        let out = tokio::process::Command::new(&tools.ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v",
                "-count_frames",
                "-show_entries",
                "stream=nb_read_frames,duration",
                "-of",
                "default=nw=1:nk=1",
                &path.display().to_string(),
            ])
            .output()
            .await
            .expect("ffprobe the source");
        let text = String::from_utf8_lossy(&out.stdout);
        let mut numbers = text.lines().filter_map(|l| l.trim().parse::<f64>().ok());
        let seconds = numbers.next().unwrap_or(0.0);
        let frames = numbers.next().unwrap_or(0.0);
        assert!(seconds > 0.0 && frames > 0.0, "could not read the source: {text}");
        frames / seconds
    }

    #[tokio::test]
    #[ignore = "needs network and a real ffmpeg"]
    async fn assembles_real_segments_into_a_playable_mp4() {
        let Ok(playlist_url) = std::env::var("KICKCUT_TEST_PLAYLIST") else {
            eprintln!("set KICKCUT_TEST_PLAYLIST to a media playlist url");
            return;
        };
        let ffmpeg_dir = PathBuf::from(
            std::env::var("KICKCUT_TEST_FFMPEG_DIR").expect("set KICKCUT_TEST_FFMPEG_DIR"),
        );
        let tools = Tools {
            ffmpeg: ffmpeg_dir.join(format!("ffmpeg{}", crate::ffmpeg::EXE)),
            ffprobe: ffmpeg_dir.join(format!("ffprobe{}", crate::ffmpeg::EXE)),
        };

        let body = crate::kick::get_text(&playlist_url).await.expect("playlist");
        let playlist = crate::hls::parse_media(&body, &playlist_url).expect("parse");
        assert!(playlist.segments.len() >= 3, "need a few segments to join");

        let dir = std::env::temp_dir().join("kickcut-e2e-mux");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Three segments is enough to exercise joining; downloading hours of
        // video would test nothing extra.
        let http = crate::kick::client().expect("client");
        let take = 3usize;
        for index in 0..take {
            let bytes = http
                .get(&playlist.segments[index].url)
                .send()
                .await
                .expect("segment request")
                .bytes()
                .await
                .expect("segment body");
            assert!(bytes.len() > 10_000, "segment {index} looks empty");
            std::fs::write(dir.join(format!("{index}.ts")), &bytes).unwrap();
        }

        let covered: f64 = playlist.segments[..take].iter().map(|s| s.duration).sum();
        // Trim a little off each end, so the seek and duration flags are
        // actually exercised rather than defaulted past.
        let trim = 1.5;
        let wanted = covered - trim - 1.0;

        let joined = join_segments(&dir, 0, take - 1).await.expect("join");
        let source_probe = joined.clone();
        let output = dir.join("clip.mp4");
        let cancel = AtomicBool::new(false);
        let seen = std::sync::Arc::new(AtomicU64::new(0));
        let reporter = seen.clone();

        run(
            &tools,
            &MuxRequest {
                source: joined,
                output: output.clone(),
                mode: MuxMode::Copy,
                trim_offset: trim,
                output_seconds: wanted,
                frame_rate: 60.0,
            },
            &cancel,
            &move |fraction| store_fraction(&reporter, fraction),
        )
        .await
        .expect("ffmpeg should produce a file");

        assert!(output.is_file(), "no output written");
        assert!(load_fraction(&seen) > 0.0, "no progress was ever reported");

        // The check the app itself runs before calling a job done.
        let verified = verify(&tools, &output, wanted).await.expect("verify");
        assert!(verified.has_video && verified.has_audio);

        /*
         * Faithfulness to the source, not to the declared rate.
         *
         * This used to require the output to sit within 0.05% of the rate the
         * stream declares, which failed on any real broadcast: Kick's
         * transcoded rungs stall and drop frames, so an honest copy lands
         * several percent below the declared rate. What can be asserted is
         * that the mux did not invent or lose time of its own - the picture
         * runs at whatever rate the input ran at.
         */
        let source_fps = probe_implied_fps(&tools, &source_probe).await;
        assert!(
            (verified.implied_fps - source_fps).abs() / source_fps < 0.01,
            "the mux changed the picture rate: {:.4} fps out of a {:.4} fps source",
            verified.implied_fps,
            source_fps
        );
        assert!(
            (verified.seconds - wanted).abs() < 3.0,
            "expected about {wanted:.1}s, got {:.1}s",
            verified.seconds
        );

        eprintln!(
            "joined {take} segments -> {:.1}s mp4, {} bytes",
            verified.seconds,
            std::fs::metadata(&output).unwrap().len()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fractions_survive_the_atomic() {
        let slot = MuxProgress::new(0);
        store_fraction(&slot, 0.5);
        assert!((load_fraction(&slot) - 0.5).abs() < 1e-6);
        store_fraction(&slot, 2.0);
        assert_eq!(load_fraction(&slot), 1.0);
    }
}
