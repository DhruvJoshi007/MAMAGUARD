// Referral message generator: plain text, copy/share-ready.
import { METRICS, SRC, SYMPTOMS, DISCLAIMER } from './config.js';
import { fmtTime } from './util.js';

const symText = v => v === true ? 'YES' : v === false ? 'no' : 'NOT ASKED';

export function sourceBreakdown(entries) {
  const out = { ble_device: [], simulated_watch: [], simulated_device: [], manual_entry: [] };
  for (const m of METRICS) { const e = entries[m.key]; if (e?.v != null && out[e.src]) out[e.src].push(m.label); }
  return out;
}

// visit = { ts, weeks, age, entries, status, symptoms, risk, overrides }
export function buildReferral({ patientId, age, visit, risk }) {
  const L = [];
  L.push('MAMAGUARD REFERRAL (decision support only)');
  L.push(`Patient ID: ${patientId}   Age: ${age ?? 'n/a'}${visit.weeks ? `   Gestation: ${visit.weeks} wk` : ''}`);
  L.push(`Time: ${fmtTime(visit.ts)}`);
  L.push('');
  L.push(`RISK LEVEL: ${risk.levelName.toUpperCase()}${risk.provisional ? ' (PROVISIONAL: data missing)' : ''}${risk.trend.alert ? '  + BP TREND ALERT' : ''}`);
  for (const r of risk.reasons.filter(r => r.kind !== 'model' || r.text.startsWith('ML model'))) L.push(` - ${r.text}`);
  L.push('');
  L.push('LATEST VITALS [data source]:');
  for (const m of METRICS) {
    const e = visit.entries[m.key], st = visit.status[m.key];
    if (e?.v == null) { L.push(` ${m.label}: NOT MEASURED`); continue; }
    const blocked = st === 'invalid';
    L.push(` ${m.label}: ${e.v}${m.unit === '/100' ? '/100' : ' ' + m.unit} [${e.src}]${blocked ? '  BLOCKED, implausible, excluded from scoring' : ''}${st === 'overridden' ? `  OVERRIDDEN (implausible; reason: ${e.override.reason})` : ''}`);
  }
  const sb = sourceBreakdown(visit.entries);
  L.push('');
  L.push('SOURCE BREAKDOWN:');
  for (const k of Object.keys(sb)) L.push(` ${k}: ${sb[k].length ? sb[k].join(', ') : '-'}`);
  L.push('');
  const c = visit.context || {}, hxl = Object.entries(c.hx || {}).filter(([, v]) => v).map(([k]) => ({ prior_pe: 'previous pre-eclampsia', chronic_htn: 'chronic hypertension', diabetes: 'diabetes' }[k]));
  if (c.protein || c.weight || hxl.length) L.push(`CLINICAL CONTEXT: urine protein ${c.protein || 'not tested'}${c.weight && c.height ? `; BMI ${(c.weight / ((c.height / 100) ** 2)).toFixed(1)} (${c.weight} kg, ${c.height} cm)` : c.weight ? `; weight ${c.weight} kg` : ''}${hxl.length ? '; history: ' + hxl.join(', ') : ''}`), L.push('');
  L.push('DANGER SYMPTOMS: ' + SYMPTOMS.map(s => `${s.label} ${symText(visit.symptoms[s.key])}`).join('; '));
  L.push('');
  L.push('3-VISIT TREND (rule-based, not ML): ' + risk.trend.text);
  if (risk.missing.length) { L.push(''); L.push('MISSING / LIMITS: ' + risk.missing.map(m => m.label + (m.blocked ? ' (blocked)' : '')).join(', ') + '. ' + risk.certaintyText); }
  L.push('');
  L.push(DISCLAIMER);
  return L.join('\n');
}

// Plain-text patient summary (all saved visits) for printing.
export function patientSummary(p) {
  const L = [`MAMAGUARD PATIENT SUMMARY (decision support only)`, `Patient ID: ${p.id}   Age: ${p.age}`, `Consent recorded: ${fmtTime(p.consent.ts)}`, ''];
  p.visits.forEach((v, i) => {
    L.push(`Visit ${i + 1} · ${fmtTime(v.ts)}${v.weeks ? ` · ${v.weeks} wk` : ''}: ${v.risk.levelName.toUpperCase()}${v.risk.provisional ? ' (provisional)' : ''}${v.risk.trend.alert ? ' + trend alert' : ''}`);
    L.push('  ' + METRICS.map(m => `${m.label} ${v.entries[m.key]?.v ?? 'n/m'}${v.entries[m.key]?.v != null ? ` [${v.entries[m.key].src}]` : ''}`).join('; '));
    L.push('  Danger signs: ' + SYMPTOMS.map(s => `${s.label} ${symText(v.symptoms[s.key])}`).join('; '));
  });
  L.push('', DISCLAIMER); return L.join('\n');
}
