// Dispatcher: the WebGL heart when available, otherwise the 2D canvas heart (same API).
import * as gl from './heartgl.js';
import * as d2 from './heart2d.js';
let mode = null;
export function startHeart(el) { stopHeart(); if (gl.start(el)) { mode = 'gl'; } else { mode = '2d'; d2.startHeart(el); } }
export function stopHeart() { if (mode === 'gl') gl.stop(); else if (mode === '2d') d2.stopHeart(); mode = null; }
export function setHeartSpeed(level) { if (mode === '2d') d2.setHeartSpeed(level); }
