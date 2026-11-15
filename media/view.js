/* CodeBeat lyrics panel. State arrives from the extension host; all animation runs here. */
(function () {
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const root = document.documentElement;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const el = {
        bg: $('bg'), empty: $('empty'), emptyTitle: $('empty-title'), emptyText: $('empty-text'),
        emptyButton: $('empty-button'), player: $('player'), art: $('art'), title: $('title'),
        artist: $('artist'), fill: $('fill'), lyrics: $('lyrics'), offLabel: $('off-label'),
        bpm: $('bpm'), tap: $('tap')
    };

    let state = null;      // latest 'state' message
    let lyricsMsg = null;  // latest 'lyrics' message
    let artMsg = null;     // latest 'art' message
    let renderedTrack = null;
    let renderedLyricsKey = null;
    let lines = [];        // [{ time, text, el }]
    let activeIdx = -2;
    let lastUserScroll = 0;
    let lastBeatValue = -1;
    let kickAt = 0;
    let emptyCommand = null;
    let previewMsg = null; // latest 'preview' message (30 s clip for beat analysis)
    let lastSecs = -1;
    let rangeStartIdx = null; // first Shift+clicked lyric line of a pending selection
    let dragSel = null;       // live selection while dragging on the timeline
    let tapForced = false;    // user asked to see the manual beat fix

    const fmt = ms => {
        const s = Math.max(0, Math.round((ms || 0) / 1000));
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };

    /* ---------------- messages ---------------- */
    window.addEventListener('message', e => {
        const msg = e.data;
        if (msg.type === 'state') {
            // Keep a beat we just worked out until the host echoes it back.
            if (state && state.beat && !msg.beat && msg.track && state.track && msg.track.id === state.track.id) {
                msg.beat = state.beat;
            }
            state = msg;
            applyState();
        } else if (msg.type === 'lyrics') {
            lyricsMsg = msg;
            renderLyrics();
            maybeAnalyze();
        } else if (msg.type === 'art') {
            artMsg = msg;
            applyArt();
        } else if (msg.type === 'preview') {
            previewMsg = msg;
            maybeAnalyze();
        }
    });

    function applyState() {
        const s = state;
        if (s.status !== 'playing' || !s.track) {
            showEmpty(s.status);
            return;
        }
        el.empty.hidden = true;
        el.player.hidden = false;

        if (renderedTrack !== s.track.id) {
            renderedTrack = s.track.id;
            el.title.textContent = s.track.name;
            el.artist.textContent = s.track.artist;
            el.art.removeAttribute('src');
            tapForced = false;
            rangeStartIdx = null;
            activeIdx = -2;
            applyArt();
            renderLyrics();
        }
        $('transport').hidden = !s.canControl;
        $('seek').classList.toggle('can-seek', !!s.canControl);
        $('seek').title = s.canControl
            ? 'Click to jump · drag to select a portion to loop'
            : 'Seeking needs Spotify Premium';
        $('t-dur').textContent = fmt(s.durationMs);
        renderLoop();
        $('icon-pause').hidden = !s.isPlaying;
        $('icon-play').hidden = s.isPlaying;
        el.offLabel.textContent = (s.offsetMs / 1000).toFixed(1) + 's';
        updateBeatLabel();
        maybeAnalyze();
    }

    function showEmpty(status) {
        el.player.hidden = true;
        el.empty.hidden = false;
        renderedTrack = null;
        el.bg.style.backgroundImage = '';
        root.style.setProperty('--beat', '0');
        const copy = {
            setup: ['Connect Spotify', 'Create a free app in the Spotify Developer Dashboard and paste its Client ID.', 'Setup', 'codebeat.setup'],
            login: ['Almost there', 'Log in to Spotify to see lyrics for whatever is playing.', 'Login to Spotify', 'codebeat.login'],
            idle: ['Nothing playing', 'Play a song on Spotify (desktop, web or phone) and it shows up here.', null, null]
        }[status] || ['CodeBeat', '', null, null];
        el.emptyTitle.textContent = copy[0];
        el.emptyText.textContent = copy[1];
        el.emptyButton.hidden = !copy[2];
        el.emptyButton.textContent = copy[2] || '';
        emptyCommand = copy[3];
    }

    function applyArt() {
        if (!artMsg || !state || !state.track || artMsg.trackId !== state.track.id) {
            return;
        }
        el.art.src = artMsg.dataUri;
        vizGrad = null; // rebuild the visualizer gradient with the new colors
        el.bg.style.backgroundImage = 'url(' + artMsg.dataUri + ')';
        if (artMsg.palette) {
            root.style.setProperty('--accent', artMsg.palette.accent);
            root.style.setProperty('--accent2', artMsg.palette.accent2);
            root.style.setProperty('--dark', artMsg.palette.dark);
        }
    }

    /* ---------------- lyrics rendering ---------------- */
    function renderLyrics() {
        if (!state || !state.track || !lyricsMsg || lyricsMsg.trackId !== state.track.id) {
            if (state && state.track && renderedLyricsKey !== 'loading:' + state.track.id) {
                renderedLyricsKey = 'loading:' + state.track.id;
                showSkeleton();
            }
            return;
        }
        const key = lyricsMsg.trackId + ':' + (lyricsMsg.loading ? 'loading' : lyricsMsg.found ? 'found' : 'none');
        if (key === renderedLyricsKey) {
            return;
        }
        renderedLyricsKey = key;
        lines = [];
        activeIdx = -2;
        el.lyrics.className = '';
        el.lyrics.textContent = '';

        if (lyricsMsg.loading) {
            return showSkeleton();
        }
        if (lyricsMsg.instrumental) {
            return note('♪ Instrumental ♪');
        }
        if (!lyricsMsg.found) {
            return note('No lyrics found for this track.\nLRCLIB is community-maintained, so it may appear later.');
        }

        const frag = document.createDocumentFragment();
        if (lyricsMsg.synced && lyricsMsg.lines.length) {
            for (const l of lyricsMsg.lines) {
                const div = document.createElement('div');
                div.className = 'line';
                div.textContent = l.text;
                const idx = lines.length;
                div.title = 'Click: jump here (Premium) · Shift+click: select a portion to loop · Alt+click: copy';
                div.addEventListener('click', e => onLineClick(e, idx));
                frag.appendChild(div);
                lines.push({ time: l.time, text: l.text, el: div });
            }
        } else {
            el.lyrics.className = 'plain-lyrics';
            for (const text of (lyricsMsg.plain || '').split(/\r?\n/)) {
                const div = document.createElement('div');
                div.className = 'line';
                div.textContent = text || ' ';
                frag.appendChild(div);
            }
        }
        el.lyrics.appendChild(frag);
        el.lyrics.scrollTop = 0;
        renderLoop(); // re-mark lines that fall inside an active loop
    }

    function showSkeleton() {
        lines = [];
        el.lyrics.className = '';
        el.lyrics.innerHTML = '<div class="skeleton"><div></div><div></div><div></div><div></div><div></div><div></div></div>';
    }

    function note(text) {
        const div = document.createElement('div');
        div.className = 'note';
        div.style.whiteSpace = 'pre-line';
        div.textContent = text;
        el.lyrics.appendChild(div);
    }

    function copyLine(div, text) {
        vscode.postMessage({ type: 'copy', text });
        div.classList.add('copied');
        setTimeout(() => div.classList.remove('copied'), 700);
    }

    /* ---------------- animation loop ---------------- */
    function progress() {
        const drift = state.isPlaying ? Date.now() - state.sentAt : 0;
        const p = state.progressMs + drift + state.offsetMs;
        return Math.max(0, state.durationMs ? Math.min(p, state.durationMs) : p);
    }

    function findActive(ms) {
        let lo = 0, hi = lines.length - 1, found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (lines[mid].time <= ms) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        return found;
    }

    function setActive(idx) {
        activeIdx = idx;
        kickAt = performance.now();
        for (let i = 0; i < lines.length; i++) {
            const d = Math.min(Math.abs(i - idx), 6);
            lines[i].el.style.setProperty('--d', d);
            lines[i].el.classList.toggle('active', i === idx);
        }
        if (idx >= 0 && performance.now() - lastUserScroll > 4000) {
            const t = lines[idx].el;
            el.lyrics.scrollTo({
                top: t.offsetTop - el.lyrics.clientHeight / 2 + t.offsetHeight / 2,
                behavior: reduceMotion ? 'auto' : 'smooth'
            });
        }
    }

    function frame() {
        requestAnimationFrame(frame);
        if (!state || state.status !== 'playing') {
            return;
        }
        const p = progress();
        // The bar and clock show the real playback position (p also contains the lyric offset).
        const real = Math.max(0, p - state.offsetMs);
        if (state.durationMs) {
            el.fill.style.transform = 'scaleX(' + Math.min(1, real / state.durationMs).toFixed(4) + ')';
        }
        const secs = Math.floor(real / 1000);
        if (secs !== lastSecs) {
            lastSecs = secs;
            $('t-cur').textContent = fmt(real);
        }
        if (lines.length) {
            const idx = findActive(p);
            if (idx !== activeIdx) {
                setActive(idx);
            }
        }

        let beatValue = 0;
        let offValue = 0;
        const b = state.beat;
        if (state.beatPulse && !reduceMotion && state.isPlaying) {
            if (b) {
                const period = 60000 / b.bpm;
                const phase = (((p - b.phaseMs) % period) + period) % period / period;
                // Unsure about the exact beat position (tempo-only)? Pulse gently instead of
                // risking a confident pulse on the wrong beat.
                const amp = 0.35 + 0.65 * (b.confidence === undefined ? 1 : b.confidence);
                beatValue = Math.exp(-phase * 6) * amp;
                offValue = Math.exp(-(((phase + 0.5) % 1)) * 6) * amp * 0.8;
            } else {
                // No tempo known yet: give a soft kick whenever the lyric line changes.
                beatValue = Math.exp(-(performance.now() - kickAt) / 450) * 0.6;
            }
        }
        drawViz(beatValue, offValue, state.isPlaying && !reduceMotion);
        if (Math.abs(beatValue - lastBeatValue) > 0.01) {
            lastBeatValue = beatValue;
            root.style.setProperty('--beat', beatValue.toFixed(3));
        }
    }
    requestAnimationFrame(frame);

    /* ---------------- seek + loop a portion ---------------- */
    function seekTo(ms) {
        if (!state || !state.canControl) { return; }
        // Move the bar immediately; the host confirms with Spotify and resyncs.
        state.progressMs = ms;
        state.sentAt = Date.now();
        vscode.postMessage({ type: 'seek', ms });
    }

    function setLoop(startMs, endMs) {
        if (endMs - startMs < 1500) { return; }
        state.loop = { startMs, endMs };
        rangeStartIdx = null;
        vscode.postMessage({ type: 'loop', startMs, endMs });
        renderLoop();
    }

    function clearLoop() {
        if (state) { state.loop = null; }
        rangeStartIdx = null;
        vscode.postMessage({ type: 'loop', clear: true });
        renderLoop();
    }

    function onLineClick(e, idx) {
        const l = lines[idx];
        if (e.altKey || !state || !state.canControl) {
            copyLine(l.el, l.text); // free accounts can't seek, so click copies as before
            return;
        }
        if (e.shiftKey) {
            // Two Shift+clicks pick the first and last line of the portion to loop.
            if (rangeStartIdx === null) {
                rangeStartIdx = idx;
                renderLoop();
                return;
            }
            const a = Math.min(rangeStartIdx, idx);
            const b = Math.max(rangeStartIdx, idx);
            const next = lines[b + 1] ? lines[b + 1].time : lines[b].time + 15000;
            const end = Math.min(next, lines[b].time + 15000);
            setLoop(lines[a].time - state.offsetMs, end - state.offsetMs);
            return;
        }
        rangeStartIdx = null;
        renderLoop();
        seekTo(l.time - state.offsetMs); // lyric times include the per-song offset
    }

    function renderLoop() {
        if (!state) { return; }
        const loop = state.loop;
        const dur = state.durationMs;
        const sel = dragSel || loop;
        const range = $('loop-range');
        if (sel && dur) {
            range.style.display = 'block';
            range.style.left = (sel.startMs / dur * 100) + '%';
            range.style.width = ((sel.endMs - sel.startMs) / dur * 100) + '%';
        } else {
            range.style.display = 'none';
        }
        const chip = $('loop-chip');
        chip.hidden = !loop;
        if (loop) {
            chip.textContent = '⟲ ' + fmt(loop.startMs) + ' – ' + fmt(loop.endMs) + '  ✕';
            chip.title = 'Looping this portion. Click to clear (Esc also works).';
        }
        for (let i = 0; i < lines.length; i++) {
            const t = lines[i].time - state.offsetMs;
            lines[i].el.classList.toggle('in-loop', !!loop && t >= loop.startMs - 1 && t < loop.endMs);
            lines[i].el.classList.toggle('range-start', i === rangeStartIdx);
        }
    }

    const seekEl = $('seek');
    let drag = null;
    const xToMs = clientX => {
        const r = $('bar').getBoundingClientRect();
        return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * state.durationMs;
    };
    seekEl.addEventListener('pointerdown', e => {
        if (!state || !state.canControl || !state.durationMs || e.button !== 0) { return; }
        seekEl.setPointerCapture(e.pointerId);
        drag = { x0: e.clientX, ms0: xToMs(e.clientX), moved: false };
        seekEl.classList.add('dragging');
    });
    seekEl.addEventListener('pointermove', e => {
        if (!drag) { return; }
        if (!drag.moved && Math.abs(e.clientX - drag.x0) > 6) { drag.moved = true; }
        if (drag.moved) {
            const ms = xToMs(e.clientX);
            dragSel = { startMs: Math.min(drag.ms0, ms), endMs: Math.max(drag.ms0, ms) };
            renderLoop();
        }
    });
    function endDrag(e, cancelled) {
        if (!drag) { return; }
        const d = drag;
        const sel = dragSel;
        drag = null;
        dragSel = null;
        seekEl.classList.remove('dragging');
        if (!cancelled) {
            if (d.moved && sel) { setLoop(sel.startMs, sel.endMs); }   // drag = select a portion
            else if (!d.moved) { seekTo(xToMs(e.clientX)); }           // click = jump
        }
        renderLoop();
    }
    seekEl.addEventListener('pointerup', e => endDrag(e, false));
    seekEl.addEventListener('pointercancel', e => endDrag(e, true));
    $('loop-chip').addEventListener('click', clearLoop);
    window.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            if (rangeStartIdx !== null) { rangeStartIdx = null; renderLoop(); }
            else if (state && state.loop) { clearLoop(); }
        }
    });

    /* ---------------- beat visualizer ---------------- */
    const vizEl = $('viz');
    const vizCtx = vizEl.getContext('2d');
    let vizGrad = null;

    function drawViz(kick, off, playing) {
        const dpr = window.devicePixelRatio || 1;
        const W = Math.max(1, Math.floor(vizEl.clientWidth * dpr));
        const H = Math.floor(34 * dpr);
        if (vizEl.width !== W || vizEl.height !== H) {
            vizEl.width = W;
            vizEl.height = H;
            vizGrad = null;
        }
        vizCtx.clearRect(0, 0, W, H);
        if (!vizGrad) {
            const cs = getComputedStyle(root);
            vizGrad = vizCtx.createLinearGradient(0, 0, W, 0);
            vizGrad.addColorStop(0, cs.getPropertyValue('--accent').trim() || '#1db954');
            vizGrad.addColorStop(1, cs.getPropertyValue('--accent2').trim() || '#1ed7a0');
        }
        const n = Math.max(12, Math.floor(W / (8 * dpr)));
        const gap = 3 * dpr;
        const bw = (W - gap * (n - 1)) / n;
        const t = performance.now();
        vizCtx.fillStyle = vizGrad;
        for (let i = 0; i < n; i++) {
            const x = i / (n - 1);
            const wobble = playing ? 0.12 * (0.5 + 0.5 * Math.sin(t / 230 + i * 1.7)) : 0;
            // Low bars follow the kick on the beat, high bars the off-beat.
            const energy = (1 - x) * kick + x * off + wobble;
            const h = Math.max(2 * dpr, H * Math.min(1, 0.08 + 0.92 * energy));
            const bx = i * (bw + gap);
            if (vizCtx.roundRect) {
                vizCtx.beginPath();
                vizCtx.roundRect(bx, H - h, bw, h, Math.min(bw / 2, 3 * dpr));
                vizCtx.fill();
            } else {
                vizCtx.fillRect(bx, H - h, bw, h);
            }
        }
    }

    /* ---------------- automatic beat detection ---------------- */
    let analyzedFor = null;
    let analyzing = false;
    let unavailableFor = null; // track whose beat could not be detected

    function updateBeatLabel() {
        const b = state && state.beat;
        if (b) {
            el.bpm.textContent = '♩ ' + Math.round(b.bpm);
            const how = b.source === 'tap' ? 'set by your taps'
                : b.confidence >= 0.7 ? 'detected automatically, locked to the beat'
                : b.confidence > 0 ? 'detected automatically, beat position estimated'
                : 'tempo detected automatically, beat position unknown';
            el.bpm.title = Math.round(b.bpm) + ' BPM: ' + how;
        } else if (analyzing) {
            el.bpm.textContent = 'listening…';
            el.bpm.title = 'Analysing a 30 s preview clip to find the tempo';
        } else if (state && state.track && unavailableFor === state.track.id) {
            el.bpm.textContent = 'no beat';
            el.bpm.title = 'No preview clip was found for this song, so the beat could not be detected. Use Fix beat to tap it in.';
        } else {
            el.bpm.textContent = '';
            el.bpm.title = '';
        }
        // The manual fix is only offered when automatic detection could not lock onto the beat
        // (or the user asks for it by clicking the BPM label).
        const id = state && state.track && state.track.id;
        const unsure = !analyzing && !!state && !!state.track &&
            (b ? b.source === 'auto' && (b.confidence || 0) < 0.7 : analyzedFor === id);
        el.tap.hidden = !(unsure || tapForced);
        el.bpm.classList.toggle('clickable', !!b);
        if (b) { el.bpm.title += ' · click to correct manually'; }
    }

    // The extension host sends a 30 s preview clip; we find tempo and beat position here,
    // once per song, then hand the result back to be cached.
    async function maybeAnalyze() {
        if (!state || !state.track || state.beat || analyzing) { return; }
        const id = state.track.id;
        if (analyzedFor === id || !previewMsg || previewMsg.trackId !== id) { return; }
        if (!previewMsg.audio) { analyzedFor = id; unavailableFor = id; updateBeatLabel(); return; }
        // Wait for lyrics: their timestamps are what lock the beat to the song timeline.
        if (!lyricsMsg || lyricsMsg.trackId !== id || lyricsMsg.loading) { return; }
        analyzedFor = id;
        analyzing = true;
        updateBeatLabel();
        try {
            const bin = atob(previewMsg.audio);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
            const buf = await new OfflineAudioContext(1, 44100, 44100).decodeAudioData(bytes.buffer);
            const mono = new Float32Array(buf.length);
            for (let c = 0; c < buf.numberOfChannels; c++) {
                const ch = buf.getChannelData(c);
                for (let i = 0; i < mono.length; i++) { mono[i] += ch[i] / buf.numberOfChannels; }
            }
            await new Promise(r => setTimeout(r, 0)); // let the UI paint before the heavy part
            const times = lyricsMsg.synced && lyricsMsg.lines ? lyricsMsg.lines.map(l => l.time) : [];
            const r = window.CodeBeatAnalyzer.analyze(mono, buf.sampleRate, times, state.durationMs);
            if (r && state && state.track && state.track.id === id && !state.beat) {
                state.beat = { bpm: r.bpm, phaseMs: r.phaseMs, source: 'auto', confidence: r.confidence };
                vscode.postMessage({ type: 'beat', trackId: id, bpm: r.bpm, phaseMs: r.phaseMs, confidence: r.confidence });
            }
        } catch (err) {
            unavailableFor = id;
            console.error('CodeBeat beat analysis failed', err);
        } finally {
            analyzing = false;
            updateBeatLabel();
        }
    }

    /* ---------------- interactions ---------------- */
    el.lyrics.addEventListener('wheel', () => { lastUserScroll = performance.now(); }, { passive: true });
    el.lyrics.addEventListener('touchmove', () => { lastUserScroll = performance.now(); }, { passive: true });

    el.bpm.addEventListener('click', () => {
        if (state && state.beat) {
            tapForced = !tapForced;
            updateBeatLabel();
        }
    });

    el.emptyButton.addEventListener('click', () => {
        if (emptyCommand) {
            vscode.postMessage({ type: 'command', command: emptyCommand });
        }
    });
    $('prev').addEventListener('click', () => vscode.postMessage({ type: 'control', action: 'previous' }));
    $('play').addEventListener('click', () => vscode.postMessage({ type: 'control', action: 'toggle' }));
    $('next').addEventListener('click', () => vscode.postMessage({ type: 'control', action: 'next' }));
    $('off-down').addEventListener('click', () => vscode.postMessage({ type: 'offset', delta: -500 }));
    $('off-up').addEventListener('click', () => vscode.postMessage({ type: 'offset', delta: 500 }));
    el.offLabel.addEventListener('click', () => vscode.postMessage({ type: 'offset', reset: true }));

    // Tap tempo: average the last few intervals, and snap the pulse phase to the last tap.
    let taps = [];
    el.tap.addEventListener('click', () => {
        if (!state || state.status !== 'playing') {
            return;
        }
        const now = performance.now();
        if (taps.length && now - taps[taps.length - 1].t > 2500) {
            taps = [];
        }
        taps.push({ t: now, p: progress() });
        taps = taps.slice(-8);
        el.tap.textContent = taps.length < 4 ? 'Tap… ' + taps.length : 'Fix beat';
        if (taps.length >= 4) {
            const intervals = [];
            for (let i = 1; i < taps.length; i++) {
                intervals.push(taps[i].t - taps[i - 1].t);
            }
            const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
            const bpm = Math.min(220, Math.max(40, Math.round((60000 / avg) * 10) / 10));
            const period = 60000 / bpm;
            const phaseMs = Math.round(((taps[taps.length - 1].p % period) + period) % period);
            state.beat = { bpm, phaseMs, source: 'tap', confidence: 1 };
            updateBeatLabel();
            vscode.postMessage({ type: 'tap', bpm, phaseMs });
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
