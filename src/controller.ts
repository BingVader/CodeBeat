import * as vscode from 'vscode';
import { BeatService } from './beat';
import { activeLineIndex, parseLrc } from './lrc';
import { LyricsService } from './lyrics';
import { extractPalette } from './palette';
import { fetchPreview } from './preview';
import { CommandResult, getPlayback, isPremium, PlayerAction, sendPlayerCommand, SpotifyAuth } from './spotify';
import { ThemeManager, ThemeMode } from './theme';
import { BeatInfo, LyricLine, PanelStatus, Palette, Playback, Track } from './types';
import { CodeBeatView } from './view';

const OFFSETS_KEY = 'codebeat.offsets.v1';
const MAX_OFFSET_MS = 10_000;

/** Owns the polling loop and pushes state to the panel, status bar and theme. */
export class Controller implements vscode.Disposable {
    private timer?: NodeJS.Timeout;
    private statusTimer?: NodeJS.Timeout;
    private disposed = false;

    private status: PanelStatus = 'idle';
    private playback?: Playback;
    private sentAt = 0;
    private lines: LyricLine[] = [];
    private lyricsLoaded = false;
    private beat?: BeatInfo;
    private palette?: Palette;
    private trackId?: string;
    private pausedSince?: number;
    private lastStatusText = '';
    private premium?: boolean;
    private lastPremiumCheck = 0;
    private rescopePrompted = false;
    private controlBusy = false;
    private seeking = false;
    private loop?: { startMs: number; endMs: number };
    private loopTimer?: NodeJS.Timeout;
    private readonly statusBar: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly ctx: vscode.ExtensionContext,
        private readonly auth: SpotifyAuth,
        private readonly lyrics: LyricsService,
        private readonly beats: BeatService,
        private readonly theme: ThemeManager,
        private readonly view: CodeBeatView
    ) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
        this.statusBar.command = 'codebeat.showPanel';
        this.disposables.push(
            this.statusBar,
            this.auth.onDidChange(() => {
                this.premium = undefined;
                this.lastPremiumCheck = 0;
                this.kick();
            }),
            this.view.onMessage(m => this.onViewMessage(m)),
            vscode.window.onDidChangeActiveColorTheme(() => {
                // The user switched light/dark theme: recompute our tint for the new base.
                if (this.theme.isApplied && this.playback?.isPlaying) {
                    void this.applyTheme();
                }
            }),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('codebeat')) {
                    void this.onConfigChanged(e);
                }
            })
        );
    }

    async start(): Promise<void> {
        // If VS Code was killed mid-song last time, put the user's colors back first.
        if (this.theme.isApplied) {
            await this.theme.restore();
        }
        this.statusTimer = setInterval(() => this.updateStatusBar(), 400);
        this.schedule(0);
    }

    async shutdown(): Promise<void> {
        this.disposed = true;
        clearTimeout(this.timer);
        clearInterval(this.statusTimer);
        clearInterval(this.loopTimer);
        await this.theme.restore();
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }

    /** Poll right now (after login or credential changes). */
    kick(): void {
        this.schedule(0);
    }

    /* ---------------- commands ---------------- */
    async adjustOffset(deltaMs: number | 'reset'): Promise<void> {
        if (!this.trackId) {
            return;
        }
        const map = this.ctx.globalState.get<Record<string, number>>(OFFSETS_KEY, {});
        const next = deltaMs === 'reset' ? 0 : Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, (map[this.trackId] ?? 0) + deltaMs));
        if (next === 0) {
            delete map[this.trackId];
        } else {
            delete map[this.trackId];
            map[this.trackId] = next;
        }
        const keys = Object.keys(map);
        for (const k of keys.slice(0, Math.max(0, keys.length - 200))) {
            delete map[k];
        }
        await this.ctx.globalState.update(OFFSETS_KEY, map);
        this.pushState();
    }

    async cycleTheme(): Promise<void> {
        const order: ThemeMode[] = ['off', 'subtle', 'vibrant'];
        const next = order[(order.indexOf(this.themeMode()) + 1) % order.length];
        await vscode.workspace.getConfiguration('codebeat').update('theme.mode', next, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(`CodeBeat theme: ${next}`, 2500);
    }

    /** Previous / play-pause / next. Premium only; the panel hides the buttons for free accounts. */
    async control(action: Exclude<PlayerAction, 'seek'> | 'toggle'): Promise<void> {
        if (!this.playback || this.controlBusy) {
            return;
        }
        if (!this.canControl()) {
            this.explainNoControl();
            return;
        }
        const act: PlayerAction = action === 'toggle' ? (this.playback.isPlaying ? 'pause' : 'play') : action;
        this.controlBusy = true;
        try {
            const result = await sendPlayerCommand(this.auth, act);
            switch (result) {
                case 'ok':
                    if (act === 'play' || act === 'pause') {
                        // Update instantly instead of waiting for the next poll.
                        this.playback = {
                            ...this.playback,
                            progressMs: this.currentProgress(),
                            isPlaying: act === 'play'
                        };
                        this.sentAt = Date.now();
                        this.pausedSince = act === 'pause' ? Date.now() : undefined;
                        this.pushState();
                    }
                    // Spotify needs a moment to switch tracks; resync shortly after.
                    this.schedule(act === 'next' || act === 'previous' ? 600 : 1200);
                    break;
                default:
                    this.handleCommandFailure(result);
            }
        } finally {
            this.controlBusy = false;
        }
    }

    /** Jump to a position in the current song (Premium). */
    async seek(ms: number): Promise<void> {
        const pb = this.playback;
        if (!pb || this.seeking) {
            return;
        }
        if (!this.canControl()) {
            this.explainNoControl();
            return;
        }
        const target = Math.max(0, Math.min(ms, Math.max(0, pb.track.durationMs - 500)));
        this.seeking = true;
        try {
            const result = await sendPlayerCommand(this.auth, 'seek', target);
            if (result === 'ok') {
                if (this.playback?.track.id === pb.track.id) {
                    this.playback = { ...this.playback, progressMs: target };
                    this.sentAt = Date.now();
                    this.pushState();
                }
                this.schedule(1500); // resync with Spotify's real position shortly after
            } else {
                this.handleCommandFailure(result);
            }
        } finally {
            this.seeking = false;
        }
    }

    /** Select a portion of the song and loop it. Pass undefined to clear. */
    setLoop(range?: { startMs: number; endMs: number }): void {
        const dur = this.playback?.track.durationMs ?? 0;
        if (range && dur) {
            const startMs = Math.max(0, Math.min(range.startMs, dur));
            const endMs = Math.max(0, Math.min(range.endMs, dur));
            // Ignore selections too short to be meaningful (accidental clicks).
            this.loop = endMs - startMs >= 1500 ? { startMs, endMs } : undefined;
        } else {
            this.loop = undefined;
        }
        clearInterval(this.loopTimer);
        this.loopTimer = this.loop ? setInterval(() => this.enforceLoop(), 150) : undefined;
        if (this.loop && this.currentProgress() < this.loop.startMs - 500) {
            void this.seek(this.loop.startMs); // start playing from the selection
        }
        this.pushState();
    }

    private enforceLoop(): void {
        const loop = this.loop;
        const pb = this.playback;
        if (!loop || !pb || !pb.isPlaying || this.seeking) {
            return;
        }
        const p = this.currentProgress();
        // Seek a little early to hide Spotify's seek latency. If the user jumped far past the
        // end on their own, leave them alone.
        if (p >= loop.endMs - 150 && p < loop.endMs + 4000) {
            void this.seek(loop.startMs);
        }
    }

    private explainNoControl(): void {
        vscode.window.showInformationMessage(
            this.auth.hasAllScopes()
                ? 'CodeBeat: play/pause, skipping, seeking and looping need Spotify Premium.'
                : 'CodeBeat: log in again to enable playback controls.'
        );
    }

    private handleCommandFailure(result: CommandResult): void {
        switch (result) {
            case 'no-device':
                vscode.window.showWarningMessage('CodeBeat: no active Spotify device. Start playback in Spotify first.');
                break;
            case 'premium':
                this.premium = false;
                this.pushState();
                vscode.window.showInformationMessage('CodeBeat: playback control needs Spotify Premium.');
                break;
            case 'scope':
                this.offerRelogin();
                break;
            case 'rate-limited':
                vscode.window.setStatusBarMessage('CodeBeat: Spotify is rate limiting, try again in a moment', 3000);
                break;
            default:
                vscode.window.setStatusBarMessage('CodeBeat: playback command failed', 3000);
        }
    }

    private canControl(): boolean {
        return this.premium === true && this.auth.hasAllScopes();
    }

    private currentProgress(): number {
        const pb = this.playback;
        if (!pb) {
            return 0;
        }
        const p = pb.progressMs + (pb.isPlaying ? Date.now() - this.sentAt : 0);
        return Math.min(p, pb.track.durationMs || p);
    }

    private offerRelogin(): void {
        if (this.rescopePrompted) {
            return;
        }
        this.rescopePrompted = true;
        void vscode.window
            .showInformationMessage(
                'CodeBeat now has play/pause/next/previous controls for Spotify Premium. Log in again to enable them.',
                'Log in again'
            )
            .then(choice => {
                if (choice) {
                    void vscode.commands.executeCommand('codebeat.login');
                }
            });
    }

    /** Looks up the Premium flag once per login (retrying occasionally if it failed). */
    private async ensurePremium(): Promise<void> {
        if (this.premium !== undefined || Date.now() - this.lastPremiumCheck < 60_000) {
            return;
        }
        if (!this.auth.hasAllScopes()) {
            this.offerRelogin();
            return;
        }
        this.lastPremiumCheck = Date.now();
        this.premium = await isPremium(this.auth);
        this.pushState();
    }

    /* ---------------- polling ---------------- */
    private schedule(ms: number): void {
        if (this.disposed) {
            return;
        }
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.poll(), ms);
    }

    private baseInterval(): number {
        const secs = vscode.workspace.getConfiguration('codebeat').get<number>('pollIntervalSeconds', 4);
        // Poll less when the window is in the background: friendlier to the free-tier rate limit.
        return vscode.window.state.focused ? secs * 1000 : Math.max(secs * 1000, 15_000);
    }

    private async poll(): Promise<void> {
        let next = this.baseInterval();
        try {
            if (!(await this.auth.getClientId())) {
                this.setStatus('setup');
                next = 5000;
            } else if (!(await this.auth.isLoggedIn())) {
                this.setStatus('login');
                next = 5000;
            } else {
                const t0 = Date.now();
                const result = await getPlayback(this.auth);
                const t1 = Date.now();
                switch (result.kind) {
                    case 'playing':
                        this.sentAt = Math.round((t0 + t1) / 2); // progress was measured mid-request
                        await this.onPlaying(result.playback);
                        break;
                    case 'idle':
                        this.onIdle();
                        next = Math.max(next, 8000);
                        break;
                    case 'rate-limited':
                        next = result.retryAfterMs;
                        break;
                    case 'unauthorized':
                        this.setStatus('login');
                        next = 5000;
                        break;
                    default:
                        next = Math.max(next, 8000);
                }
            }
        } catch (err) {
            console.error('CodeBeat poll error:', err);
            next = 10_000;
        }
        this.schedule(next);
    }

    private async onPlaying(pb: Playback): Promise<void> {
        const changed = pb.track.id !== this.trackId;
        this.playback = pb;
        this.setStatus('playing');
        void this.ensurePremium();

        if (pb.isPlaying) {
            this.pausedSince = undefined;
            if (!changed && this.palette && !this.theme.isApplied) {
                void this.applyTheme(); // resumed after the theme was restored
            }
        } else {
            this.pausedSince ??= Date.now();
            this.maybeRestoreTheme();
        }

        if (changed) {
            this.trackId = pb.track.id;
            this.setLoop(undefined); // a loop belongs to one song
            this.lines = [];
            this.lyricsLoaded = false;
            this.beat = this.beats.getCached(pb.track.id);
            this.view.post({ type: 'lyrics', trackId: pb.track.id, loading: true });
            this.pushState();
            void this.loadArt(pb.track);
            void this.loadLyrics(pb.track);
            if (!this.beat) {
                void this.loadPreview(pb.track);
            }
        } else {
            this.pushState();
        }
    }

    private onIdle(): void {
        this.setLoop(undefined);
        this.playback = undefined;
        this.trackId = undefined;
        this.lines = [];
        this.pausedSince ??= Date.now();
        this.setStatus('idle');
        this.maybeRestoreTheme();
    }

    private async loadLyrics(track: Track): Promise<void> {
        const raw = await this.lyrics.get(track);
        if (this.trackId !== track.id) {
            return; // song changed while we were fetching
        }
        this.lines = parseLrc(raw?.synced);
        this.lyricsLoaded = true;
        const found = this.lines.length > 0 || !!raw?.plain;
        this.view.post({
            type: 'lyrics',
            trackId: track.id,
            loading: false,
            found,
            synced: this.lines.length > 0,
            lines: this.lines,
            plain: raw?.plain,
            instrumental: !!raw?.instrumental
        });
    }

    /** Fetches a 30 s preview clip; the panel analyses it to find the song's tempo and beats. */
    private async loadPreview(track: Track): Promise<void> {
        const audio = await fetchPreview(track);
        if (this.trackId !== track.id) {
            return;
        }
        this.view.post({ type: 'preview', trackId: track.id, audio: audio?.base64 ?? null });
    }

    private async loadArt(track: Track): Promise<void> {
        if (!track.artUrl) {
            return;
        }
        try {
            const res = await fetch(track.artUrl, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok || this.trackId !== track.id) {
                return;
            }
            const bytes = Buffer.from(await res.arrayBuffer());
            const palette = extractPalette(bytes);
            if (this.trackId !== track.id) {
                return;
            }
            this.palette = palette;
            this.view.post({
                type: 'art',
                trackId: track.id,
                dataUri: `data:image/jpeg;base64,${bytes.toString('base64')}`,
                palette
            });
            if (this.playback?.isPlaying) {
                void this.applyTheme();
            }
        } catch (err) {
            console.error('CodeBeat: album art failed', err);
        }
    }

    /* ---------------- theme ---------------- */
    private themeMode(): ThemeMode {
        return vscode.workspace.getConfiguration('codebeat').get<ThemeMode>('theme.mode', 'vibrant');
    }

    private async applyTheme(): Promise<void> {
        const mode = this.themeMode();
        if (mode === 'off' || !this.palette) {
            return;
        }
        const kind = vscode.window.activeColorTheme.kind;
        if (kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight) {
            return; // never override high-contrast themes: they exist for accessibility
        }
        await this.theme.apply(this.palette, mode, kind === vscode.ColorThemeKind.Dark);
    }

    private maybeRestoreTheme(): void {
        if (!this.theme.isApplied || this.pausedSince === undefined) {
            return;
        }
        const secs = vscode.workspace.getConfiguration('codebeat').get<number>('theme.restoreAfterSeconds', 60);
        if (Date.now() - this.pausedSince >= secs * 1000) {
            void this.theme.restore();
        }
    }

    private async onConfigChanged(e: vscode.ConfigurationChangeEvent): Promise<void> {
        if (e.affectsConfiguration('codebeat.theme.mode')) {
            if (this.themeMode() === 'off') {
                await this.theme.restore();
            } else if (this.palette && this.playback?.isPlaying) {
                await this.applyTheme();
            }
        }
        if (e.affectsConfiguration('codebeat.statusBar')) {
            this.lastStatusText = '';
            this.updateStatusBar();
        }
        this.pushState();
    }

    /* ---------------- panel / status bar ---------------- */
    private setStatus(status: PanelStatus): void {
        if (status !== this.status) {
            this.status = status;
            if (status !== 'playing') {
                this.statusBar.hide();
                this.lastStatusText = '';
            }
        }
        if (status !== 'playing') {
            this.pushState();
        }
    }

    private currentOffset(): number {
        if (!this.trackId) {
            return 0;
        }
        return this.ctx.globalState.get<Record<string, number>>(OFFSETS_KEY, {})[this.trackId] ?? 0;
    }

    private pushState(): void {
        const cfg = vscode.workspace.getConfiguration('codebeat');
        const pb = this.playback;
        this.view.post({
            type: 'state',
            status: this.status,
            track: pb?.track,
            durationMs: pb?.track.durationMs ?? 0,
            progressMs: pb?.progressMs ?? 0,
            isPlaying: pb?.isPlaying ?? false,
            sentAt: this.sentAt,
            offsetMs: this.currentOffset(),
            beat: this.beat,
            canControl: this.canControl(),
            loop: this.loop ?? null,
            beatPulse: cfg.get<boolean>('beatPulse', true)
        });
    }

    private updateStatusBar(): void {
        const pb = this.playback;
        if (!pb || this.status !== 'playing' || !vscode.workspace.getConfiguration('codebeat').get<boolean>('statusBar', true)) {
            if (this.lastStatusText) {
                this.statusBar.hide();
                this.lastStatusText = '';
            }
            return;
        }
        let text = `${pb.track.name} · ${pb.track.artist}`;
        if (this.lines.length > 0) {
            const ms = pb.progressMs + (pb.isPlaying ? Date.now() - this.sentAt : 0) + this.currentOffset();
            const idx = activeLineIndex(this.lines, ms);
            if (idx >= 0) {
                text = this.lines[idx].text;
            }
        } else if (!this.lyricsLoaded) {
            text = `${pb.track.name} · ${pb.track.artist}`;
        }
        if (text.length > 70) {
            text = text.slice(0, 67) + '…';
        }
        const full = `${pb.isPlaying ? '$(music)' : '$(debug-pause)'} ${text}`;
        if (full !== this.lastStatusText) {
            this.lastStatusText = full;
            this.statusBar.text = full;
            this.statusBar.tooltip = `${pb.track.name} · ${pb.track.artist}\nClick to open CodeBeat`;
            this.statusBar.show();
        }
    }

    private onViewMessage(msg: any): void {
        switch (msg?.type) {
            case 'command':
                if (msg.command === 'codebeat.setup' || msg.command === 'codebeat.login') {
                    void vscode.commands.executeCommand(msg.command);
                }
                break;
            case 'control':
                if (msg.action === 'toggle' || msg.action === 'next' || msg.action === 'previous') {
                    void this.control(msg.action);
                }
                break;
            case 'seek':
                if (Number.isFinite(msg.ms)) {
                    void this.seek(msg.ms);
                }
                break;
            case 'loop':
                if (msg.clear) {
                    this.setLoop(undefined);
                } else if (Number.isFinite(msg.startMs) && Number.isFinite(msg.endMs)) {
                    this.setLoop({ startMs: Math.min(msg.startMs, msg.endMs), endMs: Math.max(msg.startMs, msg.endMs) });
                }
                break;
            case 'offset':
                void this.adjustOffset(msg.reset ? 'reset' : Number(msg.delta) || 0);
                break;
            case 'copy':
                if (typeof msg.text === 'string') {
                    void vscode.env.clipboard.writeText(msg.text);
                    vscode.window.setStatusBarMessage('CodeBeat: lyric line copied', 1500);
                }
                break;
            case 'beat':
                // Result of the panel's automatic analysis. A manual tap always wins.
                if (msg.trackId === this.trackId && this.trackId && this.beat?.source !== 'tap'
                    && Number.isFinite(msg.bpm) && Number.isFinite(msg.phaseMs)) {
                    const info: BeatInfo = {
                        bpm: msg.bpm,
                        phaseMs: msg.phaseMs,
                        source: 'auto',
                        confidence: Number.isFinite(msg.confidence) ? msg.confidence : 0
                    };
                    this.beat = info;
                    void this.beats.save(this.trackId, info);
                    this.pushState();
                }
                break;
            case 'tap':
                if (this.trackId && Number.isFinite(msg.bpm) && Number.isFinite(msg.phaseMs)) {
                    const info: BeatInfo = { bpm: msg.bpm, phaseMs: msg.phaseMs, source: 'tap', confidence: 1 };
                    this.beat = info;
                    void this.beats.save(this.trackId, info);
                }
                break;
        }
    }
}
