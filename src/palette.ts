import * as jpeg from 'jpeg-js';
import { Palette } from './types';

const DEFAULT_PALETTE: Palette = { accent: '#1db954', accent2: '#1ed7a0', dark: '#0d1f15' };

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) {
        return [0, 0, l];
    }
    const s = d / (1 - Math.abs(2 * l - 1));
    let h: number;
    if (max === r) {
        h = ((g - b) / d) % 6;
    } else if (max === g) {
        h = (b - r) / d + 2;
    } else {
        h = (r - g) / d + 4;
    }
    return [(h * 60 + 360) % 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] =
        h < 60 ? [c, x, 0] :
        h < 120 ? [x, c, 0] :
        h < 180 ? [0, c, x] :
        h < 240 ? [0, x, c] :
        h < 300 ? [x, 0, c] : [c, 0, x];
    const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const hueDistance = (a: number, b: number) => {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
};

/**
 * Picks a vivid accent and a companion from a JPEG album cover using hue buckets weighted by
 * saturation and mid-lightness, so a mostly-black cover with one red object still yields red.
 */
export function extractPalette(jpegBytes: Buffer): Palette {
    let img: { width: number; height: number; data: Uint8Array };
    try {
        img = jpeg.decode(jpegBytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 64 });
    } catch {
        return DEFAULT_PALETTE;
    }

    const BINS = 24;
    const weight = new Array<number>(BINS).fill(0);
    const sumH = new Array<number>(BINS).fill(0);
    const sumS = new Array<number>(BINS).fill(0);
    const sumL = new Array<number>(BINS).fill(0);
    let avgL = 0;
    let n = 0;

    const stride = Math.max(1, Math.floor(Math.min(img.width, img.height) / 80));
    for (let y = 0; y < img.height; y += stride) {
        for (let x = 0; x < img.width; x += stride) {
            const i = (y * img.width + x) * 4;
            const [h, s, l] = rgbToHsl(img.data[i], img.data[i + 1], img.data[i + 2]);
            avgL += l;
            n++;
            if (s < 0.15 || l < 0.12 || l > 0.9) {
                continue;
            }
            const w = Math.pow(s, 1.5) * Math.max(0.05, 1 - Math.abs(l - 0.55) * 1.4);
            const bin = Math.floor(h / (360 / BINS)) % BINS;
            weight[bin] += w;
            sumH[bin] += h * w;
            sumS[bin] += s * w;
            sumL[bin] += l * w;
        }
    }

    const order = weight.map((w, i) => i).sort((a, b) => weight[b] - weight[a]);
    const top = order[0];
    if (weight[top] < 0.5) {
        // Near-greyscale cover: derive a calm tint from overall brightness.
        const l = n ? avgL / n : 0.5;
        return { accent: hslToHex(215, 0.25, clamp(l, 0.4, 0.6)), accent2: hslToHex(215, 0.35, 0.55), dark: hslToHex(215, 0.15, 0.1) };
    }

    const h1 = sumH[top] / weight[top];
    const s1 = sumS[top] / weight[top];
    const l1 = sumL[top] / weight[top];

    const second = order.find(b => weight[b] > weight[top] * 0.2 && hueDistance(sumH[b] / weight[b], h1) >= 40);
    const h2 = second !== undefined ? sumH[second] / weight[second] : h1 + 30;

    return {
        // Clamped so white/black text on the accent stays readable and the colour never goes muddy.
        accent: hslToHex(h1, clamp(s1, 0.55, 0.9), clamp(l1, 0.42, 0.6)),
        accent2: hslToHex(h2, clamp(s1, 0.5, 0.85), clamp(l1, 0.45, 0.62)),
        dark: hslToHex(h1, clamp(s1 * 0.45, 0.2, 0.5), 0.1)
    };
}
