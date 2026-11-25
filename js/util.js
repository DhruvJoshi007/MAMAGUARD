export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const nowIso = () => new Date().toISOString();
export const fmtTime = iso => { try { return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; } };
export const fmtNum = (v, dp = 0) => (v == null || Number.isNaN(v)) ? '—' : Number(v).toFixed(dp);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function newPatientId(existing = []) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike characters
  for (;;) {
    let s = 'MG-';
    const buf = new Uint8Array(5); crypto.getRandomValues(buf);
    for (const b of buf) s += A[b % A.length];
    if (!existing.includes(s)) return s;
  }
}
