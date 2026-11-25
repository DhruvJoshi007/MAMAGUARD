// Interactive 3D heart (no libraries). ~1300 evenly spaced points on the exact implicit heart surface, lit per point,
// with a lub-dub heartbeat that ripples up the surface, a pulsing glow, shockwave rings, and pointer-follow with inertia.
// Drag to spin; it speeds up and tints with live risk. Respects reduced motion.
let raf = 0, canvas = null, pts = null, ang = 0.6, angV = 0, vel = 0.005, drag = null, tilt = 0.2, tiltT = 0.2, col = [225, 29, 72], frames = 0, stopped = true, hov = { x: 0, y: 0 }, rings = [], lastBeat = -1;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const f = (x, y, z) => Math.pow(x * x + 2.25 * y * y + z * z - 1, 3) - x * x * z * z * z - 0.1125 * y * y * z * z * z; // z is the vertical axis here
function build() {
  if (pts) return pts;
  const cand = [], ax = [[0, 1, 2], [1, 2, 0], [2, 0, 1]], R = [[-1.5, 1.5], [-1.2, 1.2], [-1.6, 1.6]];   // cast rays along all three axes so steep regions are covered too
  const at = (a, b, c, k) => { const v = [0, 0, 0]; v[ax[k][0]] = a; v[ax[k][1]] = b; v[ax[k][2]] = c; return v; };
  for (let k = 0; k < 3; k++) for (let tries = 0; tries < 9000; tries++) {
    const a = R[ax[k][0]][0] + Math.random() * (R[ax[k][0]][1] - R[ax[k][0]][0]), b = R[ax[k][1]][0] + Math.random() * (R[ax[k][1]][1] - R[ax[k][1]][0]), lo = R[ax[k][2]][0], hi = R[ax[k][2]][1], N = 40;
    const F = c => { const v = at(a, b, c, k); return f(v[0], v[1], v[2]); };
    let prev = F(lo), c0 = lo;
    for (let i = 1; i <= N; i++) {
      const c1 = lo + (hi - lo) * i / N, v = F(c1);
      if ((prev < 0) !== (v < 0)) { let u = c0, w2 = c1; for (let q = 0; q < 18; q++) { const m = (u + w2) / 2; ((F(u) < 0) === (F(m) < 0)) ? u = m : w2 = m; } cand.push(at(a, b, (u + w2) / 2, k)); }
      prev = v; c0 = c1;
    }
  }
  // thin to an even distribution
  const out = [], md = 0.074, md2 = md * md, cell = md, grid = new Map(), key = (i, j, k) => i * 73856093 ^ j * 19349663 ^ k * 83492791;
  for (const p of cand.sort(() => Math.random() - .5)) {
    const gi = Math.floor(p[0] / cell), gj = Math.floor(p[1] / cell), gk = Math.floor(p[2] / cell); let ok = true;
    for (let a = -1; a <= 1 && ok; a++) for (let b = -1; b <= 1 && ok; b++) for (let c = -1; c <= 1 && ok; c++) {
      const L = grid.get(key(gi + a, gj + b, gk + c)); if (L) for (const q of L) { const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2]; if (dx * dx + dy * dy + dz * dz < md2) { ok = false; break; } }
    }
    if (!ok) continue;
    const e = 1e-3, gx = f(p[0] + e, p[1], p[2]) - f(p[0] - e, p[1], p[2]), gy = f(p[0], p[1] + e, p[2]) - f(p[0], p[1] - e, p[2]), gz = f(p[0], p[1], p[2] + e) - f(p[0], p[1], p[2] - e);
    const n = Math.hypot(gx, gy, gz) || 1, kk = key(gi, gj, gk); (grid.get(kk) || grid.set(kk, []).get(kk)).push(p);
    out.push({ x: p[0], y: p[2] * .9, z: p[1], nx: gx / n, ny: gz / n, nz: gy / n, ph: Math.random() * 6.283 }); // display: x right, y up, z depth
  }
  return (pts = out);
}
function readColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--heart').trim(), m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) col = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
}
const lerp = (a, b, t) => a + (b - a) * t;
function draw(t) {
  const c = canvas, ctx = c.getContext('2d'), dpr = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const period = vel > .01 ? 640 : 950, p = (t / period) % 1;
  const lub = Math.exp(-Math.pow((p - .08) * 13, 2)), dub = .6 * Math.exp(-Math.pow((p - .27) * 13, 2)), beat = lub + dub;
  const bi = Math.floor(t / period); if (bi !== lastBeat) { lastBeat = bi; rings.push({ t0: t }); if (rings.length > 3) rings.shift(); }
  const S = Math.min(w, h) * .3 * (1 + .075 * beat), cx = w / 2, cy = h / 2 + h * .02;
  const [r, g, b] = col;
  // glow behind
  const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 2.1); gr.addColorStop(0, `rgba(${r},${g},${b},${.22 + .3 * beat})`); gr.addColorStop(.5, `rgba(${r},${g},${b},${.07 + .08 * beat})`); gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
  // shockwave rings
  for (const rg of rings) { const a = (t - rg.t0) / 1100; if (a > 1) continue; ctx.strokeStyle = `rgba(${r},${g},${b},${(1 - a) * .35})`; ctx.lineWidth = 2 * (1 - a) + .5; ctx.beginPath(); ctx.ellipse(cx, cy, S * (1.1 + a * 1.1), S * (1.1 + a * 1.1) * .92, 0, 0, 6.283); ctx.stroke(); }
  const ca = Math.cos(ang), sa = Math.sin(ang), ct = Math.cos(tilt), st = Math.sin(tilt), L = [-.45, .6, .65], ln = Math.hypot(...L);
  const P = pts.map(q => {
    const wave = Math.max(0, lub * Math.exp(-Math.pow((q.y + 1 - p * 0) * .0, 2))) ; // base pulse
    const trav = Math.exp(-Math.pow((((t / period) % 1) - .08 - (q.y + 1.1) * .06) * 11, 2)); // pulse travelling up the surface
    const sh = 1 + .035 * Math.sin(t / 700 + q.ph) + .06 * trav + .02 * wave;
    const x = q.x * sh, y = q.y * sh, z = q.z * sh;
    const x1 = x * ca + z * sa, z1 = -x * sa + z * ca, y1 = y * ct - z1 * st, z2 = y * st + z1 * ct, k = 3 / (3 + z2);
    let nx = q.nx * ca + q.nz * sa, nz = -q.nx * sa + q.nz * ca, ny = q.ny * ct - nz * st; nz = q.ny * st + nz * ct;
    const dif = Math.max(0, (nx * L[0] + ny * L[1] + nz * -L[2]) / ln), rim = Math.pow(1 - Math.abs(nz), 3);
    return [cx + x1 * S * k, cy - y1 * S * k, z2, k, dif, rim, trav];
  }).sort((a, b2) => b2[2] - a[2]);
  ctx.globalCompositeOperation = 'lighter';
  for (const [px, py, pz, k, dif, rim, trav] of P) {
    const depth = 1 - (pz + 1.4) / 2.8, lum = Math.min(1, .25 + .55 * dif + .35 * rim + .35 * trav), a = Math.max(.1, Math.min(.95, (.2 + .55 * depth) * (.55 + lum)));
    const cr = lerp(r, 255, lum * .55), cg = lerp(g, 200, lum * .35), cb = lerp(b, 210, lum * .35);
    ctx.fillStyle = `rgba(${cr | 0},${cg | 0},${cb | 0},${a})`;
    ctx.beginPath(); ctx.arc(px, py, (1 + 1.7 * k * k) * (1 + .5 * trav), 0, 6.283); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}
function loop(t) {
  if (stopped) return;
  if (!canvas.isConnected) { stopped = true; return; }
  if (!drag) { angV += (vel - angV) * .05; ang += angV; tiltT = .2 + hov.y * .35; tilt += (tiltT - tilt) * .06; ang += hov.x * .004; }
  else angV *= .9;
  if (++frames % 90 === 0) readColor();
  draw(t); raf = requestAnimationFrame(loop);
}
const onMove = e => { const r = canvas?.getBoundingClientRect(); if (!r) return; hov.x = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / innerWidth * 2)); hov.y = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / innerHeight * 2)); };
let wired = false;
export function startHeart(el) {
  stopHeart(); canvas = el; build(); readColor(); lastBeat = -1; rings = [];
  if (!wired) { addEventListener('pointermove', onMove); wired = true; }
  el.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing'; });
  el.addEventListener('pointermove', e => { if (!drag) return; const dx = e.clientX - drag.x; ang += dx * .012; angV = dx * .012; tilt = Math.max(-.9, Math.min(.9, tilt + (e.clientY - drag.y) * .008)); drag = { x: e.clientX, y: e.clientY }; if (reduce) draw(0); });
  const end = () => { drag = null; el.style.cursor = 'grab'; };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.style.cursor = 'grab'; stopped = false;
  if (reduce) draw(0); else raf = requestAnimationFrame(loop);
}
export function stopHeart() { stopped = true; cancelAnimationFrame(raf); }
export function setHeartSpeed(level) { vel = level === 'High' ? .014 : .005; }
addEventListener('mg-theme', readColor);
