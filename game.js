/* Magic Stones & Treasure — vanilla JS, no libraries. Sound is synthesized with the Web Audio API. */
(() => {
'use strict';
const R = 4, C = 8, NS = 'http://www.w3.org/2000/svg';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const rnd = n => Math.floor(Math.random() * n);
let S; // game state

/* ---------- Sound ---------- */
let ac;
const A = () => { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); return ac; };
function tone(f, d, type = 'square', v = .12, t0 = 0, f2) {
  const a = A(), o = a.createOscillator(), g = a.createGain(), t = a.currentTime + t0;
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
  g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.001, t + d);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + d);
}
function noise(d, fc, v = .3, t0 = 0) {
  const a = A(), n = a.sampleRate * d, b = a.createBuffer(1, n, a.sampleRate), x = b.getChannelData(0);
  for (let i = 0; i < n; i++) x[i] = Math.random() * 2 - 1;
  const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain(), t = a.currentTime + t0;
  s.buffer = b; f.type = 'lowpass'; f.frequency.setValueAtTime(fc, t); f.frequency.exponentialRampToValueAtTime(100, t + d);
  g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.001, t + d);
  s.connect(f).connect(g).connect(a.destination); s.start(t);
}
const SFX = {
  pick: () => tone(660, .08, 'square', .1, 0, 990),
  place: () => tone(180, .14, 'square', .2, 0, 80),
  zap: () => { noise(.7, 7000, .5); tone(1500, .35, 'sawtooth', .15, 0, 80); tone(90, .9, 'sine', .5, .05, 38); noise(1, 600, .5, .1); },
  deny: () => tone(130, .28, 'sawtooth', .18, 0, 70),
  fail: () => [392, 330, 262, 196].forEach((f, i) => tone(f, .25, 'triangle', .2, i * .2)),
  open: () => { noise(.5, 1500, .3); tone(90, .5, 'sawtooth', .18, 0, 50); },
  win: () => {
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, .28, 'square', .1, i * .1));
    for (let i = 0; i < 16; i++) tone(1800 + Math.random() * 1400, .08, 'triangle', .07, .6 + i * .07);
  }
};
const play = n => { try { SFX[n](); } catch (e) {} };

/* ---------- Helpers ---------- */
const count = () => S.alive.flat().filter(Boolean).length;
const doorEl = (r, c) => $(`.door[data-r="${r}"][data-c="${c}"]`);
function say(t, ms = 2600) {
  const m = $('#msg'); m.textContent = t; m.classList.add('show');
  clearTimeout(say.t); say.t = setTimeout(() => m.classList.remove('show'), ms);
}
const arrowSVG = deg => `<svg class="arr" viewBox="-1 -1 9 9" style="transform:rotate(${deg}deg)"><path d="M3 0h1v1h1v1h1v1H4v4H3V3H1V2h1V1h1z" fill="#fff" stroke="#000" stroke-width=".7" paint-order="stroke"/></svg>`;
const stoneHTML = t => `<div class="stone ${t} idle" data-type="${t}"><img src="assets/stone-${t}.svg" alt=""></div>`;

/* ---------- Setup ---------- */
function newGame() {
  S = { alive: Array.from({ length: R }, () => Array(C).fill(true)), sel: null, used: 0, over: false };
  $('#end').className = ''; $('#end').innerHTML = ''; $('#fx').innerHTML = ''; $('#bolts').innerHTML = '';
  $('#msg').classList.remove('show');
  let left = '', doors = '', top = '';
  for (let r = 0; r < R; r++) {
    left += `<div class="cell"><b>F${R - r}</b>${r < R - 1 ? `<div class="socket red" data-type="red" data-i="${r}"></div>` : ''}</div>`;
    for (let c = 0; c < C; c++) {
      const chest = '';
      doors += `<div class="door" data-r="${r}" data-c="${c}"><div class="back">${chest}</div><div class="leaf"><i></i></div></div>`;
    }
  }
  for (let c = 0; c < C; c++) top += `<div class="cell">${c < C - 1 ? `<div class="socket blue" data-type="blue" data-i="${c}"></div>` : ''}</div>`;
  $('#left').innerHTML = left; $('#doors').innerHTML = doors; $('#top').innerHTML = top;
  requestAnimationFrame(floors);
  $('#reds').innerHTML = `<div>${stoneHTML('red')}</div><div>${stoneHTML('red')}</div>`;
  $('#blues').innerHTML = `<div>${stoneHTML('blue')}</div><div>${stoneHTML('blue')}</div><div>${stoneHTML('blue')}</div>`;
}

/* ---------- Stones ---------- */
function clearSel() { S.sel = null; $('#board').className = ''; $$('.sel,.ready').forEach(x => x.classList.remove('sel', 'ready')); }

function place(sock) {
  const stone = S.sel, t = stone.dataset.type, i = +sock.dataset.i;
  // red: "first" = treasure is above; blue: "first" = treasure is left
  // Malicious opponent: the treasure is never fixed. It always "moves" to the larger remaining side,
  // so only perfect halving (2 red cuts for 4 floors, 3 blue cuts for 8 doors) can ever win.
  let a = 0;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (S.alive[r][c] && (t === 'red' ? r <= i : c <= i)) a++;
  const b = count() - a, first = a === b ? Math.random() < .5 : a > b;
  const dir = t === 'red' ? (first ? 'up' : 'down') : (first ? 'left' : 'right');
  stone.classList.add('used'); clearSel();
  sock.classList.add('full');
  $$(`.socket.${t}[data-i="${i}"]`).forEach(x => x.classList.add('full'));
  sock.innerHTML = `<div class="stone ${t} spent"><img src="assets/stone-${t}-calm.svg" alt="">${arrowSVG({ up: 0, right: 90, down: 180, left: 270 }[dir])}</div>`;
  S.used++;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const keep = t === 'red' ? (first ? r <= i : r > i) : (first ? c <= i : c > i);
    S.alive[r][c] = S.alive[r][c] && keep;
  }
  play('place');
  setTimeout(() => { play('zap'); bolts(sock, t, dir); }, 220);
  setTimeout(render, 900);
  if (S.used === 5) setTimeout(() => { if (count() > 1) endCard(false); }, 2400);
}

function bolts(sock, t, dir) {
  // One bolt from the stone to the screen edge in the stone's direction; doors light up as it passes.
  const svg = $('#bolts'), b = $('#board').getBoundingClientRect(), k = sock.getBoundingClientRect();
  const sx = k.x + k.width / 2 - b.x, sy = k.y + k.height / 2 - b.y;
  const ex = dir === 'left' ? -b.x : dir === 'right' ? innerWidth - b.x : sx;
  const ey = dir === 'up' ? -b.y : dir === 'down' ? innerHeight - b.y : sy;
  const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
  svg.setAttribute('viewBox', `0 0 ${b.width} ${b.height}`);
  document.body.classList.add('shake'); setTimeout(() => document.body.classList.remove('shake'), 450);
  const fl = document.createElement('div'); fl.className = 'flash'; document.body.appendChild(fl); setTimeout(() => fl.remove(), 400);
  const pts = [], steps = Math.max(6, Math.round(len / 16));
  for (let j = 0; j <= steps; j++) {
    const f = j / steps, o = j && j < steps ? (Math.random() - .5) * 22 : 0;
    pts.push(`${sx + dx * f + nx * o},${sy + dy * f + ny * o}`);
  }
  ['glow', 'core'].forEach(cl => {
    const p = document.createElementNS(NS, 'polyline');
    p.setAttribute('points', pts.join(' ')); p.setAttribute('pathLength', 1);
    p.setAttribute('class', `bolt ${cl} ${t}`); p.style.setProperty('--d', '0ms');
    svg.appendChild(p); setTimeout(() => p.remove(), 1500);
  });
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    if (!S.alive[r][c]) continue;
    const d = doorEl(r, c), q = d.getBoundingClientRect();
    const dist = Math.abs(dir === 'left' || dir === 'right' ? q.x + q.width / 2 - b.x - sx : q.y + q.height / 2 - b.y - sy);
    setTimeout(() => { d.classList.add('zap'); setTimeout(() => d.classList.remove('zap'), 800); }, dist / len * 280);
  }
}

function render() {
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const d = doorEl(r, c), a = S.alive[r][c];
    d.classList.toggle('dead', !a);
    d.classList.toggle('live', a && S.used > 0 && !S.over);
    if (a && S.used > 0) d.style.animationDelay = (-Math.random() * 1.2) + 's';
  }
}

/* Stone floors sit in the gaps between rows (plus a ground floor), spanning the doors */
function floors() {
  const f = $('#floors'), b = $('#board').getBoundingClientRect(), dr = $('#doors').getBoundingClientRect(); f.innerHTML = '';
  const add = y => { const e = document.createElement('div'), x = dr.left - b.x - 6; e.className = 'floor';
    Object.assign(e.style, { left: x + 'px', width: dr.right - b.x - x + 6 + 'px', top: y + 'px' }); f.appendChild(e); };
  $$('.socket.red').forEach(s => { const k = s.getBoundingClientRect(); add(k.y + k.height / 2 - b.y); });
  add(dr.bottom - b.y + 2);
}
addEventListener('resize', floors);

/* ---------- Doors & endings ---------- */
function tryDoor(d) {
  if (S.over) return;
  const r = +d.dataset.r, c = +d.dataset.c, n = count();
  const refuse = m => { play('deny'); d.classList.add('no'); setTimeout(() => d.classList.remove('no'), 450); say(m); };
  if (n > 1) return refuse(`There are ${n} possible doors where the treasure can be`);
  if (!S.alive[r][c]) return refuse('That door is sealed by magic. Try the glowing door!');
  S.over = true; d.querySelector('.back').innerHTML = '<img src="assets/chest.svg" alt="">'; d.classList.add('open'); play('open');
  setTimeout(() => { play('win'); coins(); endCard(true); }, 1000);
}

function endCard(win) {
  S.over = true; $$('.door').forEach(d => d.classList.remove('live'));
  const e = $('#end');
  e.className = 'show' + (win ? ' win' : '');
  e.innerHTML = win
    ? `<div class="card"><img src="assets/trophy.svg" alt="Trophy"><h2>You won! You found the perfect strategy!</h2><button class="pbtn" id="again">Play again</button></div>`
    : `<div class="card"><h2>There exists a better strategy, please try again</h2><button class="pbtn" id="again">Try again</button></div>`;
  if (!win) play('fail');
  $('#again').onclick = newGame;
}

function coins() {
  const fx = $('#fx');
  for (let i = 0; i < 80; i++) {
    const im = new Image(); im.src = 'assets/coin.svg'; im.className = 'coin';
    const w = 16 + Math.random() * 24;
    Object.assign(im.style, { left: Math.random() * 100 + 'vw', width: w + 'px', animationDuration: 2 + Math.random() * 2.5 + 's', animationDelay: Math.random() * 1.6 + 's' });
    fx.appendChild(im);
  }
  setTimeout(() => fx.innerHTML = '', 7000);
}

/* ---------- Events ---------- */
document.addEventListener('click', e => {
  const st = e.target.closest('.tray .stone');
  if (st) {
    if (S.over || st.classList.contains('used')) return;
    A(); const was = S.sel === st; clearSel();
    if (!was) { S.sel = st; st.classList.add('sel'); $$('.socket.' + st.dataset.type + ':not(.full)').forEach(x => x.classList.add('ready')); $('#board').className = 'pick-' + st.dataset.type; play('pick'); }
    return;
  }
  const sk = e.target.closest('.socket');
  if (sk && !S.over) {
    if (!S.sel) return say('Tap a stone in the tray first!');
    if (S.sel.dataset.type !== sk.dataset.type) return say(`This socket needs a ${sk.dataset.type} stone`);
    if (!sk.classList.contains('full')) place(sk);
    return;
  }
  const d = e.target.closest('.door');
  if (d) { A(); tryDoor(d); }
});
$('#resetBtn').onclick = () => { A(); newGame(); };
$('#helpBtn').onclick = () => $('#help').showModal();

newGame();
$('#help').showModal();
})();
