# Test fixtures

`kick-vod-1080p60.m3u8` is the unmodified 1080p60 media playlist of a real
Kick VOD, captured 2026-09-07. It is kept in full rather than trimmed because
its awkward parts are the point:

- 2932 segments over 29355.435 s (8h 09m), so the range math is exercised at
  a realistic scale
- `#EXTINF` durations vary between 2.000 and 11.916 s despite a nominal 10 s
  target, which is what breaks index-by-arithmetic
- one `#EXT-X-DISCONTINUITY`, at segment 1001

It is the regression lock for the bug that motivated parsing playlists
ourselves: assuming 10 s segments puts a 02:00:00 cut 18.7 s late.

The URLs inside have long since expired; nothing here reaches the network.
