// Optional Fetal Health (CTG) tab. Inputs are CTG-machine outputs (Kaggle "Fetal Health" structure).
import { predictProba, argmax } from './model.js';
import { esc } from './util.js';
const LABEL = f => f.replace(/_/g, ' ').replace('prolongued', 'prolonged');
let model = null, presets = null, metrics = null;

export async function initCtg(root) {
  const get = u => fetch(u).then(r => r.json());
  [model, presets, metrics] = await Promise.all([get('js/ctg_model.json'), get('js/ctg_presets.json'), get('js/ctg_metrics.json')]);
  root.innerHTML = `
  <div class="card">
    <h2>Fetal health from cardiotocography (CTG)</h2>
    <p class="muted">Optional module. Inputs come from a CTG machine&rsquo;s analysis output, <b>not</b> from a wrist sensor. Random-forest model trained on the public Kaggle Fetal Health dataset (2,126 CTGs; classes Normal / Suspect / Pathological). Decision support only.</p>
    <div class="row"><span class="muted">Load example:</span>
      ${Object.keys(presets).map(k => `<button class="btn mini" data-ctg-preset="${esc(k)}">${esc(k)}</button>`).join('')}
      <button class="btn mini ghost" data-ctg-preset="__median">Dataset median</button></div>
    <div class="ctgfields" id="ctgfields">${model.features.map(f => `<div><label for="ctg-${esc(f)}">${esc(LABEL(f))}</label><input type="number" step="any" id="ctg-${esc(f)}" data-f="${esc(f)}"></div>`).join('')}</div>
    <div id="ctgres" class="card res" style="margin-top:12px"></div>
    <p class="muted">Cross-validated on the dataset: accuracy ${(metrics.accuracy_mean * 100).toFixed(1)}%, Pathological recall ${(metrics.pathological_recall_mean * 100).toFixed(1)}% (${esc(metrics.protocol)}). Class balance is skewed (${metrics.class_counts.join(' / ')}). Not externally validated.</p>
  </div>`;
  const fill = obj => { for (const f of model.features) root.querySelector(`[data-f="${f}"]`).value = obj[f]; run(); };
  const run = () => {
    const x = model.features.map(f => parseFloat(root.querySelector(`[data-f="${f}"]`).value));
    const res = root.querySelector('#ctgres');
    if (x.some(v => !Number.isFinite(v))) { res.className = 'card res'; res.innerHTML = '<b>Enter every CTG field.</b> A missing field is never assumed normal.'; return; }
    const p = predictProba(model, x), c = argmax(p);
    const lvl = ['Low', 'Mid', 'High'][c];
    res.className = `card res ${lvl}`;
    res.innerHTML = `<div class="big">${model.classes[c]}</div>
      <p>${model.classes.map((n, i) => `${n} ${Math.round(p[i] * 100)}%`).join(' · ')}</p>
      ${c ? `<p><b>${c === 2 ? 'Pathological pattern: arrange urgent obstetric review.' : 'Suspect pattern: repeat / continue monitoring and seek review.'}</b></p>` : '<p>Normal pattern predicted. This does not replace clinical review.</p>'}
      <p class="muted">Most influential features in the dataset: ${metrics.top_features.slice(0, 3).map(t => esc(LABEL(t[0]))).join(', ')}.</p>`;
  };
  root.addEventListener('input', e => { if (e.target.dataset.f) run(); });
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-ctg-preset]'); if (!b) return;
    const k = b.dataset.ctgPreset; fill(k === '__median' ? model.medians : presets[k]);
  });
  fill(presets.Normal);
}
