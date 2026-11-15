import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { PollResult, Track } from './types';

export const REDIRECT_URI = 'vscode://BingVader.codebeat/callback';
const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state user-read-private';
const REQUIRED_SCOPES = SCOPES.split(' ');
const KEY_SCOPES = 'codebeat.grantedScopes';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SECRET_CLIENT_ID = 'codebeat.clientId';
const SECRET_REFRESH = 'codebeat.refreshToken';

const b64url = (buf: Buffer) =>
    buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Spotify OAuth using Authorization Code + PKCE: no client secret required. */
export class SpotifyAuth {
    private accessToken?: string;
    private expiresAt = 0;
    private verifier?: string;
    private state?: string;
    private refreshing?: Promise<string | null>;
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;

    constructor(private readonly ctx: vscode.ExtensionContext) { }

    getClientId(): Thenable<string | undefined> {
        return this.ctx.secrets.get(SECRET_CLIENT_ID);
    }

    async setClientId(id: string): Promise<void> {
        await this.ctx.secrets.store(SECRET_CLIENT_ID, id.trim());
        this.changed.fire();
    }

    async isLoggedIn(): Promise<boolean> {
        return !!(await this.ctx.secrets.get(SECRET_REFRESH));
    }

    /** False for logins made before playback controls existed: the user must log in again. */
    hasAllScopes(): boolean {
        const granted = this.ctx.globalState.get<string>(KEY_SCOPES, '').split(' ');
        return REQUIRED_SCOPES.every(s => granted.includes(s));
    }

    /** Opens the browser for consent. Returns false if no Client ID is stored yet. */
    async beginLogin(): Promise<boolean> {
        const clientId = await this.getClientId();
        if (!clientId) {
            return false;
        }
        this.verifier = b64url(crypto.randomBytes(64));
        this.state = b64url(crypto.randomBytes(16));
        const challenge = b64url(crypto.createHash('sha256').update(this.verifier).digest());
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            scope: SCOPES,
            redirect_uri: REDIRECT_URI,
            code_challenge_method: 'S256',
            code_challenge: challenge,
            state: this.state
        });
        await vscode.env.openExternal(
            vscode.Uri.parse(`https://accounts.spotify.com/authorize?${params.toString()}`)
        );
        return true;
    }

    async handleCallback(uri: vscode.Uri): Promise<boolean> {
        const query = new URLSearchParams(uri.query);
        const error = query.get('error');
        if (error) {
            vscode.window.showErrorMessage(`CodeBeat: Spotify declined the login (${error}).`);
            return false;
        }
        const code = query.get('code');
        if (!code || !this.verifier || query.get('state') !== this.state) {
            vscode.window.showErrorMessage(
                'CodeBeat: login response did not match a pending login. Run "CodeBeat: Login to Spotify" again.'
            );
            return false;
        }
        const clientId = await this.getClientId();
        if (!clientId) {
            return false;
        }
        const data = await this.postToken({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: clientId,
            code_verifier: this.verifier
        });
        this.verifier = undefined;
        this.state = undefined;
        if (!data || data === 'revoked') {
            return false;
        }
        await this.storeTokens(data);
        this.changed.fire();
        return true;
    }

    /** Returns a valid access token, refreshing it when it is close to expiry. */
    async getAccessToken(): Promise<string | null> {
        if (this.accessToken && Date.now() < this.expiresAt - 60_000) {
            return this.accessToken;
        }
        if (!this.refreshing) {
            this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
        }
        return this.refreshing;
    }

    /** Forget the cached access token so the next call refreshes it (used after a 401). */
    invalidateAccessToken(): void {
        this.accessToken = undefined;
        this.expiresAt = 0;
    }

    async logout(): Promise<void> {
        this.invalidateAccessToken();
        await this.ctx.secrets.delete(SECRET_REFRESH);
        await this.ctx.globalState.update(KEY_SCOPES, undefined);
        this.changed.fire();
    }

    private async refresh(): Promise<string | null> {
        const refreshToken = await this.ctx.secrets.get(SECRET_REFRESH);
        const clientId = await this.getClientId();
        if (!refreshToken || !clientId) {
            return null;
        }
        const data = await this.postToken({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId
        }, true);
        if (data === 'revoked') {
            await this.ctx.secrets.delete(SECRET_REFRESH);
            this.changed.fire();
            return null;
        }
        if (!data) {
            return null;
        }
        await this.storeTokens(data);
        return this.accessToken ?? null;
    }

    private async storeTokens(data: { access_token: string; expires_in: number; refresh_token?: string; scope?: string }) {
        this.accessToken = data.access_token;
        this.expiresAt = Date.now() + data.expires_in * 1000;
        if (data.scope) {
            await this.ctx.globalState.update(KEY_SCOPES, data.scope);
        }
        if (data.refresh_token) {
            await this.ctx.secrets.store(SECRET_REFRESH, data.refresh_token);
        }
    }

    private async postToken(body: Record<string, string>, silent = false) {
        try {
            const res = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(body).toString(),
                signal: AbortSignal.timeout(10_000)
            });
            const data: any = await res.json();
            if (res.ok && data.access_token) {
                return data as { access_token: string; expires_in: number; refresh_token?: string; scope?: string };
            }
            if (data?.error === 'invalid_grant' && silent) {
                return 'revoked' as const;
            }
            if (!silent) {
                vscode.window.showErrorMessage(
                    `CodeBeat: Spotify error: ${data?.error_description || data?.error || res.status}`
                );
            }
        } catch (err) {
            console.error('CodeBeat: token request failed', err);
        }
        return null;
    }
}

/** One call to "currently playing". Ads, podcasts and idle players are reported as idle. */
export async function getPlayback(auth: SpotifyAuth): Promise<PollResult> {
    const token = await auth.getAccessToken();
    if (!token) {
        return (await auth.isLoggedIn()) ? { kind: 'error' } : { kind: 'unauthorized' };
    }
    let res: Response;
    try {
        res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8_000)
        });
    } catch {
        return { kind: 'error' };
    }

    if (res.status === 204) {
        return { kind: 'idle' };
    }
    if (res.status === 401) {
        auth.invalidateAccessToken();
        return { kind: 'error' };
    }
    if (res.status === 429) {
        const secs = parseInt(res.headers.get('retry-after') ?? '10', 10);
        return { kind: 'rate-limited', retryAfterMs: (Number.isFinite(secs) ? secs : 10) * 1000 + 500 };
    }
    if (!res.ok) {
        return { kind: 'error' };
    }

    let data: any;
    try {
        data = await res.json();
    } catch {
        return { kind: 'idle' };
    }
    const item = data?.item;
    if (!item || data.currently_playing_type !== 'track') {
        return { kind: 'idle' };
    }

    const images: { url: string; width: number }[] = item.album?.images ?? [];
    // Prefer the ~300px image: sharp enough for the panel, light to download.
    const art = images.find(i => i.width === 300) ?? images[1] ?? images[0];
    const track: Track = {
        id: item.id,
        name: item.name,
        artist: (item.artists ?? []).map((a: any) => a.name).join(', '),
        album: item.album?.name ?? '',
        durationMs: item.duration_ms ?? 0,
        artUrl: art?.url
    };
    return {
        kind: 'playing',
        playback: { track, progressMs: data.progress_ms ?? 0, isPlaying: !!data.is_playing }
    };
}

export type PlayerAction = 'play' | 'pause' | 'next' | 'previous' | 'seek';
export type CommandResult = 'ok' | 'premium' | 'no-device' | 'scope' | 'rate-limited' | 'error';

/** True when the account has Spotify Premium (required for playback control). */
export async function isPremium(auth: SpotifyAuth): Promise<boolean | undefined> {
    const token = await auth.getAccessToken();
    if (!token) {
        return undefined;
    }
    try {
        const res = await fetch('https://api.spotify.com/v1/me', {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8_000)
        });
        if (!res.ok) {
            return undefined;
        }
        const data: any = await res.json();
        return data?.product === 'premium';
    } catch {
        return undefined;
    }
}

/** Play, pause, skip. Only works for Premium accounts with an active Spotify device. */
export async function sendPlayerCommand(
    auth: SpotifyAuth,
    action: PlayerAction,
    positionMs = 0
): Promise<CommandResult> {
    const token = await auth.getAccessToken();
    if (!token) {
        return 'error';
    }
    const route: Record<PlayerAction, [string, string]> = {
        play: ['PUT', 'play'],
        pause: ['PUT', 'pause'],
        next: ['POST', 'next'],
        previous: ['POST', 'previous'],
        seek: ['PUT', `seek?position_ms=${Math.max(0, Math.round(positionMs))}`]
    };
    const [method, path] = route[action];
    try {
        const res = await fetch(`https://api.spotify.com/v1/me/player/${path}`, {
            method,
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8_000)
        });
        if (res.ok) {
            return 'ok';
        }
        if (res.status === 429) {
            return 'rate-limited';
        }
        if (res.status === 404) {
            return 'no-device';
        }
        if (res.status === 403) {
            const body: any = await res.json().catch(() => ({}));
            return body?.error?.reason === 'PREMIUM_REQUIRED' ? 'premium' : 'scope';
        }
        return 'error';
    } catch {
        return 'error';
    }
}
