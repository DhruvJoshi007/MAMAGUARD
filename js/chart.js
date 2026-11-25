// Dependency-free SVG BP chart with 140/90 and 160/110 reference lines.
import { esc } from './util.js';
export function bpChart(points) { // [{label, sbp, dbp, risk}]
  const pts = points.filter(p => p.sbp != null && p.dbp != null);
  if (!pts.length) return '<p class="muted">No BP recorded yet.</p>';
  const W = 640, H = 260, L = 44, R = 16, T = 16, B = 40;
  const lo = 40, hi = 180, y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const x = i => pts.length === 1 ? (L + W - R) / 2 : L + (W - L - R) * i / (pts.length - 1);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Blood pressure per visit" class="chart">`;
  for (const g of [60, 80, 100, 120, 140, 160, 180]) s += `<line x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" class="grid"/><text x="${L - 6}" y="${y(g) + 4}" text-anchor="end" class="axis">${g}</text>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${y(140)}" y2="${y(140)}" class="ref warn"/><text x="${W - R}" y="${y(140) - 4}" text-anchor="end" class="reflab">140 systolic</text>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${y(90)}" y2="${y(90)}" class="ref warn"/><text x="${W - R}" y="${y(90) - 4}" text-anchor="end" class="reflab">90 diastolic</text>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${y(160)}" y2="${y(160)}" class="ref crit"/><text x="${W - R}" y="${y(160) - 4}" text-anchor="end" class="reflab crit">160 severe</text>`;
  const path = k => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  s += `<path d="${path('sbp')}" class="line sys"/><path d="${path('dbp')}" class="line dia"/>`;
  pts.forEach((p, i) => {
    s += `<circle cx="${x(i)}" cy="${y(p.sbp)}" r="4.5" class="dot sys"/><circle cx="${x(i)}" cy="${y(p.dbp)}" r="4.5" class="dot dia"/>`;
    s += `<text x="${x(i)}" y="${y(p.sbp) - 9}" text-anchor="middle" class="val">${p.sbp}</text><text x="${x(i)}" y="${y(p.dbp) + 17}" text-anchor="middle" class="val">${p.dbp}</text>`;
    s += `<text x="${x(i)}" y="${H - 14}" text-anchor="middle" class="axis">${esc(p.label)}</text>`;
  });
  return s + '</svg><p class="legend"><span class="sw sys"></span>Systolic <span class="sw dia"></span>Diastolic (mmHg)</p>';
}
