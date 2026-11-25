import { esc, } from './util.js';
import { DISCLAIMER } from './config.js';
let ctgM = null, dbM = null;
const pct = x => (x * 100).toFixed(1) + '%';
const pm = o => `${pct(o.mean)} <span class="muted">±${(o.std * 100).toFixed(1)}</span>`;
const cm = (mat, labels) => `<table class="cm"><thead><tr><th>actual \\ predicted</th>${labels.map(l => `<th>${l}</th>`).join('')}<th>recall</th></tr></thead><tbody>${mat.map((r, i) => { const t = r.reduce((a, b) => a + b, 0); return `<tr><th>${labels[i]}</th>${r.map((v, j) => `<td class="${i === j ? 'diag' : ''}">${v}</td>`).join('')}<td>${pct(r[i] / t)}</td></tr>`; }).join('')}</tbody></table>`;
const name = k => k.replace('|', ' · ').replace(/_/g, ' ');

export async function renderModelTab(el, m) {
  if (dbM === null) { try { dbM = await (await fetch('js/dataset_b_metrics.json')).json(); } catch { dbM = false; } }
  if (!ctgM) { try { ctgM = await (await fetch('js/ctg_metrics.json')).json(); } catch { ctgM = false; } }
  const f = m.dataset_facts, T = m.tables, key = `${m.chosen.model}|${m.chosen.feature_set}`, sel = T.raw_dedup[key], s = sel.metrics;
  const other = `${m.chosen.model}|${m.chosen.feature_set === 'base' ? 'engineered' : 'base'}`, o = T.raw_dedup[other].metrics;
  const row = (k, r, mark) => { const g = r.metrics; return `<tr><td>${esc(name(k))}${mark === k ? ' <b>(shipped)</b>' : ''}</td><td>${pct(g.accuracy.mean)}</td><td>${pct(g.macro_f1.mean)}</td><td><b>${pm(g.high_recall)}</b></td><td>${pct(g.high_precision.mean)}</td><td>${pct(g.high_specificity.mean)}</td><td>${g.high_roc_auc.mean.toFixed(3)}</td><td>${g.high_pr_auc.mean.toFixed(3)}</td></tr>`; };
  const head = '<thead><tr><th>Model · features</th><th>Accuracy</th><th>Macro F1</th><th>High recall</th><th>High precision</th><th>High specificity</th><th>ROC-AUC</th><th>PR-AUC</th></tr></thead>';
  const cr = T.conflict_resolved[key].metrics, nv = T.naive_leaky[`${m.chosen.model}|base`].metrics;
  const proto = (label, g, note) => `<tr><td>${label}</td><td>${pct(g.accuracy.mean)}</td><td>${pct(g.high_recall.mean)}</td><td>${pct(g.high_precision.mean)}</td><td class="muted">${note}</td></tr>`;
  const tri = m.triage, tm = tri.metrics, hi = sel.confusion_matrix_summed_over_seeds[2], hiT = hi.reduce((a, b) => a + b, 0);
  const dRec = s.high_recall.mean - o.high_recall.mean, dAcc = s.accuracy.mean - o.accuracy.mean;
  el.innerHTML = `
  <div class="card"><h2>Model &amp; evaluation (real cross-validated metrics)</h2>
    <p><b>Data:</b> UCI Maternal Health Risk (id 863, CC BY 4.0), ${f.rows} rows: Age, SystolicBP, DiastolicBP, BS, BodyTemp, HeartRate → Low / Mid / High. Classes: ${Object.entries(f.class_counts).map(([k, v]) => `${k} ${v}`).join(', ')}.</p>
    <p class="warn soft"><b>Why the numbers are lower than many online notebooks:</b> ${f.exact_duplicate_rows} of ${f.rows} rows are exact duplicates, so only ${f.raw_dedup_rows} rows are unique. Leaving them in puts copies of one record in both train and test and inflates accuracy to about ${pct(nv.accuracy.mean)} (last table). Here duplicates are dropped, identical vitals stay in one fold, and the scaler is fitted inside each fold. The honest accuracy is about ${pct(s.accuracy.mean)}.</p>
    <h3>Headline protocol: de-duplicated, original labels (out-of-fold, 5 repeats)</h3>
    <div class="tablewrap"><table>${head}<tbody>${Object.entries(T.raw_dedup).map(([k, r]) => row(k, r, key)).join('')}</tbody></table></div>
    <p class="muted">${esc(m.protocol)}</p>
    <p class="muted"><b>Selection:</b> ${esc(m.selection_rule)}</p>
    <h3>Confusion matrix: shipped model (summed over 5 repeats)</h3>
    <div class="tablewrap">${cm(sel.confusion_matrix_summed_over_seeds, m.labels_order)}</div>
    <p>The model alone finds ${pct(s.high_recall.mean)} of true High-risk records; ${pct(hi[0] / hiT)} are labelled Low and ${pct(hi[1] / hiT)} Mid. Most of the remaining error is Low vs Mid, which matters far less than a missed High.</p>
  </div>
  <div class="card"><h2>Label noise: two ways of handling conflicting labels</h2>
    <p>${f.conflicting_feature_vectors} sets of identical vitals appear with different risk labels. <b>Raw-dedup</b> keeps them as they are (headline). <b>Conflict-resolved</b> replaces each by the majority label, ties going to the higher risk (${f.conflict_resolved_rows} rows). Resolving also cleans the test labels, so it looks better but is easier and is not a fair estimate of real-world performance.</p>
    <div class="tablewrap"><table><thead><tr><th>Protocol (${esc(name(key))})</th><th>Accuracy</th><th>High recall</th><th>High precision</th><th></th></tr></thead><tbody>
    ${proto('Raw-dedup (headline)', s, 'original labels, duplicates removed')}${proto('Conflict-resolved', cr, 'majority-vote labels, easier')}${proto('Naive, duplicates kept', nv, 'LEAKS: do not trust')}</tbody></table></div>
  </div>
  <div class="card"><h2>Clinical feature engineering</h2>
    <p>I added pulse pressure, mean arterial pressure, shock index (HR / systolic) and flags for BP ≥130/80, ≥140/90, blood sugar &gt;7.8, age &lt;18 and age ≥35 to every model (rows tagged “engineered” above). For the shipped model type the change was ${dAcc >= 0 ? '+' : ''}${(dAcc * 100).toFixed(1)} points accuracy and ${dRec >= 0 ? '+' : ''}${(dRec * 100).toFixed(1)} points High recall, ${Math.abs(dRec) < 0.02 && Math.abs(dAcc) < 0.02 ? 'which is within run-to-run noise' : ''}. ${m.chosen.feature_set === 'engineered' ? 'The engineered set won the selection rule and is shipped.' : 'The selection rule kept the original six inputs. Trees can already form these combinations from raw BP on this data, so the extra features add no reliable signal.'}</p>
  </div>
  <div class="card"><h2>High-risk triage setting</h2>
    <p>Framed as <b>High vs not High</b>, the model scores ROC-AUC ${s.high_roc_auc.mean.toFixed(3)} and PR-AUC ${s.high_pr_auc.mean.toFixed(3)}. The app flags High when P(High) reaches <b>${Math.round(m.deployed_high_threshold * 100)}%</b> instead of using plain argmax. The threshold is tuned for High recall (target ${pct(tri.target_high_recall)}).</p>
    <p><b>Honest check (nested):</b> choosing the threshold inside each training fold and testing on untouched folds gives High recall <b>${pm(tm.high_recall)}</b>, precision ${pct(tm.high_precision.mean)}, specificity ${pct(tm.high_specificity.mean)}. More High cases are caught, at the cost of more false alarms.</p>
    <div class="tablewrap">${cm(tri.confusion_matrix_summed_over_seeds, m.labels_order)}</div>
  </div>
  <div class="card"><h2>Safety rules sit above the model</h2><p>Rules run after the model and can only raise risk: BP ≥160/110, danger signs with BP ≥140/90, headache or blurred vision with BP unmeasured, SpO₂ &lt;90%, and more. The result panel states whether the model drove the level or a rule/trend overrode it.</p></div>
  <div class="card"><h2>3-visit trend alert</h2><p><b>Rule-based, not machine-learned.</b> The UCI dataset has about 1,000 rows (${f.raw_dedup_rows} unique), one per woman, with no repeat visits, so there is nothing to train a trend model on. Rule: BP is higher at each of the last three visits (steps ≥2 mmHg) and the total rise is ≥10 mmHg systolic or ≥8 mmHg diastolic. It fires even when every single reading is below 140/90, and it floors risk at Mid (High if the latest BP is already ≥140/90).</p></div>
  <div class="card"><h2>Fetal health (CTG) model</h2>${ctgM ? `<p>Kaggle Fetal Health structure, ${ctgM.rows} CTGs${ctgM.duplicates_dropped ? ` (${ctgM.duplicates_dropped} duplicates dropped)` : ''}. Cross-validated accuracy ${pct(ctgM.accuracy_mean)}, Pathological recall ${pct(ctgM.pathological_recall_mean)}.</p><div class="tablewrap">${cm(ctgM.confusion_matrix, ctgM.labels)}</div>` : '<p class="muted">Metrics unavailable.</p>'}</div>
  ${dbM ? `<div class="card"><h2>Extra dataset (evaluation only, not deployed)</h2>
    <p>Updated CSV: ${dbM.rows_raw} rows, ${dbM.classes}. After dropping ${dbM.dropped_missing} with missing values, ${dbM.dropped_implausible} implausible and duplicates, ${dbM.rows_used} rows (${dbM.high} High). Same leak-free protocol (grouped 5-fold CV).</p>
    <div class="tablewrap"><table><thead><tr><th>Inputs</th><th>AUC</th><th>Accuracy</th><th>High recall</th><th>High precision</th></tr></thead><tbody>${dbM.results.map(r => `<tr><td>${esc(r.name)}</td><td>${r.auc}</td><td>${(r.accuracy * 100).toFixed(1)}%</td><td>${(r.recall_high * 100).toFixed(1)}%</td><td>${(r.precision_high * 100).toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>
    <div class="warn soft"><b>Read with care:</b><ul>${dbM.findings.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
    <p class="muted">Reproduce: <code>python ml/train_dataset_b.py</code></p></div>` : ''}
  <div class="card"><h2>Limits</h2><ul>${m.limitations.map(l => `<li>${esc(l)}</li>`).join('')}<li>${esc(DISCLAIMER)}</li><li>Plausibility bounds: HR 30–220, SpO₂ 70–100, SBP 60–260, DBP 30–150 (and ≥10 below systolic), blood sugar 1.5–40 mmol/L, temp 34–42 °C, sleep/stress 0–100, age 12–55.</li></ul>
  <p class="muted">Reproduce: <code>python ml/train_eval.py</code> (rewrites <code>js/model_artifact.json</code>, which also carries these metrics).</p></div>`;
}
