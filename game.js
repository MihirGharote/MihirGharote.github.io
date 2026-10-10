/* =====================================================================
   THE MAGIC STONES & TREASURE GAME
   ---------------------------------------------------------------------
   File map (search for these banners):
     1. CONFIG        - numbers you may want to tweak
     2. AUDIO         - tiny synthesized sound effects (no files needed)
     3. SPRITES       - all pixel art is drawn here, in code
                        (swap any of these for your own PNGs later!)
     4. STONE LIFE    - the crackling energy inside un-used magic stones
     5. FX            - lightning bolts, sparks, coins, embers
     6. GAME          - the rules and state (no drawing in here)
     7. RENDER        - turns game state into DOM + animation
     8. INPUT         - dragging / tapping stones
     9. START
   ===================================================================== */


/* =====================================================================
   1. CONFIG
   ===================================================================== */
const GAME_CONFIG = {
    totalDoors: 16,
    totalStones: 4,
    sfxVolume: 0.35,
    fxPixelSize: 3,        // how chunky the lightning / sparks are (CSS px per art pixel)
    stoneFps: 20,          // frame rate of the crackling energy inside stones
    stoneFlashMs: 420      // how long a stone "fires" before it goes dark
};

// Geometry of one door sprite, in art pixels. Everything else is derived from this.
const DOOR = { w: 26, h: 68, openX: 3, openW: 20, openTop: 14, openBottom: 64 };
DOOR.openH  = DOOR.openBottom - DOOR.openTop;   // 50
DOOR.archR  = DOOR.openW / 2;                   // 10
DOOR.cx     = DOOR.openX + DOOR.archR;          // 13
DOOR.archCy = DOOR.openTop + DOOR.archR;        // 24

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


/* =====================================================================
   2. AUDIO  (Web Audio API synthesizer)
   ===================================================================== */
const AudioEngine = {
    ctx: null,
    muted: false,

    init() {
        if (!this.ctx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) this.ctx = new AudioCtx();
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },

    // One oscillator that slides from freq0 to freq1
    tone(type, freq0, freq1, dur, vol, delay = 0) {
        this.init();
        if (!this.ctx || this.muted) return;
        const t = this.ctx.currentTime + delay;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq0, t);
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq1), t + dur);
        gain.gain.setValueAtTime(GAME_CONFIG.sfxVolume * vol, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.connect(gain); gain.connect(this.ctx.destination);
        osc.start(t); osc.stop(t + dur);
    },

    // A burst of filtered noise (crackle, rumble, scrape...)
    noise(dur, filterType, freq, vol, delay = 0) {
        this.init();
        if (!this.ctx || this.muted) return;
        const t = this.ctx.currentTime + delay;
        const size = Math.floor(this.ctx.sampleRate * dur);
        const buffer = this.ctx.createBuffer(1, size, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        const filter = this.ctx.createBiquadFilter();
        filter.type = filterType;
        filter.frequency.setValueAtTime(freq, t);
        filter.Q.setValueAtTime(3, t);
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(GAME_CONFIG.sfxVolume * vol, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(filter); filter.connect(gain); gain.connect(this.ctx.destination);
        src.start(t); src.stop(t + dur);
    },

    playStoneSelect() { this.tone('sine', 880, 1760, 0.16, 0.6); },
    playStoneDrop()   { this.tone('triangle', 220, 55, 0.22, 0.9); this.noise(0.1, 'lowpass', 600, 0.6); },
    playLightningZap() {
        this.noise(0.32, 'bandpass', 3200, 0.7);
        this.tone('sawtooth', 2200, 180, 0.28, 0.18);
        this.noise(0.12, 'bandpass', 5000, 0.5, 0.12);
    },
    playDoorOpen() {
        this.tone('square', 150, 85, 0.5, 0.12);
        this.noise(0.45, 'bandpass', 520, 0.25);
    },
    playEmptyThud() { this.tone('sine', 120, 45, 0.24, 0.8, 0.45); },
    playError()     { this.tone('square', 170, 110, 0.14, 0.25); },
    playVictoryFanfare() {
        [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f, i) => this.tone('triangle', f, f, 0.5, 0.75, i * 0.08));
        [1568, 1760, 2093, 2637].forEach((f, i) => this.tone('sine', f, f, 0.25, 0.35, 0.5 + i * 0.07));
    }
};


/* =====================================================================
   3. SPRITES  (every picture in the game is drawn here, pixel by pixel)
   ---------------------------------------------------------------------
   Want to use your own art instead? Replace the matching function so it
   returns a canvas (or change the CSS/DOM to use an <img> of your PNG).
   ===================================================================== */
const Sprites = {
    GRID: 28,          // stones, sockets and slots are all 28x28 art pixels
    stones: {},        // filled in by init()
    urls: {},

    /* ---------- small helpers ---------- */
    rng(seed) {                      // tiny seeded random generator (so art is repeatable)
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    },
    hash(a, b) {
        let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    },
    canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
    rect(g, x, y, w, h, color) { g.fillStyle = color; g.fillRect(x, y, w, h); },
    shade(hex, amt) {                // lighten (+) or darken (-) a #rrggbb colour
        const n = parseInt(hex.slice(1), 16);
        const cl = (v) => Math.max(0, Math.min(255, v));
        const r = cl((n >> 16) + amt), g = cl(((n >> 8) & 255) + amt), b = cl((n & 255) + amt);
        return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
    },
    url(canvas) { return canvas.toDataURL(); },

    /* ---------- shapes ---------- */
    // Regular pentagon, point up. Returns its corner points and centre.
    pentagonPoints(size, scale) {
        const R = size * 0.5 * scale;
        const cx = size / 2, cy = size / 2 + 0.0955 * R;
        const pts = [];
        for (let k = 0; k < 5; k++) {
            const a = -Math.PI / 2 + k * (2 * Math.PI / 5);
            pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
        }
        return { pts, cx, cy, R };
    },
    pointInPoly(x, y, pts) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const [xi, yi] = pts[i], [xj, yj] = pts[j];
            if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    },
    // Turn a polygon into a grid of 0/1 pixels (no anti-aliasing = crisp pixel art)
    rasterize(pts, w, h) {
        const m = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = this.pointInPoly(x + 0.5, y + 0.5, pts) ? 1 : 0;
        return m;
    },
    // A lightning-bolt arrow. Tip points RIGHT; pass 'LEFT' to mirror it.
    boltPoints(direction, size) {
        const P = [[0.60, 0], [0.20, 0.54], [0.46, 0.54], [0.34, 1.0], [0.84, 0.40], [0.56, 0.40], [0.78, 0]];
        const T = P.map(([x, y]) => [y, x]);                 // rotate the classic bolt to point right
        const minX = Math.min(...T.map((p) => p[0])), maxX = Math.max(...T.map((p) => p[0]));
        const minY = Math.min(...T.map((p) => p[1])), maxY = Math.max(...T.map((p) => p[1]));
        const k = (size * 0.66) / (maxX - minX);             // scale to ~66% of the stone width
        const cx = size / 2, cy = size / 2 + 1;
        return T.map(([x, y]) => {
            let px = cx + (x - (minX + maxX) / 2) * k;
            const py = cy + (y - (minY + maxY) / 2) * k;
            if (direction === 'LEFT') px = 2 * cx - px;
            return [px, py];
        });
    },

    /* ---------- stone wall textures ---------- */
    wallTile({ w, h, brickW, brickH, seed, colors, mortar }) {
        const c = this.canvas(w, h), g = c.getContext('2d'), r = this.rng(seed);
        this.rect(g, 0, 0, w, h, mortar);
        for (let row = 0; row < h / brickH; row++) {
            const off = (row % 2) * (brickW / 2);
            for (let col = 0; col < w / brickW; col++) {
                const base = colors[Math.floor(r() * colors.length)];
                const specks = Array.from({ length: 5 }, () => [Math.floor(r() * 99), Math.floor(r() * 99), r() < 0.5]);
                for (const dx of [-w, 0, w]) {               // draw 3 times so the tile wraps seamlessly
                    const bx = col * brickW + off + dx + 1, by = row * brickH + 1, bw = brickW - 1, bh = brickH - 1;
                    this.rect(g, bx, by, bw, bh, base);
                    this.rect(g, bx, by, bw, 1, this.shade(base, 22));
                    this.rect(g, bx, by, 1, bh, this.shade(base, 12));
                    this.rect(g, bx, by + bh - 1, bw, 1, this.shade(base, -22));
                    this.rect(g, bx + bw - 1, by, 1, bh, this.shade(base, -14));
                    for (const [sx, sy, light] of specks) {
                        this.rect(g, bx + 1 + (sx % (bw - 2)), by + 1 + (sy % (bh - 2)), 1, 1, this.shade(base, light ? 14 : -14));
                    }
                }
            }
        }
        return c;
    },
    // Smooth carved slab with speckles and a few cracks (used for panels & buttons)
    slabTile(base, seed, size = 64) {
        const c = this.canvas(size, size), g = c.getContext('2d'), r = this.rng(seed);
        this.rect(g, 0, 0, size, size, base);
        for (let i = 0; i < size * size * 0.22; i++) {
            const x = Math.floor(r() * size), y = Math.floor(r() * size);
            this.rect(g, x, y, 1, 1, this.shade(base, Math.round((r() - 0.5) * 26)));
        }
        for (let n = 0; n < 3; n++) {                         // cracks
            let x = Math.floor(r() * size), y = Math.floor(r() * size);
            for (let s = 0; s < 14; s++) {
                this.rect(g, (x + size) % size, (y + size) % size, 1, 1, this.shade(base, -38));
                this.rect(g, (x + 1 + size) % size, (y + 1 + size) % size, 1, 1, this.shade(base, 14));
                x += r() < 0.6 ? 1 : 0; y += r() < 0.7 ? 1 : (r() < 0.5 ? -1 : 0);
            }
        }
        return c;
    },

    /* ---------- the doorway: stone arch, number plate ---------- */
    doorFrame() {
        const D = DOOR, c = this.canvas(D.w, D.h), g = c.getContext('2d');
        const stone = ['#6f6a82', '#666179', '#7a758c', '#615c74'];
        const mortar = '#2b2736', ink = '#17131f';
        const inOpening = (x, y) => {
            if (x < D.openX || x >= D.openX + D.openW || y < D.openTop || y >= D.openBottom) return false;
            if (y >= D.archCy) return true;
            const dx = x + 0.5 - D.cx, dy = y + 0.5 - D.archCy;
            return dx * dx + dy * dy <= D.archR * D.archR;
        };
        for (let y = 0; y < D.h; y++) {
            for (let x = 0; x < D.w; x++) {
                if (inOpening(x, y)) continue;
                const dx = x + 0.5 - D.cx, dy = y + 0.5 - D.archCy, d = Math.hypot(dx, dy);
                let color, mort = false;
                if (y < D.archCy && d <= D.archR + 4.5) {     // arch stones (fan-shaped blocks)
                    const a = Math.atan2(dy, dx) + Math.PI;     // 0..PI across the top
                    const step = Math.PI / 7, sector = Math.min(6, Math.floor(a / step));
                    mort = (a - sector * step) * d < 0.9;
                    color = sector === 3 ? '#8e89a4' : stone[Math.floor(this.hash(sector, 1) * 4)];   // lighter keystone
                } else {                                        // ordinary brick courses
                    const row = Math.floor((y - 1) / 6), off = (row % 2) * 5;
                    mort = (y - 1) % 6 === 0 || (x + off) % 10 === 0;
                    color = stone[Math.floor(this.hash(row, Math.floor((x + off) / 10)) * 4)];
                    if (!mort && (y - 1) % 6 === 1) color = this.shade(color, 16);
                }
                this.rect(g, x, y, 1, 1, mort ? mortar : color);
            }
        }
        // dark inner edge + outer outline
        for (let y = 0; y < D.h; y++) for (let x = 0; x < D.w; x++) {
            if (inOpening(x, y)) continue;
            const touches = inOpening(x - 1, y) || inOpening(x + 1, y) || inOpening(x, y - 1) || inOpening(x, y + 1);
            if (touches || x === 0 || x === D.w - 1 || y === 0) this.rect(g, x, y, 1, 1, ink);
        }
        this.rect(g, 1, 1, D.w - 2, 1, '#8f8aa3');            // top highlight
        this.rect(g, 1, D.openBottom, D.w - 2, 1, '#8f8aa3'); // threshold highlight
        // brass number plate (the number itself is HTML text laid on top)
        this.rect(g, 3, 1, 20, 10, '#3a2208');
        this.rect(g, 4, 2, 18, 8, '#a8742c');
        this.rect(g, 4, 2, 18, 1, '#e6b866');
        this.rect(g, 4, 9, 18, 1, '#6b4416');
        this.rect(g, 4, 2, 1, 8, '#d09a48');
        this.rect(g, 21, 2, 1, 8, '#7d5220');
        for (const [rx, ry] of [[5, 3], [20, 3], [5, 8], [20, 8]]) this.rect(g, rx, ry, 1, 1, '#f6dc9a');
        return c;
    },

    /* ---------- one wooden door leaf (half of a double door) ---------- */
    doorLeaf(seed, mirror) {
        const W = DOOR.openW / 2, H = DOOR.openH;
        const c = this.canvas(W, H), g = c.getContext('2d'), r = this.rng(seed);
        const wood = ['#7b4522', '#8a4f26', '#703d1d', '#935830'];
        let x = 0;
        for (const pw of [3, 3, 4]) {                          // three vertical planks
            const base = wood[Math.floor(r() * wood.length)];
            this.rect(g, x, 0, pw, H, base);
            this.rect(g, x, 0, 1, H, this.shade(base, 18));
            this.rect(g, x + pw - 1, 0, 1, H, this.shade(base, -32));
            for (let i = 0; i < 5; i++) this.rect(g, x + Math.floor(r() * pw), Math.floor(r() * H), 1, 2 + Math.floor(r() * 6), this.shade(base, -16));
            x += pw;
        }
        for (const by of [9, 34]) {                            // iron bands + hinge straps
            this.rect(g, 0, by, W, 3, '#2c2f3a');
            this.rect(g, 0, by, W, 1, '#5a6075');
            this.rect(g, 0, by + 2, W, 1, '#1a1c24');
            this.rect(g, 0, by - 1, 5, 5, '#23262f');
            this.rect(g, 0, by - 1, 5, 1, '#4a4f60');
            this.rect(g, 1, by + 1, 1, 1, '#b8c0d4');
            this.rect(g, 3, by + 1, 1, 1, '#b8c0d4');
            this.rect(g, 7, by + 1, 1, 1, '#b8c0d4');
        }
        // gold ring handle near the middle seam
        this.rect(g, 9, 22, 1, 7, '#23262f');
        for (const [hx, hy] of [[6, 24], [7, 24], [8, 24], [6, 25], [8, 25], [6, 26], [7, 26], [8, 26]]) this.rect(g, hx, hy + 1, 1, 1, '#ffd84a');
        this.rect(g, 7, 26, 1, 1, '#c77a0d');
        this.rect(g, 9, 0, 1, H, '#1d0f06');                   // seam shadow
        this.rect(g, 0, H - 2, W, 2, '#2a1608');               // worn bottom edge
        if (!mirror) return c;
        const c2 = this.canvas(W, H), g2 = c2.getContext('2d');
        g2.translate(W, 0); g2.scale(-1, 1); g2.drawImage(c, 0, 0);
        return c2;
    },

    /* ---------- magic stones, sockets (pentagons!) ---------- */
    isEdge(M, S, x, y) {
        const at = (a, b) => a >= 0 && b >= 0 && a < S && b < S && M[b * S + a] === 1;
        return at(x, y) && !(at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1));
    },

    // style: 'energized' (bright, crackling) or 'spent' (dull, with a lightning-bolt arrow)
    makeStone(style, direction) {
        const S = this.GRID, { pts, cx, cy, R } = this.pentagonPoints(S, 0.8);
        const M = this.rasterize(pts, S, S);
        const c = this.canvas(S, S), g = c.getContext('2d');
        const hot = style === 'energized';
        const pal = hot
            ? { f: ['#45d8ff', '#1d84e0', '#1665c4', '#2fb0f5', '#6af2ff'], seam: '#c9fbff', line: '#0b2a5a' }
            : { f: ['#858da1', '#626878', '#525766', '#737a8d', '#98a0b3'], seam: '#4b5060', line: '#1b1d27' };
        const edge = (x, y) => this.isEdge(M, S, x, y);
        const sector = (2 * Math.PI) / 5;

        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
            if (!M[y * S + x]) continue;
            if (edge(x, y)) { this.rect(g, x, y, 1, 1, pal.line); continue; }
            const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.hypot(dx, dy);
            let a = Math.atan2(dy, dx) + Math.PI / 2; if (a < 0) a += 2 * Math.PI;
            const k = Math.floor(a / sector) % 5, frac = (a % sector) / sector;
            let col = pal.f[k];
            if (edge(x - 1, y) || edge(x, y - 1)) col = this.shade(col, 45);          // lit rim
            else if (edge(x + 1, y) || edge(x, y + 1)) col = this.shade(col, -40);     // shaded rim
            else if (frac * sector * d < 0.75) col = pal.seam;                           // facet lines
            else if (hot && d < R * 0.3) col = '#e2feff';                                // glowing core
            else if (hot && d < R * 0.5) col = this.shade(col, 28);
            else if (!hot) col = this.shade(col, Math.round((this.hash(x, y) - 0.5) * 22)); // rocky grain
            this.rect(g, x, y, 1, 1, col);
        }

        if (!hot && direction) {                               // engrave the lightning-bolt arrow
            const B = this.rasterize(this.boltPoints(direction, S), S, S);
            const inB = (x, y) => x >= 0 && y >= 0 && x < S && y < S && B[y * S + x] === 1;
            for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {     // soft drop shadow
                if (!inB(x, y) && inB(x - 1, y - 1) && M[y * S + x]) this.rect(g, x, y, 1, 1, '#14111c');
            }
            let top = S, bottom = 0;
            for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (inB(x, y)) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
            for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
                if (!inB(x, y)) continue;
                const outline = !(inB(x - 1, y) && inB(x + 1, y) && inB(x, y - 1) && inB(x, y + 1));
                const t = (y - top) / Math.max(1, bottom - top);
                this.rect(g, x, y, 1, 1, outline ? '#5a3600' : (t < 0.5 ? '#ffec7a' : '#ffbe2e'));
            }
        }
        return c;
    },
    // A white-ish copy of the stone shape, used to make energized stones pulse
    makeStoneGlow() {
        const S = this.GRID, M = this.stones.mask, c = this.canvas(S, S), g = c.getContext('2d');
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
            if (M[y * S + x] && !this.isEdge(M, S, x, y)) this.rect(g, x, y, 1, 1, '#d9fdff');
        }
        return c;
    },

    // The carved hole in the wall. glow=true draws only a cyan outline (used when a socket is "active")
    makeIndent(glow) {
        const S = this.GRID, { pts } = this.pentagonPoints(S, 0.94);
        const M = this.rasterize(pts, S, S), c = this.canvas(S, S), g = c.getContext('2d');
        const at = (x, y) => x >= 0 && y >= 0 && x < S && y < S && M[y * S + x] === 1;
        const edge = (x, y) => this.isEdge(M, S, x, y);
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
            if (at(x, y)) {
                const e = edge(x, y), rimTL = edge(x - 1, y) || edge(x, y - 1), rimBR = edge(x + 1, y) || edge(x, y + 1);
                if (glow) {
                    if (e) this.rect(g, x, y, 1, 1, '#3ef0ff');
                    else if (rimTL || rimBR) this.rect(g, x, y, 1, 1, 'rgba(62,240,255,.55)');
                    continue;
                }
                let col;
                if (e) col = '#07050b';
                else if (rimTL) col = '#0c0912';        // shadow inside the top-left wall of the hollow
                else if (rimBR) col = '#575266';        // light catching the bottom-right wall
                else col = this.shade('#201c2b', Math.round((this.hash(x, y) - 0.5) * 8));
                this.rect(g, x, y, 1, 1, col);
            } else if (!glow) {
                if (at(x - 1, y) || at(x, y - 1)) this.rect(g, x, y, 1, 1, '#a39eb8');            // lit lip
                else if (at(x + 1, y) || at(x, y + 1)) this.rect(g, x, y, 1, 1, 'rgba(0,0,0,.5)'); // shadow
            }
        }
        return c;
    },

    /* ---------- treasure chest, rooms behind the doors ---------- */
    chestSprite(seed = 3) {
        const c = this.canvas(20, 20), g = c.getContext('2d'), r = this.rng(seed), ink = '#1b0d06';
        // open lid (back)
        this.rect(g, 3, 0, 14, 9, ink);
        this.rect(g, 4, 1, 12, 7, '#4a2511');
        this.rect(g, 4, 1, 12, 1, '#a0622f');
        this.rect(g, 6, 1, 2, 7, '#c77a0d'); this.rect(g, 12, 1, 2, 7, '#c77a0d');
        // heap of gold
        const golds = ['#ffd84a', '#ffb81f', '#e69a10', '#fff0a0'];
        for (let y = 5; y <= 11; y++) {
            const half = Math.min(8, 2 + (y - 5) * 1.2);
            for (let x = Math.ceil(10 - half); x <= Math.floor(10 + half - 1); x++) this.rect(g, x, y, 1, 1, golds[Math.floor(r() * golds.length)]);
        }
        for (const [col, gx, gy] of [['#ff4d6d', 7, 8], ['#4dd2ff', 12, 7], ['#7dff9a', 10, 6], ['#ff4d6d', 14, 10]]) this.rect(g, gx, gy, 1, 1, col);
        // wooden body
        this.rect(g, 1, 11, 18, 8, ink);
        this.rect(g, 2, 12, 16, 6, '#7a4421');
        this.rect(g, 2, 12, 16, 1, '#a0622f');
        this.rect(g, 2, 15, 16, 1, '#4a2511');
        this.rect(g, 2, 17, 16, 1, '#5c2f17');
        this.rect(g, 2, 12, 3, 6, '#c77a0d'); this.rect(g, 15, 12, 3, 6, '#c77a0d');
        this.rect(g, 2, 12, 1, 6, '#ffd84a'); this.rect(g, 15, 12, 1, 6, '#ffd84a');
        this.rect(g, 8, 13, 4, 4, '#ffd84a'); this.rect(g, 9, 14, 2, 1, ink); this.rect(g, 9, 16, 2, 1, '#c77a0d');
        this.rect(g, 2, 19, 16, 1, 'rgba(0,0,0,.45)');
        return c;
    },

    roomSprite(kind, seed) {
        const W = DOOR.openW, H = DOOR.openH, floorY = H - 9;
        const c = this.canvas(W, H), g = c.getContext('2d'), r = this.rng(seed);
        const wallCols = ['#241f31', '#2a2438', '#201b2c'];
        this.rect(g, 0, 0, W, H, '#120e1a');
        for (let row = 0; row * 5 < floorY; row++) {
            const off = (row % 2) * 4;
            for (let x = -4; x < W; x += 8) this.rect(g, x + off + 1, row * 5 + 1, 7, 4, wallCols[Math.floor(r() * 3)]);
        }
        this.rect(g, 0, floorY, W, H - floorY, '#2c2639');
        for (let x = 0; x < W; x += 7) this.rect(g, x, floorY, 1, H - floorY, '#18131f');
        this.rect(g, 0, floorY, W, 1, '#4a4360');
        this.rect(g, 0, floorY + 4, W, 1, '#18131f');

        if (kind === 'treasure') {
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {          // warm golden light
                const a = Math.max(0, 1 - Math.hypot(x - 10, y - (floorY - 4)) / 26) * 0.55;
                if (a > 0.02) this.rect(g, x, y, 1, 1, `rgba(255,196,80,${a.toFixed(2)})`);
            }
            g.drawImage(this.chestSprite(seed), 0, floorY - 17);
            for (let i = 0; i < 7; i++) this.rect(g, 1 + Math.floor(r() * 18), floorY - 12 + Math.floor(r() * 12), 1, 1, '#fff6b0');
            for (let i = 0; i < 5; i++) this.rect(g, 1 + Math.floor(r() * 18), floorY + 2 + Math.floor(r() * 5), 1, 1, '#ffd84a');
        } else {
            const flip = r() < 0.5, web = 'rgba(210,214,235,.55)';
            const plot = (x, y) => this.rect(g, flip ? W - 1 - x : x, y, 1, 1, web);
            for (const deg of [0, 22, 45, 68, 90]) for (let t = 0; t < 12; t++) plot(Math.round(t * Math.cos(deg * Math.PI / 180)), Math.round(t * Math.sin(deg * Math.PI / 180)));
            for (const rad of [4, 7, 10]) for (let a = 0; a <= 90; a += 6) plot(Math.round(rad * Math.cos(a * Math.PI / 180)), Math.round(rad * Math.sin(a * Math.PI / 180)));
            if (r() < 0.6) {                                                    // a dangling spider
                const sx = flip ? 5 : W - 6, len = 8 + Math.floor(r() * 10);
                this.rect(g, sx, 0, 1, len, 'rgba(210,214,235,.5)');
                this.rect(g, sx - 1, len, 3, 2, '#0b0810');
                this.rect(g, sx - 2, len + 1, 1, 1, '#0b0810'); this.rect(g, sx + 2, len + 1, 1, 1, '#0b0810');
                this.rect(g, sx, len, 1, 1, '#ff5a5a');
            }
            for (let i = 0; i < 3; i++) this.rect(g, 2 + Math.floor(r() * 15), floorY + 2 + Math.floor(r() * 5), 2, 1, '#4a4560');
        }
        g.fillStyle = 'rgba(0,0,0,.4)'; g.fillRect(0, 0, 2, H); g.fillRect(W - 2, 0, 2, H);
        g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(2, 0, 1, H); g.fillRect(W - 3, 0, 1, H);
        return c;
    },

    /* ---------- wall torch (3 animation frames side by side) ---------- */
    torchSheet() {
        const fw = 12, fh = 30, c = this.canvas(fw * 3, fh), g = c.getContext('2d');
        const rows = [[2, 4, 6, 8, 8, 8, 6, 4], [2, 4, 4, 6, 8, 8, 6, 4], [2, 2, 4, 6, 8, 8, 6, 4]];
        const sway = [[0, 0, 0, 0, 0, 0, 0, 0], [1, 1, 0, 0, 0, 0, 0, 0], [-1, -1, 0, 0, 0, 0, 0, 0]];
        for (let f = 0; f < 3; f++) {
            const ox = f * fw;
            this.rect(g, ox + 5, 14, 2, 12, '#5c2f17');
            this.rect(g, ox + 3, 12, 6, 3, '#2c2f3a'); this.rect(g, ox + 3, 12, 6, 1, '#7d8497');
            this.rect(g, ox + 2, 24, 8, 5, '#2c2f3a'); this.rect(g, ox + 2, 24, 8, 1, '#5a6075');
            this.rect(g, ox + 3, 26, 1, 1, '#aab2c5'); this.rect(g, ox + 8, 26, 1, 1, '#aab2c5');
            rows[f].forEach((w, i) => {
                const y = 3 + i, mid = ox + 6 + sway[f][i];
                this.rect(g, mid - w / 2, y, w, 1, '#ff6a2e');
                if (w > 2) this.rect(g, mid - (w - 2) / 2, y, w - 2, 1, '#ff9a2e');
                if (w > 4 && i > 1) this.rect(g, mid - (w - 4) / 2, y, w - 4, 1, '#ffd84a');
                if (w > 6 && i > 3) this.rect(g, mid - (w - 6) / 2, y, w - 6, 1, '#fff6b0');
            });
        }
        return c;
    },

    /* ---------- build everything once, hand textures to the CSS ---------- */
    init() {
        const root = document.documentElement.style;
        const cssUrl = (canvas) => `url(${this.url(canvas)})`;

        root.setProperty('--wall-url', cssUrl(this.wallTile({ w: 64, h: 64, brickW: 16, brickH: 8, seed: 7, mortar: '#14111b', colors: ['#3b3748', '#413c4f', '#37333f', '#453f54', '#3d3a4a'] })));
        root.setProperty('--floor-url', cssUrl(this.wallTile({ w: 48, h: 24, brickW: 16, brickH: 8, seed: 21, mortar: '#17131f', colors: ['#4b4658', '#524c60', '#464152'] })));
        root.setProperty('--slab-url', cssUrl(this.slabTile('#5b566a', 5)));
        root.setProperty('--torch-url', cssUrl(this.torchSheet()));
        root.setProperty('--open-l', (DOOR.openX / DOOR.w * 100) + '%');
        root.setProperty('--open-t', (DOOR.openTop / DOOR.h * 100) + '%');
        root.setProperty('--open-w', (DOOR.openW / DOOR.w * 100) + '%');
        root.setProperty('--open-h', (DOOR.openH / DOOR.h * 100) + '%');

        this.urls.frame = this.url(this.doorFrame());
        this.urls.leafL = [1, 2, 3, 4].map((s) => this.url(this.doorLeaf(s, false)));
        this.urls.leafR = [1, 2, 3, 4].map((s) => this.url(this.doorLeaf(s + 10, true)));

        const S = this.GRID;
        this.stones.energized = this.makeStone('energized');
        this.stones.mask = this.rasterize(this.pentagonPoints(S, 0.8).pts, S, S);
        this.stones.glow = this.makeStoneGlow();
        this.stones.boundary = [];
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (this.isEdge(this.stones.mask, S, x, y)) this.stones.boundary.push([x, y]);
        this.stones.spentUrl = { LEFT: this.url(this.makeStone('spent', 'LEFT')), RIGHT: this.url(this.makeStone('spent', 'RIGHT')) };
        this.stones.indent = this.makeIndent(false);
        this.stones.indentGlow = this.makeIndent(true);
    },

    // Copy a sprite onto a fresh canvas element (a canvas can only live in one place in the page)
    copyTo(source) {
        const c = this.canvas(source.width, source.height);
        c.getContext('2d').drawImage(source, 0, 0);
        return c;
    },

    /* ---------- lightning path helpers (shared by stones and FX) ---------- */
    jagged(a, b, disp, depth) {
        let pts = [a, b];
        for (let d = 0; d < depth; d++) {
            const out = [pts[0]];
            for (let i = 0; i < pts.length - 1; i++) {
                const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
                const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
                const o = (Math.random() - 0.5) * 2 * disp;
                out.push([(ax + bx) / 2 - (dy / len) * o, (ay + by) / 2 + (dx / len) * o], [bx, by]);
            }
            pts = out; disp *= 0.55;
        }
        return pts;
    },
    pixelPath(pts) {            // connect points with 1-pixel steps (Bresenham)
        const out = [];
        for (let i = 0; i < pts.length - 1; i++) {
            let x0 = Math.round(pts[i][0]), y0 = Math.round(pts[i][1]);
            const x1 = Math.round(pts[i + 1][0]), y1 = Math.round(pts[i + 1][1]);
            const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
            let err = dx + dy;
            while (true) {
                out.push([x0, y0]);
                if (x0 === x1 && y0 === y1) break;
                const e2 = 2 * err;
                if (e2 >= dy) { err += dy; x0 += sx; }
                if (e2 <= dx) { err += dx; y0 += sy; }
            }
        }
        return out;
    }
};


/* =====================================================================
   4. STONE LIFE  - electric sparks that run through un-used stones
   ===================================================================== */
const StoneLife = {
    items: new Set(),
    last: 0,
    running: false,

    // Start animating a 28x28 canvas as an energized stone. intensity 1 = calm, 3 = excited.
    attach(canvas, intensity = 1) {
        const item = { canvas, g: canvas.getContext('2d'), bolts: [], next: 0, intensity, phase: Math.random() * 6 };
        this.items.add(item);
        if (!this.running) { this.running = true; requestAnimationFrame((t) => this.loop(t)); }
        return item;
    },
    detach(item) { if (item) this.items.delete(item); },

    loop(t) {
        if (!this.items.size) { this.running = false; return; }
        requestAnimationFrame((n) => this.loop(n));
        if (t - this.last < 1000 / GAME_CONFIG.stoneFps) return;
        this.last = t;
        this.items.forEach((item) => this.draw(item, t));
    },

    makeBolt(t) {      // a short jagged spark between two points on the stone's edge
        const edge = Sprites.stones.boundary, M = Sprites.stones.mask, S = Sprites.GRID;
        const a = edge[Math.floor(Math.random() * edge.length)];
        let b = a;
        for (let i = 0; i < 12 && Math.hypot(b[0] - a[0], b[1] - a[1]) < 12; i++) b = edge[Math.floor(Math.random() * edge.length)];
        const pixels = Sprites.pixelPath(Sprites.jagged(a, b, 3.2, 3)).filter(([x, y]) => x >= 0 && y >= 0 && x < S && y < S && M[y * S + x]);
        return { pixels, born: t, life: 900 + Math.random() * 700 };
    },

    draw(item, t) {
        const g = item.g, S = Sprites.GRID;
        g.clearRect(0, 0, S, S);
        g.drawImage(Sprites.stones.energized, 0, 0);
        g.globalAlpha = 0.04 + 0.24 * ((Math.sin(t / 380 + item.phase) + 1) / 2) * Math.min(1.5, item.intensity);
        g.drawImage(Sprites.stones.glow, 0, 0);
        g.globalAlpha = 1;

        if (t >= item.next) {
            item.bolts.push(this.makeBolt(t));
            item.next = t + (350 + Math.random() * 450) / item.intensity;
        }
        item.bolts = item.bolts.filter((b) => t - b.born < b.life);

        for (const b of item.bolts) {
            const n = b.pixels.length, p = (t - b.born) / b.life;
            const head = Math.min(1, p / 0.65) * n;                         // the spark runs along the path...
            const tail = Math.max(0, head - 10 + (p > 0.65 ? ((p - 0.65) / 0.35) * 10 : 0));   // ...then its tail catches up
            for (let i = Math.floor(tail); i < Math.min(n, Math.floor(head)); i++) {
                const behind = head - i;
                g.fillStyle = behind < 1.5 ? '#ffffff' : behind < 4 ? '#b6fbff' : '#46d6ff';
                g.fillRect(b.pixels[i][0], b.pixels[i][1], 1, 1);
            }
        }
    }
};


/* =====================================================================
   5. FX  - big lightning bolts, sparks, coins and floating embers
   ---------------------------------------------------------------------
   Drawn on a small canvas that the browser scales up, so everything
   looks chunky and pixelated like the rest of the game.
   ===================================================================== */
const FX = {
    cv: null, g: null, w: 0, h: 0,
    bolts: [], parts: [], rings: [],
    last: 0,

    init() {
        this.cv = $('fx');
        this.g = this.cv.getContext('2d');
        this.resize();
        window.addEventListener('resize', () => this.resize());
        requestAnimationFrame((t) => this.loop(t));
    },
    resize() {
        const S = GAME_CONFIG.fxPixelSize;
        this.w = Math.ceil(window.innerWidth / S);
        this.h = Math.ceil(window.innerHeight / S);
        this.cv.width = this.w; this.cv.height = this.h;
    },
    clear() { this.bolts = []; this.parts = []; this.rings = []; },

    /* ----- spawners (all take normal CSS pixel coordinates) ----- */
    bolt(x0, y0, x1, y1) {
        const S = GAME_CONFIG.fxPixelSize;
        [x0, y0, x1, y1] = [x0 / S, y0 / S, x1 / S, y1 / S];
        const len = Math.hypot(x1 - x0, y1 - y0);
        const ang = Math.atan2(y1 - y0, x1 - x0);
        const variants = [];
        for (let v = 0; v < 3; v++) {                      // 3 slightly different shapes -> flicker
            const main = Sprites.pixelPath(Sprites.jagged([x0, y0], [x1, y1], Math.min(14, len * 0.08), 5));
            const branches = [];
            for (let b = 0; b < 4; b++) {
                const at = Math.floor(Math.random() * main.length * 0.85);
                const [bx, by] = main[at];
                const a = ang + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.7);
                const L = 14 + Math.random() * 34;
                branches.push({ at, px: Sprites.pixelPath(Sprites.jagged([bx, by], [bx + Math.cos(a) * L, by + Math.sin(a) * L], 4, 3)) });
            }
            variants.push({ main, branches });
        }
        this.bolts.push({ variants, born: performance.now(), grow: 170, hold: 260, fade: 300 });
    },

    burst(cssX, cssY, o = {}) {
        const S = GAME_CONFIG.fxPixelSize, n = o.n || 20;
        const colors = o.colors || ['#ffffff', '#b6fbff', '#3ef0ff', '#46d6ff'];
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2, sp = (o.speed || 60) * (0.35 + Math.random());
            this.parts.push({
                x: cssX / S, y: cssY / S, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (o.lift || 0),
                g: o.g || 0, life: (o.life || 0.6) * (0.6 + Math.random() * 0.8), age: 0,
                color: colors[Math.floor(Math.random() * colors.length)], size: o.size || 1,
                bounce: o.bounce || 0, floor: o.floor, twinkle: !!o.twinkle
            });
        }
    },
    ring(cssX, cssY) {
        const S = GAME_CONFIG.fxPixelSize;
        this.rings.push({ x: cssX / S, y: cssY / S, born: performance.now(), life: 380, max: 16 });
    },
    coins(cssX, cssY, n = 70) {
        this.burst(cssX, cssY, { n, speed: 130, lift: 120, g: 170, life: 2.2, size: 2, bounce: 0.45, floor: this.h - 4, twinkle: true,
            colors: ['#ffd84a', '#ffb81f', '#fff0a0', '#ffe56b', '#ff4d6d', '#4dd2ff'] });
    },
    confettiRain(n = 90) {
        for (let i = 0; i < n; i++) {
            this.parts.push({
                x: Math.random() * this.w, y: -Math.random() * 40, vx: (Math.random() - 0.5) * 14, vy: 25 + Math.random() * 35,
                g: 4, life: 5, age: 0, size: 2, twinkle: true,
                color: ['#ffd84a', '#fff0a0', '#ff4d6d', '#4dd2ff', '#7dff9a'][Math.floor(Math.random() * 5)]
            });
        }
    },
    dust(cssX, cssY) {
        this.burst(cssX, cssY, { n: 14, speed: 18, lift: 14, g: -6, life: 1.1, size: 2, colors: ['#8e89a4', '#6f6a82', '#a39eb8'] });
    },

    /* ----- main loop ----- */
    loop(t) {
        requestAnimationFrame((n) => this.loop(n));
        if (t - this.last < 28) return;                     // ~30 fps keeps it light and a bit retro
        const dt = Math.min(0.06, (t - this.last) / 1000);
        this.last = t;
        const g = this.g, now = performance.now();
        g.clearRect(0, 0, this.w, this.h);

        // drifting embers (the castle's torches)
        if (!REDUCED_MOTION && Math.random() < 0.12 && this.parts.length < 160) {
            this.parts.push({ x: Math.random() * this.w, y: this.h + 2, vx: (Math.random() - 0.5) * 6, vy: -(8 + Math.random() * 14), g: 0,
                life: 4 + Math.random() * 4, age: 0, size: 1, twinkle: true, ember: true,
                color: ['#ff9a2e', '#ffd84a', '#ff6a2e'][Math.floor(Math.random() * 3)] });
        }

        // particles
        this.parts = this.parts.filter((p) => (p.age += dt) < p.life);
        for (const p of this.parts) {
            p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
            if (p.bounce && p.y > p.floor) { p.y = p.floor; p.vy *= -p.bounce; p.vx *= 0.8; }
            if (p.twinkle && Math.floor(p.age * 12) % 3 === 0) continue;
            g.globalAlpha = p.ember ? 0.7 * (1 - p.age / p.life) : Math.min(1, (p.life - p.age) * 2.5);
            g.fillStyle = p.color;
            g.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
        }
        g.globalAlpha = 1;

        // shock rings
        this.rings = this.rings.filter((r) => now - r.born < r.life);
        for (const r of this.rings) {
            const k = (now - r.born) / r.life, rad = r.max * (1 - Math.pow(1 - k, 2));
            g.globalAlpha = 1 - k; g.fillStyle = '#b6fbff';
            for (let a = 0; a < 40; a++) g.fillRect(Math.round(r.x + Math.cos(a / 40 * 6.283) * rad), Math.round(r.y + Math.sin(a / 40 * 6.283) * rad), 1, 1);
        }
        g.globalAlpha = 1;

        // lightning bolts
        this.bolts = this.bolts.filter((b) => now - b.born < b.grow + b.hold + b.fade);
        for (const b of this.bolts) {
            const age = now - b.born, v = b.variants[Math.floor(age / 50) % 3];
            const prog = Math.min(1, age / b.grow);
            g.globalAlpha = age < b.grow + b.hold ? 1 : 1 - (age - b.grow - b.hold) / b.fade;
            const n = Math.floor(v.main.length * prog);
            this.drawPixels(v.main, n);
            for (const br of v.branches) if (br.at < n) this.drawPixels(br.px, Math.min(br.px.length, (n - br.at) * 1.5));
        }
        g.globalAlpha = 1;
    },

    drawPixels(px, count) {      // three layers: soft glow, cyan body, white-hot core
        const g = this.g;
        g.fillStyle = 'rgba(62,240,255,.10)';
        for (let i = 0; i < count; i++) g.fillRect(px[i][0] - 2, px[i][1] - 2, 5, 5);
        g.fillStyle = 'rgba(62,240,255,.9)';
        for (let i = 0; i < count; i++) { g.fillRect(px[i][0] - 1, px[i][1], 3, 1); g.fillRect(px[i][0], px[i][1] - 1, 1, 3); }
        g.fillStyle = '#ffffff';
        for (let i = 0; i < count; i++) g.fillRect(px[i][0], px[i][1], 1, 1);
    }
};


/* =====================================================================
   6. GAME  - rules and state. (No drawing here; it asks RenderEngine.)
   ===================================================================== */
const Game = {
    treasureDoor: 1,
    usedStones: new Set(),          // which of the 4 stones are spent (0..3)
    selectedStoneIndex: null,
    placedStones: {},               // { gapIndex: 'LEFT' | 'RIGHT' }
    openDoors: new Set(),
    isGameOver: false,
    pendingDoorToOpen: null,
    round: 0,                       // goes up on every reset, so old animations can tell they're stale

    get stonesRemaining() { return GAME_CONFIG.totalStones - this.usedStones.size; },

    init() {
        this.bindEvents();
        this.resetGame();
    },

    resetGame() {
        this.round++;
        this.treasureDoor = Math.floor(Math.random() * GAME_CONFIG.totalDoors) + 1;
        this.usedStones = new Set();
        this.selectedStoneIndex = null;
        this.placedStones = {};
        this.openDoors.clear();
        this.isGameOver = false;
        this.pendingDoorToOpen = null;

        FX.clear();
        RenderEngine.hideModal('victory-modal');
        RenderEngine.hideModal('confirm-modal');
        RenderEngine.buildInventory();
        RenderEngine.buildBoard();
        RenderEngine.updateOracle('Welcome, explorer! One of these 16 doors hides a treasure. Drag a magic stone into a socket between two doors to ask which way to go.');
    },

    // Tap a stone: pick it up (or put it back)
    selectStone(index) {
        if (this.isGameOver || this.usedStones.has(index)) return;
        AudioEngine.playStoneSelect();
        this.selectedStoneIndex = this.selectedStoneIndex === index ? null : index;
        RenderEngine.updateInventory();
        if (this.selectedStoneIndex !== null) RenderEngine.updateOracle('Stone ready! Now choose a socket between two doors.');
    },
    // Used when a drag starts: pick up without toggling
    beginDrag(index) {
        this.selectedStoneIndex = index;
        RenderEngine.updateInventory();
    },
    cancelSelection() {
        this.selectedStoneIndex = null;
        RenderEngine.updateInventory();
    },

    // The big question: "is the treasure left or right of this spot?"  `from` = where the stone flies from.
    placeStoneInGap(gapIndex, from) {
        if (this.isGameOver) return false;

        if (this.placedStones[gapIndex]) {
            AudioEngine.playError();
            RenderEngine.updateOracle('That socket already holds a spent stone. Try a different one!');
            return false;
        }
        let stone = this.selectedStoneIndex;
        if (stone === null) {                                   // no stone picked yet -> use the next free one
            for (let i = 0; i < GAME_CONFIG.totalStones; i++) if (!this.usedStones.has(i)) { stone = i; break; }
        }
        if (stone === null) {
            AudioEngine.playError();
            RenderEngine.updateOracle('You have no stones left! Open a door to look for the treasure.');
            return false;
        }

        const direction = this.treasureDoor <= gapIndex ? 'LEFT' : 'RIGHT';   // the stone always tells the truth
        if (!from) from = RenderEngine.stoneRect(stone);          // tap: the stone flies out of its slot
        this.placedStones[gapIndex] = direction;
        this.usedStones.add(stone);
        this.selectedStoneIndex = null;

        RenderEngine.updateInventory();
        RenderEngine.playPlacement(gapIndex, direction, from);
        return true;
    },

    attemptOpenDoor(doorNum) {
        if (this.isGameOver || this.openDoors.has(doorNum)) return;
        if (this.stonesRemaining > 0) {
            this.pendingDoorToOpen = doorNum;
            RenderEngine.showConfirmModal(doorNum, this.stonesRemaining);
        } else {
            this.executeOpenDoor(doorNum);
        }
    },

    confirmOpenDoor() {
        if (this.pendingDoorToOpen === null) return;
        const num = this.pendingDoorToOpen;
        this.pendingDoorToOpen = null;
        RenderEngine.hideModal('confirm-modal');
        this.executeOpenDoor(num);
    },

    async executeOpenDoor(doorNum) {
        const round = this.round;
        this.openDoors.add(doorNum);
        const isTreasure = doorNum === this.treasureDoor;
        if (isTreasure) this.isGameOver = true;

        AudioEngine.playDoorOpen();
        RenderEngine.openDoor(doorNum, isTreasure);

        if (isTreasure) {
            await sleep(750);
            if (round !== this.round) return;
            RenderEngine.celebrate(doorNum);
            await sleep(1400);
            if (round !== this.round) return;
            RenderEngine.showVictoryModal(this.usedStones.size, this.openDoors.size);
        } else {
            AudioEngine.playEmptyThud();
            const left = this.stonesRemaining;
            RenderEngine.updateOracle(`Door ${doorNum} is empty! ` + (left > 0 ? 'Use another stone or try a different door.' : 'Try a different door.'));
        }
    },

    bindEvents() {
        const click = (id, fn) => $(id).addEventListener('click', fn);
        click('reset-btn', () => { AudioEngine.playStoneSelect(); this.resetGame(); });
        click('modal-reset-btn', () => { AudioEngine.playStoneSelect(); this.resetGame(); });
        click('confirm-proceed-btn', () => this.confirmOpenDoor());
        click('confirm-cancel-btn', () => { AudioEngine.playStoneSelect(); RenderEngine.hideModal('confirm-modal'); this.pendingDoorToOpen = null; });
        click('help-btn', () => { AudioEngine.playStoneSelect(); RenderEngine.showModal('help-modal'); });
        click('help-close-btn', () => { AudioEngine.playStoneSelect(); RenderEngine.hideModal('help-modal'); });
        click('mute-btn', () => {
            AudioEngine.muted = !AudioEngine.muted;
            $('mute-btn').textContent = AudioEngine.muted ? 'Sound: off' : 'Sound: on';
            AudioEngine.playStoneSelect();
        });
        // Browsers only allow sound after the first tap
        const unlock = () => { AudioEngine.init(); document.removeEventListener('pointerdown', unlock); };
        document.addEventListener('pointerdown', unlock);
    }
};


/* =====================================================================
   7. RENDER  - builds the page and plays animations
   ===================================================================== */
const RenderEngine = {
    slots: [],          // { el, item } for each of the 4 stones in the pouch
    typer: null,

    /* ---------- the pouch of stones ---------- */
    buildInventory() {
        this.slots.forEach((s) => StoneLife.detach(s.item));
        this.slots = [];
        const box = $('inventory-container');
        box.innerHTML = '';
        for (let i = 0; i < GAME_CONFIG.totalStones; i++) {
            const el = document.createElement('div');
            el.className = 'slot';
            el.setAttribute('aria-label', `Magic stone ${i + 1}`);
            const indent = Sprites.copyTo(Sprites.stones.indent);
            indent.className = 'indent';
            const wrap = document.createElement('div');
            wrap.className = 'stone-wrap';
            const stoneCanvas = Sprites.canvas(Sprites.GRID, Sprites.GRID);
            wrap.appendChild(stoneCanvas);
            el.append(indent, wrap);
            box.appendChild(el);
            this.slots.push({ el, item: StoneLife.attach(stoneCanvas, 1) });
            Input.bindSlot(el, i);
        }
        this.updateInventory();
    },

    updateInventory() {
        $('stone-counter').textContent = `${Game.stonesRemaining} ${Game.stonesRemaining === 1 ? 'stone' : 'stones'} left`;
        this.slots.forEach((s, i) => {
            const used = Game.usedStones.has(i), selected = Game.selectedStoneIndex === i;
            s.el.classList.toggle('used', used);
            s.el.classList.toggle('selected', selected);
            s.item.intensity = selected ? 2.6 : 1;
        });
        $('board-row').classList.toggle('targeting', Game.selectedStoneIndex !== null);
    },

    stoneRect(index) {
        const r = this.slots[index].el.querySelector('.stone-wrap').getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    },

    /* ---------- the hall of doors ---------- */
    buildBoard() {
        const board = $('board-row');
        board.innerHTML = '';
        board.classList.remove('targeting');
        for (let i = 1; i <= GAME_CONFIG.totalDoors; i++) {
            board.appendChild(this.createDoor(i));
            if (i < GAME_CONFIG.totalDoors) board.appendChild(this.createGap(i));
        }
        $('hall-scroll').scrollLeft = 0;
    },

    createDoor(n) {
        const el = document.createElement('div');
        el.className = 'door';
        el.id = `door-${n}`;
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', `Door ${n}`);
        const v = n % 4;
        el.innerHTML = `
            <div class="room"></div>
            <div class="leaves">
                <div class="leaf left"><img class="pixel" src="${Sprites.urls.leafL[v]}" alt="" draggable="false"></div>
                <div class="leaf right"><img class="pixel" src="${Sprites.urls.leafR[v]}" alt="" draggable="false"></div>
            </div>
            <img class="frame pixel" src="${Sprites.urls.frame}" alt="" draggable="false">
            <div class="number">${n}</div>`;
        el.addEventListener('click', () => Game.attemptOpenDoor(n));
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Game.attemptOpenDoor(n); } });
        return el;
    },

    createGap(i) {
        const el = document.createElement('div');
        el.className = 'gap';
        el.id = `gap-${i}`;
        el.dataset.gap = i;
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', `Socket between door ${i} and door ${i + 1}`);
        const socket = document.createElement('div');
        socket.className = 'socket';
        const base = Sprites.copyTo(Sprites.stones.indent);
        const glow = Sprites.copyTo(Sprites.stones.indentGlow);
        glow.className = 'glow';
        socket.append(base, glow);
        el.appendChild(socket);
        el.addEventListener('click', () => Game.placeStoneInGap(i, null));
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Game.placeStoneInGap(i, null); } });
        return el;
    },

    /* ---------- placing a stone: fly -> zap -> go dark ---------- */
    makeGhost(rect, intensity = 3) {
        const ghost = document.createElement('div');
        ghost.className = 'ghost';
        ghost.style.width = rect.width + 'px';
        ghost.style.height = rect.height + 'px';
        const c = Sprites.canvas(Sprites.GRID, Sprites.GRID);
        ghost.appendChild(c);
        document.body.appendChild(ghost);
        ghost._item = StoneLife.attach(c, intensity);
        ghost.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
        return ghost;
    },

    async playPlacement(gapIndex, direction, from) {
        const round = Game.round;
        const gap = $(`gap-${gapIndex}`);
        gap.classList.add('filled');
        gap.classList.remove('hover');
        const socket = gap.querySelector('.socket');
        const to = socket.getBoundingClientRect();

        // 1. the stone flies to the socket
        const ghost = from.ghost || this.makeGhost(from);          // dragged stones already have a ghost
        const w = from.width, h = from.height;
        const tx = to.left + to.width / 2 - w / 2, ty = to.top + to.height / 2 - h / 2;
        const sx = from.left, sy = from.top;
        const endScale = (to.width * 0.8) / w;
        AudioEngine.playStoneSelect();
        const anim = ghost.animate([
            { transform: `translate(${sx}px, ${sy}px) scale(1)` },
            { transform: `translate(${(sx + tx) / 2}px, ${Math.min(sy, ty) - 50}px) scale(1.15)`, offset: 0.5 },
            { transform: `translate(${tx}px, ${ty}px) scale(${endScale})` }
        ], { duration: 320, easing: 'cubic-bezier(.45,.05,.75,.6)', fill: 'forwards' });
        await anim.finished.catch(() => {});
        StoneLife.detach(ghost._item);
        ghost.remove();
        if (round !== Game.round) return;

        // 2. it lands, sparks, and fires lightning toward the treasure side
        const placed = Sprites.canvas(Sprites.GRID, Sprites.GRID);
        placed.className = 'placed energized';
        socket.appendChild(placed);
        const item = StoneLife.attach(placed, 4);

        const cx = to.left + to.width / 2, cy = to.top + to.height / 2;
        const scroller = $('hall-scroll').getBoundingClientRect();
        const targetX = direction === 'LEFT' ? Math.max(0, scroller.left) : Math.min(window.innerWidth, scroller.right);

        AudioEngine.playStoneDrop();
        AudioEngine.playLightningZap();
        FX.bolt(cx, cy, targetX, cy);
        FX.burst(cx, cy, { n: 26, speed: 70, life: 0.55 });
        FX.ring(cx, cy);
        this.flash(cx, cy);
        this.shake();
        this.popText(cx, cy - 40, direction === 'LEFT' ? 'TO THE LEFT!' : 'TO THE RIGHT!');
        this.shimmerDoors(gapIndex, direction);
        this.updateOracle(`The stone crackles: the treasure is to the ${direction} of this spot!` +
            (Game.stonesRemaining === 0 ? ' That was your last stone.' : ''));

        // 3. the stone spends its energy and goes dark, with the lightning-bolt arrow showing the way
        await sleep(GAME_CONFIG.stoneFlashMs);
        if (round !== Game.round) { StoneLife.detach(item); return; }
        StoneLife.detach(item);
        placed.remove();
        const spent = document.createElement('img');
        spent.className = 'placed settle pixel';
        spent.src = Sprites.stones.spentUrl[direction];
        spent.alt = `Stone points ${direction.toLowerCase()}`;
        spent.draggable = false;
        socket.appendChild(spent);
        FX.burst(cx, cy, { n: 10, speed: 22, life: 0.5, colors: ['#8e89a4', '#6f6a82', '#a39eb8'], size: 1 });
    },

    // A wave of light runs over the doors on the side the stone points to
    shimmerDoors(gapIndex, direction) {
        const doors = [];
        if (direction === 'LEFT') for (let d = gapIndex; d >= 1; d--) doors.push(d);
        else for (let d = gapIndex + 1; d <= GAME_CONFIG.totalDoors; d++) doors.push(d);
        doors.forEach((n, step) => setTimeout(() => {
            const el = $(`door-${n}`);
            if (!el) return;
            el.classList.remove('glow'); void el.offsetWidth; el.classList.add('glow');
            setTimeout(() => el.classList.remove('glow'), 650);
        }, 120 + step * 55));
    },

    /* ---------- opening a door ---------- */
    openDoor(n, isTreasure) {
        const el = $(`door-${n}`);
        const room = el.querySelector('.room');
        room.innerHTML = '';
        room.appendChild(Sprites.roomSprite(isTreasure ? 'treasure' : 'empty', n * 13 + 5));   // the secret is only drawn NOW
        el.classList.add('open', isTreasure ? 'treasure' : 'empty');
        el.removeAttribute('tabindex');
        el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        const r = el.getBoundingClientRect();
        setTimeout(() => FX.dust(r.left + r.width / 2, r.bottom - r.height * 0.1), 250);
    },

    celebrate(n) {
        const r = $(`door-${n}`).getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height * 0.6;
        AudioEngine.playVictoryFanfare();
        FX.coins(cx, cy, 120);
        FX.ring(cx, cy);
        this.flash(cx, cy);
        this.updateOracle(`You found it! The treasure was behind door ${n}!`);
    },

    /* ---------- little juicy things ---------- */
    flash(x, y) {
        const f = $('flash');
        f.style.setProperty('--fx', (x / window.innerWidth * 100) + '%');
        f.style.setProperty('--fy', (y / window.innerHeight * 100) + '%');
        f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
    },
    shake() {
        if (REDUCED_MOTION) return;
        const hall = $('hall');
        hall.classList.remove('shake'); void hall.offsetWidth; hall.classList.add('shake');
    },
    popText(x, y, text) {
        const el = document.createElement('div');
        el.className = 'pop-text';
        el.textContent = text;
        el.style.left = Math.max(90, Math.min(window.innerWidth - 90, x)) + 'px';
        el.style.top = y + 'px';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 1400);
    },

    // The message tablet "types" its text letter by letter
    updateOracle(text) {
        const el = $('oracle-message');
        clearInterval(this.typer);
        let i = 0;
        el.classList.add('cursor-blink');
        el.textContent = '';
        this.typer = setInterval(() => {
            i += 2;
            el.textContent = text.slice(0, i);
            if (i >= text.length) { clearInterval(this.typer); el.textContent = text; el.classList.remove('cursor-blink'); }
        }, 16);
    },

    /* ---------- modals ---------- */
    showModal(id) {
        const m = $(id);
        m.classList.add('show');
        requestAnimationFrame(() => requestAnimationFrame(() => m.classList.add('visible')));
    },
    hideModal(id) {
        const m = $(id);
        m.classList.remove('visible');
        setTimeout(() => { if (!m.classList.contains('visible')) m.classList.remove('show'); }, 260);
    },
    showConfirmModal(doorNum, stonesLeft) {
        $('confirm-title').textContent = `Open door ${doorNum}?`;
        $('confirm-desc').innerHTML = `You still have <b>${stonesLeft} magic ${stonesLeft === 1 ? 'stone' : 'stones'}</b> left. Open this door anyway?`;
        this.showModal('confirm-modal');
    },
    showVictoryModal(usedStones, doorsOpened) {
        const art = $('victory-asset-container');
        art.innerHTML = '';
        art.appendChild(Sprites.copyTo(Sprites.chestSprite(3)));
        $('stat-stones').textContent = `${usedStones} / ${GAME_CONFIG.totalStones}`;
        $('stat-doors').textContent = `${doorsOpened}`;
        FX.confettiRain(90);
        this.showModal('victory-modal');
    }
};


/* =====================================================================
   8. INPUT  - drag a stone with mouse or finger (or just tap it)
   ===================================================================== */
const Input = {
    drag: null,

    bindSlot(slot, index) {
        slot.addEventListener('pointerdown', (e) => {
            if (Game.isGameOver || Game.usedStones.has(index)) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            slot.setPointerCapture(e.pointerId);
            this.drag = { slot, index, id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, ghost: null, hover: null, w: 0, h: 0 };
        });
        slot.addEventListener('pointermove', (e) => this.onMove(e));
        slot.addEventListener('pointerup', (e) => this.onUp(e));
        slot.addEventListener('pointercancel', () => this.cancel());
    },

    onMove(e) {
        const d = this.drag;
        if (!d || e.pointerId !== d.id) return;
        if (!d.moved) {
            if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 8) return;     // small wiggles still count as a tap
            d.moved = true;
            const rect = d.slot.querySelector('.stone-wrap').getBoundingClientRect();
            d.w = rect.width; d.h = rect.height;
            d.ghost = RenderEngine.makeGhost(rect);
            d.slot.classList.add('dragging');
            AudioEngine.playStoneSelect();
            Game.beginDrag(d.index);
        }
        const lift = d.h * 0.6;                                                  // hold the stone above the finger
        d.cx = e.clientX; d.cy = e.clientY - lift;
        d.ghost.style.transform = `translate(${d.cx - d.w / 2}px, ${d.cy - d.h / 2}px)`;
        this.setHover(d, this.gapAt(d.cx, d.cy));
        const scroller = $('hall-scroll');                                       // scroll the hall when dragging near the edges
        if (e.clientX < 60) scroller.scrollLeft -= 14;
        else if (e.clientX > window.innerWidth - 60) scroller.scrollLeft += 14;
    },

    onUp(e) {
        const d = this.drag;
        if (!d || e.pointerId !== d.id) return;
        this.drag = null;
        if (!d.moved) { Game.selectStone(d.index); return; }                     // it was a tap

        this.setHover(d, null);
        d.slot.classList.remove('dragging');
        const gap = this.gapAt(d.cx, d.cy);
        const from = { left: d.cx - d.w / 2, top: d.cy - d.h / 2, width: d.w, height: d.h, ghost: d.ghost };
        if (gap && !gap.classList.contains('filled')) {
            Game.placeStoneInGap(Number(gap.dataset.gap), from);
        } else {
            if (gap) { AudioEngine.playError(); RenderEngine.updateOracle('That socket already holds a spent stone. Try a different one!'); }
            this.returnGhost(d);
        }
    },

    cancel() {
        const d = this.drag;
        this.drag = null;
        if (d && d.moved) { this.setHover(d, null); d.slot.classList.remove('dragging'); this.returnGhost(d); }
    },

    returnGhost(d) {                // dropped in the wrong place: the stone hops back to its slot
        const target = d.slot.querySelector('.stone-wrap').getBoundingClientRect();
        const anim = d.ghost.animate([
            { transform: d.ghost.style.transform },
            { transform: `translate(${target.left}px, ${target.top}px)` }
        ], { duration: 220, easing: 'ease-out', fill: 'forwards' });
        anim.finished.then(() => { StoneLife.detach(d.ghost._item); d.ghost.remove(); }).catch(() => {});
        Game.cancelSelection();
    },

    // Find the socket under a point (a little forgiving: also checks to the left and right)
    gapAt(x, y) {
        for (const dx of [0, -10, 10]) {
            const el = document.elementFromPoint(x + dx, y);
            const gap = el && el.closest ? el.closest('.gap') : null;
            if (gap) return gap;
        }
        return null;
    },
    setHover(d, gap) {
        if (d.hover === gap) return;
        if (d.hover) d.hover.classList.remove('hover');
        if (gap && !gap.classList.contains('filled')) gap.classList.add('hover');
        d.hover = gap;
    }
};


/* =====================================================================
   9. START
   ===================================================================== */
window.addEventListener('DOMContentLoaded', () => {
    Sprites.init();
    FX.init();

    // little glowing stones in the header and message tablet
    StoneLife.attach($('emblem-stone'), 1.4);
    StoneLife.attach($('orb-stone'), 1);

    Game.init();
});
