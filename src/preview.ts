import { Track } from './types';

const MAX_BYTES = 2_000_000;
const UA = 'CodeBeat VS Code extension (https://github.com/BingVader/CodeBeat)';

export interface PreviewAudio {
    base64: string;
}

const normalize = (s: string) =>
    s.toLowerCase()
        .replace(/\(.*?\)|\[.*?\]/g, ' ')
        .replace(/ - .*$/, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

function titleMatches(wanted: string, found: string): boolean {
    const a = normalize(wanted);
    const b = normalize(found);
    return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

async function getJson(url: string): Promise<any | null> {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8_000) });
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

async function download(url: string): Promise<PreviewAudio | undefined> {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
            return undefined;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_BYTES) {
            return undefined;
        }
        return { base64: buf.toString('base64') };
    } catch {
        return undefined;
    }
}

/**
 * Spotify no longer exposes beats or preview URLs to new apps, so we borrow the 30 second
 * preview clip from Deezer (mp3, no key) or iTunes (aac, no key) and analyse it in the panel.
 * Only the clip is used for tempo analysis; nothing is stored.
 */
export async function fetchPreview(track: Track): Promise<PreviewAudio | undefined> {
    const artist = track.artist.split(', ')[0];
    const durationSec = track.durationMs / 1000;
    const cleanName = track.name
        .replace(/\(.*?\)|\[.*?\]/g, ' ')
        .replace(/ - .*$/, ' ')
        .trim();

    // Deezer
    let dz = await getJson(
        `https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${artist}" track:"${track.name}"`)}&limit=8`
    );
    if ((!dz?.data || dz.data.length === 0) && cleanName && cleanName !== track.name) {
        dz = await getJson(
            `https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${artist}" track:"${cleanName}"`)}&limit=8`
        );
    }
    const dzHits: any[] = Array.isArray(dz?.data) ? dz.data.filter((r: any) => r.preview) : [];
    const dzBest =
        dzHits.find(r => titleMatches(track.name, r.title) && Math.abs((r.duration ?? 0) - durationSec) <= 6) ??
        dzHits.find(r => titleMatches(track.name, r.title)) ??
        (cleanName ? dzHits.find(r => titleMatches(cleanName, r.title)) : undefined);
    if (dzBest) {
        const audio = await download(dzBest.preview);
        if (audio) {
            return audio;
        }
    }

    // iTunes fallback
    let it = await getJson(
        `https://itunes.apple.com/search?${new URLSearchParams({ term: `${artist} ${track.name}`, entity: 'song', limit: '8' }).toString()}`
    );
    if ((!it?.results || it.results.length === 0) && cleanName && cleanName !== track.name) {
        it = await getJson(
            `https://itunes.apple.com/search?${new URLSearchParams({ term: `${artist} ${cleanName}`, entity: 'song', limit: '8' }).toString()}`
        );
    }
    const itHits: any[] = Array.isArray(it?.results) ? it.results.filter((r: any) => r.previewUrl) : [];
    const itBest =
        itHits.find(r => titleMatches(track.name, r.trackName) && Math.abs((r.trackTimeMillis ?? 0) / 1000 - durationSec) <= 6) ??
        itHits.find(r => titleMatches(track.name, r.trackName)) ??
        (cleanName ? itHits.find(r => titleMatches(cleanName, r.trackName)) : undefined);
    if (itBest) {
        return download(itBest.previewUrl);
    }
    return undefined;
}
