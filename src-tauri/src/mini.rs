//! The download panel as a window of its own.
//!
//! The in-app panel can be dragged anywhere inside KickCut, which is no help
//! when KickCut is not the window you are looking at. This is the same card in
//! a borderless always-on-top window: it goes on a second monitor, or into a
//! corner over whatever you are actually working in, and it keeps showing the
//! download while the main window is behind everything else.
//!
//! ## Why the window is declared in the config and merely hidden
//!
//! Detaching is a `show`, not a build, because a window that Tauri did not
//! create from `tauri.conf.json` does not come up usable here. Three ways were
//! tried, 2026-10-05:
//!
//! | approach | what happened |
//! |---|---|
//! | `WebviewUrl::App("index.html?mini=1")` at runtime | blank white: the query folds into the file name, nothing is served |
//! | `WebviewUrl::External(main window's live url)` at runtime | the right page with no `__TAURI_INTERNALS__` behind it, so the module graph threw before the stylesheet was injected - white again |
//! | declared with `"create": false`, built on demand with `from_config` | the window appears and the stylesheet loads, but nothing renders and `set_position` is ignored |
//!
//! Declared and hidden works completely, and that is what ships.
//!
//! **It is not free.** Measured on this machine: the app idles at 562 MB across
//! eight processes with the hidden window present, and at 407 MB across seven
//! without it - 155 MB, a bit over a quarter of the whole app, paid by every
//! session whether or not anyone detaches anything. Getting that back means
//! making the `from_config` route render, and it is worth doing.
//!
//! Both windows load the same document, and the page picks which of its two
//! roots to render from its own window label.
//!
//! No extra plumbing carries the queue into it. Progress is published with
//! `app.emit`, which reaches every webview, so the second window is live from
//! the moment it is shown.

use tauri::{AppHandle, Emitter, Manager};

const LABEL: &str = "mini";
const HEIGHT: f64 = 204.0;

#[tauri::command]
pub fn open_mini(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(LABEL)
        .ok_or("The mini window is missing from this build.")?;

    /*
     * Exactly where the in-app panel was: the main window's bottom left
     * corner. The point is that it reads as the same panel lifted out, and
     * from there the user drags it wherever they actually want it.
     *
     * Measured against the monitor instead on the first attempt, and it landed
     * half off the bottom of a second screen - `primary_monitor` is not
     * necessarily the one the app is on, and its logical size is not the
     * working area. The main window's own frame needs no such guessing and is
     * on screen by definition.
     */
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(at), Ok(size), Ok(scale)) =
            (main.outer_position(), main.outer_size(), main.scale_factor())
        {
            let at = at.to_logical::<f64>(scale);
            let size = size.to_logical::<f64>(scale);
            let _ = window.set_position(tauri::LogicalPosition::new(
                at.x + 24.0,
                at.y + size.height - HEIGHT - 48.0,
            ));
        }
    }

    // Asked for again here as well as in the config: on Windows the flag did
    // not survive the window being hidden and shown again.
    let _ = window.set_always_on_top(true);
    window
        .show()
        .map_err(|e| format!("The mini window could not be opened: {e}"))?;
    let _ = window.set_focus();

    let _ = app.emit("mini", true);
    Ok(())
}

#[tauri::command]
pub fn close_mini(app: AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        // Hidden, not destroyed: it is the same window every time, and it
        // cannot be built again without losing its bridge.
        let _ = window.hide();
    }
    let _ = app.emit("mini", false);
}

/// Whether the window is up, so the in-app panel knows to stay hidden after a
/// reload of the main window.
#[tauri::command]
pub fn mini_open(app: AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}
