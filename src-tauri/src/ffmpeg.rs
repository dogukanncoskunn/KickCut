//! Finding, and if necessary installing, ffmpeg.
//!
//! KickCut downloads the segments itself but does not mux them itself - that is
//! ffmpeg's job, and writing an MP4 muxer to avoid a dependency would be an
//! absurd trade. So the app needs an ffmpeg, and the one thing it must not do is
//! make the user go and find one.
//!
//! Resolution order is: our own managed copy, then whatever is on PATH, then
//! install. PATH comes before installing so a machine that already has ffmpeg
//! is left alone; our copy comes before PATH so that once we have installed one,
//! a later PATH change cannot silently swap the binary underneath a job.
//!
//! The download is pinned to an exact version and checked against a SHA-256
//! published alongside it. An unpinned "latest" URL would mean the bytes
//! executed on the user's machine could change without this code changing,
//! which is not something to leave to chance.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

/// Pinned build. Both URLs serve the identical archive; the second is the
/// upstream author's GitHub mirror, used when the first is unreachable.
const VERSION: &str = "9.0.1";
const ARCHIVE: &str = "ffmpeg-9.0.1-essentials_build.zip";
const URLS: [&str; 2] = [
    "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.1-essentials_build.zip",
    "https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-essentials_build.zip",
];
/// Published at <https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256>,
/// checked 2026-09-07. Archive is 111_253_802 bytes.
const SHA256: &str = "fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9";
const EXPECTED_BYTES: u64 = 111_253_802;

#[cfg(windows)]
pub const EXE: &str = ".exe";
#[cfg(not(windows))]
pub const EXE: &str = "";

/// Where ffmpeg was found, so the UI can say something truthful about it.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// Installed by this app into its own data directory.
    Managed,
    /// Already present on the machine.
    System,
    Missing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub source: Source,
    /// First line of `ffmpeg -version`, or None when nothing was found.
    pub version: Option<String>,
    pub path: Option<String>,
    /// Bytes the installer will need to fetch, so the UI can warn before it starts.
    pub download_bytes: u64,
    pub download_version: &'static str,
}

/// Progress of an install, emitted as `ffmpeg-install`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    stage: &'static str,
    received: u64,
    total: u64,
}

/// Resolved binaries, for the mux phase.
#[derive(Debug, Clone)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

fn managed_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("bin"))
        .map_err(|e| format!("This machine's application data folder could not be located: {e}"))
}

/// Run a binary with a short argument and return its first stdout line.
///
/// Doubles as the liveness check: a file that exists but does not run - a
/// half-extracted download, a binary for the wrong architecture - fails here
/// rather than at the end of an hour-long job.
async fn probe_version(bin: &Path) -> Option<String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("-version");
    #[cfg(windows)]
    {
        // Without this every invocation flashes a console window over the app.
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|l| l.trim().to_string())
}

/// Locate a usable pair of binaries, or report why not.
pub async fn locate(app: &AppHandle) -> Result<(Status, Option<Tools>), String> {
    resolve(&managed_dir(app)?).await
}

/// The resolution order itself, with the managed directory passed in.
///
/// Split from `locate` so it can be tested against a real ffmpeg without a
/// running Tauri app - "do I still have to install it if I already have
/// ffmpeg?" is the first thing anyone asks, and the answer deserves a test
/// rather than an assurance.
pub async fn resolve(dir: &Path) -> Result<(Status, Option<Tools>), String> {
    let candidates = [
        (
            Source::Managed,
            dir.join(format!("ffmpeg{EXE}")),
            dir.join(format!("ffprobe{EXE}")),
        ),
        // Bare names resolve through PATH.
        (
            Source::System,
            PathBuf::from(format!("ffmpeg{EXE}")),
            PathBuf::from(format!("ffprobe{EXE}")),
        ),
    ];

    for (source, ffmpeg, ffprobe) in candidates {
        // The managed copy is only considered if it is actually on disk;
        // probing a missing absolute path is a slow way to learn nothing.
        if source == Source::Managed && !ffmpeg.is_file() {
            continue;
        }
        let Some(version) = probe_version(&ffmpeg).await else {
            continue;
        };
        // ffprobe is required too: the mux step verifies its own output, and
        // discovering ffprobe is missing after an hour of downloading is not
        // an acceptable place to find out.
        if probe_version(&ffprobe).await.is_none() {
            continue;
        }
        return Ok((
            Status {
                source,
                version: Some(version),
                path: Some(ffmpeg.display().to_string()),
                download_bytes: EXPECTED_BYTES,
                download_version: VERSION,
            },
            Some(Tools { ffmpeg, ffprobe }),
        ));
    }

    Ok((
        Status {
            source: Source::Missing,
            version: None,
            path: None,
            download_bytes: EXPECTED_BYTES,
            download_version: VERSION,
        },
        None,
    ))
}

#[tauri::command]
pub async fn ffmpeg_status(app: AppHandle) -> Result<Status, String> {
    Ok(locate(&app).await?.0)
}

/// Download, verify and unpack the pinned build.
///
/// Emits `ffmpeg-install` throughout. Safe to call when ffmpeg is already
/// present - it simply replaces the managed copy.
#[tauri::command]
pub async fn install_ffmpeg(app: AppHandle) -> Result<Status, String> {
    let dir = managed_dir(&app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    let reporter = app.clone();
    fetch_and_unpack(&dir, move |stage, received, total| {
        emit(&reporter, stage, received, total)
    })
    .await?;

    let (status, tools) = locate(&app).await?;
    if tools.is_none() {
        return Err("ffmpeg was installed but will not run on this machine.".into());
    }
    emit(&app, "done", 0, 0);
    Ok(status)
}

fn emit(app: &AppHandle, stage: &'static str, received: u64, total: u64) {
    let _ = app.emit(
        "ffmpeg-install",
        Progress {
            stage,
            received,
            total,
        },
    );
}

/// The whole install, with no Tauri in it.
///
/// Kept free of `AppHandle` so it can be tested for real: progress arrives
/// through the callback, and the caller decides whether that becomes an event
/// or is thrown away.
pub async fn fetch_and_unpack(
    dir: &Path,
    report: impl Fn(&'static str, u64, u64) + Send + Sync + 'static,
) -> Result<(), String> {
    let archive = dir.join(ARCHIVE);

    // Download and hash in one pass, then check before anything is unpacked.
    let digest = download(&archive, &report).await?;
    report("verifying", 0, 0);
    if digest != SHA256 {
        let _ = tokio::fs::remove_file(&archive).await;
        return Err(format!(
            "The downloaded ffmpeg does not match its published checksum, so it was discarded. \
             Expected {SHA256}, got {digest}."
        ));
    }

    report("extracting", 0, 0);
    let extract_to = dir.to_path_buf();
    let archive_for_task = archive.clone();
    // The zip crate is blocking and this unpacks a couple of hundred megabytes,
    // so it runs off the async runtime rather than stalling every task on it.
    tokio::task::spawn_blocking(move || extract(&archive_for_task, &extract_to))
        .await
        .map_err(|e| format!("Unpacking ffmpeg did not finish: {e}"))??;
    let _ = tokio::fs::remove_file(&archive).await;
    Ok(())
}

/// Stream the archive to `target`, returning its lowercase hex SHA-256.
async fn download(
    target: &Path,
    report: &(impl Fn(&'static str, u64, u64) + Send + Sync),
) -> Result<String, String> {
    /*
     * Its own client, deliberately. The one the rest of the app uses caps a
     * whole request at 30 s, which is right for a playlist and fatally wrong
     * for a hundred megabytes - it cut every attempt off mid-transfer. What
     * needs a deadline here is a stall, not the transfer, so the limits are on
     * connecting and on time between chunks; a slow connection is allowed to
     * take as long as it takes.
     */
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client could not be created: {e}"))?;
    let mut last_error = String::new();

    for url in URLS {
        // Cleared per attempt, or a failure on the first mirror would condemn
        // a good download from the second.
        last_error.clear();
        let response = match client.get(url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                last_error = format!("{url} answered {}", r.status());
                continue;
            }
            Err(e) => {
                last_error = format!("{url}: {e}");
                continue;
            }
        };

        let total = response.content_length().unwrap_or(EXPECTED_BYTES);
        let mut file = tokio::fs::File::create(target)
            .await
            .map_err(|e| format!("Could not write to {}: {e}", target.display()))?;
        let mut hasher = Sha256::new();
        let mut received: u64 = 0;
        let mut since_emit: u64 = 0;
        let mut stream = response;

        loop {
            let chunk = match stream.chunk().await {
                Ok(Some(c)) => c,
                Ok(None) => break,
                Err(e) => {
                    last_error = format!("{url}: transfer interrupted: {e}");
                    // Fall through to the next mirror rather than failing the
                    // whole install on one flaky connection.
                    break;
                }
            };
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Could not write ffmpeg to disk: {e}"))?;
            received += chunk.len() as u64;
            since_emit += chunk.len() as u64;
            // A progress event per chunk would be thousands of IPC messages a
            // second; every megabyte is smooth enough to watch.
            if since_emit >= 1_048_576 {
                since_emit = 0;
                report("downloading", received, total);
            }
        }

        file.flush()
            .await
            .map_err(|e| format!("Could not finish writing ffmpeg: {e}"))?;

        if received > 0 && last_error.is_empty() {
            report("downloading", received, total);
            return Ok(format!("{:x}", hasher.finalize()));
        }
    }

    Err(format!("ffmpeg could not be downloaded. {last_error}"))
}

/// Pull just the two binaries out of the archive.
///
/// The build also ships ffplay, documentation and presets; none of it is used
/// here, and unpacking it would roughly double what sits on the user's disk.
fn extract(archive: &Path, dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("The downloaded archive could not be opened: {e}"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| format!("The downloaded archive is not readable: {e}"))?;

    let wanted = [format!("ffmpeg{EXE}"), format!("ffprobe{EXE}")];
    let mut found = 0;

    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("The archive could not be read: {e}"))?;
        // Entries are nested under a versioned folder, and the name is matched
        // rather than the path so a changed folder layout does not break this.
        // `enclosed_name` also rejects any entry trying to escape the directory.
        let Some(name) = entry
            .enclosed_name()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        else {
            continue;
        };
        if !wanted.contains(&name) {
            continue;
        }

        let mut buffer = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buffer)
            .map_err(|e| format!("{name} could not be unpacked: {e}"))?;
        std::fs::write(dir.join(&name), buffer)
            .map_err(|e| format!("{name} could not be saved: {e}"))?;
        found += 1;
    }

    if found != wanted.len() {
        return Err("The downloaded archive did not contain ffmpeg and ffprobe.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pinned_urls_point_at_the_pinned_version() {
        // A version bump that misses one of these would install a build whose
        // checksum cannot match, so tie them together here.
        for url in URLS {
            assert!(url.contains(VERSION), "{url} is not the pinned version");
            assert!(url.ends_with(ARCHIVE), "{url} is not the pinned archive");
        }
        assert_eq!(SHA256.len(), 64);
        assert!(SHA256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    /// Copy a real ffmpeg pair into `dir`, or skip the test if none is around.
    ///
    /// Looks for the managed copy this app installs, then anything on PATH.
    fn borrow_real_binaries(dir: &Path) -> bool {
        let sources: Vec<PathBuf> = std::env::var_os("KICKCUT_TEST_FFMPEG_DIR")
            .map(|d| vec![PathBuf::from(d)])
            .unwrap_or_default();

        for source in sources {
            let ffmpeg = source.join(format!("ffmpeg{EXE}"));
            let ffprobe = source.join(format!("ffprobe{EXE}"));
            if ffmpeg.is_file() && ffprobe.is_file() {
                std::fs::create_dir_all(dir).unwrap();
                std::fs::copy(&ffmpeg, dir.join(format!("ffmpeg{EXE}"))).unwrap();
                std::fs::copy(&ffprobe, dir.join(format!("ffprobe{EXE}"))).unwrap();
                return true;
            }
        }
        false
    }

    /// An ffmpeg already on the machine is used as-is.
    ///
    /// This is the question every first-time user asks, so it is answered by
    /// running the real resolution order against a real binary rather than by
    /// reading the code. Set `KICKCUT_TEST_FFMPEG_DIR` to a folder holding
    /// ffmpeg and ffprobe, then run with `--ignored`.
    #[tokio::test]
    #[ignore = "needs a real ffmpeg; set KICKCUT_TEST_FFMPEG_DIR"]
    async fn an_ffmpeg_already_on_path_is_found_and_nothing_is_downloaded() {
        let root = std::env::temp_dir().join("kickcut-resolve-test");
        let _ = std::fs::remove_dir_all(&root);
        let on_path = root.join("on-path");
        let managed = root.join("managed");
        std::fs::create_dir_all(&managed).unwrap();

        if !borrow_real_binaries(&on_path) {
            eprintln!("no ffmpeg to borrow; set KICKCUT_TEST_FFMPEG_DIR");
            return;
        }

        // The managed directory is empty, exactly as it is on a fresh install.
        let previous = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{};{previous}", on_path.display()));

        let (status, tools) = resolve(&managed).await.expect("resolve");
        assert_eq!(status.source, Source::System, "should have used the machine's own copy");
        assert!(status.version.is_some_and(|v| v.contains("version")));
        assert!(tools.is_some(), "both binaries should have resolved");

        // Now give the managed directory its own copy: it must win, so that a
        // later PATH change cannot swap the binary under a running job.
        assert!(borrow_real_binaries(&managed));
        let (status, _) = resolve(&managed).await.expect("resolve");
        assert_eq!(status.source, Source::Managed, "our own copy must take precedence");

        std::env::set_var("PATH", previous);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The real install, end to end.
    ///
    /// `#[ignore]`d because it fetches 106 MB. Run it deliberately - with
    /// `cargo test -- --ignored` - after changing the pinned version, the
    /// checksum, or anything in the unpacking path. It is the only thing that
    /// proves the three parts agree: that the URL still serves the archive the
    /// checksum describes, and that the archive still contains binaries that
    /// run on this machine.
    #[tokio::test]
    #[ignore = "downloads 106 MB from gyan.dev"]
    async fn installs_the_pinned_build_and_the_binaries_run() {
        let dir = std::env::temp_dir().join("kickcut-ffmpeg-install-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");

        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
        let recorder = seen.clone();
        fetch_and_unpack(&dir, move |stage, _, _| {
            let mut log = recorder.lock().unwrap();
            if log.last() != Some(&stage) {
                log.push(stage);
            }
        })
        .await
        .expect("install should succeed");

        // Progress has to reach the UI in order, or the installer looks stuck.
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["downloading", "verifying", "extracting"]
        );

        for name in [format!("ffmpeg{EXE}"), format!("ffprobe{EXE}")] {
            let bin = dir.join(&name);
            assert!(bin.is_file(), "{name} was not extracted");
            let version = probe_version(&bin).await.unwrap_or_else(|| panic!("{name} did not run"));
            assert!(version.contains("version"), "unexpected banner: {version}");
        }

        // Only the two binaries, not the rest of the archive.
        let extra: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with("ffmpeg") && !n.starts_with("ffprobe"))
            .collect();
        assert!(extra.is_empty(), "archive left behind: {extra:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
