//! Kick's own (undocumented) web API, plus HLS master-playlist parsing.
//!
//! Everything here runs in Rust rather than in the webview for two reasons:
//! the webview would need a CSP hole per host, and `stream.kick.com` sends no
//! CORS headers at all, so a `fetch` from the page cannot read the playlist
//! even though the browser can play it.
//!
//! Endpoint shapes were verified live on 2026-09-07. Neither needs auth, a
//! cookie, or a Cloudflare challenge solve - a plain GET with a browser
//! User-Agent is enough. They are unofficial, so every field this module reads
//! is treated as optional and a missing one degrades the card rather than
//! failing the request.

use serde::{Deserialize, Serialize};
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/// What the UI needs to show one past broadcast and to start a download from it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vod {
    pub uuid: String,
    pub title: String,
    pub channel: String,
    /// Wall-clock start of the broadcast, ISO-8601 as Kick returns it.
    pub started_at: String,
    /// Total length in milliseconds, as reported by the API. This is the
    /// broadcast's length and can disagree with the playlist by a few seconds;
    /// the playlist wins once it is fetched (see `hls`).
    pub duration_ms: u64,
    pub views: u64,
    pub thumbnail: Option<String>,
    /// The master playlist. Every later phase starts from this URL.
    pub master_url: String,
}

/// One quality option from the master playlist.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendition {
    /// `NAME` from `EXT-X-MEDIA`, e.g. "1080p60" - also the path segment.
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    /// Peak bits per second, used for the download-size estimate.
    pub bandwidth: u64,
    /// Absolute URL of this rendition's media playlist.
    pub playlist_url: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client could not be created: {e}"))
}

async fn get_text(url: &str) -> Result<String, String> {
    let res = client()?
        .get(url)
        .header("Accept", "application/json, text/plain, */*")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Kick did not answer in time. Check your connection and try again.".to_string()
            } else {
                format!("Could not reach Kick: {e}")
            }
        })?;

    let status = res.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("Kick has no record of that - the VOD may have expired or been deleted.".into());
    }
    if !status.is_success() {
        return Err(format!("Kick answered {status}."));
    }
    res.text()
        .await
        .map_err(|e| format!("Kick's response could not be read: {e}"))
}

/* ------------------------------------------------------------ API shapes -- */

/*
 * Only the fields this app reads are declared. `serde` ignores the rest, which
 * matters here: these payloads are large and change without notice, and a
 * strict struct would turn an unrelated new field into a crash.
 */

#[derive(Deserialize)]
struct ApiLivestream {
    session_title: Option<String>,
    start_time: Option<String>,
    created_at: Option<String>,
    /// Present on the channel-videos list; the per-video endpoint puts it at
    /// the top level instead.
    source: Option<String>,
    duration: Option<f64>,
    views: Option<u64>,
    thumbnail: Option<ApiThumbnail>,
    video: Option<ApiVideoRef>,
    channel: Option<ApiChannel>,
}

#[derive(Deserialize)]
struct ApiThumbnail {
    src: Option<String>,
}

#[derive(Deserialize)]
struct ApiVideoRef {
    uuid: Option<String>,
}

#[derive(Deserialize)]
struct ApiChannel {
    slug: Option<String>,
}

/// `GET /api/v1/video/{uuid}` - the same broadcast seen from the video side.
#[derive(Deserialize)]
struct ApiVideo {
    uuid: Option<String>,
    source: Option<String>,
    livestream: Option<ApiLivestream>,
}

fn to_vod(ls: ApiLivestream, channel_hint: &str, uuid: Option<String>, source: Option<String>) -> Option<Vod> {
    let master_url = source.or(ls.source)?;
    let uuid = uuid.or_else(|| ls.video.as_ref().and_then(|v| v.uuid.clone()))?;
    let channel = ls
        .channel
        .as_ref()
        .and_then(|c| c.slug.clone())
        .unwrap_or_else(|| channel_hint.to_string());

    Some(Vod {
        uuid,
        title: ls
            .session_title
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Untitled broadcast".to_string()),
        channel,
        started_at: ls.start_time.or(ls.created_at).unwrap_or_default(),
        duration_ms: ls.duration.unwrap_or(0.0).max(0.0) as u64,
        views: ls.views.unwrap_or(0),
        thumbnail: ls.thumbnail.and_then(|t| t.src),
        master_url,
    })
}

/* -------------------------------------------------------------- commands -- */

/// Past broadcasts for a channel, newest first.
///
/// The endpoint is not paginated - `?page=2` returns the same page - so this is
/// the ~20 most recent VODs and nothing older. Anything past that has to come
/// in as a direct link, which is what `resolve_vod` is for.
#[tauri::command]
pub async fn channel_vods(slug: String) -> Result<Vec<Vod>, String> {
    let slug = slug.trim().trim_matches('/').to_lowercase();
    if slug.is_empty() {
        return Err("Type a channel name first.".into());
    }
    // A pasted channel URL is a natural thing to type into a "channel" box.
    let slug = slug
        .rsplit(['/', ' '])
        .next()
        .unwrap_or(&slug)
        .to_string();

    let body = get_text(&format!("https://kick.com/api/v2/channels/{slug}/videos")).await?;
    let raw: Vec<ApiLivestream> = serde_json::from_str(&body)
        .map_err(|_| format!("No channel named \"{slug}\" was found on Kick."))?;

    let vods: Vec<Vod> = raw
        .into_iter()
        .filter_map(|ls| to_vod(ls, &slug, None, None))
        .collect();

    if vods.is_empty() {
        return Err(format!("\"{slug}\" has no downloadable past broadcasts right now."));
    }
    Ok(vods)
}

/// Resolve a pasted VOD reference to the same shape a library card carries.
///
/// Accepts `kick.com/{channel}/videos/{uuid}`, `kick.com/video/{uuid}`, either
/// with or without scheme or query string, and a bare UUID.
#[tauri::command]
pub async fn resolve_vod(input: String) -> Result<Vod, String> {
    let uuid = extract_uuid(&input)
        .ok_or("That does not look like a Kick VOD link. Paste the address of the video page.")?;

    let body = get_text(&format!("https://kick.com/api/v1/video/{uuid}")).await?;
    let raw: ApiVideo = serde_json::from_str(&body)
        .map_err(|e| format!("Kick's answer for that VOD could not be read: {e}"))?;

    let source = raw.source;
    let uuid = raw.uuid.or(Some(uuid));
    let ls = raw
        .livestream
        .ok_or("That VOD exists but carries no broadcast data, so it cannot be downloaded.")?;

    to_vod(ls, "", uuid, source)
        .ok_or_else(|| "That VOD has no playable stream - it may still be processing.".into())
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
    Ok(list)
}

/* --------------------------------------------------------------- parsing -- */

/// Pull the video UUID out of anything a user might paste.
pub fn extract_uuid(input: &str) -> Option<String> {
    let text = input.trim();
    // Scan for the first 8-4-4-4-12 hex run rather than matching URL shapes, so
    // a new Kick URL layout does not break this.
    let bytes: Vec<char> = text.chars().collect();
    let groups = [8usize, 4, 4, 4, 12];

    'start: for start in 0..bytes.len() {
        let mut i = start;
        for (g, len) in groups.iter().enumerate() {
            if g > 0 {
                if bytes.get(i) != Some(&'-') {
                    continue 'start;
                }
                i += 1;
            }
            for _ in 0..*len {
                match bytes.get(i) {
                    Some(c) if c.is_ascii_hexdigit() => i += 1,
                    _ => continue 'start,
                }
            }
        }
        // Reject a longer hex run that merely contains a UUID-shaped prefix.
        if bytes.get(i).is_some_and(|c| c.is_ascii_hexdigit()) {
            continue 'start;
        }
        return Some(bytes[start..i].iter().collect::<String>().to_lowercase());
    }
    None
}

/// Resolve a possibly-relative playlist path against the master playlist URL.
fn absolutize(reference: &str, base: &str) -> String {
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

    #[test]
    fn extracts_uuid_from_every_shape_a_user_might_paste() {
        let want = "2e0c2dc9-011a-4f04-990b-4d952b865811";
        for input in [
            "https://kick.com/xqc/videos/2e0c2dc9-011a-4f04-990b-4d952b865811",
            "kick.com/video/2e0c2dc9-011a-4f04-990b-4d952b865811?t=90",
            "  2E0C2DC9-011A-4F04-990B-4D952B865811  ",
        ] {
            assert_eq!(extract_uuid(input).as_deref(), Some(want), "input: {input}");
        }
        assert_eq!(extract_uuid("https://kick.com/xqc"), None);
        // A longer hex run must not be mistaken for a UUID with a suffix.
        assert_eq!(extract_uuid("2e0c2dc9-011a-4f04-990b-4d952b865811a"), None);
    }

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
    fn rejects_a_master_with_no_variants() {
        assert!(parse_master("#EXTM3U\n#EXT-X-VERSION:3\n", "https://x/m.m3u8").is_err());
    }
}
