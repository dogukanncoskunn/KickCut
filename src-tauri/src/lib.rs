mod hls;
mod kick;

/// Entry point, kept in the library rather than in `main.rs` so integration
/// tests and future platform shims can call it.
pub fn run() {
    tauri::Builder::default()
        .manage(hls::PlaylistCache::default())
        .invoke_handler(tauri::generate_handler![
            kick::renditions,
            hls::playlist_summary,
            hls::plan_range,
        ])
        .run(tauri::generate_context!())
        .expect("KickCut could not start");
}
