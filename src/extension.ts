import * as vscode from 'vscode';
import { BeatService } from './beat';
import { Controller } from './controller';
import { LyricsService } from './lyrics';
import { getRedirectUri, SpotifyAuth } from './spotify';
import { ThemeManager } from './theme';
import { CodeBeatView, VIEW_ID } from './view';

let controller: Controller | undefined;

async function setupClientId(auth: SpotifyAuth): Promise<boolean> {
    const redirectUri = getRedirectUri();
    const choice = await vscode.window.showInformationMessage(
        `CodeBeat needs a free Spotify app. In the Spotify Developer Dashboard create an app and add this Redirect URI: ${redirectUri}`,
        'Copy Redirect URI',
        'Open Dashboard',
        'I have my Client ID'
    );
    if (choice === 'Copy Redirect URI') {
        await vscode.env.clipboard.writeText(redirectUri);
        vscode.window.showInformationMessage(`Redirect URI copied: ${redirectUri}`);
    } else if (choice === 'Open Dashboard') {
        await vscode.env.openExternal(vscode.Uri.parse('https://developer.spotify.com/dashboard'));
    } else if (!choice) {
        return false;
    }

    const id = await vscode.window.showInputBox({
        title: 'CodeBeat: Spotify Client ID',
        prompt: 'Paste the Client ID of your Spotify app (no secret needed)',
        ignoreFocusOut: true,
        validateInput: v => (/^[0-9a-f]{32}$/i.test(v.trim()) ? undefined : 'A Client ID is 32 hex characters')
    });
    if (!id) {
        return false;
    }
    await auth.setClientId(id);
    vscode.window.showInformationMessage('CodeBeat: Client ID saved. Now log in to Spotify.');
    return true;
}

async function handleManualCallbackInput(auth: SpotifyAuth, input: string): Promise<boolean> {
    const raw = input.trim();
    if (!raw) {
        return false;
    }
    try {
        let uri: vscode.Uri;
        if (raw.includes('://')) {
            uri = vscode.Uri.parse(raw);
        } else {
            const query = raw.startsWith('?') ? raw.substring(1) : (raw.startsWith('code=') ? raw : `code=${raw}`);
            uri = vscode.Uri.parse(`http://localhost/callback?${query}`);
        }
        return await auth.handleCallback(uri);
    } catch (e: any) {
        vscode.window.showErrorMessage(`CodeBeat: Invalid callback URL format: ${e?.message || e}`);
        return false;
    }
}

export async function activate(context: vscode.ExtensionContext) {
    const auth = new SpotifyAuth(context);
    const lyrics = new LyricsService(context);
    const beats = new BeatService(context);
    const theme = new ThemeManager(context);
    const view = new CodeBeatView(context.extensionUri);
    const ctl = new Controller(context, auth, lyrics, beats, theme, view);
    controller = ctl;

    const login = async () => {
        if (!(await auth.getClientId()) && !(await setupClientId(auth))) {
            return;
        }
        const started = await auth.beginLogin();
        if (started) {
            const redirectUri = getRedirectUri();
            void vscode.window.showInformationMessage(
                `CodeBeat: Authorizing in browser. Ensure '${redirectUri}' is in your Spotify Dashboard Redirect URIs.`,
                'Copy Redirect URI',
                'Paste Callback URL'
            ).then(action => {
                if (action === 'Copy Redirect URI') {
                    void vscode.env.clipboard.writeText(redirectUri);
                    void vscode.window.showInformationMessage(`Redirect URI copied: ${redirectUri}`);
                } else if (action === 'Paste Callback URL') {
                    void vscode.commands.executeCommand('codebeat.pasteCallback');
                }
            });
        }
    };

    context.subscriptions.push(
        ctl,
        vscode.window.registerWebviewViewProvider(VIEW_ID, view),
        vscode.window.registerUriHandler({
            async handleUri(uri: vscode.Uri) {
                if (await auth.handleCallback(uri)) {
                    vscode.window.showInformationMessage('CodeBeat: Spotify connected!');
                    ctl.kick();
                }
            }
        }),
        vscode.commands.registerCommand('codebeat.setup', () => setupClientId(auth)),
        vscode.commands.registerCommand('codebeat.login', login),
        vscode.commands.registerCommand('codebeat.pasteCallback', async () => {
            const redirectUri = getRedirectUri();
            const input = await vscode.window.showInputBox({
                title: 'CodeBeat: Paste Spotify Callback URL',
                prompt: `Paste the URL from your browser address bar after logging into Spotify`,
                placeHolder: `${redirectUri}?code=...&state=...`,
                ignoreFocusOut: true
            });
            if (!input) {
                return;
            }
            if (await handleManualCallbackInput(auth, input)) {
                vscode.window.showInformationMessage('CodeBeat: Spotify connected!');
                ctl.kick();
            }
        }),
        vscode.commands.registerCommand('codebeat.logout', async () => {
            await auth.logout();
            await theme.restore();
            vscode.window.showInformationMessage('CodeBeat: logged out.');
        }),
        vscode.commands.registerCommand('codebeat.showPanel', () =>
            vscode.commands.executeCommand('workbench.view.extension.codebeat-sidebar')),
        vscode.commands.registerCommand('codebeat.playPause', () => ctl.control('toggle')),
        vscode.commands.registerCommand('codebeat.next', () => ctl.control('next')),
        vscode.commands.registerCommand('codebeat.previous', () => ctl.control('previous')),
        vscode.commands.registerCommand('codebeat.clearLoop', () => ctl.setLoop(undefined)),
        vscode.commands.registerCommand('codebeat.offsetDown', () => ctl.adjustOffset(-500)),
        vscode.commands.registerCommand('codebeat.offsetUp', () => ctl.adjustOffset(500)),
        vscode.commands.registerCommand('codebeat.offsetReset', () => ctl.adjustOffset('reset')),
        vscode.commands.registerCommand('codebeat.cycleTheme', () => ctl.cycleTheme()),
        vscode.commands.registerCommand('codebeat.restoreTheme', async () => {
            await theme.restore();
            vscode.window.showInformationMessage('CodeBeat: original colors restored.');
        })
    );

    await ctl.start();
}

export async function deactivate() {
    await controller?.shutdown();
}
