export interface Track {
    id: string;
    name: string;
    artist: string;
    album: string;
    durationMs: number;
    artUrl?: string;
}

export interface Playback {
    track: Track;
    progressMs: number;
    isPlaying: boolean;
}

export type PollResult =
    | { kind: 'playing'; playback: Playback }
    | { kind: 'idle' }
    | { kind: 'unauthorized' }
    | { kind: 'rate-limited'; retryAfterMs: number }
    | { kind: 'error' };

export interface LyricLine {
    time: number;
    text: string;
}

export interface RawLyrics {
    synced?: string;
    plain?: string;
    instrumental: boolean;
}

export interface Palette {
    accent: string;
    accent2: string;
    dark: string;
}

export interface BeatInfo {
    bpm: number;
    /** Offset (ms into the song) of a known beat, used to align the pulse. */
    phaseMs: number;
    source: 'auto' | 'tap';
    /** 0..1: how sure we are the pulse lands on the beat (tempo alone is 0). */
    confidence?: number;
}

export type PanelStatus = 'setup' | 'login' | 'idle' | 'playing';
