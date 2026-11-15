import * as vscode from 'vscode';
import * as crypto from 'crypto';

export const VIEW_ID = 'codebeat-view';

/** Hosts the lyrics webview. Keeps the latest message of each type so it can be replayed. */
export class CodeBeatView implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private readonly latest = new Map<string, unknown>();
    private readonly messageEmitter = new vscode.EventEmitter<any>();
    readonly onMessage = this.messageEmitter.event;

    constructor(private readonly extensionUri: vscode.Uri) { }

    post(message: { type: string;[k: string]: unknown }): void {
        this.latest.set(message.type, message);
        this.view?.webview.postMessage(message);
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        const media = vscode.Uri.joinPath(this.extensionUri, 'media');
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [media] };
        webviewView.webview.html = this.html(webviewView.webview, media);

        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg?.type === 'ready') {
                this.replay();
            } else {
                this.messageEmitter.fire(msg);
            }
        });
        // The webview script is suspended while hidden, so catch it up when it returns.
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.replay();
            }
        });
        webviewView.onDidDispose(() => {
            if (this.view === webviewView) {
                this.view = undefined;
            }
        });
    }

    private replay(): void {
        for (const msg of this.latest.values()) {
            this.view?.webview.postMessage(msg);
        }
    }

    private html(webview: vscode.Webview, media: vscode.Uri): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.css'));
        const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.js'));
        const beatJs = webview.asWebviewUri(vscode.Uri.joinPath(media, 'beat.js'));
        const csp = [
            `default-src 'none'`,
            `img-src data:`,
            `style-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="bg"></div>
<main id="app">
  <section id="empty" hidden>
    <div id="empty-icon">♪</div>
    <h2 id="empty-title"></h2>
    <p id="empty-text"></p>
    <button id="empty-button" hidden></button>
  </section>
  <section id="player" hidden>
    <header id="card">
      <div id="art-wrap"><img id="art" alt=""></div>
      <div id="meta"><div id="title"></div><div id="artist"></div></div>
    </header>
    <div id="seek" title="">
      <div id="bar"><div id="loop-range"></div><div id="fill"></div></div>
    </div>
    <div id="times"><span id="t-cur">0:00</span><span id="loop-chip" hidden></span><span id="t-dur">0:00</span></div>
    <div id="transport" hidden>
      <button id="prev" class="icon" title="Previous track" aria-label="Previous track">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 6h2v12H6zM9.5 12 18 6v12z"/></svg>
      </button>
      <button id="play" class="icon big" title="Play / Pause" aria-label="Play or pause">
        <svg id="icon-pause" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
        <svg id="icon-play" viewBox="0 0 24 24" width="22" height="22" fill="currentColor" hidden><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button id="next" class="icon" title="Next track" aria-label="Next track">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M16 6h2v12h-2zM6 18V6l8.5 6z"/></svg>
      </button>
    </div>
    <canvas id="viz" height="34" aria-hidden="true"></canvas>
    <div id="lyrics" aria-live="off"></div>
    <footer id="tools">
      <button id="off-down" title="Lyrics earlier (-0.5s)">−</button>
      <span id="off-label" title="Click to reset offset">0.0s</span>
      <button id="off-up" title="Lyrics later (+0.5s)">+</button>
      <span class="sep"></span>
      <button id="tap" title="The beat is detected automatically. Tap along to correct it." hidden>Fix beat</button>
      <span id="bpm"></span>
    </footer>
  </section>
</main>
<script nonce="${nonce}" src="${beatJs}"></script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    }
}
