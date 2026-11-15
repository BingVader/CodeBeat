import { LyricLine } from './types';

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** Parses LRC text. Handles multiple timestamps per line and 1-3 digit fractions. */
export function parseLrc(raw: string | undefined): LyricLine[] {
    if (!raw) {
        return [];
    }
    const lines: LyricLine[] = [];
    for (const row of raw.split(/\r?\n/)) {
        const stamps: number[] = [];
        let lastIndex = 0;
        TIME_TAG.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TIME_TAG.exec(row)) !== null) {
            const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
            stamps.push((parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000 + frac);
            lastIndex = TIME_TAG.lastIndex;
        }
        if (stamps.length === 0) {
            continue;
        }
        const text = row.slice(lastIndex).trim();
        if (!text) {
            continue;
        }
        for (const time of stamps) {
            lines.push({ time, text });
        }
    }
    return lines.sort((a, b) => a.time - b.time);
}

/** Index of the line active at `ms`, or -1 before the first line. */
export function activeLineIndex(lines: LyricLine[], ms: number): number {
    let lo = 0;
    let hi = lines.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].time <= ms) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}
