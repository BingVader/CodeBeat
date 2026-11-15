# 🥁 CodeBeat

Synced Spotify lyrics in your VS Code sidebar, with a theme that follows your song and a lyrics panel that pulses on the beat.

Lyrics come from [LRCLIB](https://lrclib.net) (free, no key). Playback comes from your own free Spotify Developer app. No backend, no third-party server.

## ✨ Features

- **Synced lyrics** that scroll and highlight in time. Click a line to copy it.
- **Dynamic theme.** VS Code takes on the colors of the current album art: status bar, cursor, focus ring and active tab, plus (in `vibrant` mode, the default) the title bar, activity bar, side bar and selection. Works on light and dark themes, never touches high-contrast themes, and your own colors are saved first and restored on pause, logout and exit.
- **Automatic beat.** The panel pulses on the beat and shows a beat-driven visualizer. The tempo is detected automatically for every song, with no tapping needed (see "How the beat works").
- **Playback controls (Spotify Premium).** Previous, play/pause and next buttons in the panel, plus the commands `CodeBeat: Play / Pause`, `Next Track` and `Previous Track` that you can bind to keys. Free accounts simply don't see the buttons.
- **Seek and loop a portion (Spotify Premium).** Click the timeline to jump, or **drag across it to select a portion** that then loops. You can also click a lyric line to jump to it, or **Shift+click two lines** to loop from the first to the last. The loop shows as a chip under the timeline; click it or press Esc to clear. Free accounts can still click a line to copy it.
- **Status bar lyrics.** The current line, always visible. Click to open the panel.
- **Per-song offset.** If the lyrics are slightly early or late, nudge ±0.5 s. It is remembered for that song.
- **Smooth and gentle on the API.** Progress is interpolated locally, polling is slow when the window is in the background, and `429` limits are respected.

## 🚀 Setup (about 2 minutes)

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and **Create app**.
2. Add your editor's **Redirect URI** under app settings:
   - For **Antigravity**: `antigravity-ide://BingVader.codebeat/callback`
   - For **VS Code**: `vscode://BingVader.codebeat/callback`
   *(Tip: you can add both redirect URIs to your Spotify app settings!)*
3. Copy the **Client ID**. (No Client Secret is needed: CodeBeat uses PKCE.)
4. In your editor run **CodeBeat: Login to Spotify**, paste the Client ID when asked, and approve in the browser.
   *(If your browser does not redirect automatically, use the **CodeBeat: Paste Spotify Callback URL** command.)*
5. Play a song on Spotify and open the CodeBeat icon in the Activity Bar.

## 🎚️ Settings

| Setting | Default | |
| --- | --- | --- |
| `codebeat.theme.mode` | `vibrant` | `off` / `subtle` / `vibrant` |
| `codebeat.theme.restoreAfterSeconds` | `60` | Restore your colors after this long paused or stopped |
| `codebeat.beatPulse` | `true` | Pulse in the lyrics panel |
| `codebeat.statusBar` | `true` | Current line in the status bar |
| `codebeat.pollIntervalSeconds` | `4` | Raise it if you hit rate limits |

Useful commands: **Clear Loop Selection**, **Cycle Dynamic Theme**, **Restore My Original Colors**, **Lyrics Earlier/Later**, **Play / Pause**, **Next / Previous Track**.

## 🥁 How the beat works

Spotify removed tempo and beat data from its free API for new apps, so CodeBeat works it out itself:

1. It fetches the free 30 second **preview clip** of the song (Deezer, with iTunes as a fallback). Nothing is stored; it is used only for analysis.
2. The panel analyses the clip's audio for the **tempo** (BPM). This is accurate for most songs.
3. To place the beat on the song's timeline it uses the **synced lyric timestamps**: it locates where the clip sits in the song and cross-checks against the lyric rhythm.
4. The result is cached per song, so each song is analysed once.

How sure it is about the exact beat position shows in the pulse strength. When tempo and position agree (hover the ♩ label to see), the pulse is full strength; when it knows the tempo but not where the beats fall (for example songs with heavily syncopated vocals), it pulses gently instead of guessing. You normally never touch it: the **Fix beat** button only appears when detection could not lock onto the beat (no preview, no synced lyrics, or heavily syncopated vocals), and then tapping along sets it, which is remembered. To correct a song that looks wrong, click the ♩ label to reveal the button.

The theme changes once per song, never on every beat, so your `settings.json` is not rewritten constantly. The beat visuals live in the panel.

## ⚠️ Free Spotify API limits

- Development-mode apps are limited to a small number of allow-listed users, and Spotify may require the app owner to have Premium. Add yourself under **User Management** in the dashboard.
- Playback control (play/pause/next/previous) is a Spotify Premium feature and needs an active Spotify device. If you logged in with an older version, CodeBeat asks you to log in once more to grant the extra permission. Free accounts stay read-only.

## 🔒 Privacy

Your Client ID and tokens are stored in VS Code's SecretStorage (OS keychain). Requests go only to Spotify, LRCLIB (lyrics) and Deezer / iTunes (the 30 s preview clip used for beat detection).

## 📜 License

MIT. See [LICENSE](LICENSE).

Developed with ❤️ by [BingVader](https://github.com/BingVader)
