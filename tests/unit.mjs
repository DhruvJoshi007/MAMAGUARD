// Run: node tests/unit.mjs   (no dependencies)
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { predictProba, rowFor, decide } from '../js/model.js';
import { assess, trendCheck } from '../js/risk.js';
import { evaluate } from '../js/validate.js';
import * as ble from '../js/ble.js';
import { buildReferral } from '../js/referral.js';
import { METRICS } from '../js/config.js';
import { parseSpeech } from '../js/voice.js';

const model = JSON.parse(fs.readFileSync(new URL('../js/model_artifact.json', import.meta.url)));
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

t('JS inference matches scikit-learn predict_proba on 40 fixtures', () => {
  const fx = JSON.parse(fs.readFileSync(new URL('../ml/fixtures.json', import.meta.url)));
  for (const f of fx) { const p = predictProba(model, rowFor(model, f.base)); p.forEach((v, i) => assert.ok(Math.abs(v - f.p[i]) < 2e-3, `${v} vs ${f.p[i]}`)); }
});

const SYM0 = { headache: false, vision: false, swelling: false, fetal: false };
const full = { hr: 80, spo2: 98, sleep: 70, stress: 30, sbp: 112, dbp: 70, bs: 6.4, temp: 36.8 };
const run = (o = {}) => assess({ model, age: 25, vals: full, symptoms: SYM0, history: [], ...o });

t('plausible normal visit with all data can be Low', () => { const r = run(); assert.equal(r.levelName, 'Low'); assert.equal(r.provisional, false); });
t('BP >= 160/110 forces High even if the model says Low', () => {
  const r = run({ vals: { ...full, sbp: 162, dbp: 100 } }); assert.equal(r.levelName, 'High');
  const r2 = run({ vals: { ...full, sbp: 130, dbp: 111 } }); assert.equal(r2.levelName, 'High');
});
t('danger sign + raised BP forces High', () => {
  const r = run({ vals: { ...full, sbp: 142, dbp: 88 }, symptoms: { ...SYM0, headache: true } }); assert.equal(r.levelName, 'High');
});
t('danger sign with normal BP is at least Mid', () => { assert.ok(run({ symptoms: { ...SYM0, fetal: true } }).level >= 1); });
t('headache with BP unmeasured => High', () => {
  const { sbp, dbp, ...rest } = full; const r = run({ vals: rest, missing: ['sbp', 'dbp'], symptoms: { ...SYM0, headache: true } }); assert.equal(r.levelName, 'High');
});
t('missing BP/BS/temp is never Low', () => {
  const r = run({ vals: { hr: 79, spo2: 98, sleep: 70, stress: 38 }, missing: ['sbp', 'dbp', 'bs', 'temp'], symptoms: { ...SYM0, fetal: null } });
  assert.notEqual(r.levelName, 'Low'); assert.equal(r.provisional, true); assert.ok(r.missing.length >= 5); assert.equal(r.modelName, null);
});
t('unanswered danger-sign questions block a Low result', () => {
  const r = run({ symptoms: { ...SYM0, vision: null } }); assert.notEqual(r.levelName, 'Low'); assert.ok(r.missing.some(m => m.symptom));
});
t('missing watch-only metrics reduce certainty but are listed', () => {
  const r = run({ vals: { ...full, spo2: undefined, sleep: undefined, stress: undefined }, missing: ['spo2', 'sleep', 'stress'] });
  assert.equal(r.certainty, 'reduced'); assert.equal(r.missing.length, 3);
});
t('3-visit rising BP triggers alert although each reading < 140/90', () => {
  const hist = [{ ts: 'a', vals: { sbp: 112, dbp: 70 } }, { ts: 'b', vals: { sbp: 124, dbp: 78 } }];
  const r = run({ vals: { ...full, sbp: 136, dbp: 86 }, history: hist });
  assert.equal(r.trend.alert, true); assert.ok(r.level >= 1); assert.equal(r.referralEligible, true);
});
t('flat or falling BP does not trigger the trend', () => {
  assert.equal(trendCheck([{ sbp: 120, dbp: 78 }, { sbp: 118, dbp: 76 }, { sbp: 126, dbp: 80 }]).alert, false);
  assert.equal(trendCheck([{ sbp: 120, dbp: 78 }, { sbp: 121, dbp: 79 }, { sbp: 122, dbp: 80 }]).alert, false);
  assert.equal(trendCheck([{ sbp: 120, dbp: 78 }]).enough, false);
});
t('trend + hypertensive latest reading => High', () => {
  const r = run({ vals: { ...full, sbp: 144, dbp: 92 }, history: [{ ts: 'a', vals: { sbp: 120, dbp: 76 } }, { ts: 'b', vals: { sbp: 132, dbp: 84 } }] }); assert.equal(r.levelName, 'High');
});

t('urine protein + raised BP => High; prior pre-eclampsia => at least Mid', () => {
  assert.equal(run({ vals: { ...full, sbp: 142, dbp: 90 }, context: { protein: '2+' } }).levelName, 'High');
  assert.ok(run({ context: { hx: { prior_pe: true } } }).level >= 1);
  assert.equal(run({ vals: { ...full, sbp: 144, dbp: 92 }, context: { hx: { chronic_htn: true } } }).levelName, 'High');
  assert.equal(run({ context: { protein: 'trace' } }).levelName, 'Low');
});
t('implausible readings are blocked; override needs a reason', () => {
  const e = Object.fromEntries(METRICS.map(m => [m.key, { v: full[m.key], src: 'manual_entry' }]));
  e.spo2 = { v: 0, src: 'ble_device' }; e.hr = { v: 255, src: 'simulated_watch' };
  let ev = evaluate(e); assert.deepEqual(ev.blocked.sort(), ['hr', 'spo2']); assert.equal(ev.vals.spo2, undefined);
  e.hr.override = { reason: 'ok' }; ev = evaluate(e); assert.ok(ev.blocked.includes('hr'));        // < 3 chars
  e.hr.override = { reason: 'manual pulse count 118' }; ev = evaluate(e); assert.equal(ev.status.hr, 'overridden'); assert.equal(ev.vals.hr, 255);
  e.sbp = { v: 100, src: 'manual_entry' }; e.dbp = { v: 98, src: 'manual_entry' }; ev = evaluate(e); assert.ok(ev.blocked.includes('dbp') && ev.blocked.includes('sbp'));
});

t('BLE parsers (standard GATT formats)', () => {
  const dv = a => new DataView(new Uint8Array(a).buffer);
  assert.equal(ble.parseHeartRate(dv([0x00, 72])).hr, 72);
  assert.equal(ble.parseHeartRate(dv([0x01, 0x2c, 0x01])).hr, 300);
  // BP 120/80 mmHg: SFLOAT exp0 mant 120 = 0x0078, 80 = 0x0050, MAP 93 = 0x005d
  assert.deepEqual(ble.parseBloodPressure(dv([0x00, 0x78, 0x00, 0x50, 0x00, 0x5d, 0x00])), { sbp: 120, dbp: 80 });
  // kPa: 16.0 kPa = mant 160 exp -1 => 0xF0A0 ; 10.7 kPa => mant 107 exp -1 => 0xF06B
  const kp = ble.parseBloodPressure(dv([0x01, 0xa0, 0xf0, 0x6b, 0xf0, 0, 0])); assert.equal(kp.sbp, 120); assert.equal(kp.dbp, 80);
  // Temp 36.8 C = mant 368 exp -1 => FLOAT32 0xFF000170 (LE: 70 01 00 FF)
  assert.equal(ble.parseTemperature(dv([0x00, 0x70, 0x01, 0x00, 0xff])).temp, 36.8);
  // Temp 98.6 F => mant 986 exp -1 => 0xFF0003DA ; flag bit0 => F
  assert.equal(ble.parseTemperature(dv([0x01, 0xda, 0x03, 0x00, 0xff])).temp, 37);
  assert.equal(ble.parsePlx(dv([0x00, 0x62, 0x00, 0x48, 0x00])).spo2, 98);
  // Glucose 90 mg/dL (kg/L unit): 90e-5 kg/L => mant 900 exp -6 => exp nibble 0xA, mant 0x384 => 0xA384 -> 5.0 mmol/L
  const g = ble.parseGlucose(dv([0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x84, 0xa3, 0x11]));
  assert.ok(Math.abs(g.bs - 5.0) < 0.1, String(g.bs));
  assert.ok(Number.isNaN(ble.sfloat(0x07ff)));
});

t('referral contains ID, vitals, sources, symptoms, reasons, trend, timestamp, disclaimer', () => {
  const entries = Object.fromEntries(METRICS.map(m => [m.key, { v: full[m.key], src: m.group === 'watch' ? 'simulated_watch' : 'simulated_device' }]));
  entries.bs = { v: null, src: null }; entries.sbp = { v: 172, src: 'manual_entry' };
  const status = Object.fromEntries(METRICS.map(m => [m.key, entries[m.key].v == null ? 'missing' : 'ok']));
  const risk = run({ vals: { ...full, sbp: 172 }, symptoms: { ...SYM0, headache: true }, missing: ['bs'] });
  const txt = buildReferral({ patientId: 'MG-TEST1', age: 25, visit: { ts: '2026-01-01T10:00:00Z', weeks: 33, entries, status, symptoms: { ...SYM0, headache: true } }, risk });
  for (const s of ['MG-TEST1', 'HIGH', '[manual_entry]', '[simulated_watch]', '[simulated_device]', 'Blood sugar: NOT MEASURED', 'Severe headache YES', '3-VISIT TREND', 'ble_device:', 'Decision support only']) assert.ok(txt.includes(s), s);
});
t('voice parser: English and Hindi vitals and danger signs', () => {
  const r = parseSpeech('blood pressure 128 over 84, heart rate 82, sugar 6.5, temperature 98.6, oxygen 97');
  assert.deepEqual(r.metrics, { sbp: 128, dbp: 84, hr: 82, spo2: 97, bs: 6.5, temp: 37 });
  const s = parseSpeech('severe headache yes, no blurred vision, swelling, baby movement reduced').symptoms;
  assert.deepEqual(s, { headache: true, vision: false, swelling: true, fetal: true });
  const h = parseSpeech('बीपी 130 80 नाड़ी 88 शुगर 112 सिर दर्द हाँ, धुंधला नहीं');
  assert.equal(h.metrics.sbp, 130); assert.equal(h.metrics.hr, 88); assert.equal(h.metrics.bs, 6.2); assert.equal(h.symptoms.headache, true); assert.equal(h.symptoms.vision, false);
});
console.log(`\n${n} tests passed`);
