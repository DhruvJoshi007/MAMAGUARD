// Risk engine: ML model + hard safety rules (rules can only RAISE risk) + strict missing-data handling
// + rule-based 3-visit BP trend alert (UCI data has no repeat visits, so the trend is NOT learned).
import { M, SYMPTOMS, cToF } from './config.js';
import { predictProba, rowFor, decide, drivers, outsideTraining } from './model.js';

export const LEVELS = ['Low', 'Mid', 'High'];
const FEAT_LABEL = { Age: 'Age', SystolicBP: 'Systolic BP', DiastolicBP: 'Diastolic BP', BS: 'Blood sugar', BodyTemp: 'Body temperature', HeartRate: 'Heart rate' };

// Trend rule: last three visits, BP higher at each visit (steps >= 2 mmHg) and total rise
// >= 10 mmHg systolic or >= 8 mmHg diastolic. Fires even if every single reading is < 140/90.
export function trendCheck(series) { // series: [{ts, sbp, dbp}] oldest -> newest (needs 3)
  if (series.length < 3) return { alert: false, enough: false, text: `Trend needs 3 visits with BP (have ${series.length}).` };
  const s = series.slice(-3);
  const rising = k => s[1][k] - s[0][k] >= 2 && s[2][k] - s[1][k] >= 2;
  const sysUp = rising('sbp') && s[2].sbp - s[0].sbp >= 10;
  const diaUp = rising('dbp') && s[2].dbp - s[0].dbp >= 8;
  const txt = `BP over last 3 visits: ${s.map(v => `${v.sbp}/${v.dbp}`).join(' → ')} mmHg`;
  if (sysUp || diaUp) return { alert: true, enough: true, series: s, text: `${txt}. Rising at every visit (${sysUp ? `systolic +${s[2].sbp - s[0].sbp}` : ''}${sysUp && diaUp ? ', ' : ''}${diaUp ? `diastolic +${s[2].dbp - s[0].dbp}` : ''} mmHg) even if each reading looks borderline.` };
  return { alert: false, enough: true, series: s, text: `${txt}. No sustained rise.` };
}

/**
 * @param {object} p
 *  model: forest json; age: number|null; vals: accepted metric values (SI-ish UI units, temp in °C)
 *  symptoms: {headache,vision,swelling,fetal} each true|false|null(not asked)
 *  history: prior saved visits [{ts, vals:{sbp,dbp}}] oldest->newest (excluding the current one)
 *  blocked/missing: metric keys; overrides: keys accepted via override
 */
export function assess({ model, age, vals, symptoms, history = [], blocked = [], missing = [], overrides = [] }) {
  const reasons = [];
  const add = (kind, severity, text) => reasons.push({ kind, severity, text });
  let floor = 0;              // lowest level the safety rules allow
  const raise = (lvl, kind, text) => { floor = Math.max(floor, lvl); add(kind, lvl, text); };

  const { sbp, dbp, hr, spo2, bs, temp } = vals;
  const yes = k => symptoms[k] === true;
  const present = SYMPTOMS.filter(s => yes(s.key));
  const unasked = SYMPTOMS.filter(s => symptoms[s.key] == null);
  const hasBP = sbp != null && dbp != null;

  // ---- safety rules (override the model upwards, never downwards) ----
  const severeBP = (sbp != null && sbp >= 160) || (dbp != null && dbp >= 110);
  const hyperBP = (sbp != null && sbp >= 140) || (dbp != null && dbp >= 90);
  if (severeBP) raise(2, 'rule', `Severe-range BP ${sbp ?? '?'}/${dbp ?? '?'} mmHg (≥160 systolic or ≥110 diastolic) forces High risk regardless of the model.`);
  if (present.length && hyperBP) raise(2, 'rule', `Danger sign(s) (${present.map(s => s.label.toLowerCase()).join(', ')}) together with raised BP ${sbp ?? '?'}/${dbp ?? '?'} mmHg forces High risk (possible pre-eclampsia).`);
  if (present.some(s => s.key === 'headache' || s.key === 'vision') && !hasBP)
    raise(2, 'rule', 'Severe headache / blurred vision reported and BP is NOT measured: pre-eclampsia cannot be excluded, treated as High risk until BP is taken.');
  if (spo2 != null && spo2 < 90) raise(2, 'rule', `SpO₂ ${spo2}% is below 90% (wrist sensors are unreliable, but this needs prompt clinical re-check).`);
  else if (spo2 != null && spo2 < 94) raise(1, 'rule', `SpO₂ ${spo2}% is below 94%: re-check with a clinical oximeter.`);
  if (hyperBP && !severeBP) raise(1, 'rule', `BP ${sbp ?? '?'}/${dbp ?? '?'} mmHg is in the hypertensive range for pregnancy (≥140 systolic or ≥90 diastolic): at least Mid risk.`);
  if (present.length && !hyperBP) raise(1, 'rule', `Danger sign reported (${present.map(s => s.label.toLowerCase()).join(', ')}): at least Mid risk, assess promptly.`);
  if (temp != null && temp >= 38.0) raise(1, 'rule', `Temperature ${temp.toFixed(1)} °C suggests fever: at least Mid risk.`);
  if (hr != null && (hr >= 120 || hr < 50)) raise(1, 'rule', `Resting heart rate ${hr} bpm is outside 50–119: at least Mid risk (wrist reading, confirm manually).`);
  if (bs != null && bs >= 11.1) raise(1, 'rule', `Blood sugar ${bs.toFixed(1)} mmol/L is ≥11.1: at least Mid risk.`);

  // ---- trend (rule-based) ----
  const series = history.filter(h => h.vals?.sbp != null && h.vals?.dbp != null).map(h => ({ ts: h.ts, sbp: h.vals.sbp, dbp: h.vals.dbp }));
  if (hasBP) series.push({ ts: 'current', sbp, dbp });
  const trend = trendCheck(series);
  if (trend.alert) {
    if (hyperBP) raise(2, 'trend', `TREND ALERT: ${trend.text} Latest reading is also in the hypertensive range, so High risk.`);
    else raise(1, 'trend', `TREND ALERT: ${trend.text}`);
  }

  // ---- model ----
  const x = (age != null && hasBP && bs != null && temp != null && hr != null)
    ? [age, sbp, dbp, bs, cToF(temp), hr] : null;
  let probs = null, modelLevel = null, drv = [], extrapolated = [];
  if (x) {
    probs = predictProba(model, rowFor(model, x));
    modelLevel = decide(model, probs);
    drv = drivers(model, x, modelLevel, probs).filter(d => d.delta > 0.02).slice(0, 3);
    extrapolated = outsideTraining(model, x).map(f => FEAT_LABEL[f]);
    add('model', modelLevel, `ML model (UCI-trained random forest): ${LEVELS[modelLevel]} risk (${LEVELS.map((l, i) => `${l} ${Math.round(probs[i] * 100)}%`).join(' / ')})${model.high_threshold ? `. Triage setting: flags High when P(High) ≥ ${Math.round(model.high_threshold * 100)}%` : ''}.`);
    if (drv.length) add('model', modelLevel, `Inputs pushing the model toward ${LEVELS[modelLevel]} (approximate): ` + drv.map(d => `${FEAT_LABEL[model.features[d.index]]} ${d.delta >= 0 ? '+' : ''}${Math.round(d.delta * 100)} pts`).join(', ') + '.');
    if (extrapolated.length) add('missing', 1, `Outside the model's training range: ${extrapolated.join(', ')}. The model is extrapolating; rely on the safety rules.`);
  }

  // ---- strict missing-data handling ----
  const modelNeeds = ['sbp', 'dbp', 'bs', 'temp', 'hr'].filter(k => vals[k] == null);
  const missingList = [];
  for (const k of missing.concat(blocked).filter((k, i, a) => a.indexOf(k) === i)) {
    missingList.push({ key: k, label: M[k].label, blocked: blocked.includes(k), model: !!M[k].model });
  }
  if (age == null) missingList.push({ key: 'age', label: 'Age', blocked: false, model: true });
  for (const s of unasked) missingList.push({ key: s.key, label: `${s.label} (not asked)`, blocked: false, model: false, symptom: true });

  let provisional = false;
  if (!x) {
    provisional = true;
    const need = modelNeeds.map(k => M[k].label).concat(age == null ? ['Age'] : []);
    add('missing', 1, `The ML model cannot run: missing ${need.join(', ')}. Missing data is never treated as Low risk.`);
  }
  if (unasked.length) {
    provisional = true;
    add('missing', 1, `Danger-sign questions not answered (${unasked.map(s => s.label.toLowerCase()).join(', ')}): Low risk cannot be confirmed.`);
  }
  if (blocked.length) add('missing', 1, `Reading(s) blocked as implausible and excluded from scoring: ${blocked.map(k => M[k].label).join(', ')}.`);
  if (overrides.length) add('missing', 1, `Implausible reading(s) accepted by override: ${overrides.map(k => M[k].label).join(', ')}. Review the reason before relying on them.`);

  let level = Math.max(modelLevel ?? 0, floor);
  if (provisional) level = Math.max(level, 1);          // strict rule: unknown ≠ Low
  const unconfirmedLow = provisional && level === 1 && floor < 1 && (modelLevel ?? 0) < 1;

  const supplementary = ['spo2', 'sleep', 'stress'].filter(k => vals[k] == null);
  let certainty = 'full';
  if (!x || unasked.length) certainty = 'low';
  else if (supplementary.length || blocked.length || overrides.length) certainty = 'reduced';

  const certaintyText = {
    full: '',
    reduced: `Core inputs present, but ${[...supplementary.map(k => M[k].label), ...blocked.map(k => M[k].label + ' (blocked)')].join(', ') || 'some readings need review'} ${supplementary.length || blocked.length ? 'missing/blocked' : ''}. Certainty is reduced.`.replace(/\s+\./, '.'),
    low: 'Key inputs or danger-sign answers are missing. This result is provisional and must not be read as "low risk".',
  }[certainty];

  const referralEligible = level === 2 || trend.alert;
  return { level, levelName: LEVELS[level], provisional, unconfirmedLow, modelLevel, modelName: modelLevel == null ? null : LEVELS[modelLevel],
    probs, reasons, missing: missingList, certainty, certaintyText, trend, referralEligible,
    overridden: modelLevel != null && level > modelLevel, rulesFloor: floor, dangerSigns: present.map(s => s.label), extrapolated };
}
