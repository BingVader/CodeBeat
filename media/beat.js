/*
 * CodeBeat beat analyzer. Runs in the panel (and in Node for tests).
 *
 *  1. Spectral-flux onset envelope from the 30 s preview clip.
 *  2. Tempo from the autocorrelation of that envelope (harmonic-weighted, 120 BPM prior).
 *  3. Beat phase inside the clip with a comb filter.
 *  4. The clip comes from an unknown point of the song, so we find where it sits by sliding the
 *     clip over the synced-lyric timestamps: vocal phrases start on onsets, so the right offset
 *     makes lyric times line up with envelope peaks. That turns clip phase into song phase.
 *  5. If that match is not convincing, fall back to the circular mean of lyric times modulo the
 *     beat period, and report lower confidence so the UI pulses more gently.
 */
(function (root) {
    'use strict';

    const N = 1024;
    const HOP = 512;

    function fft(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) { j ^= bit; }
            j ^= bit;
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const half = len >> 1;
            const ang = -2 * Math.PI / len;
            const wr = Math.cos(ang), wi = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let cr = 1, ci = 0;
                for (let k = 0; k < half; k++) {
                    const a = i + k, b = a + half;
                    const vr = re[b] * cr - im[b] * ci;
                    const vi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - vr; im[b] = im[a] - vi;
                    re[a] += vr; im[a] += vi;
                    const ncr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = ncr;
                }
            }
        }
    }

    function onsetEnvelope(x, sr) {
        const frames = Math.max(0, Math.floor((x.length - N) / HOP));
        const win = new Float32Array(N);
        for (let i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); }
        const binHz = sr / N;
        const lo = Math.max(1, Math.floor(30 / binHz));
        const hi = Math.min(N / 2 - 1, Math.floor(8000 / binHz));
        const re = new Float32Array(N), im = new Float32Array(N);
        let prev = new Float32Array(hi + 1);
        const flux = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
            const off = f * HOP;
            for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
            fft(re, im);
            let sum = 0;
            const cur = new Float32Array(hi + 1);
            for (let k = lo; k <= hi; k++) {
                const mag = Math.log(1 + 100 * Math.sqrt(re[k] * re[k] + im[k] * im[k]) / N * 8);
                cur[k] = mag;
                const d = mag - prev[k];
                if (d > 0) { sum += d; }
            }
            flux[f] = f === 0 ? 0 : sum;
            prev = cur;
        }
        // Subtract a moving average so only peaks above the local level remain.
        const env = new Float32Array(frames);
        const w = 21;
        let acc = 0;
        const half = w >> 1;
        for (let i = 0; i < Math.min(frames, half); i++) { acc += flux[i]; }
        for (let i = 0; i < frames; i++) {
            if (i + half < frames) { acc += flux[i + half]; }
            if (i - half - 1 >= 0) { acc -= flux[i - half - 1]; }
            const count = Math.min(frames - 1, i + half) - Math.max(0, i - half) + 1;
            env[i] = Math.max(0, flux[i] - acc / count);
        }
        return { env, fr: sr / HOP };
    }

    function estimateTempo(env, fr) {
        const n = env.length;
        let mean = 0;
        for (let i = 0; i < n; i++) { mean += env[i]; }
        mean /= n || 1;
        const e = new Float32Array(n);
        for (let i = 0; i < n; i++) { e[i] = env[i] - mean; }

        const minLag = Math.floor(fr * 60 / 200);
        const maxLag = Math.ceil(fr * 60 / 60);
        const maxAc = Math.min(n - 2, maxLag * 4);
        const ac = new Float32Array(maxAc + 1);
        for (let lag = 1; lag <= maxAc; lag++) {
            let s = 0;
            for (let i = 0; i + lag < n; i++) { s += e[i] * e[i + lag]; }
            ac[lag] = s / (n - lag);
        }
        const at = l => (l <= maxAc ? ac[l] : 0);

        const score = new Float32Array(maxLag + 2);
        let best = minLag, bestScore = -Infinity, total = 0, cnt = 0;
        for (let lag = minLag; lag <= maxLag; lag++) {
            const bpm = 60 * fr / lag;
            const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.8, 2));
            const s = (at(lag) + 0.5 * at(2 * lag) + 0.25 * at(4 * lag)) * prior;
            score[lag] = s;
            total += Math.max(0, s); cnt++;
            if (s > bestScore) { bestScore = s; best = lag; }
        }
        // Parabolic refinement for sub-frame precision.
        let lagF = best;
        if (best > minLag && best < maxLag) {
            const a = score[best - 1], b = score[best], c = score[best + 1];
            const den = a - 2 * b + c;
            if (den !== 0) { lagF = best + 0.5 * (a - c) / den; }
        }
        let bpm = 60 * fr / lagF;
        while (bpm < 70) { bpm *= 2; }
        while (bpm > 180) { bpm /= 2; }
        const strength = bestScore / ((total / (cnt || 1)) || 1e-9);
        return { bpm, strength };
    }

    function combPhase(env, fr, bpm) {
        const period = fr * 60 / bpm;
        let bestPhase = 0, bestScore = -Infinity;
        for (let ph = 0; ph < period; ph += 0.5) {
            let s = 0;
            for (let t = ph; t < env.length; t += period) {
                const i = Math.round(t);
                if (i < env.length) { s += env[i]; }
            }
            if (s > bestScore) { bestScore = s; bestPhase = ph; }
        }
        return bestPhase / fr; // seconds into the clip
    }

    function gaussianSmooth(env, sigmaFrames) {
        const r = Math.ceil(sigmaFrames * 3);
        const k = new Float32Array(2 * r + 1);
        let sum = 0;
        for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-0.5 * (i / sigmaFrames) ** 2); sum += k[i + r]; }
        const out = new Float32Array(env.length);
        for (let i = 0; i < env.length; i++) {
            let s = 0;
            for (let j = -r; j <= r; j++) {
                const idx = i + j;
                if (idx >= 0 && idx < env.length) { s += env[idx] * k[j + r]; }
            }
            out[i] = s / sum;
        }
        return out;
    }

    /** Where in the song does the clip start? Returns { offsetSec, z } or null. */
    function locateClip(env, fr, clipSec, lyricSec, songSec) {
        if (lyricSec.length < 6) { return null; }
        const smooth = gaussianSmooth(env, Math.max(2, fr * 0.14));
        let overall = 0;
        for (let i = 0; i < smooth.length; i++) { overall += smooth[i]; }
        overall /= smooth.length || 1;

        const maxStart = Math.max(0, songSec - clipSec);
        const step = 0.02;
        const scores = [];
        let best = -Infinity, bestS = 0;
        for (let S = 0; S <= maxStart; S += step) {
            let s = 0, c = 0;
            for (let j = 0; j < lyricSec.length; j++) {
                const t = lyricSec[j] - S;
                if (t < 0.3) { continue; }
                if (t > clipSec - 0.3) { break; }
                s += smooth[Math.min(smooth.length - 1, Math.round(t * fr))];
                c++;
            }
            if (c < 4) { scores.push(NaN); continue; }
            const v = (s / c - overall) * Math.sqrt(c);
            scores.push(v);
            if (v > best) { best = v; bestS = S; }
        }
        const valid = scores.filter(v => !Number.isNaN(v));
        if (valid.length < 20) { return null; }
        let m = 0;
        for (const v of valid) { m += v; }
        m /= valid.length;
        let sd = 0;
        for (const v of valid) { sd += (v - m) * (v - m); }
        sd = Math.sqrt(sd / valid.length) || 1e-9;
        return { offsetSec: bestS, z: (best - m) / sd };
    }

    /** How tightly lyric start times cluster on a beat grid of this period (R in 0..1). */
    function concentration(lyricSec, periodSec) {
        let cs = 0, sn = 0;
        for (const t of lyricSec) {
            const a = 2 * Math.PI * ((t % periodSec) / periodSec);
            cs += Math.cos(a); sn += Math.sin(a);
        }
        const R = Math.sqrt(cs * cs + sn * sn) / lyricSec.length;
        let ang = Math.atan2(sn, cs);
        if (ang < 0) { ang += 2 * Math.PI; }
        return { R, phaseSec: ang / (2 * Math.PI) * periodSec };
    }

    /**
     * The clip gives tempo to ~0.3%, which drifts ~0.2 s over 100 beats. Lyrics span the whole
     * song, so scanning the period around the clip's estimate for the tightest lyric clustering
     * gives a far more precise period and a song-wide phase.
     */
    function refineByLyrics(lyricSec, p0) {
        if (lyricSec.length < 8) { return null; }
        const rs = [];
        let best = { R: -1, p: p0, phaseSec: 0 };
        for (let f = -0.012; f <= 0.012; f += 0.00004) {
            const p = p0 * (1 + f);
            const c = concentration(lyricSec, p);
            rs.push(c.R);
            if (c.R > best.R) { best = { R: c.R, p, phaseSec: c.phaseSec }; }
        }
        // Robust baseline (median / MAD): the true period makes a wide peak that would inflate a
        // plain standard deviation.
        const sorted = rs.slice().sort((a, b) => a - b);
        const med = sorted[sorted.length >> 1];
        const dev = rs.map(r => Math.abs(r - med)).sort((a, b) => a - b);
        const mad = (dev[dev.length >> 1] * 1.4826) || 1e-9;
        const z = (best.R - med) / mad;
        return best.R >= 0.28 && z >= 2.5 ? { ...best, z } : null;
    }

    const circDiff = (a, b, period) => {
        const d = Math.abs(a - b) % period;
        return Math.min(d, period - d);
    };

    /**
     * @param {Float32Array} samples mono PCM of the preview clip
     * @param {number} sr sample rate
     * @param {number[]} lyricTimesMs synced lyric line start times (song time), may be empty
     * @param {number} songMs full track length
     */
    function analyze(samples, sr, lyricTimesMs, songMs) {
        const { env, fr } = onsetEnvelope(samples, sr);
        if (env.length < fr * 8) { return null; }
        const tempo = estimateTempo(env, fr);
        const strength = tempo.strength;
        let periodSec = 60 / tempo.bpm;
        const clipSec = samples.length / sr;
        const lyricSec = (lyricTimesMs || []).map(t => t / 1000).sort((a, b) => a - b);

        // Song-wide grid from lyrics (precise period + phase), if the lyrics cluster on a beat.
        const lyr = refineByLyrics(lyricSec, periodSec);
        if (lyr) { periodSec = lyr.p; }

        // Where the clip sits in the song, for a phase measured from real audio onsets.
        const located = locateClip(env, fr, clipSec, lyricSec, (songMs || 0) / 1000);
        const audioOk = !!located && located.z >= 3;
        const audioPhase = audioOk
            ? (located.offsetSec + combPhase(env, fr, 60 / periodSec)) % periodSec
            : null;

        let phaseSec = 0, confidence = 0, method = 'none';
        if (lyr && audioOk && circDiff(audioPhase, lyr.phaseSec, periodSec) < periodSec * 0.15) {
            phaseSec = audioPhase;                      // two independent estimates agree
            confidence = Math.min(1, 0.75 + Math.min(0.25, lyr.R / 4));
            method = 'audio+lyrics';
        } else if (lyr) {
            phaseSec = lyr.phaseSec;
            confidence = Math.min(0.6, lyr.R);
            method = 'lyrics';
        } else if (audioOk && located.z >= 4) {
            phaseSec = audioPhase;                      // tempo not refined, so it can drift
            confidence = 0.4;
            method = 'audio';
        }
        if (strength < 1.5) { confidence *= 0.6; }
        return {
            bpm: Math.round(60 / periodSec * 100) / 100,
            phaseMs: Math.round(phaseSec * 1000),
            confidence: Math.round(confidence * 100) / 100,
            method,
            z: located ? Math.round(located.z * 10) / 10 : null,
            strength: Math.round(strength * 10) / 10
        };
    }

    const api = { analyze, onsetEnvelope, estimateTempo };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; } else { root.CodeBeatAnalyzer = api; }
})(typeof window !== 'undefined' ? window : globalThis);
