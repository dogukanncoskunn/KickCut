//! Media-playlist parsing and the time-to-segment arithmetic behind the range
//! picker.
//!
//! This module exists because the obvious shortcut is wrong. Kick's segments
//! carry a nominal 10 s target duration, so it is tempting to find the segment
//! for a timecode with `seconds / 10`. Measured against a real 8-hour VOD, the
//! `#EXTINF` values actually range from 2.000 to 11.916 s, and that shortcut
//! puts a 02:00:00 cut 18.7 s late - eighteen seconds of the wrong footage, with
//! nothing in the output to say it happened.
//!
//! So durations are summed. Everything here is pure and covered by tests against
//! that same playlist, which is checked in under `tests/fixtures/`.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

use crate::kick::{absolutize, get_text};

/// One `.ts` file, with the duration its `#EXTINF` declared.
#[derive(Debug, Clone)]
pub struct Segment {
    pub url: String,
    pub duration: f64,
}

#[derive(Debug, Clone)]
pub struct MediaPlaylist {
    pub segments: Vec<Segment>,
    /// `starts[i]` is the media time at which segment `i` begins. Built by
    /// accumulation, which is the whole point of this module.
    pub starts: Vec<f64>,
    pub total: f64,
    /// Indices of segments preceded by `#EXT-X-DISCONTINUITY`. A cut spanning
    /// one of these is where a stream-copy remux produces the timestamp breaks
    /// that make an editor stutter, so the UI warns about it.
    pub discontinuities: Vec<usize>,
    /// `#EXT-X-PROGRAM-DATE-TIME` of the first segment: the wall-clock instant
    /// media time 0 corresponds to.
    pub program_start: Option<String>,
    /// Whether `#EXT-X-ENDLIST` was present. A playlist without it is still
    /// being written - the broadcast has not finished processing.
    pub complete: bool,
}

/// What the UI needs to draw the range picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
    pub total_seconds: f64,
    pub segment_count: usize,
    /// Media times at which a discontinuity falls, for marking the timeline.
    pub discontinuity_seconds: Vec<f64>,
    pub program_start: Option<String>,
    pub complete: bool,
}

/// The resolved consequences of a requested time range.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangePlan {
    /// First segment to fetch.
    pub start_index: usize,
    /// Last segment to fetch, inclusive.
    pub end_index: usize,
    pub segment_count: usize,
    /// Seconds to drop from the front of the first segment so the output starts
    /// exactly where the user asked. Segments cannot be split, so the download
    /// always begins slightly early and ffmpeg trims the difference.
    pub trim_offset: f64,
    /// Length of the finished file.
    pub output_seconds: f64,
    /// Media actually fetched, which is `output_seconds` plus the partial
    /// segments at each end.
    pub download_seconds: f64,
    pub estimated_bytes: u64,
    /// True when the range spans a discontinuity, which is the case where a
    /// stream copy is most likely to misbehave in an editor.
    pub crosses_discontinuity: bool,
}

/* --------------------------------------------------------------- parsing -- */

pub fn parse_media(body: &str, base_url: &str) -> Result<MediaPlaylist, String> {
    let mut segments = Vec::new();
    let mut starts = Vec::new();
    let mut discontinuities = Vec::new();
    let mut program_start = None;
    let mut complete = false;

    let mut pending: Option<f64> = None;
    let mut clock = 0.0f64;

    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            // "#EXTINF:10.000," - the trailing comma may carry a title.
            pending = rest.split(',').next().and_then(|n| n.trim().parse::<f64>().ok());
        } else if line.starts_with("#EXT-X-DISCONTINUITY") {
            // Marks the segment that follows, which is the one about to be pushed.
            discontinuities.push(segments.len());
        } else if let Some(rest) = line.strip_prefix("#EXT-X-PROGRAM-DATE-TIME:") {
            program_start.get_or_insert_with(|| rest.trim().to_string());
        } else if line.starts_with("#EXT-X-ENDLIST") {
            complete = true;
        } else if !line.starts_with('#') {
            // A URI with no preceding #EXTINF is malformed; skipping it would
            // silently shift every later segment, so the playlist is rejected.
            let duration = pending
                .take()
                .ok_or("This playlist is malformed: a segment has no duration.")?;
            starts.push(clock);
            clock += duration;
            segments.push(Segment {
                url: absolutize(line, base_url),
                duration,
            });
        }
    }

    if segments.is_empty() {
        return Err("That quality has no segments - the broadcast may still be processing.".into());
    }

    Ok(MediaPlaylist {
        segments,
        starts,
        total: clock,
        discontinuities,
        program_start,
        complete,
    })
}

impl MediaPlaylist {
    pub fn summary(&self) -> PlaylistSummary {
        PlaylistSummary {
            total_seconds: self.total,
            segment_count: self.segments.len(),
            discontinuity_seconds: self.discontinuities.iter().map(|&i| self.starts[i]).collect(),
            program_start: self.program_start.clone(),
            complete: self.complete,
        }
    }

    /// Index of the segment containing `seconds`.
    ///
    /// Binary search over the accumulated start times - never `seconds / target`.
    pub fn index_at(&self, seconds: f64) -> usize {
        if seconds <= 0.0 {
            return 0;
        }
        match self
            .starts
            .binary_search_by(|probe| probe.partial_cmp(&seconds).unwrap_or(std::cmp::Ordering::Less))
        {
            // Exactly on a boundary: that segment starts here.
            Ok(i) => i,
            // Otherwise the segment before the insertion point contains it.
            Err(0) => 0,
            Err(i) => i - 1,
        }
    }

    /// Resolve a requested range to the segments that cover it.
    ///
    /// `bandwidth` is the rendition's peak bits per second, used only for the
    /// size estimate. The requested times are clamped to the playlist rather
    /// than rejected, so a range picker that overshoots the end by a frame is
    /// not an error.
    pub fn plan(&self, start: f64, end: f64, bandwidth: u64) -> Result<RangePlan, String> {
        let start = start.max(0.0).min(self.total);
        let end = end.max(0.0).min(self.total);
        if end - start < 0.5 {
            return Err("Pick an end time that is later than the start time.".into());
        }

        let start_index = self.index_at(start);
        // `end` is exclusive at a boundary: a cut landing exactly where a
        // segment begins does not need that segment.
        let end_index = if end <= self.starts[start_index] {
            start_index
        } else {
            self.index_at(end - f64::EPSILON.max(1e-6))
        };

        let trim_offset = start - self.starts[start_index];
        let download_seconds: f64 = self.segments[start_index..=end_index]
            .iter()
            .map(|s| s.duration)
            .sum();

        Ok(RangePlan {
            start_index,
            end_index,
            segment_count: end_index - start_index + 1,
            trim_offset,
            output_seconds: end - start,
            download_seconds,
            // Peak bandwidth over the fetched media. It reads high for a mostly
            // static scene, which is the right way to be wrong about free disk.
            estimated_bytes: (download_seconds * bandwidth as f64 / 8.0).max(0.0) as u64,
            crosses_discontinuity: self
                .discontinuities
                .iter()
                .any(|&d| d > start_index && d <= end_index),
        })
    }
}

/* -------------------------------------------------------------- commands -- */

/// Parsed playlists, keyed by URL.
///
/// The range picker asks for a plan every time the user commits a new time, and
/// a media playlist is a couple of hundred kilobytes over the network - so it is
/// fetched once per quality and kept. Entries are only ever added, which is fine
/// for a session: a user works through a handful of qualities, not thousands.
#[derive(Default)]
pub struct PlaylistCache(Mutex<HashMap<String, MediaPlaylist>>);

async fn with_playlist<T>(
    cache: &PlaylistCache,
    url: &str,
    f: impl FnOnce(&MediaPlaylist) -> T,
) -> Result<T, String> {
    if let Some(hit) = cache.0.lock().map_err(|_| "Playlist cache is poisoned.")?.get(url) {
        return Ok(f(hit));
    }
    let parsed = parse_media(&get_text(url).await?, url)?;
    let out = f(&parsed);
    cache
        .0
        .lock()
        .map_err(|_| "Playlist cache is poisoned.")?
        .insert(url.to_string(), parsed);
    Ok(out)
}

#[tauri::command]
pub async fn playlist_summary(
    cache: tauri::State<'_, PlaylistCache>,
    playlist_url: String,
) -> Result<PlaylistSummary, String> {
    with_playlist(&cache, &playlist_url, |p| p.summary()).await
}

#[tauri::command]
pub async fn plan_range(
    cache: tauri::State<'_, PlaylistCache>,
    playlist_url: String,
    start_seconds: f64,
    end_seconds: f64,
    bandwidth: u64,
) -> Result<RangePlan, String> {
    with_playlist(&cache, &playlist_url, |p| {
        p.plan(start_seconds, end_seconds, bandwidth)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The unmodified 1080p60 playlist of a real 8-hour Kick VOD.
    const REAL: &str = include_str!("../tests/fixtures/kick-vod-1080p60.m3u8");
    const BASE: &str = "https://stream.kick.com/x/ivs/v1/1/S/2026/9/6/0/14/G/media/hls/1080p60/playlist.m3u8";

    fn real() -> MediaPlaylist {
        parse_media(REAL, BASE).expect("fixture should parse")
    }

    #[test]
    fn reads_the_real_playlist_exactly() {
        let p = real();
        assert_eq!(p.segments.len(), 2932);
        assert!((p.total - 29355.435).abs() < 0.001, "total was {}", p.total);
        assert!(p.complete, "EXT-X-ENDLIST should mark this VOD complete");
        assert_eq!(p.discontinuities, vec![1001]);
        assert_eq!(p.program_start.as_deref(), Some("2026-09-06T00:14:55.337Z"));
        assert_eq!(
            p.segments[0].url,
            "https://stream.kick.com/x/ivs/v1/1/S/2026/9/6/0/14/G/media/hls/1080p60/0.ts"
        );
    }

    /// The bug this module exists to prevent.
    ///
    /// Segment durations are nominally 10 s, so `seconds / 10` looks correct
    /// and is not. On this playlist it lands almost nineteen seconds late, and
    /// nothing downstream would report it - the output would simply be missing
    /// the start of what was asked for.
    #[test]
    fn assuming_fixed_length_segments_would_cut_in_the_wrong_place() {
        let p = real();
        let two_hours = 7200.0;

        let correct = p.index_at(two_hours);
        let naive = (two_hours / 10.0) as usize;

        assert_eq!(correct, 718);
        assert_eq!(naive, 720);
        assert!(
            (p.starts[naive] - two_hours) > 18.0,
            "naive index starts at {} s, only {} s late - fixture may have been replaced",
            p.starts[naive],
            p.starts[naive] - two_hours
        );
        // The correct segment genuinely contains the requested instant.
        assert!(p.starts[correct] <= two_hours);
        assert!(p.starts[correct] + p.segments[correct].duration > two_hours);
    }

    #[test]
    fn plans_the_range_from_the_original_use_case() {
        // "02:00:00 to 05:30:00", the example the whole tool was asked for.
        let p = real();
        let plan = p.plan(7200.0, 19800.0, 9_584_164).expect("plan");

        assert_eq!(plan.start_index, 718);
        assert_eq!(plan.end_index, 1974);
        assert_eq!(plan.segment_count, 1257);
        assert!((plan.output_seconds - 12600.0).abs() < 0.001);
        // Segments cannot be split, so slightly more is fetched than kept.
        assert!(plan.download_seconds > plan.output_seconds);
        assert!((plan.trim_offset - 1.3).abs() < 0.01, "offset {}", plan.trim_offset);
        // Segment 1001 falls inside this range, so the editing-safe warning fires.
        assert!(plan.crosses_discontinuity);
        // ~9.58 Mbit/s over ~3h30m is roughly 14 GB.
        assert!(plan.estimated_bytes > 13_000_000_000, "{}", plan.estimated_bytes);
        assert!(plan.estimated_bytes < 16_000_000_000, "{}", plan.estimated_bytes);
    }

    #[test]
    fn a_range_clear_of_the_discontinuity_does_not_warn() {
        let p = real();
        // Segment 1001 begins at ~10030 s; stay well before it.
        let plan = p.plan(60.0, 600.0, 9_584_164).expect("plan");
        assert!(!plan.crosses_discontinuity);
        assert_eq!(plan.start_index, 6);
    }

    #[test]
    fn whole_vod_covers_every_segment_with_no_trim() {
        let p = real();
        let plan = p.plan(0.0, p.total, 1_000_000).expect("plan");
        assert_eq!(plan.start_index, 0);
        assert_eq!(plan.end_index, 2931);
        assert_eq!(plan.segment_count, 2932);
        assert_eq!(plan.trim_offset, 0.0);
    }

    #[test]
    fn clamps_an_overshooting_range_instead_of_failing() {
        let p = real();
        let plan = p.plan(-30.0, p.total + 500.0, 1_000_000).expect("plan");
        assert_eq!(plan.start_index, 0);
        assert_eq!(plan.end_index, 2931);
    }

    #[test]
    fn rejects_a_range_that_is_not_a_range() {
        let p = real();
        assert!(p.plan(500.0, 500.0, 1).is_err());
        assert!(p.plan(900.0, 300.0, 1).is_err());
    }

    #[test]
    fn a_segment_without_a_duration_is_rejected_rather_than_silently_shifting() {
        // Dropping the URI would renumber every later segment, so the whole
        // playlist has to fail instead.
        let bad = "#EXTM3U\n#EXTINF:10.000,\n0.ts\n1.ts\n#EXT-X-ENDLIST\n";
        assert!(parse_media(bad, "https://x/p.m3u8").is_err());
    }

    #[test]
    fn discontinuity_is_attributed_to_the_segment_that_follows_it() {
        let body = "#EXTM3U\n#EXTINF:4.000,\n0.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:6.000,\n1.ts\n#EXT-X-ENDLIST\n";
        let p = parse_media(body, "https://x/p.m3u8").expect("parse");
        assert_eq!(p.discontinuities, vec![1]);
        assert_eq!(p.starts, vec![0.0, 4.0]);
        assert_eq!(p.total, 10.0);
    }
}
