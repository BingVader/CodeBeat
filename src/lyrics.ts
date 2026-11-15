import * as vscode from 'vscode';
import { RawLyrics, Track } from './types';

const UA = 'CodeBeat VS Code extension (https://github.com/BingVader/CodeBeat)';
const CACHE_KEY = 'codebeat.lyricsCache.v1';
const CACHE_MAX = 150;

interface CacheEntry extends RawLyrics {
    savedAt: number;
}

/** Fetches lyrics from LRCLIB (free, no key) with a local cache to spare the network. */
export class LyricsService {
    constructor(private readonly ctx: vscode.ExtensionContext) { }

    async get(track: Track): Promise<RawLyrics | null> {
        const cache = this.ctx.globalState.get<Record<string, CacheEntry>>(CACHE_KEY, {});
        const hit = cache[track.id];
        if (hit) {
            return hit;
        }

        const found = await this.lookup(track);
        if (found) {
            cache[track.id] = { ...found, savedAt: Date.now() };
            const keys = Object.keys(cache);
            if (keys.length > CACHE_MAX) {
                keys.sort((a, b) => cache[a].savedAt - cache[b].savedAt);
                for (const k of keys.slice(0, keys.length - CACHE_MAX)) {
                    delete cache[k];
                }
            }
            await this.ctx.globalState.update(CACHE_KEY, cache);
        }
        return found;
    }

    private async lookup(track: Track): Promise<RawLyrics | null> {
        const durationSec = Math.round(track.durationMs / 1000);

        // 1. Exact match using duration: LRCLIB uses it to pick the right version.
        const exact = await this.fetchJson('get', {
            artist_name: track.artist.split(', ')[0],
            track_name: track.name,
            album_name: track.album,
            duration: String(durationSec)
        });
        if (exact && !Array.isArray(exact)) {
            return toRaw(exact);
        }

        // 2. Fuzzy search: choose the closest duration, preferring synced lyrics.
        const results = await this.fetchJson('search', {
            track_name: track.name,
            artist_name: track.artist.split(', ')[0]
        });
        if (Array.isArray(results) && results.length > 0) {
            const scored = results
                .filter((r: any) => r.syncedLyrics || r.plainLyrics || r.instrumental)
                .map((r: any) => ({
                    r,
                    score: Math.abs((r.duration ?? 0) - durationSec) + (r.syncedLyrics ? 0 : 8)
                }))
                .sort((a, b) => a.score - b.score);
            if (scored.length > 0 && scored[0].score <= 15) {
                return toRaw(scored[0].r);
            }
        }
        return null;
    }

    private async fetchJson(endpoint: string, params: Record<string, string>): Promise<any | null> {
        try {
            const res = await fetch(`https://lrclib.net/api/${endpoint}?${new URLSearchParams(params).toString()}`, {
                headers: { 'User-Agent': UA },
                signal: AbortSignal.timeout(10_000)
            });
            return res.ok ? await res.json() : null;
        } catch {
            return null;
        }
    }
}

function toRaw(r: any): RawLyrics {
    return {
        synced: r.syncedLyrics || undefined,
        plain: r.plainLyrics || undefined,
        instrumental: !!r.instrumental
    };
}
