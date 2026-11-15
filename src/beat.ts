import * as vscode from 'vscode';
import { BeatInfo } from './types';

const CACHE_KEY = 'codebeat.beats.v2';
const CACHE_MAX = 300;

/** Remembers each song's analysed (or tapped) tempo so a song is only analysed once. */
export class BeatService {
    constructor(private readonly ctx: vscode.ExtensionContext) { }

    getCached(trackId: string): BeatInfo | undefined {
        return this.ctx.globalState.get<Record<string, BeatInfo>>(CACHE_KEY, {})[trackId];
    }

    async save(trackId: string, info: BeatInfo): Promise<void> {
        const cache = this.ctx.globalState.get<Record<string, BeatInfo>>(CACHE_KEY, {});
        delete cache[trackId];
        cache[trackId] = info; // re-insert so insertion order approximates recency
        const keys = Object.keys(cache);
        for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) {
            delete cache[k];
        }
        await this.ctx.globalState.update(CACHE_KEY, cache);
    }
}
