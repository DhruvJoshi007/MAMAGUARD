// Interactive background: drifting particles that link up and flee the pointer; tint follows live risk level.
const cv = document.createElement('canvas');
cv.setAttribute('aria-hidden', 'true');
Object.assign(cv.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '-1', pointerEvents: 'none' });
document.body.prepend(cv);
const ctx = cv.getContext('2d');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let W = 0, H = 0, dpr = 1, pts = [], mouse = { x: -999, y: -999 }, level = 'none', col = [15, 118, 110], raf = 0;
const TINT = { none: '--brand', Low: '--low', Mid: '--mid', High: '--high' };
function readColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue(TINT[level]).trim();
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) col = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
}
function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const n = Math.round(Math.min(70, Math.max(24, W * H / 18000)));
  pts = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .3, vy: (Math.random() - .5) * .3, r: 1.5 + Math.random() * 2.5 }));
}
function frame(t) {
  ctx.clearRect(0, 0, W, H);
  const [r, g, b] = col, speed = level === 'High' ? 1.8 : 1;
  for (const p of pts) {
    const dx = p.x - mouse.x, dy = p.y - mouse.y, d2 = dx * dx + dy * dy;
    if (d2 < 14000) { const f = (1 - d2 / 14000) * 1.4, d = Math.sqrt(d2) || 1; p.vx += dx / d * f * .25; p.vy += dy / d * f * .25; }
    p.vx *= .985; p.vy *= .985;
    p.vx += (Math.random() - .5) * .02; p.vy += (Math.random() - .5) * .02;
    p.x += p.vx * speed; p.y += p.vy * speed;
    if (p.x < -10) p.x = W + 10; if (p.x > W + 10) p.x = -10; if (p.y < -10) p.y = H + 10; if (p.y > H + 10) p.y = -10;
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    for (let j = i + 1; j < pts.length; j++) {
      const c = pts[j], d = Math.hypot(a.x - c.x, a.y - c.y);
      if (d < 130) { ctx.strokeStyle = `rgba(${r},${g},${b},${(1 - d / 130) * .32})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke(); }
    }
    ctx.fillStyle = `rgba(${r},${g},${b},.55)`; ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, 6.283); ctx.fill();
  }
  // faint ECG sweep along the bottom
  ctx.strokeStyle = `rgba(${r},${g},${b},.18)`; ctx.lineWidth = 2; ctx.beginPath();
  const base = H - 36, ph = (t / (level === 'High' ? 700 : 1400)) % 1;
  for (let x = 0; x <= W; x += 4) {
    const u = ((x / 260) - ph + 10) % 1; let y = 0;
    if (u > .40 && u < .44) y = -10; else if (u >= .44 && u < .48) y = 26; else if (u >= .48 && u < .52) y = -6;
    x ? ctx.lineTo(x, base + y) : ctx.moveTo(x, base + y);
  }
  ctx.stroke();
  raf = requestAnimationFrame(frame);
}
addEventListener('resize', resize);
addEventListener('pointermove', e => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
addEventListener('pointerleave', () => { mouse.x = mouse.y = -999; });
addEventListener('mg-risk', e => { level = TINT[e.detail] ? e.detail : 'none'; readColor(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', readColor);
document.addEventListener('visibilitychange', () => { cancelAnimationFrame(raf); if (!document.hidden && !reduce) raf = requestAnimationFrame(frame); });
resize(); readColor();
if (reduce) frame(0), cancelAnimationFrame(raf); else raf = requestAnimationFrame(frame);
addEventListener('mg-theme', () => setTimeout(readColor, 60));
