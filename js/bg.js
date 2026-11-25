// Living background: drifting colour orbs, a particle web flowing on a swirl field, cursor glow + links, hold to pull a vortex,
// click for ripples and floating hearts, and an ECG trace that swells near the pointer. Tints with theme and live risk. Pure canvas.
const cv = document.createElement('canvas');
cv.setAttribute('aria-hidden', 'true');
Object.assign(cv.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '-1', pointerEvents: 'none' });
document.body.prepend(cv);
const ctx = cv.getContext('2d');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let W = 0, H = 0, dpr = 1, pts = [], hearts = [], ripples = [], level = 'none', raf = 0, light = true, last = 0;
const mouse = { x: -999, y: -999, sx: -999, sy: -999, down: false, in: false };
let C = { tint: [15, 118, 110], heart: [225, 29, 72], brand: [15, 118, 110] };
const TINT = { none: '--brand', Low: '--low', Mid: '--mid', High: '--high' };
const hex = v => { const m = /^#([0-9a-f]{6})$/i.exec((v || '').trim()); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null; };
function readColor() {
  const cs = getComputedStyle(document.documentElement), g = n => hex(cs.getPropertyValue(n));
  C = { tint: g(TINT[level]) || C.tint, heart: g('--heart') || C.heart, brand: g('--brand') || C.brand };
  const bg = g('--bg') || [255, 255, 255]; light = (bg[0] * .3 + bg[1] * .59 + bg[2] * .11) > 128;
}
function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const n = Math.round(Math.min(120, Math.max(36, W * H / 13000)));
  pts = Array.from({ length: n }, () => { const z = .35 + Math.random() * .65; return { x: Math.random() * W, y: Math.random() * H, vx: 0, vy: 0, z, r: .8 + z * 2.6, ph: Math.random() * 6.28 }; });
}
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
function heartPath(x, y, s) { ctx.beginPath(); ctx.moveTo(x, y + s * .35); ctx.bezierCurveTo(x - s, y - s * .35, x - s * .5, y - s * 1.1, x, y - s * .45); ctx.bezierCurveTo(x + s * .5, y - s * 1.1, x + s, y - s * .35, x, y + s * .35); ctx.closePath(); }
function frame(now) {
  const t = now / 1000, dt = Math.min(.05, (now - last) / 1000 || .016); last = now;
  ctx.clearRect(0, 0, W, H);
  const k = light ? 1 : .85, speed = level === 'High' ? 1.6 : 1;
  mouse.sx += (mouse.x - mouse.sx) * .14; mouse.sy += (mouse.y - mouse.sy) * .14;
  const px = mouse.in ? (mouse.sx / W - .5) : 0, py = mouse.in ? (mouse.sy / H - .5) : 0;
  // 1) drifting colour orbs
  const orbs = [[C.tint, .22, .3, .55, 1], [C.heart, .78, .25, .45, 1.3], [C.brand, .5, .85, .6, .8], [C.heart, .12, .8, .4, 1.6]];
  orbs.forEach(([c, ax, ay, rr, sp], i) => {
    const x = (ax + .12 * Math.sin(t * .13 * sp + i * 2) + px * .04 * (i + 1)) * W, y = (ay + .1 * Math.cos(t * .11 * sp + i) + py * .04 * (i + 1)) * H, r = rr * Math.max(W, H) * .55 * (1 + .06 * Math.sin(t * .4 + i));
    const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, rgba(c, (light ? .16 : .2) * k)); g.addColorStop(1, rgba(c, 0)); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  });
  // cursor glow (lags behind the pointer)
  if (mouse.in) { const g = ctx.createRadialGradient(mouse.sx, mouse.sy, 0, mouse.sx, mouse.sy, mouse.down ? 220 : 150); g.addColorStop(0, rgba(C.heart, mouse.down ? .28 : .16)); g.addColorStop(1, rgba(C.heart, 0)); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
  // 2) particles on a swirl field, attracted to the pointer (hold = vortex), pushed by ripples
  for (const p of pts) {
    const a = Math.sin(p.y * .006 + t * .4) + Math.cos(p.x * .005 - t * .33);
    p.vx += Math.cos(a * 3.1) * .018 * p.z; p.vy += Math.sin(a * 3.1) * .018 * p.z;
    if (mouse.in) {
      const dx = mouse.x - p.x, dy = mouse.y - p.y, d2 = dx * dx + dy * dy, R = mouse.down ? 90000 : 30000;
      if (d2 < R) { const d = Math.sqrt(d2) || 1, f = (1 - d2 / R); if (mouse.down) { p.vx += (dx / d * .5 - dy / d * .9) * f * .22; p.vy += (dy / d * .5 + dx / d * .9) * f * .22; } else if (d < 70) { p.vx -= dx / d * f * .35; p.vy -= dy / d * f * .35; } else { p.vx += dx / d * f * .03; p.vy += dy / d * f * .03; } }
    }
    for (const r of ripples) { const dx = p.x - r.x, dy = p.y - r.y, d = Math.hypot(dx, dy) || 1, off = Math.abs(d - r.r); if (off < 40) { const f = (1 - off / 40) * r.a * .9; p.vx += dx / d * f; p.vy += dy / d * f; } }
    p.vx *= .965; p.vy *= .965; p.x += p.vx * speed * (.6 + p.z) + .15 * (px) * p.z; p.y += p.vy * speed * (.6 + p.z);
    if (p.x < -20) p.x = W + 20; if (p.x > W + 20) p.x = -20; if (p.y < -20) p.y = H + 20; if (p.y > H + 20) p.y = -20;
  }
  const c = C.tint;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], ax = a.x + px * 40 * a.z, ay = a.y + py * 40 * a.z;
    for (let j = i + 1; j < pts.length; j++) {
      const b = pts[j], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < 125) { ctx.strokeStyle = rgba(c, (1 - d / 125) * .3 * Math.min(a.z, b.z) * 1.4); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(b.x + px * 40 * b.z, b.y + py * 40 * b.z); ctx.stroke(); }
    }
    if (mouse.in) { const d = Math.hypot(a.x - mouse.x, a.y - mouse.y); if (d < 170) { ctx.strokeStyle = rgba(C.heart, (1 - d / 170) * .5); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(mouse.sx, mouse.sy); ctx.stroke(); } }
    const tw = .5 + .3 * Math.sin(t * 1.6 + a.ph); ctx.fillStyle = rgba(c, tw * (.35 + .5 * a.z)); ctx.beginPath(); ctx.arc(ax, ay, a.r, 0, 6.283); ctx.fill();
  }
  // 3) ripples and floating hearts from clicks
  for (let i = ripples.length - 1; i >= 0; i--) { const r = ripples[i]; r.r += 340 * dt; r.a -= dt * .6; if (r.a <= 0) { ripples.splice(i, 1); continue; } ctx.strokeStyle = rgba(C.heart, r.a * .6); ctx.lineWidth = 2.5 * r.a + .5; ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, 6.283); ctx.stroke(); }
  for (let i = hearts.length - 1; i >= 0; i--) { const h = hearts[i]; h.life -= dt; if (h.life <= 0) { hearts.splice(i, 1); continue; } h.x += h.vx * dt + Math.sin(t * 3 + h.ph) * .4; h.y += h.vy * dt; h.vy += 20 * dt * -.2; ctx.fillStyle = rgba(C.heart, Math.min(1, h.life) * .55); heartPath(h.x, h.y, h.s * (1 + .1 * Math.sin(t * 8 + h.ph))); ctx.fill(); }
  // 4) ECG trace along the bottom; it swells under the pointer
  const base = H - 36, ph = (t * 1000 / (level === 'High' ? 700 : 1400)) % 1; ctx.strokeStyle = rgba(C.tint, light ? .26 : .3); ctx.lineWidth = 2; ctx.beginPath();
  for (let x = 0; x <= W; x += 4) {
    const u = ((x / 260) - ph + 10) % 1, amp = 1 + (mouse.in ? 1.6 * Math.exp(-Math.pow((x - mouse.sx) / 160, 2)) : 0); let y = 0;
    if (u > .40 && u < .44) y = -10; else if (u >= .44 && u < .48) y = 26; else if (u >= .48 && u < .52) y = -6;
    x ? ctx.lineTo(x, base + y * amp) : ctx.moveTo(x, base + y * amp);
  }
  ctx.stroke();
  if (!reduce) raf = requestAnimationFrame(frame);
}
const interactive = e => e.target.closest?.('button,a,input,select,textarea,label,dialog,summary,canvas#heart3d,[role=radio]');
addEventListener('resize', resize);
addEventListener('pointermove', e => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.in = true; if (mouse.sx < 0) { mouse.sx = mouse.x; mouse.sy = mouse.y; } }, { passive: true });
document.documentElement.addEventListener('pointerleave', () => { mouse.in = false; mouse.down = false; });
addEventListener('pointerdown', e => { if (interactive(e)) return; mouse.down = true; });
addEventListener('pointerup', e => {
  const was = mouse.down; mouse.down = false; if (!was || interactive(e)) return;
  ripples.push({ x: e.clientX, y: e.clientY, r: 0, a: 1 }); if (ripples.length > 4) ripples.shift();
  for (let i = 0; i < 7; i++) hearts.push({ x: e.clientX + (Math.random() - .5) * 30, y: e.clientY, vx: (Math.random() - .5) * 60, vy: -50 - Math.random() * 70, s: 5 + Math.random() * 7, ph: Math.random() * 6, life: 1.6 + Math.random() });
});
addEventListener('mg-risk', e => { level = TINT[e.detail] ? e.detail : 'none'; readColor(); });
addEventListener('mg-theme', () => setTimeout(readColor, 60));
document.addEventListener('visibilitychange', () => { cancelAnimationFrame(raf); if (!document.hidden && !reduce) { last = performance.now(); raf = requestAnimationFrame(frame); } });
resize(); readColor();
if (reduce) frame(performance.now()); else raf = requestAnimationFrame(frame);
