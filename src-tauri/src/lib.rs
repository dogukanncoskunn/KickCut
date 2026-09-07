mod download;
mod ffmpeg;
mod hls;
mod kick;
mod mux;
mod rate;

/// Entry point, kept in the library rather than in `main.rs` so integration
/// tests and future platform shims can call it.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(hls::PlaylistCache::default())
        .manage(download::Downloads::default())
        .invoke_handler(tauri::generate_handler![
            kick::renditions,
            hls::playlist_summary,
            hls::plan_range,
            ffmpeg::ffmpeg_status,
            ffmpeg::install_ffmpeg,
            download::load_jobs,
            download::enqueue_job,
            download::pause_job,
            download::resume_job,
            download::cancel_job,
            download::set_speed_limit,
        ])
        .run(tauri::generate_context!())
        .expect("KickCut could not start");
}
