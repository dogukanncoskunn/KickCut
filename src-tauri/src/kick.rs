//! HLS parsing for `stream.kick.com`.
//!
//! Note what is *not* here: the `kick.com/api/*` metadata calls. Those sit
//! behind a Cloudflare WAF rule that answers this Rust client `403 {"error":
//! "Request blocked by security policy."}` regardless of headers, HTTP version
//! or TLS backend, so they run in the webview instead - see
//! `src/lib/kickApi.ts` for the measurements behind that split.
//!
//! `stream.kick.com` is a different story and is deliberately kept here: it is
//! not behind that rule, it answers Rust with 200, and it is where all of the
//! real traffic goes. A verified 10 MB segment fetch is what the downloader in
//! later phases is built on.

use serde::Serialize;
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/// One quality option from the master playlist.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendition {
    /// `VIDEO` from `EXT-X-STREAM-INF`, e.g. "1080p60" - also the path segment.
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    /// Peak bits per second, used for the download-size estimate.
    pub bandwidth: u64,
    /// Absolute URL of this rendition's media playlist.
    pub playlist_url: String,
    /// True when this looks like the broadcaster's own stream passed through
    /// rather than something Kick's transcoder produced. See `mark_source`.
    pub is_source: bool,
}

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client could not be created: {e}"))
}

pub async fn get_text(url: &str) -> Result<String, String> {
    let res = client()?.get(url).send().await.map_err(|e| {
        if e.is_timeout() {
            "The stream server did not answer in time. Check your connection and try again.".to_string()
        } else {
            format!("Could not reach the stream server: {e}")
        }
    })?;

    let status = res.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("That stream is no longer available - Kick may have pruned it.".into());
    }
    if !status.is_success() {
        return Err(format!("The stream server answered {status}."));
    }
    res.text()
        .await
        .map_err(|e| format!("The stream server's response could not be read: {e}"))
}

/// The quality options behind a master playlist, best first.
#[tauri::command]
pub async fn renditions(master_url: String) -> Result<Vec<Rendition>, String> {
    let body = get_text(&master_url).await?;
    let mut list = parse_master(&body, &master_url)?;
    // Sorting here rather than in the UI keeps "best" a single definition:
    // pixels first, then frame rate, then bitrate.
    list.sort_by(|a, b| {
        (b.width * b.height)
            .cmp(&(a.width * a.height))
            .then(b.frame_rate.total_cmp(&a.frame_rate))
            .then(b.bandwidth.cmp(&a.bandwidth))
    });
    mark_source(&mut list, &parse_profiles(&body));
    Ok(list)
}

/// Read the H.264 profile out of each `CODECS` attribute, keyed by rendition.
///
/// `avc1.PPCCLL` puts profile_idc in the first byte: 0x42 baseline, 0x4D main,
/// 0x64 high.
fn parse_profiles(body: &str) -> Vec<(String, u32)> {
    let mut out = Vec::new();
    let mut lines = body.lines().map(str::trim).filter(|l| !l.is_empty());
    while let Some(line) = lines.next() {
        if !line.starts_with("#EXT-X-STREAM-INF:") {
            continue;
        }
        let Some(uri) = lines.next().filter(|u| !u.starts_with('#')) else {
            continue;
        };
        let name = attr(line, "VIDEO")
            .map(str::to_string)
            .or_else(|| uri.split('/').next().map(str::to_string));
        let profile = attr(line, "CODECS")
            .and_then(|c| c.split(',').find(|c| c.trim_start().starts_with("avc1.")))
            .and_then(|c| u32::from_str_radix(c.trim().get(5..7)?, 16).ok());
        if let (Some(name), Some(profile)) = (name, profile) {
            out.push((name, profile));
        }
    }
    out
}

/// Decide whether the top rendition is the broadcaster's own stream.
///
/// Kick exposes no separate "source" rendition the way Twitch does - the master
/// playlist is the complete list, and every path outside it 403s. So the
/// question is only ever whether the top rung is a passthrough or one more
/// transcode.
///
/// The tell is the H.264 profile. Kick's ladder encodes every rung it makes at
/// Main, so a top rung arriving at High is not something the ladder produced -
/// it is what the broadcaster sent. When the top rung matches the rest, this
/// stays false and the UI calls it the highest quality rather than the source,
/// because claiming otherwise would be a guess dressed as a fact.
fn mark_source(list: &mut [Rendition], profiles: &[(String, u32)]) {
    let profile_of = |name: &str| profiles.iter().find(|(n, _)| n == name).map(|(_, p)| *p);
    let Some((top, rest)) = list.split_first_mut() else {
        return;
    };
    let Some(top_profile) = profile_of(&top.name) else {
        return;
    };
    // A lone rendition has nothing to compare against; Kick's basic channels
    // pass those straight through, so it is the source by definition.
    if rest.is_empty() {
        top.is_source = true;
        return;
    }
    top.is_source = rest
        .iter()
        .filter_map(|r| profile_of(&r.name))
        .all(|p| top_profile > p);
}

/* --------------------------------------------------------------- parsing -- */

/// Resolve a possibly-relative playlist path against the playlist URL it came from.
pub fn absolutize(reference: &str, base: &str) -> String {
    if reference.starts_with("http://") || reference.starts_with("https://") {
        return reference.to_string();
    }
    match base.rfind('/') {
        Some(cut) => format!("{}/{}", &base[..cut], reference.trim_start_matches('/')),
        None => reference.to_string(),
    }
}

/// Read one `KEY=VALUE` attribute out of an `#EXT-X-*` line.
fn attr<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let start = line.find(&format!("{key}="))? + key.len() + 1;
    let rest = &line[start..];
    Some(match rest.strip_prefix('"') {
        Some(quoted) => &quoted[..quoted.find('"')?],
        None => rest.split(',').next()?,
    })
}

/// Parse `#EXT-X-STREAM-INF` / URI pairs out of a master playlist.
///
/// Kick's masters carry muxed audio (`CODECS="avc1.*,mp4a.*"`) with no separate
/// audio group, so a rendition is the whole stream and there is nothing to pair
/// up afterwards.
pub fn parse_master(body: &str, base_url: &str) -> Result<Vec<Rendition>, String> {
    let mut out = Vec::new();
    let mut lines = body.lines().map(str::trim).filter(|l| !l.is_empty());

    while let Some(line) = lines.next() {
        if !line.starts_with("#EXT-X-STREAM-INF:") {
            continue;
        }
        let Some(uri) = lines.next().filter(|u| !u.starts_with('#')) else {
            continue;
        };

        let (width, height) = attr(line, "RESOLUTION")
            .and_then(|r| r.split_once('x'))
            .and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?)))
            .unwrap_or((0, 0));

        // `VIDEO` names the rendition the way Kick labels it in its own player;
        // the URI's first path segment is the same string, and is the fallback.
        let name = attr(line, "VIDEO")
            .map(str::to_string)
            .or_else(|| uri.split('/').next().map(str::to_string))
            .unwrap_or_else(|| format!("{height}p"));

        out.push(Rendition {
            name,
            width,
            height,
            frame_rate: attr(line, "FRAME-RATE").and_then(|f| f.parse().ok()).unwrap_or(0.0),
            bandwidth: attr(line, "BANDWIDTH").and_then(|b| b.parse().ok()).unwrap_or(0),
            playlist_url: absolutize(uri, base_url),
            // Decided across the whole ladder afterwards, not per line.
            is_source: false,
        });
    }

    if out.is_empty() {
        return Err("That stream lists no downloadable qualities.".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from the real master playlist of a Kick VOD (2026-09-07).
    const MASTER: &str = "#EXTM3U\n\
        #EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"1080p60\",NAME=\"1080p60\",AUTOSELECT=YES,DEFAULT=YES\n\
        #EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=9584164,CODECS=\"avc1.64002A,mp4a.40.2\",RESOLUTION=1920x1080,VIDEO=\"1080p60\",FRAME-RATE=60.000\n\
        1080p60/playlist.m3u8\n\
        #EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"480p30\",NAME=\"480p\",AUTOSELECT=YES,DEFAULT=YES\n\
        #EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1488983,CODECS=\"avc1.4D401F,mp4a.40.2\",RESOLUTION=852x480,VIDEO=\"480p30\",FRAME-RATE=30.000\n\
        480p30/playlist.m3u8\n";

    #[test]
    fn parses_master_playlist_and_resolves_relative_uris() {
        let base = "https://stream.kick.com/abc/ivs/v1/1/S/2026/9/6/0/14/G/media/hls/master.m3u8";
        let got = parse_master(MASTER, base).expect("master should parse");

        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "1080p60");
        assert_eq!((got[0].width, got[0].height), (1920, 1080));
        assert_eq!(got[0].frame_rate, 60.0);
        assert_eq!(got[0].bandwidth, 9_584_164);
        assert_eq!(
            got[0].playlist_url,
            "https://stream.kick.com/abc/ivs/v1/1/S/2026/9/6/0/14/G/media/hls/1080p60/playlist.m3u8"
        );
        // NAME is "480p" but VIDEO is "480p30"; the path segment must win so
        // the rendition name stays usable as an identifier.
        assert_eq!(got[1].name, "480p30");
    }

    #[test]
    fn absolutize_leaves_absolute_urls_alone() {
        let base = "https://stream.kick.com/a/hls/master.m3u8";
        assert_eq!(absolutize("https://cdn.example/x.m3u8", base), "https://cdn.example/x.m3u8");
        assert_eq!(absolutize("720p60/playlist.m3u8", base), "https://stream.kick.com/a/hls/720p60/playlist.m3u8");
    }

    #[test]
    fn rejects_a_master_with_no_variants() {
        assert!(parse_master("#EXTM3U\n#EXT-X-VERSION:3\n", "https://x/m.m3u8").is_err());
    }

    fn ladder(body: &str) -> Vec<Rendition> {
        let mut list = parse_master(body, "https://x/hls/master.m3u8").expect("parse");
        list.sort_by(|a, b| (b.width * b.height).cmp(&(a.width * a.height)));
        mark_source(&mut list, &parse_profiles(body));
        list
    }

    /// The real shape: the top rung arrives at High profile while everything
    /// Kick's ladder produced is Main, which is what identifies a passthrough.
    #[test]
    fn a_top_rung_at_a_higher_profile_is_the_broadcaster_s_own_stream() {
        let list = ladder(MASTER);
        assert!(list[0].is_source, "1080p60 at High should read as source");
        assert!(!list[1].is_source, "only the top rung can be the source");
    }

    /// A ladder encoded uniformly says nothing about where the top came from,
    /// so the claim is not made.
    #[test]
    fn a_uniform_ladder_is_not_claimed_as_source() {
        let uniform = MASTER.replace("avc1.64002A", "avc1.4D401F");
        assert!(!ladder(&uniform)[0].is_source);
    }

    /// Kick's basic channels publish one rendition and pass it straight
    /// through, so there is nothing to compare and nothing to doubt.
    #[test]
    fn a_lone_rendition_is_the_source() {
        let single = "#EXTM3U\n\
            #EXT-X-STREAM-INF:BANDWIDTH=6000000,CODECS=\"avc1.4D401F,mp4a.40.2\",RESOLUTION=1280x720,VIDEO=\"720p60\",FRAME-RATE=60.000\n\
            720p60/playlist.m3u8\n";
        assert!(ladder(single)[0].is_source);
    }
}
