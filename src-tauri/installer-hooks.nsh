; Uninstall leaves nothing behind.
;
; Without this, uninstalling KickCut removes the program and keeps everything
; it ever wrote: the ~196 MB FFmpeg it installed, the job records, any segments
; a paused download had already fetched, and the WebView2 profile - which holds
; kick.com cookies, caches and local storage. On a machine that installed this
; once to try it, that is several hundred megabytes and a browser profile
; sitting there forever.
;
; Downloaded videos are not touched: they are written to the folder the user
; chose, never into app data.

!macro NSIS_HOOK_POSTUNINSTALL
  ; A silent uninstall is automation, and automation cannot answer a prompt -
  ; so it gets the clean outcome without being asked.
  IfSilent kickcut_remove_data 0
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Also remove KickCut's downloaded FFmpeg, unfinished downloads and cached data?$\r$\n$\r$\nVideos you have already saved are not affected." \
    IDYES kickcut_remove_data IDNO kickcut_keep_data

  kickcut_remove_data:
    RMDir /r "$APPDATA\${BUNDLEID}"
    RMDir /r "$LOCALAPPDATA\${BUNDLEID}"

  kickcut_keep_data:
!macroend
