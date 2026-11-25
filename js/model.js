// Random-forest inference port (trees exported from scikit-learn by ml/train.py).
const softmax = z => { const mx = Math.max(...z), e = z.map(v => Math.exp(v - mx)), s = e.reduce((a, b) => a + b, 0); return e.map(v => v / s); };
// scikit-learn casts inputs to float32 before comparing with float64 thresholds; Math.fround reproduces that exactly.
const walk = (t, x) => { let n = 0; while (t.l[n] !== -1) n = x[t.f[n]] <= t.t[n] ? t.l[n] : t.r[n]; return t.v[n]; };
// Inference for every artifact type written by ml/train_eval.py: random_forest | gradient_boosting | logistic_regression
export function predictProba(model, x) {
  if (model.type !== 'logistic_regression') x = x.map(Math.fround);
  if (model.type === 'logistic_regression') {
    const z = x.map((v, i) => (v - model.mean[i]) / model.scale[i]);
    return softmax(model.coef.map((row, k) => row.reduce((s, c, i) => s + c * z[i], model.intercept[k])));
  }
  if (model.type === 'gradient_boosting') {
    const raw = model.init.slice();
    for (const stage of model.stages) stage.forEach((t, k) => { raw[k] += model.learning_rate * walk(t, x); });
    return softmax(raw);
  }
  const k = model.classes ? model.classes.length : 3, p = new Array(k).fill(0);   // random forest (also the CTG model)
  for (const t of model.trees) { const v = walk(t, x); for (let i = 0; i < k; i++) p[i] += v[i]; }
  return p.map(v => v / model.trees.length);
}
export const argmax = a => a.indexOf(Math.max(...a));

// Base vitals [age, sbp, dbp, bs, tempF, hr] -> model input row (adds the engineered features when the artifact uses them).
// Must match feats() in ml/train_eval.py exactly.
export function rowFor(model, b) {
  if (!model.engineered) return b;
  const [age, sbp, dbp, bs, , hr] = b, pp = sbp - dbp;
  return [...b, pp, dbp + pp / 3, hr / sbp, +(sbp >= 130 || dbp >= 80), +(sbp >= 140 || dbp >= 90), +(bs > 7.8), +(age < 18), +(age >= 35)];
}
// Triage decision: flag High when P(High) reaches the tuned threshold, otherwise choose between Low and Mid.
export function decide(model, p) {
  const t = model.high_threshold;
  if (t && p[2] >= t) return 2;
  return t ? (p[1] > p[0] ? 1 : 0) : argmax(p);
}

// Approximate local explanation: how much does swapping ONE input for a typical low-risk value
// reduce the probability of the predicted class? (Occlusion, not SHAP. Positive = pushed toward the prediction.)
export function drivers(model, x, cls, probs) {
  const out = [];
  model.features.forEach((f, i) => {
    const y = x.slice(); y[i] = model.low_risk_reference[f];
    const p2 = predictProba(model, rowFor(model, y))[cls];
    out.push({ feature: f, index: i, delta: probs[cls] - p2 });
  });
  return out.sort((a, b) => b.delta - a.delta);
}
export function outsideTraining(model, x) {
  return model.features.map((f, i) => ({ f, v: x[i], r: model.training_ranges[f] }))
    .filter(o => o.v < o.r[0] || o.v > o.r[1]).map(o => o.f);
}
