//! Turning downloaded segments into one MP4.
//!
//! This is where the problem that started the project gets fixed. Joining HLS
//! transport-stream segments into an MP4 with a plain stream copy produces a
//! file that plays fine and then misbehaves in an editor - audio artefacts,
//! and a timeline that stutters or stalls part-way through. Three specific
//! things cause it, and each has a flag:
//!
//! * **`-bsf:a aac_adtstoasc`** - AAC inside a transport stream is framed as
//!   ADTS, and MP4 expects a raw AudioSpecificConfig. Copying the frames across
//!   without converting leaves an ADTS header on every packet. Players tolerate
//!   it; editors do not, and that is the audio complaint.
//! * **`-fflags +genpts` with `-avoid_negative_ts make_zero`** - a broadcast's
//!   timestamps start wherever the encoder happened to be and jump at every
//!   `EXT-X-DISCONTINUITY`. Timestamps are rebuilt into one continuous run
//!   starting at zero, which is what stops the timeline stalling.
//! * **`-video_track_timescale 90000`** - MPEG-TS is a 90 kHz clock. Keeping the
//!   MP4 on the same base means no rounding drift accumulating across hours.
//!
//! `-movflags +faststart` is a fourth, less dramatic one: it moves the index to
//! the front, so an editor can open the file without reading to the end first.
//!
//! Where a copy still cannot win is across a discontinuity that changes the
//! encode itself. For that there is the re-encode mode, which rebuilds one
//! constant-frame-rate stream and is offered whenever the chosen range spans a
//! break.

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

/// Write the concat script.
///
/// Entries are bare file names and the script lives in the same directory as
/// the segments, because the concat demuxer resolves relative paths against the
/// script's own location. That sidesteps quoting a Windows path - backslashes,
/// spaces and apostrophes all need escaping in this format, and getting it
/// subtly wrong fails thousands of lines in.
pub async fn write_concat_list(dir: &Path, start: usize, end: usize) -> Result<PathBuf, String> {
    let mut body = String::with_capacity((end - start + 1) * 16);
    for index in start..=end {
        if !dir.join(format!("{index}.ts")).is_file() {
            return Err(format!(
                "Segment {index} is missing, so this clip cannot be assembled. Resume the download."
            ));
        }
        body.push_str(&format!("file '{index}.ts'\n"));
    }

    let path = dir.join("concat.txt");
    tokio::fs::write(&path, body)
        .await
        .map_err(|e| format!("The segment list could not be written: {e}"))?;
    Ok(path)
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

/// Build the argument list.
///
/// Split out from the run so the flag choices above can be asserted in tests
/// rather than only discovered when a file misbehaves in an editor.
pub fn build_args(
    concat_list: &Path,
    output: &Path,
    mode: MuxMode,
    trim_offset: f64,
    output_seconds: f64,
    frame_rate: f64,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        // Input options. genpts has to precede -i to apply to this input.
        "-fflags".into(),
        "+genpts".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        concat_list.display().to_string(),
    ];

    // Output-side seek. The download always starts on a segment boundary at or
    // before the requested time, and this drops the difference. It is on the
    // output side deliberately: seeking a concat input is imprecise, and here
    // the cost is only that a stream copy lands on the next keyframe.
    if trim_offset > 0.05 {
        args.push("-ss".into());
        args.push(format!("{trim_offset:.3}"));
    }
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
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-video_track_timescale".into(),
        "90000".into(),
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
    concat_list: &Path,
    output: &Path,
    mode: MuxMode,
    trim_offset: f64,
    output_seconds: f64,
    frame_rate: f64,
    cancel: &AtomicBool,
    progress: &(impl Fn(f64) + Send + Sync),
) -> Result<(), String> {
    let args = build_args(concat_list, output, mode, trim_offset, output_seconds, frame_rate);

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

    let total_us = (output_seconds * 1_000_000.0).max(1.0);
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

    let result = Verified {
        seconds,
        has_video: kind("video"),
        has_audio: kind("audio"),
    };

    if !result.has_video {
        return Err("The finished file has no video track.".into());
    }
    if !result.has_audio {
        return Err("The finished file has no audio track.".into());
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
        build_args(
            Path::new("C:/parts/x/concat.txt"),
            Path::new("C:/out/clip.mp4"),
            mode,
            trim,
            12600.0,
            60.0,
        )
    }

    /// The three flags this module exists for. If any of them is dropped, the
    /// output goes back to misbehaving in an editor - which is not something a
    /// test can observe, so it is pinned here instead.
    #[test]
    fn a_stream_copy_carries_the_fixes_that_make_it_editable() {
        let args = args_of(MuxMode::Copy, 1.3).join(" ");
        assert!(args.contains("-bsf:a aac_adtstoasc"), "ADTS to ASC conversion missing");
        assert!(args.contains("-fflags +genpts"), "timestamp rebuild missing");
        assert!(args.contains("-avoid_negative_ts make_zero"), "zero-basing missing");
        assert!(args.contains("-video_track_timescale 90000"), "90 kHz timebase missing");
        assert!(args.contains("-movflags +faststart"), "faststart missing");
        assert!(args.contains("-c copy"), "should not re-encode");
    }

    /// genpts is an input option: after -i it silently applies to nothing.
    #[test]
    fn input_flags_come_before_the_input() {
        let args = args_of(MuxMode::Copy, 0.0);
        let genpts = args.iter().position(|a| a == "+genpts").expect("genpts");
        let input = args.iter().position(|a| a == "-i").expect("-i");
        assert!(genpts < input, "+genpts must precede -i");
    }

    /// -ss after -i is an output seek. Before -i it would seek the concat
    /// input, which is imprecise, so the order is load-bearing.
    #[test]
    fn the_trim_is_an_output_seek() {
        let args = args_of(MuxMode::Copy, 1.3);
        let input = args.iter().position(|a| a == "-i").expect("-i");
        let ss = args.iter().position(|a| a == "-ss").expect("-ss");
        assert!(ss > input, "-ss must follow -i");
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
    async fn a_missing_segment_stops_the_mux_rather_than_producing_a_short_clip() {
        let dir = std::env::temp_dir().join("kickcut-concat-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("0.ts"), b"x").unwrap();
        std::fs::write(dir.join("2.ts"), b"x").unwrap();

        // Segment 1 is absent. Assembling 0 and 2 would silently drop ten
        // seconds out of the middle, which is worse than failing.
        let err = write_concat_list(&dir, 0, 2).await.expect_err("should refuse");
        assert!(err.contains("Segment 1"), "unhelpful message: {err}");

        std::fs::write(dir.join("1.ts"), b"x").unwrap();
        let list = write_concat_list(&dir, 0, 2).await.expect("should succeed");
        let body = std::fs::read_to_string(&list).unwrap();
        // Relative names, in order - the demuxer resolves them next to the
        // script, so no Windows path ever has to be escaped.
        assert_eq!(body, "file '0.ts'\nfile '1.ts'\nfile '2.ts'\n");

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
