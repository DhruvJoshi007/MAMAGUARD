// WebGL heart: ~10k GPU particles on/in the exact implicit heart surface. They swirl in and assemble, beat (only while hovered),
// bulge toward and flow around the pointer, burst in a shockwave on click, and orbit with drag inertia. An ECG ring circles the heart.
// Raw WebGL, no libraries, works offline. Returns false from start() if WebGL is unavailable so the 2D heart is used instead.
import { build } from './heart2d.js';
const VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aSeed;
uniform mat3 uRot; uniform vec2 uScale; uniform float uTime, uBeat, uAmt, uAsm, uPx, uBurstT, uMouseK; uniform vec2 uMouse; uniform vec3 uCol;
varying vec3 vCol; varying float vSpec;
float ease(float x){ x = clamp(x, 0., 1.); return x * x * (3. - 2. * x); }
void main() {
  float period = 0.95, ph = fract(uTime / period);
  float trav = uAmt * exp(-pow((ph - .08 - (aPos.y + 1.1) * .06) * 11., 2.));
  vec3 p = aPos;
  // assembly: start on a swirling shell, fly into place (staggered by seed)
  float k0 = ease((uAsm - aSeed.x * .45) / .55);
  float a = aSeed.y * 6.2831 + uTime * (1. - k0) * 1.4;
  vec3 far = normalize(vec3(cos(a) * (.4 + aSeed.x), (aSeed.x - .5) * 2.2, sin(a) * (.4 + aSeed.x))) * (2.1 + aSeed.y * .9);
  p = mix(far, p, k0);
  vec3 n = aNrm;
  p += n * (.03 * sin(uTime * 1.3 + aSeed.y * 40.) * uAmt + .055 * trav + .045 * uBeat);          // breathing + travelling pulse
  p += n * .012 * sin(uTime * .8 + aSeed.x * 30.);                                                  // idle shimmer
  // shockwave from a click: a ring of displacement expanding from the centre
  float r0 = length(aPos), w = uBurstT < 2.2 ? exp(-pow((r0 - uBurstT * 1.5) * 3.2, 2.)) * (1. - uBurstT / 2.2) : 0.;
  p += normalize(aPos + .001) * w * .2 + n * w * .06;
  vec3 q = uRot * p;
  float kp = min(3. / max(3. + q.z, 1.), 1.7);
  vec2 s = q.xy * kp;
  // pointer: points near the cursor bulge toward the viewer and slide away around it
  vec2 ndc = s * uScale; vec2 dm = (ndc - uMouse) * vec2(uScale.y / uScale.x, 1.) ;
  float f = uMouseK * exp(-dot(dm, dm) / .045);
  s += normalize(ndc - uMouse + .0001) / uScale * f * .09; q.z -= f * .55;
  gl_Position = vec4(s * uScale, q.z * .22, 1.);
  vec3 nr = uRot * n; vec3 L = normalize(vec3(-.5, .65, -.6));
  float dif = max(0., dot(nr, L)), rim = pow(1. - abs(nr.z), 3.), front = 1. - (q.z + 1.5) / 3.;
  float lit = (.42 + .6 * dif) * (.5 + .6 * front) + .25 * trav + .6 * w;
  vSpec = pow(dif, 10.) * .7 * front + .3 * rim * dif;
  vCol = uCol * lit * 1.12 + vec3(1., .78, .8) * vSpec;
  gl_PointSize = min((1.6 + 2.9 * kp * kp) * uPx * (1. + .5 * trav + .6 * w + f * .5) * (.55 + .45 * k0), 14. * uPx);
}`;
const FS = `precision mediump float; varying vec3 vCol; varying float vSpec;
void main(){ vec2 c = gl_PointCoord * 2. - 1.; float d = dot(c, c); if (d > 1.) discard;
  float nz = sqrt(1. - d); vec3 col = vCol * (.62 + .5 * nz) + vec3(1., .9, .92) * pow(nz, 9.) * .35;   // each dot is a tiny lit bead
  gl_FragColor = vec4(min(col, 1.), 1.); }`;
const RVS = `attribute float aT; uniform mat3 uRot; uniform vec2 uScale; uniform float uTime, uAmt, uBeat; varying float vA;
void main(){ float th = aT * 6.2831; float spike = exp(-pow(mod(th - uTime * 1.1 + 3.1416, 6.2831) - 3.1416, 2.) * 55.);
  float y = spike * (.55 + .3 * uBeat) * (.4 + .6 * uAmt) + .02 * sin(th * 7. + uTime * 2.);
  vec3 p0 = vec3(cos(th) * 1.75, y - .1, sin(th) * 1.75); vec3 p = vec3(p0.x, p0.y * .85 + p0.z * .5, p0.z * .85 - p0.y * .5); vec3 q = uRot * p; float kp = 3. / (3. + q.z);
  gl_Position = vec4(q.xy * kp * uScale, q.z * .22, 1.); vA = (.1 + spike * .9) * (.6 + .4 * (1. - (q.z + 1.8) / 3.6)); }`;
const RFS = `precision mediump float; uniform vec3 uCol; varying float vA; void main(){ gl_FragColor = vec4(uCol, vA); }`;

let st = null;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
function sh(gl, type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
function prog(gl, v, f) { const p = gl.createProgram(); gl.attachShader(p, sh(gl, gl.VERTEX_SHADER, v)); gl.attachShader(p, sh(gl, gl.FRAGMENT_SHADER, f)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; }
const color = () => { const v = getComputedStyle(document.documentElement).getPropertyValue('--heart').trim(), m = /^#([0-9a-f]{6})$/i.exec(v); return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255) : [.88, .11, .28]; };

export function start(canvas) {
  stop();
  let gl; try { gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: true }); if (!gl) return false; } catch { return false; }
  let P, R;
  try { P = prog(gl, VS, FS); R = prog(gl, RVS, RFS); } catch (e) { console.warn('heart GL disabled:', e.message); return false; }
  const small = innerWidth < 600, pts0 = build(small ? 0.075 : 0.058), ctr = pts0.ctr || { x: 0, y: 0 };
  const n = pts0.length, A = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) { const q = pts0[i], o = i * 8; A.set([q.x - ctr.x, q.y - ctr.y, q.z, q.nx, q.ny, q.nz, Math.random(), Math.random()], o); }
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, A, gl.STATIC_DRAW);
  const RN = 360, T = new Float32Array(RN + 1); for (let i = 0; i <= RN; i++) T[i] = i / RN;
  const rbuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, rbuf); gl.bufferData(gl.ARRAY_BUFFER, T, gl.STATIC_DRAW);
  const U = (pr, nm) => gl.getUniformLocation(pr, nm), up = {}, ur = {};
  for (const k of ['uRot', 'uScale', 'uTime', 'uBeat', 'uAmt', 'uAsm', 'uPx', 'uBurstT', 'uMouseK', 'uMouse', 'uCol']) { up[k] = U(P, k); ur[k] = U(R, k); }
  const S = { raf: 0, canvas, gl, ang: 0, angV: 0, tilt: .08, hov: { x: 0, y: 0 }, hot: false, amt: 0, drag: null, mouse: [9, 9], mk: 0, mkT: 0, t0: performance.now(), burst: -9, asm: reduce ? 1 : 0, ctr, stopped: false, offs: [] };
  const ca = canvas.closest('.hl') || canvas.parentElement;
  function size() { const dpr = Math.min(devicePixelRatio || 1, 2), w = canvas.clientWidth, h = canvas.clientHeight; if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); } gl.viewport(0, 0, canvas.width, canvas.height); return [w, h, dpr]; }
  function frame(now) {
    if (S.stopped) return; if (!canvas.isConnected) { stop(); return; }
    const t = (now - S.t0) / 1000, [w, h, dpr] = size();
    if (!S.drag) { S.ang += S.angV; S.angV *= .94; S.ang += (S.hov.x * .35 - S.ang) * .03 * (Math.abs(S.angV) < .002 ? 1 : 0); S.tilt += (.06 + S.hov.y * .25 - S.tilt) * .06; }
    S.amt += ((S.hot ? 1 : 0) - S.amt) * .08; if (!S.hot && S.amt < .004) S.amt = 0;
    S.mk += ((S.hot ? 1 : 0) - S.mk) * .12;
    if (S.asm < 1) S.asm = Math.min(1, S.asm + .011);
    const ph = (t / .95) % 1, lub = Math.exp(-Math.pow((ph - .08) * 13, 2)), dub = .6 * Math.exp(-Math.pow((ph - .27) * 13, 2)), beat = (lub + dub) * S.amt;
    const sc = Math.min(w, h) * .3 * (1 + .075 * beat), sx = sc / (w / 2), sy = sc / (h / 2);
    const ca_ = Math.cos(S.ang), sa = Math.sin(S.ang), ct = Math.cos(S.tilt), st_ = Math.sin(S.tilt);
    const M = new Float32Array([ca_, st_ * sa, -ct * sa, 0, ct, st_, sa, -st_ * ca_, ct * ca_]);
    if (S.burst >= 0 && t - S.burst > 2.3) S.burst = -9;
    const col = S.col || (S.col = color());
    ca.style.setProperty('--beat', beat.toFixed(3)); ca.style.setProperty('--hot', S.amt.toFixed(3));
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    // ECG ring (additive-looking alpha line)
    gl.useProgram(R); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, rbuf); const al = gl.getAttribLocation(R, 'aT'); gl.enableVertexAttribArray(al); gl.vertexAttribPointer(al, 1, gl.FLOAT, false, 4, 0);
    gl.uniformMatrix3fv(ur.uRot, false, M); gl.uniform2f(ur.uScale, sx, sy); gl.uniform1f(ur.uTime, t); gl.uniform1f(ur.uAmt, S.amt); gl.uniform1f(ur.uBeat, beat); gl.uniform3f(ur.uCol, col[0], col[1], col[2]);
    gl.drawArrays(gl.LINE_STRIP, 0, RN + 1); gl.disableVertexAttribArray(al); gl.disable(gl.BLEND);
    // particles
    gl.useProgram(P); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const l0 = gl.getAttribLocation(P, 'aPos'), l1 = gl.getAttribLocation(P, 'aNrm'), l2 = gl.getAttribLocation(P, 'aSeed');
    gl.enableVertexAttribArray(l0); gl.vertexAttribPointer(l0, 3, gl.FLOAT, false, 32, 0); gl.enableVertexAttribArray(l1); gl.vertexAttribPointer(l1, 3, gl.FLOAT, false, 32, 12); gl.enableVertexAttribArray(l2); gl.vertexAttribPointer(l2, 2, gl.FLOAT, false, 32, 24);
    gl.uniformMatrix3fv(up.uRot, false, M); gl.uniform2f(up.uScale, sx, sy); gl.uniform1f(up.uTime, t); gl.uniform1f(up.uBeat, beat); gl.uniform1f(up.uAmt, S.amt); gl.uniform1f(up.uAsm, S.asm);
    gl.uniform1f(up.uPx, dpr * Math.max(.7, Math.min(w, h) / 320)); gl.uniform1f(up.uBurstT, S.burst < 0 ? 9 : t - S.burst); gl.uniform1f(up.uMouseK, S.mk); gl.uniform2f(up.uMouse, S.mouse[0], S.mouse[1]); gl.uniform3f(up.uCol, col[0], col[1], col[2]);
    gl.drawArrays(gl.POINTS, 0, n);
    gl.disableVertexAttribArray(l0); gl.disableVertexAttribArray(l1); gl.disableVertexAttribArray(l2);
    S.raf = requestAnimationFrame(frame);
  }
  const ptr = e => { const r = canvas.getBoundingClientRect(); S.mouse = [((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)]; };
  const on = (el, ev, fn, o) => { el.addEventListener(ev, fn, o); S.offs.push(() => el.removeEventListener(ev, fn, o)); };
  on(canvas, 'pointerenter', e => { S.hot = true; ptr(e); }); on(canvas, 'pointerleave', () => { S.hot = false; });
  on(canvas, 'pointermove', e => { ptr(e); if (!S.drag) return; const dx = e.clientX - S.drag.x; S.ang += dx * .012; S.angV = dx * .012; S.tilt = Math.max(-.9, Math.min(.9, S.tilt + (e.clientY - S.drag.y) * .008)); S.drag = { x: e.clientX, y: e.clientY, moved: S.drag.moved + Math.abs(dx) }; });
  on(canvas, 'pointerdown', e => { S.drag = { x: e.clientX, y: e.clientY, moved: 0 }; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; });
  const up_ = e => { if (S.drag && S.drag.moved < 6) S.burst = (performance.now() - S.t0) / 1000; S.drag = null; canvas.style.cursor = 'grab'; }; // a click (not a drag) fires the shockwave
  on(canvas, 'pointerup', up_); on(canvas, 'pointercancel', () => { S.drag = null; });
  on(window, 'mg-theme', () => setTimeout(() => { S.col = null; }, 60));
  on(canvas, 'webglcontextlost', e => { e.preventDefault(); stop(); }, false);
  canvas.style.cursor = 'grab'; canvas.title = 'Hover to feel the pulse · drag to turn · click for a shockwave';
  st = S; if (reduce) { frame(performance.now()); S.stopped = true; } else S.raf = requestAnimationFrame(frame);
  return true;
}
export function stop() { if (!st) return; st.stopped = true; cancelAnimationFrame(st.raf); st.offs.forEach(f => f()); try { st.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {} st = null; }
