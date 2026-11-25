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
  L.push('DANGER SYMPTOMS: ' + SYMPTOMS.map(s => `${s.label} ${symText(visit.symptoms[s.key])}`).join('; '));
  L.push('');
  L.push('3-VISIT TREND (rule-based, not ML): ' + risk.trend.text);
  if (risk.missing.length) { L.push(''); L.push('MISSING / LIMITS: ' + risk.missing.map(m => m.label + (m.blocked ? ' (blocked)' : '')).join(', ') + '. ' + risk.certaintyText); }
  L.push('');
  L.push(DISCLAIMER);
  return L.join('\n');
}
