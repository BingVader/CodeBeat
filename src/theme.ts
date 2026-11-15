import * as vscode from 'vscode';
import { Palette } from './types';

export type ThemeMode = 'off' | 'subtle' | 'vibrant';

const KEY_ORIGINAL = 'codebeat.originalColors';
const KEY_APPLIED = 'codebeat.themeApplied';

type Colors = Record<string, unknown>;

function hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
    const [r, g, b] = hexToRgb(hex).map(v => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Black or white, whichever reads better on `bg`. */
function readableOn(bg: string): string {
    return luminance(bg) > 0.35 ? '#111111' : '#ffffff';
}

function withAlpha(hex: string, alpha: number): string {
    return hex + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

function mix(a: string, b: string, t: number): string {
    const [ar, ag, ab] = hexToRgb(a);
    const [br, bg, bb] = hexToRgb(b);
    const ch = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
    return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

/**
 * Tints VS Code via `workbench.colorCustomizations`. The user's own customizations are saved
 * first and restored on pause/logout/exit (and on next start if VS Code was killed mid-song).
 * Only called on track changes, never on the beat, so settings.json is not churned.
 */
export class ThemeManager {
    private queue: Promise<void> = Promise.resolve();

    constructor(private readonly ctx: vscode.ExtensionContext) { }

    get isApplied(): boolean {
        return this.ctx.globalState.get<boolean>(KEY_APPLIED, false);
    }

    apply(palette: Palette, mode: Exclude<ThemeMode, 'off'>, isDark = true): Promise<void> {
        return this.enqueue(async () => {
            const cfg = vscode.workspace.getConfiguration('workbench');
            if (!this.isApplied) {
                const original = cfg.inspect<Colors>('colorCustomizations')?.globalValue;
                await this.ctx.globalState.update(KEY_ORIGINAL, original ?? null);
                await this.ctx.globalState.update(KEY_APPLIED, true);
            }
            const original = this.ctx.globalState.get<Colors | null>(KEY_ORIGINAL, null) ?? {};
            await cfg.update(
                'colorCustomizations',
                { ...original, ...this.build(palette, mode, isDark) },
                vscode.ConfigurationTarget.Global
            );
        });
    }

    restore(): Promise<void> {
        return this.enqueue(async () => {
            if (!this.isApplied) {
                return;
            }
            const original = this.ctx.globalState.get<Colors | null>(KEY_ORIGINAL, null);
            await vscode.workspace
                .getConfiguration('workbench')
                .update('colorCustomizations', original ?? undefined, vscode.ConfigurationTarget.Global);
            await this.ctx.globalState.update(KEY_APPLIED, false);
            await this.ctx.globalState.update(KEY_ORIGINAL, undefined);
        });
    }

    private enqueue(task: () => Promise<void>): Promise<void> {
        this.queue = this.queue.then(task).catch(err => console.error('CodeBeat theme error:', err));
        return this.queue;
    }

    private build(p: Palette, mode: Exclude<ThemeMode, 'off'>, isDark: boolean): Colors {
        const onAccent = readableOn(p.accent);
        const colors: Colors = {
            'statusBar.background': p.accent,
            'statusBar.foreground': onAccent,
            'statusBar.debuggingBackground': p.accent2,
            'statusBarItem.hoverBackground': withAlpha(onAccent, 0.15),
            'activityBarBadge.background': p.accent,
            'activityBarBadge.foreground': onAccent,
            'tab.activeBorderTop': p.accent,
            'editorCursor.foreground': p.accent,
            'focusBorder': withAlpha(p.accent, 0.8),
            'progressBar.background': p.accent,
            'textLink.foreground': p.accent2,
            'textLink.activeForeground': p.accent
        };

        if (mode === 'vibrant') {
            // Chrome surfaces are tinted from a base that matches the user's light/dark theme,
            // and every foreground is derived from its background so text stays readable.
            const base = isDark ? p.dark : '#ffffff';
            const tint = (amount: number) => mix(base, p.accent, amount);
            const title = tint(isDark ? 0.34 : 0.3);
            const titleInactive = tint(isDark ? 0.16 : 0.14);
            const activity = tint(isDark ? 0.22 : 0.2);
            const side = tint(isDark ? 0.09 : 0.08);
            const tabs = tint(isDark ? 0.13 : 0.1);
            const fgOnActivity = readableOn(activity);
            Object.assign(colors, {
                'titleBar.activeBackground': title,
                'titleBar.activeForeground': readableOn(title),
                'titleBar.inactiveBackground': titleInactive,
                'titleBar.inactiveForeground': withAlpha(readableOn(titleInactive), 0.7),
                'activityBar.background': activity,
                'activityBar.foreground': fgOnActivity,
                'activityBar.inactiveForeground': withAlpha(fgOnActivity, 0.6),
                'activityBar.activeBorder': p.accent,
                'sideBar.background': side,
                'sideBar.foreground': readableOn(side),
                'sideBarSectionHeader.background': tint(isDark ? 0.15 : 0.13),
                'sideBarSectionHeader.foreground': readableOn(tint(isDark ? 0.15 : 0.13)),
                'sideBarTitle.foreground': isDark ? p.accent2 : readableOn(side),
                'editorGroupHeader.tabsBackground': tabs,
                'list.hoverBackground': withAlpha(p.accent, 0.14),
                'list.activeSelectionBackground': withAlpha(p.accent, 0.38),
                'list.inactiveSelectionBackground': withAlpha(p.accent, 0.22),
                'editor.selectionBackground': withAlpha(p.accent, 0.3),
                'editor.lineHighlightBackground': withAlpha(p.accent, 0.08),
                'button.background': p.accent,
                'button.foreground': onAccent
            });
        }
        return colors;
    }
}
