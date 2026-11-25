// Interactive 3D heart: ~1000 surface points of the implicit heart surface, projected by hand (no libraries).
// Drag to rotate, it beats, and it speeds up and tints with the live risk.
let raf = 0, canvas = null, pts = null, ang = 0.6, vel = 0.006, drag = null, tilt = 0.25, col = [15, 118, 110], frames = 0, stopped = true;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

function build() {
  if (pts) return pts;
  const out = [], f = (x, y, z) => Math.pow(x * x + 2.25 * y * y + z * z - 1, 3) - x * x * z * z * z - 0.1125 * y * y * z * z * z;
  for (let tries = 0; out.length < 1100 && tries < 600000; tries++) {
    const x = (Math.random() - .5) * 3, y = (Math.random() - .5) * 2.4, z = (Math.random() - .5) * 3;   // in this formula z is the vertical axis
    if (Math.abs(f(x, y, z)) < 0.012) out.push([x, z * .9, y]);                                    // display: x right, up = z, depth = y
  }
  return (pts = out);
}
function readColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(), m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) col = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
}
function draw(t) {
  const c = canvas, ctx = c.getContext('2d'), dpr = Math.min(devicePixelRatio || 1, 2);
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const beat = (() => { const p = (t / 900) % 1; return 1 + .07 * (Math.exp(-Math.pow((p - .1) * 14, 2)) + .7 * Math.exp(-Math.pow((p - .3) * 14, 2))); })();
  const S = Math.min(w, h) * .3 * beat, cx = w / 2, cy = h / 2 + h * .03, ca = Math.cos(ang), sa = Math.sin(ang), ct = Math.cos(tilt), st = Math.sin(tilt);
  const P = pts.map(([x, y, z]) => {
    const x1 = x * ca + z * sa, z1 = -x * sa + z * ca, y1 = y * ct - z1 * st, z2 = y * st + z1 * ct, k = 3 / (3 + z2);
    return [cx + x1 * S * k, cy - y1 * S * k, z2, k];
  }).sort((a, b) => b[2] - a[2]);
  for (const [px, py, pz, k] of P) {
    const a = .25 + .65 * (1 - (pz + 1.3) / 2.6);
    ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${Math.max(.12, Math.min(.95, a))})`;
    ctx.beginPath(); ctx.arc(px, py, 1.1 + 1.5 * k * k, 0, 6.283); ctx.fill();
  }
}
function loop(t) {
  if (stopped) return;
  if (!canvas.isConnected) { stopped = true; return; }
  if (!drag) { ang += vel; tilt += (.25 - tilt) * .05; }
  if (++frames % 90 === 0) readColor();
  draw(t); raf = requestAnimationFrame(loop);
}
export function startHeart(el) {
  stopHeart(); canvas = el; build(); readColor();
  el.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing'; });
  el.addEventListener('pointermove', e => { if (!drag) return; ang += (e.clientX - drag.x) * .012; tilt = Math.max(-.9, Math.min(.9, tilt + (e.clientY - drag.y) * .008)); drag = { x: e.clientX, y: e.clientY }; if (reduce) draw(0); });
  const end = () => { drag = null; el.style.cursor = 'grab'; };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.style.cursor = 'grab'; stopped = false;
  if (reduce) draw(0); else raf = requestAnimationFrame(loop);
}
export function stopHeart() { stopped = true; cancelAnimationFrame(raf); }
export function setHeartSpeed(level) { vel = level === 'High' ? .016 : .006; }
