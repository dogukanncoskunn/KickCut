//! The download engine: segments to disk, pausable, resumable, queued.
//!
//! Resume is the requirement that shaped this. A three-hour 1080p60 clip is
//! tens of gigabytes over an hour or more, and an hour of work that cannot
//! survive a pause - let alone a reboot - is not really a download at all.
//!
//! So there is no separate progress file to keep in step with reality. **The
//! segment files on disk are the state.** A segment is written as `N.part` and
//! renamed to `N.ts` only once it is complete, so a `.ts` is finished by
//! construction: resuming means listing the directory, and a crash mid-write
//! costs one segment. That also removes any need for byte-range resume - at
//! roughly 10 MB a segment there is nothing worth salvaging from a partial one.
//!
//! Jobs run one at a time. Two large downloads sharing a connection finish no
//! sooner together than in sequence, and one finishing early is far more useful
//! than both finishing late.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::hls::parse_media;
use crate::kick::get_text;
use crate::mux::{self, MuxMode};
use crate::rate::RateLimiter;

/// Concurrent segment requests. Eight saturates a fast connection without
/// making the app the reason the rest of the machine feels slow.
const DEFAULT_CONCURRENCY: usize = 8;

/// Attempts per segment before a job is failed.
///
/// Ten, not four. A segment is one of thousands and the cost of retrying is a
/// few seconds; the cost of giving up is an abandoned multi-hour download.
const MAX_ATTEMPTS: u32 = 10;
const MAX_BACKOFF: Duration = Duration::from_secs(8);

/// How many times a job restarts itself after coming up short.
///
/// A retry costs almost nothing - only the missing segments are fetched again -
/// and the failures this recovers from are transient by nature. The cap exists
/// for the case that is not transient: a segment Kick has actually pruned would
/// otherwise loop forever.
const MAX_AUTO_RETRIES: u32 = 5;
/// Long enough for a bad patch of connection to pass, short enough that someone
/// watching does not think it has given up.
const AUTO_RETRY_DELAY: Duration = Duration::from_secs(20);

/// Segments are fetched with their own client, and the reason is the bug this
/// constant exists to prevent.
///
/// The client the rest of the app uses caps a whole request at 30 s. That is
/// right for a playlist and wrong for a segment: at 1080p60 a segment is about
/// 10 MB, so a connection running at 0.3 MB/s needs over half a minute just to
/// transfer one and hits the cap mid-body - which reqwest reports as "error
/// decoding response body", not as a timeout, so it does not even look like
/// what it is. The same segment then succeeds on a faster moment, which is
/// exactly the maddening pattern that was reported.
///
/// What needs a deadline here is a stall, not the transfer. A slow connection
/// is allowed to take as long as it takes.
fn segment_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(crate::kick::UA)
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("HTTP client could not be created: {e}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Downloading,
    Paused,
    /// Every segment is on disk; ffmpeg is assembling the MP4.
    Muxing,
    /// The MP4 exists and has been read back to confirm it is real.
    Done,
    Failed,
}

/// Everything needed to resume a job in a later run of the app.
///
/// Deliberately self-contained: it carries the segment range rather than the
/// times it came from, so resuming never has to re-resolve a playlist and can
/// never resolve it differently than the first time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub quality: String,
    pub playlist_url: String,
    pub start_index: usize,
    pub end_index: usize,
    pub trim_offset: f64,
    pub output_seconds: f64,
    pub crosses_discontinuity: bool,
    pub output_dir: String,
    pub file_name: String,
    #[serde(default)]
    pub mux_mode: MuxMode,
    /// Needed only when re-encoding, to pin a constant frame rate.
    #[serde(default)]
    pub frame_rate: f64,
    /// Set once the file exists, so the queue can offer to open it.
    #[serde(default)]
    pub output_path: Option<String>,
    /// Segments that never downloaded, with the minutes of the broadcast they
    /// cover. Empty on a clean run; cleared whenever a retry succeeds.
    #[serde(default)]
    pub failed_segments: Vec<FailedSegment>,
    pub state: JobState,
    pub created_at: u64,
    pub error: Option<String>,
}

/// A segment that never downloaded, and where it sits in the broadcast.
///
/// The index alone is useless to anyone - "segment 1455 failed" says nothing
/// about what is missing. The times say it in the terms the user chose the
/// range in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedSegment {
    pub index: usize,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

impl Job {
    pub fn segment_count(&self) -> usize {
        self.end_index - self.start_index + 1
    }
}

/// A job plus what is actually on disk right now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    #[serde(flatten)]
    pub job: Job,
    pub segments_done: usize,
    pub segments_total: usize,
    pub bytes_done: u64,
    /// Only meaningful while running; zero otherwise.
    pub bytes_per_second: u64,
    pub eta_seconds: Option<u64>,
    /// 0..1 while ffmpeg is running, otherwise None.
    pub mux_fraction: Option<f64>,
}

/// Per-job stop switches, held only while a job is active.
#[derive(Default)]
struct Control {
    pause: AtomicBool,
    cancel: AtomicBool,
}

/// The queue and its runner.
pub struct Downloads {
    jobs: Mutex<Vec<Job>>,
    control: Mutex<Option<(String, Arc<Control>)>>,
    /// Job id and 0..1 progress of the running mux.
    muxing: Mutex<Option<(String, Arc<mux::MuxProgress>)>>,
    /// Live counters for the running job, so progress does not restat the
    /// directory several times a second.
    live: Mutex<Option<Live>>,
    /// Shared by every worker of every job, and adjustable mid-download.
    pub limiter: Arc<RateLimiter>,
    /// Whether a job that came up short puts itself back in the queue.
    pub auto_resume: AtomicBool,
    /// Automatic retries already spent, per job.
    auto_retries: Mutex<HashMap<String, u32>>,
}

struct Live {
    id: String,
    segments_done: Arc<AtomicU64>,
    bytes_done: Arc<AtomicU64>,
    started: Instant,
    bytes_at_start: u64,
}

impl Default for Downloads {
    fn default() -> Self {
        Self {
            jobs: Mutex::new(Vec::new()),
            control: Mutex::new(None),
            muxing: Mutex::new(None),
            live: Mutex::new(None),
            limiter: Arc::new(RateLimiter::default()),
            // On by default: leaving a multi-hour download running unattended
            // is the normal way to use this, and a transient failure should not
            // mean finding it stopped hours later.
            auto_resume: AtomicBool::new(true),
            auto_retries: Mutex::new(HashMap::new()),
        }
    }
}

/* ----------------------------------------------------------------- paths -- */

fn jobs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("jobs"))
        .map_err(|e| format!("This machine's application data folder could not be located: {e}"))
}

fn parts_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("parts").join(id))
        .map_err(|e| format!("This machine's application data folder could not be located: {e}"))
}

/// Strip what Windows will not accept in a file name.
///
/// Also collapses the result to something that still reads like the stream
/// title it came from - a name of underscores helps nobody find the file later.
pub fn safe_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();

    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    // Windows also rejects a trailing dot or space on a path component.
    let trimmed = collapsed.trim_matches(|c| c == '.' || c == ' ');
    let limited: String = trimmed.chars().take(120).collect();
    let limited = limited.trim_end().to_string();

    if limited.is_empty() {
        "kick-vod".to_string()
    } else {
        limited
    }
}

/* ------------------------------------------------------------ persistence -- */

async fn save(app: &AppHandle, job: &Job) -> Result<(), String> {
    let dir = jobs_dir(app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Could not create the jobs folder: {e}"))?;
    let body = serde_json::to_vec_pretty(job).map_err(|e| format!("Job could not be saved: {e}"))?;
    tokio::fs::write(dir.join(format!("{}.json", job.id)), body)
        .await
        .map_err(|e| format!("Job could not be saved: {e}"))
}

/// Read every stored job back.
///
/// Anything recorded as running belongs to a previous run of the app and is
/// no longer running, so it comes back paused rather than lying about itself.
async fn load_all(app: &AppHandle) -> Result<Vec<Job>, String> {
    let dir = jobs_dir(app)?;
    let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
        return Ok(Vec::new()); // No jobs folder yet: first run, not an error.
    };

    let mut jobs = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.path().extension().is_none_or(|e| e != "json") {
            continue;
        }
        let Ok(body) = tokio::fs::read(entry.path()).await else {
            continue;
        };
        // A job file that will not parse is skipped rather than fatal: one bad
        // record must not hide the rest of the queue.
        let Ok(mut job) = serde_json::from_slice::<Job>(&body) else {
            continue;
        };
        if matches!(job.state, JobState::Downloading) {
            job.state = JobState::Paused;
        }
        jobs.push(job);
    }
    jobs.sort_by_key(|j| j.created_at);
    Ok(jobs)
}

/// Which segments are already complete, and how many bytes they account for.
async fn scan_parts(dir: &Path) -> (HashSet<usize>, u64) {
    let mut done = HashSet::new();
    let mut bytes = 0u64;
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return (done, bytes);
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Only `.ts` counts. A `.part` is an interrupted write and is simply
        // fetched again.
        let Some(stem) = name.strip_suffix(".ts") else {
            continue;
        };
        let Ok(index) = stem.parse::<usize>() else {
            continue;
        };
        if let Ok(meta) = entry.metadata().await {
            bytes += meta.len();
        }
        done.insert(index);
    }
    (done, bytes)
}

/* --------------------------------------------------------------- running -- */

impl Downloads {
    fn snapshot(&self) -> Vec<Job> {
        self.jobs.lock().map(|j| j.clone()).unwrap_or_default()
    }

    fn set_state(&self, id: &str, state: JobState, error: Option<String>) -> Option<Job> {
        let mut jobs = self.jobs.lock().ok()?;
        let job = jobs.iter_mut().find(|j| j.id == id)?;
        job.state = state;
        job.error = error;
        Some(job.clone())
    }
}

/// Emit the whole queue. It is a handful of small records, and sending all of
/// it means the UI can never hold a job the backend has forgotten.
fn emit_queue(app: &AppHandle) {
    let Some(state) = app.try_state::<Downloads>() else {
        return;
    };
    let jobs = state.snapshot();
    let muxing = state
        .muxing
        .lock()
        .ok()
        .and_then(|m| m.as_ref().map(|(id, slot)| (id.clone(), mux::load_fraction(slot))));
    let live = state.live.lock().ok().and_then(|l| {
        l.as_ref().map(|l| {
            (
                l.id.clone(),
                l.segments_done.load(Ordering::Relaxed),
                l.bytes_done.load(Ordering::Relaxed),
                l.started.elapsed().as_secs_f64(),
                l.bytes_at_start,
            )
        })
    });

    let list: Vec<JobProgress> = jobs
        .into_iter()
        .map(|job| {
            let total = job.segment_count();
            let mux_fraction = muxing
                .as_ref()
                .filter(|(id, _)| *id == job.id)
                .map(|(_, fraction)| *fraction);
            match &live {
                Some((id, done, bytes, elapsed, at_start)) if *id == job.id => {
                    let done = *done as usize;
                    // Rate is measured from this session's start, not from the
                    // job's, or a resumed job would report a speed inflated by
                    // everything the previous session already had.
                    let rate = if *elapsed > 1.0 {
                        ((*bytes - *at_start) as f64 / *elapsed) as u64
                    } else {
                        0
                    };
                    let eta = (rate > 0 && done > 0 && done < total).then(|| {
                        let per_segment = (*bytes - *at_start) as f64 / done.max(1) as f64;
                        ((total - done) as f64 * per_segment / rate as f64) as u64
                    });
                    JobProgress {
                        segments_done: done,
                        segments_total: total,
                        bytes_done: *bytes,
                        bytes_per_second: rate,
                        eta_seconds: eta,
                        mux_fraction,
                        job,
                    }
                }
                // A job that is muxing, queued or finished reports no download
                // counters: they would be a stale snapshot of a past session.
                _ => JobProgress {
                    segments_done: if matches!(job.state, JobState::Muxing | JobState::Done) {
                        total
                    } else {
                        0
                    },
                    segments_total: total,
                    bytes_done: 0,
                    bytes_per_second: 0,
                    eta_seconds: None,
                    mux_fraction,
                    job,
                },
            }
        })
        .collect();

    let _ = app.emit("queue", list);
}

/// Start the next queued job if nothing is running.
fn pump(app: &AppHandle) {
    let Some(state) = app.try_state::<Downloads>() else {
        return;
    };
    {
        let running = state.control.lock().ok();
        if running.map(|r| r.is_some()).unwrap_or(true) {
            return; // Something is already running, or the lock is poisoned.
        }
    }

    let next = state
        .snapshot()
        .into_iter()
        .find(|j| matches!(j.state, JobState::Queued));
    let Some(job) = next else {
        return;
    };

    let control = Arc::new(Control::default());
    if let Ok(mut slot) = state.control.lock() {
        *slot = Some((job.id.clone(), control.clone()));
    }
    state.set_state(&job.id, JobState::Downloading, None);

    let runner = app.clone();
    tauri::async_runtime::spawn(async move {
        let app = runner;
        let id = job.id.clone();
        let downloaded = run_job(&app, &job, &control).await;

        let state = app.state::<Downloads>();
        if let Ok(mut live) = state.live.lock() {
            *live = None;
        }

        /*
         * Downloading and muxing are one job, not two. The control slot stays
         * held across both so nothing else starts while ffmpeg is running, and
         * a job only reports Done once the file has been read back.
         */
        let outcome: Result<JobState, String> = match downloaded {
            Ok(Outcome::Finished) => {
                if let Some(updated) = state.set_state(&id, JobState::Muxing, None) {
                    let _ = save(&app, &updated).await;
                }
                emit_queue(&app);
                match assemble(&app, &job, &control).await {
                    Ok(path) => {
                        if let Ok(mut jobs) = state.jobs.lock() {
                            if let Some(entry) = jobs.iter_mut().find(|j| j.id == id) {
                                entry.output_path = Some(path);
                                entry.failed_segments.clear();
                            }
                        }
                        // A clean finish forgets whatever retries it took.
                        if let Ok(mut retries) = state.auto_retries.lock() {
                            retries.remove(&id);
                        }
                        Ok(JobState::Done)
                    }
                    Err(problem) => Err(problem),
                }
            }
            // Stopped on request: the segments stay on disk, ready to resume.
            Ok(Outcome::Stopped) => Ok(JobState::Paused),
            // Some segments never arrived. The job is not muxed - a clip with
            // silent gaps in it is worse than no clip - but everything else
            // stays on disk, and the record of what is missing goes onto the
            // job so the user can see which minutes are affected.
            Ok(Outcome::Incomplete(missing)) => {
                if let Ok(mut jobs) = state.jobs.lock() {
                    if let Some(entry) = jobs.iter_mut().find(|j| j.id == id) {
                        entry.failed_segments = missing.clone();
                    }
                }

                let spent = state
                    .auto_retries
                    .lock()
                    .map(|mut m| {
                        let n = m.entry(id.clone()).or_insert(0);
                        *n += 1;
                        *n
                    })
                    .unwrap_or(u32::MAX);

                if state.auto_resume.load(Ordering::Relaxed) && spent <= MAX_AUTO_RETRIES {
                    // Only the missing segments are fetched on the way round,
                    // so a retry costs seconds rather than starting over.
                    tokio::time::sleep(AUTO_RETRY_DELAY).await;
                    Ok(JobState::Queued)
                } else {
                    Err(format!(
                        "{} segment(s) could not be downloaded after {MAX_ATTEMPTS} attempts each.",
                        missing.len()
                    ))
                }
            }
            Err(problem) => Err(problem),
        };

        if let Ok(mut slot) = state.control.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = state.muxing.lock() {
            *slot = None;
        }

        let (next_state, error) = match outcome {
            Ok(state) => (state, None),
            Err(problem) => (JobState::Failed, Some(problem)),
        };
        if let Some(updated) = state.set_state(&id, next_state, error) {
            let _ = save(&app, &updated).await;
        }
        emit_queue(&app);
        // Whatever happened to this job, the queue moves on.
        pump(&app);
    });

    emit_queue(app);
}

/// Turn the downloaded segments into the finished MP4.
///
/// Returns the path it wrote. The segments are deleted only after the file has
/// been read back and confirmed - if anything here fails, an hour of download
/// is still on disk and the job can be retried without fetching it again.
async fn assemble(app: &AppHandle, job: &Job, control: &Arc<Control>) -> Result<String, String> {
    let tools = crate::ffmpeg::locate(app)
        .await?
        .1
        .ok_or("ffmpeg is not installed, so this clip cannot be assembled.")?;

    let dir = parts_dir(app, &job.id)?;
    let joined = mux::join_segments(&dir, job.start_index, job.end_index).await?;
    let output = mux::free_output_path(Path::new(&job.output_dir), &job.file_name);

    let fraction = Arc::new(mux::MuxProgress::new(0));
    if let Ok(mut slot) = app.state::<Downloads>().muxing.lock() {
        *slot = Some((job.id.clone(), fraction.clone()));
    }

    // ffmpeg reports far more often than a progress bar needs; the UI is
    // refreshed on a timer instead, as during the download.
    let ticker = {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(400)).await;
                emit_queue(&app);
            }
        })
    };

    let reporter = fraction.clone();
    let result = mux::run(
        &tools,
        &mux::MuxRequest {
            source: joined,
            output: output.clone(),
            mode: job.mux_mode,
            trim_offset: job.trim_offset,
            output_seconds: job.output_seconds,
            frame_rate: job.frame_rate,
        },
        &control.cancel,
        &move |done| mux::store_fraction(&reporter, done),
    )
    .await;
    ticker.abort();
    result?;

    mux::verify(&tools, &output, job.output_seconds).await?;

    // The segments have served their purpose; they are typically far larger
    // than the file they produced.
    let _ = tokio::fs::remove_dir_all(&dir).await;
    Ok(output.display().to_string())
}

/// How a download run ended.
///
/// `Incomplete` is deliberately not an `Err`: everything that did download is
/// on disk, the job can be retried and will fetch only what is missing, and the
/// list is what the user is shown. An error string would lose all of that.
enum Outcome {
    Finished,
    /// Paused or cancelled on request.
    Stopped,
    Incomplete(Vec<FailedSegment>),
}

/// Fetch every missing segment.
async fn run_job(app: &AppHandle, job: &Job, control: &Arc<Control>) -> Result<Outcome, String> {
    let dir = parts_dir(app, &job.id)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Could not create the working folder: {e}"))?;

    // The playlist is re-fetched rather than stored: it is a couple of hundred
    // kilobytes, and the stored segment indices make the result unambiguous.
    let playlist = parse_media(&get_text(&job.playlist_url).await?, &job.playlist_url)?;
    if job.end_index >= playlist.segments.len() {
        return Err("This broadcast no longer has the segments this job was planned around.".into());
    }

    let (already, bytes_already) = scan_parts(&dir).await;
    // Reversed because workers take from the back, so segments are fetched in
    // playback order. Nothing depends on that, but a half-finished directory
    // that reads 0..n is far easier to reason about than one that reads n..0.
    let todo: Vec<usize> = (job.start_index..=job.end_index)
        .filter(|i| !already.contains(i))
        .rev()
        .collect();

    let segments_done = Arc::new(AtomicU64::new(already.len() as u64));
    let bytes_done = Arc::new(AtomicU64::new(bytes_already));
    if let Ok(mut live) = app.state::<Downloads>().live.lock() {
        *live = Some(Live {
            id: job.id.clone(),
            segments_done: segments_done.clone(),
            bytes_done: bytes_done.clone(),
            started: Instant::now(),
            bytes_at_start: bytes_already,
        });
    }
    emit_queue(app);

    if todo.is_empty() {
        return Ok(Outcome::Finished);
    }

    let http = segment_client()?;
    let limiter = app.state::<Downloads>().limiter.clone();
    // No more workers than there is work: a three-segment resume should not
    // open eight connections.
    let worker_count = DEFAULT_CONCURRENCY.min(todo.len());
    let queue = Arc::new(Mutex::new(todo));
    let stopped = Arc::new(AtomicBool::new(false));
    let failure: Arc<Mutex<Vec<usize>>> = Arc::new(Mutex::new(Vec::new()));

    let mut workers = Vec::new();
    for _ in 0..worker_count {
        let http = http.clone();
        let queue = queue.clone();
        let control = control.clone();
        let stopped = stopped.clone();
        let failure = failure.clone();
        let segments_done = segments_done.clone();
        let bytes_done = bytes_done.clone();
        let dir = dir.clone();
        let limiter = limiter.clone();
        let urls: Vec<String> = playlist.segments.iter().map(|s| s.url.clone()).collect();

        workers.push(tauri::async_runtime::spawn(async move {
            loop {
                if control.pause.load(Ordering::Relaxed) || control.cancel.load(Ordering::Relaxed) {
                    stopped.store(true, Ordering::Relaxed);
                    return;
                }
                let Some(index) = queue.lock().ok().and_then(|mut q| q.pop()) else {
                    return;
                };

                match fetch_segment(&http, &urls[index], &dir, index, &control, &limiter).await {
                    Ok(Some(len)) => {
                        bytes_done.fetch_add(len, Ordering::Relaxed);
                        segments_done.fetch_add(1, Ordering::Relaxed);
                    }
                    // Stopped mid-segment; put it back so a resume picks it up.
                    Ok(None) => {
                        if let Ok(mut q) = queue.lock() {
                            q.push(index);
                        }
                        stopped.store(true, Ordering::Relaxed);
                        return;
                    }
                    // One segment gave up after every attempt. The rest of the
                    // run continues: aborting here would leave the user knowing
                    // about one gap when there might be three, and would throw
                    // away the segments still queued behind it. They are all
                    // reported together at the end, and everything that did
                    // download stays on disk for the retry.
                    Err(_) => {
                        if let Ok(mut list) = failure.lock() {
                            list.push(index);
                        }
                    }
                }
            }
        }));
    }

    // Progress is emitted on a timer rather than per segment: eight workers
    // finishing 10 MB chunks would otherwise flood the UI with IPC.
    let ticker = {
        let app = app.clone();
        let stopped = stopped.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(250)).await;
                if stopped.load(Ordering::Relaxed) {
                    return;
                }
                emit_queue(&app);
            }
        })
    };

    for worker in workers {
        let _ = worker.await;
    }
    ticker.abort();

    if control.cancel.load(Ordering::Relaxed) {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return Ok(Outcome::Stopped);
    }

    let mut missing = failure.lock().map(|f| f.clone()).unwrap_or_default();
    if !missing.is_empty() {
        missing.sort_unstable();
        // Translated into broadcast times here, where the playlist is still in
        // hand. An index means nothing to the person reading the warning.
        return Ok(Outcome::Incomplete(
            missing
                .into_iter()
                .map(|index| FailedSegment {
                    index,
                    start_seconds: playlist.starts[index],
                    end_seconds: playlist.starts[index] + playlist.segments[index].duration,
                })
                .collect(),
        ));
    }

    if stopped.load(Ordering::Relaxed) {
        return Ok(Outcome::Stopped);
    }
    Ok(Outcome::Finished)
}

/// Fetch one segment to `dir`. `Ok(None)` means it was stopped part-way.
///
/// The write goes to `N.part` and is renamed to `N.ts` only after the last byte
/// lands, so a `.ts` on disk is always a whole segment - which is what lets the
/// directory listing serve as the resume state.
async fn fetch_segment(
    http: &reqwest::Client,
    url: &str,
    dir: &Path,
    index: usize,
    control: &Control,
    limiter: &RateLimiter,
) -> Result<Option<u64>, String> {
    let part = dir.join(format!("{index}.part"));
    let final_path = dir.join(format!("{index}.ts"));
    let mut delay = Duration::from_millis(400);

    for attempt in 1..=MAX_ATTEMPTS {
        match stream_to_file(http, url, &part, control, limiter).await {
            Ok(Some(len)) => {
                tokio::fs::rename(&part, &final_path)
                    .await
                    .map_err(|e| format!("Segment {index} could not be saved: {e}"))?;
                return Ok(Some(len));
            }
            Ok(None) => {
                let _ = tokio::fs::remove_file(&part).await;
                return Ok(None);
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&part).await;
                if attempt == MAX_ATTEMPTS {
                    return Err(format!("Segment {index} failed after {MAX_ATTEMPTS} attempts: {e}"));
                }
                // Backing off matters: a CDN hiccup answered by eight workers
                // retrying immediately is how a slow moment becomes a failure.
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(MAX_BACKOFF);
            }
        }
    }
    unreachable!("loop returns on the final attempt")
}

async fn stream_to_file(
    http: &reqwest::Client,
    url: &str,
    path: &Path,
    control: &Control,
    limiter: &RateLimiter,
) -> Result<Option<u64>, String> {
    use tokio::io::AsyncWriteExt;

    let mut response = http
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    let mut written = 0u64;

    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        limiter.take(chunk.len() as u64).await;
        // Checked after the throttle wait, not before: a pause pressed during a
        // long wait should land as soon as it ends, not one chunk later.
        if control.pause.load(Ordering::Relaxed) || control.cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        written += chunk.len() as u64;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(Some(written))
}

/* -------------------------------------------------------------- commands -- */

/// Load stored jobs at startup. Anything left mid-download comes back paused.
#[tauri::command]
pub async fn load_jobs(app: AppHandle) -> Result<(), String> {
    let restored = load_all(&app).await?;
    for job in &restored {
        // Persist the demotion from Downloading to Paused, so a crash right
        // now does not resurrect the lie.
        if matches!(job.state, JobState::Paused) {
            let _ = save(&app, job).await;
        }
    }
    if let Ok(mut jobs) = app.state::<Downloads>().jobs.lock() {
        *jobs = restored;
    }
    emit_queue(&app);
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewJob {
    pub title: String,
    pub channel: String,
    pub quality: String,
    pub playlist_url: String,
    pub start_index: usize,
    pub end_index: usize,
    pub trim_offset: f64,
    pub output_seconds: f64,
    pub crosses_discontinuity: bool,
    pub output_dir: String,
    pub file_name: String,
    pub mux_mode: MuxMode,
    pub frame_rate: f64,
}

#[tauri::command]
pub async fn enqueue_job(app: AppHandle, job: NewJob) -> Result<String, String> {
    if job.end_index < job.start_index {
        return Err("That range is empty.".into());
    }
    let output_dir = PathBuf::from(&job.output_dir);
    if !output_dir.is_dir() {
        return Err("Pick a folder that exists to save into.".into());
    }

    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // Millisecond plus a counter: unique without pulling in a uuid crate for
    // ids that only ever have to be distinct within one machine's queue.
    let id = format!("{created_at:x}-{:x}", next_sequence());

    let record = Job {
        id: id.clone(),
        title: job.title,
        channel: job.channel,
        quality: job.quality,
        playlist_url: job.playlist_url,
        start_index: job.start_index,
        end_index: job.end_index,
        trim_offset: job.trim_offset,
        output_seconds: job.output_seconds,
        crosses_discontinuity: job.crosses_discontinuity,
        output_dir: job.output_dir,
        file_name: safe_file_name(&job.file_name),
        mux_mode: job.mux_mode,
        frame_rate: job.frame_rate,
        output_path: None,
        failed_segments: Vec::new(),
        state: JobState::Queued,
        created_at,
        error: None,
    };

    save(&app, &record).await?;
    if let Ok(mut jobs) = app.state::<Downloads>().jobs.lock() {
        jobs.push(record);
    }
    emit_queue(&app);
    pump(&app);
    Ok(id)
}

fn next_sequence() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// Cap the download rate, in bytes per second. Zero removes the cap.
///
/// Takes effect on the next chunk of whatever is already running, which is the
/// only time anyone actually reaches for this.
/// Turn automatic retrying of a short download on or off.
#[tauri::command]
pub fn set_auto_resume(app: AppHandle, enabled: bool) {
    app.state::<Downloads>()
        .auto_resume
        .store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_speed_limit(app: AppHandle, bytes_per_second: u64) {
    app.state::<Downloads>().limiter.set(bytes_per_second);
}

#[tauri::command]
pub async fn pause_job(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<Downloads>();
    if let Ok(slot) = state.control.lock() {
        if let Some((running, control)) = slot.as_ref() {
            if *running == id {
                control.pause.store(true, Ordering::Relaxed);
                return Ok(()); // The runner records Paused when it winds down.
            }
        }
    }
    // Not the running job: it is queued, so pausing just takes it out of line.
    if let Some(updated) = state.set_state(&id, JobState::Paused, None) {
        save(&app, &updated).await?;
    }
    emit_queue(&app);
    Ok(())
}

#[tauri::command]
pub async fn resume_job(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<Downloads>();
    if let Some(updated) = state.set_state(&id, JobState::Queued, None) {
        save(&app, &updated).await?;
    }
    emit_queue(&app);
    pump(&app);
    Ok(())
}

/// Remove a job.
///
/// `delete_output` separates the two things "remove" can mean. In the queue it
/// is always true: the job has produced nothing but a folder of segments, and
/// leaving those behind would be litter. In the finished list the record and
/// the video are different objects - forgetting a line from a list should not
/// delete somebody's recording - so the list offers both, and only the one that
/// destroys a file asks first.
#[tauri::command]
pub async fn cancel_job(app: AppHandle, id: String, delete_output: bool) -> Result<(), String> {
    let state = app.state::<Downloads>();
    if let Ok(slot) = state.control.lock() {
        if let Some((running, control)) = slot.as_ref() {
            if *running == id {
                control.cancel.store(true, Ordering::Relaxed);
            }
        }
    }
    let output = state
        .jobs
        .lock()
        .ok()
        .and_then(|jobs| jobs.iter().find(|j| j.id == id).and_then(|j| j.output_path.clone()));

    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.retain(|j| j.id != id);
    }
    let _ = tokio::fs::remove_file(jobs_dir(&app)?.join(format!("{id}.json"))).await;
    let _ = tokio::fs::remove_dir_all(parts_dir(&app, &id)?).await;

    if delete_output {
        if let Some(path) = output {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
    emit_queue(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_survive_windows() {
        assert_eq!(safe_file_name("Yayin 7 Eylul"), "Yayin 7 Eylul");
        // The characters Windows rejects become spaces, which then collapse -
        // so a title full of them stays readable instead of turning into runs
        // of underscores.
        assert_eq!(safe_file_name("LIVE: drama/news *today*?"), "LIVE drama news today");
        assert_eq!(safe_file_name("a\\b/c:d*e?f\"g<h>i|j"), "a b c d e f g h i j");
        // Windows rejects a trailing dot or space outright.
        assert_eq!(safe_file_name("clip..."), "clip");
        assert_eq!(safe_file_name("  spaced  "), "spaced");
        // Something is always returned, or there would be no file to write.
        assert_eq!(safe_file_name(""), "kick-vod");
        assert_eq!(safe_file_name("???"), "kick-vod");
        assert!(safe_file_name(&"x".repeat(400)).len() <= 120);
    }

    #[test]
    fn a_job_knows_how_many_segments_it_covers() {
        let job = Job {
            id: "1".into(),
            title: "t".into(),
            channel: "c".into(),
            quality: "1080p60".into(),
            playlist_url: "https://x/p.m3u8".into(),
            start_index: 718,
            end_index: 1974,
            trim_offset: 1.3,
            output_seconds: 12600.0,
            crosses_discontinuity: true,
            output_dir: ".".into(),
            file_name: "clip".into(),
            mux_mode: MuxMode::Copy,
            frame_rate: 60.0,
            output_path: None,
            failed_segments: Vec::new(),
            state: JobState::Queued,
            created_at: 0,
            error: None,
        };
        // Inclusive at both ends - the segment containing the end time is part
        // of the clip, so an off-by-one here loses the last ten seconds.
        assert_eq!(job.segment_count(), 1257);
    }
}

/* --------------------------------------------------------------- reveal -- */

/// Show a finished file in Explorer, selected, or open a folder.
///
/// Done here rather than through the opener plugin: opening a path through it
/// needs a scope allowlist, and without one the button silently does nothing -
/// which is exactly what it was doing. A single command with an obvious
/// implementation is easier to trust than a permission that fails quietly.
#[tauri::command]
pub fn reveal(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("That file or folder is no longer there.".into());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `/select,` highlights the file inside its folder; a directory is
        // opened directly, since selecting it would highlight it in its parent.
        let mut cmd = std::process::Command::new("explorer.exe");
        if target.is_dir() {
            cmd.arg(&target);
        } else {
            cmd.raw_arg(format!("/select,\"{}\"", target.display()));
        }
        // explorer.exe returns a non-zero exit code even when it succeeds, so
        // only a failure to start it is worth reporting.
        cmd.spawn()
            .map_err(|e| format!("Explorer could not be opened: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        let dir = if target.is_dir() { target.clone() } else {
            target.parent().map(|p| p.to_path_buf()).unwrap_or(target.clone())
        };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("The file manager could not be opened: {e}"))?;
    }
    Ok(())
}
