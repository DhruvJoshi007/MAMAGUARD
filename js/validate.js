// Plausibility checks + the "accepted values" gate that feeds scoring.
import { M, METRICS, AGE_BOUNDS } from './config.js';

// entry = { v:number|null, src, override?:{reason, ts} }
export function checkValue(key, v, vals = {}) {
  const m = M[key];
  if (v == null || v === '') return { ok: true, missing: true };
  if (typeof v !== 'number' || !Number.isFinite(v))
    return { ok: false, msg: `${m.label}: not a valid number.` };
  if (v < m.min || v > m.max)
    return { ok: false, msg: `${m.label} ${v} ${m.unit} is outside the plausible range (${m.min}–${m.max} ${m.unit}). Possible sensor glitch or typo: re-read, correct, or override with a reason.` };
  if (key === 'dbp' && vals.sbp != null && vals.sbp - v < 10)
    return { ok: false, msg: `Diastolic ${v} is within 10 mmHg of systolic ${vals.sbp}. Pulse pressure that small is implausible: re-measure.` };
  if (key === 'sbp' && vals.dbp != null && v - vals.dbp < 10)
    return { ok: false, msg: `Systolic ${v} is within 10 mmHg of diastolic ${vals.dbp}. Pulse pressure that small is implausible: re-measure.` };
  return { ok: true };
}

export function checkAge(a) {
  if (!Number.isFinite(a) || a < AGE_BOUNDS[0] || a > AGE_BOUNDS[1])
    return { ok: false, msg: `Patients must be at least ${AGE_BOUNDS[0]} years old (accepted range ${AGE_BOUNDS[0]}–${AGE_BOUNDS[1]}).` };
  return { ok: true };
}

// Returns per-metric status: 'missing' | 'ok' | 'invalid' (blocked) | 'overridden'
export function evaluate(entries) {
  const raw = {};
  for (const m of METRICS) raw[m.key] = entries[m.key]?.v ?? null;
  const status = {}, msgs = {}, vals = {};
  for (const m of METRICS) {
    const e = entries[m.key];
    const r = checkValue(m.key, raw[m.key], raw);
    if (r.missing) { status[m.key] = 'missing'; continue; }
    if (r.ok) { status[m.key] = 'ok'; vals[m.key] = raw[m.key]; continue; }
    msgs[m.key] = r.msg;
    if (e?.override?.reason && e.override.reason.trim().length >= 3) { status[m.key] = 'overridden'; vals[m.key] = raw[m.key]; }
    else status[m.key] = 'invalid';
  }
  return { status, msgs, vals,
    blocked: METRICS.filter(m => status[m.key] === 'invalid').map(m => m.key),
    missing: METRICS.filter(m => status[m.key] === 'missing').map(m => m.key) };
}
