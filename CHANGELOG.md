# Change Log

All notable changes to the "CodeBeat" extension are documented here.

## [0.1.0]

- Renamed to **CodeBeat** (commands are now `codebeat.*`, redirect URI is `vscode://BingVader.codebeat/callback`).
- Login uses OAuth PKCE: only a Client ID is needed, no Client Secret. Refresh token is kept in SecretStorage.
- Access tokens refresh automatically; the polling loop is a single cancellable timer.
- Local progress interpolation, slower polling in the background, and `Retry-After` handling.
- Fixed LRC parsing (fractional seconds were read as milliseconds); handles multiple timestamps per line.
- Ads, podcasts and idle players no longer crash the poller.
- Lyrics cached locally; LRCLIB lookup uses track duration and falls back to search.
- New panel UI: album-art background, track card, progress bar, skeleton loader, empty states.
- Dynamic theme from album art (`subtle` / `vibrant`) with guaranteed restore of the user's colors.
- Automatic beat detection: tempo from a 30 s preview clip (Deezer / iTunes) analysed in the panel, beat position locked using synced lyric timing, with a beat-driven visualizer. "Fix beat" tap tempo remains as a manual override.
- Stronger song-colored theme (title bar, activity bar, side bar) that adapts to light and dark themes.
- Playback controls (previous / play-pause / next) for Spotify Premium.
- Seek by clicking the timeline or a lyric line, and loop a selected portion (drag on the timeline, or Shift+click two lines). Premium only.
- "Fix beat" is hidden unless automatic beat detection is unsure.
- Status bar lyric line, per-song lyric offset, click-to-copy lines.

## [0.0.1]

- Initial release
