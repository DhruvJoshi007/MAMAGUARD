import { METRICS, M, SRC, SYMPTOMS, DISCLAIMER, AGE_BOUNDS, WEEKS_BOUNDS } from './config.js';
import { esc, $, $$, nowIso, fmtTime, fmtNum, sleep } from './util.js';
import { evaluate, checkAge } from './validate.js';
import { assess } from './risk.js';
import * as store from './store.js';
import { Simulator, SCENARIOS, WATCH_PROFILE } from './sim.js';
import { connectBle, bleSupported } from './ble.js';
import { buildReferral, sourceBreakdown } from './referral.js';
import { bpChart } from './chart.js';
import { initCtg } from './ctg.js';
import { renderModelTab } from './modeltab.js';
import './bg.js';
import { startHeart, stopHeart, setHeartSpeed } from './heart3d.js';

const S = { tab: 'patients', pid: null, model: null, metrics: null, draft: null, sim: null, simOn: false, ble: null, log: [], busy: {}, lastRisk: null, ctgReady: false };
const getJson = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
const setHtml = (el, html) => { if (el && el._h !== html) { el._h = html; el.innerHTML = html; } };
const ZT = { ok: 'in range', watch: 'watch', alert: 'high / low' };
function zoneOf(k, v) {
  if (v == null || Number.isNaN(v)) return 'none';
  const z = { hr: v < 50 || v >= 120 ? 'alert' : v < 60 || v > 100 ? 'watch' : 'ok', spo2: v < 90 ? 'alert' : v < 95 ? 'watch' : 'ok',
    sbp: v >= 160 ? 'alert' : v >= 130 ? 'watch' : 'ok', dbp: v >= 110 ? 'alert' : v >= 85 ? 'watch' : 'ok',
    bs: v >= 11.1 ? 'alert' : v > 7.8 ? 'watch' : 'ok', temp: v >= 38 ? 'alert' : v > 37.5 || v < 36 ? 'watch' : 'ok' }[k];
  return z || 'none';
}
const patient = () => store.getPatient(S.pid);

/* ---------- boot ---------- */
async function boot() {
  store.load();
  try { S.model = await getJson('js/model_artifact.json'); S.metrics = S.model.evaluation; }
  catch (e) { document.querySelector('main').innerHTML = `<div class="warn">Could not load the risk model (${esc(e.message)}). Reload while online once.</div>`; return; }
  S.sim = new Simulator((k, v, src) => setReading(k, v, src, { stream: src === 'simulated_watch' && S.sim.streaming }));
  wireNet(); wireEvents(); renderPatients(); showTab('patients');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(() => { S.swReady = true; wireNet(); }).catch(() => {});
}
function wireNet() {
  const upd = () => {
    const on = navigator.onLine, n = $('#net');
    n.className = 'net ' + (on ? 'online' : 'offline');
    $('#net-text').textContent = on ? 'Online' : 'Offline: working from local data' ;
    if (S.swReady || navigator.serviceWorker?.controller) $('#net-text').textContent += ' · app cached for offline use';
  };
  if (!S.netWired) { addEventListener('online', upd); addEventListener('offline', upd); S.netWired = true; }
  upd();
}

/* ---------- tabs ---------- */
function showTab(t) {
  S.tab = t;
  for (const b of $$('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
  for (const s of $$('main > section')) s.hidden = s.id !== 'tab-' + t;
  if (t !== 'patients') stopHeart();
  if (t !== 'visit') dispatchEvent(new CustomEvent('mg-risk', { detail: 'none' }));
  if (t === 'patients') renderPatients();
  if (t === 'visit') buildVisit();
  if (t === 'history') renderHistory();
  if (t === 'model') renderModelTab($('#tab-model'), S.metrics);
  if (t === 'ctg' && !S.ctgReady) { S.ctgReady = true; initCtg($('#tab-ctg')).catch(e => { $('#tab-ctg').innerHTML = `<div class="warn">CTG model failed to load: ${esc(e.message)}</div>`; S.ctgReady = false; }); }
  scrollTo(0, 0);
}

/* ---------- patients ---------- */
function riskPill(r) { return r ? `<span class="pill ${r.levelName}">${r.levelName}${r.provisional ? ' (provisional)' : ''}</span>` : '<span class="pill none">no visits</span>'; }
const STEPS = ['Consent', 'Patient', 'Start'];
function flowHtml() {
  const f = S.flow, steps = `<ol class="steps">${STEPS.map((s, i) => `<li class="${i < f.step ? 'done' : i === f.step ? 'on' : ''}"><span>${i < f.step ? '✓' : i + 1}</span>${s}</li>`).join('')}</ol>`;
  let body = '';
  if (f.step === 0) body = `<h2>Patient consent</h2>
    <label class="consent" for="np-consent"><input id="np-consent" type="checkbox" ${f.consent ? 'checked' : ''}><span>The patient has been told what is recorded and <b>consents</b> to anonymised, on-device storage of her vitals for this check-up. The time of consent will be recorded.</span></label>
    <div class="row end"><button class="btn primary" data-act="flow-next" id="flow-next" ${f.consent ? '' : 'disabled'}>Continue</button></div>`;
  if (f.step === 1) body = `<h2>Patient details</h2>
    <label for="np-age">Age (years)</label><input id="np-age" type="number" inputmode="numeric" min="${AGE_BOUNDS[0]}" max="${AGE_BOUNDS[1]}" value="${esc(f.age)}" placeholder="e.g. 27">
    <p class="muted">No names. A random anonymous Patient ID is created for this record.</p>
    <div id="np-msg" class="warn" hidden></div>
    <div class="row end"><button class="btn ghost" data-act="flow-back">Back</button><button class="btn primary" data-act="flow-next">Continue</button></div>`;
  if (f.step === 2) body = `<h2>Start the visit</h2>
    <button class="btn primary big" data-act="create-patient" id="np-create">Start live visit</button>
    <p class="muted" style="text-align:center;margin:10px 0 6px">or try a demo scenario</p>
    <div class="scn">${Object.entries(SCENARIOS).map(([k, s]) => `<button class="btn" data-act="scenario" data-sc="${k}"><b>${esc(s.name)}</b><small>${esc(s.blurb)}</small></button>`).join('')}</div>
    <div class="row end"><button class="btn ghost" data-act="flow-back">Back</button></div>`;
  return steps + body;
}
function renderPatients() {
  const el = $('#tab-patients'), list = store.patients();
  if (!S.flow) S.flow = { step: 0, consent: false, age: '' };
  const all = list.flatMap(p => p.visits), hi = all.filter(v => v.risk.levelName === 'High').length, al = list.filter(p => p.visits.at(-1)?.risk.trend?.alert).length;
  el.innerHTML = `
  <section class="hero3d" id="hero3d">
    <div class="hl"><canvas id="heart3d" aria-label="Interactive 3D heart: drag to rotate" role="img"></canvas>
      <h1>Antenatal risk,<br>at a glance</h1><p class="muted">Vitals in, risk and referral out. Works offline.</p></div>
    <div class="flowcard" id="flowcard">${store.isPersistent() ? '' : '<p class="warn">Storage is blocked in this browser: data will be lost on reload.</p>'}<div id="flowbody">${flowHtml()}</div></div>
  </section>
  <div class="stats"><div class="stat"><b>${list.length}</b><span>patients</span></div><div class="stat"><b>${all.length}</b><span>visits</span></div><div class="stat ${hi ? 'hi' : ''}"><b>${hi}</b><span>high-risk visits</span></div><div class="stat ${al ? 'md' : ''}"><b>${al}</b><span>trend alerts</span></div></div>
  <h2>Recent patients</h2>
  ${list.length ? list.map(p => { const last = p.visits.at(-1)?.risk; return `
    <div class="card"><div class="row" style="justify-content:space-between">
      <div><b style="font-size:1.1rem">${esc(p.id)}</b> ${riskPill(last)} ${last?.trend?.alert ? '<span class="pill Mid">Trend alert</span>' : ''}<br>
      <span class="muted">Age ${esc(p.age)} · ${p.visits.length} visit(s) · consent ${esc(fmtTime(p.consent.ts))}</span></div>
      <div class="row"><button class="btn" data-act="open" data-pid="${esc(p.id)}">Open</button>
      ${S.confirmDel === p.id ? `<button class="btn danger" data-act="delete-confirm" data-pid="${esc(p.id)}">Yes, permanently delete</button><button class="btn ghost" data-act="delete-cancel">Cancel</button>`
        : `<button class="btn danger" data-act="delete" data-pid="${esc(p.id)}">Delete patient data</button>`}</div></div></div>`; }).join('') : '<p class="muted">No patients yet.</p>'}
  ${list.length ? '<button class="btn ghost" data-act="delete-all">Delete ALL data on this device…</button>' : ''}`;
  startHeart($('#heart3d'));
  const hero = $('#hero3d'), card = $('#flowcard');
  hero.addEventListener('pointermove', e => { const r = hero.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5; card.style.setProperty('--ry', (x * 8).toFixed(2) + 'deg'); card.style.setProperty('--rx', (-y * 6).toFixed(2) + 'deg'); });
  hero.addEventListener('pointerleave', () => { card.style.setProperty('--ry', '0deg'); card.style.setProperty('--rx', '0deg'); });
}
function renderFlow() { const b = $('#flowbody'); if (b) { b.innerHTML = flowHtml(); b.classList.remove('swap'); void b.offsetWidth; b.classList.add('swap'); } }

function createPatient(age, synthetic = false) {
  const p = store.createPatient({ age, consentGiven: S.flow?.consent, synthetic });
  return p;
}

/* ---------- visit draft ---------- */
function newDraft(weeks = null) {
  return { weeks, entries: Object.fromEntries(METRICS.map(m => [m.key, { v: null, src: null }])), symptoms: Object.fromEntries(SYMPTOMS.map(s => [s.key, null])), ovOpen: {} };
}
function setReading(key, v, src, { stream = false } = {}) {
  const d = S.draft; if (!d) return;
  const e = d.entries[key];
  if (stream && e.src === 'manual_entry' && e.v != null) return;   // streams never clobber typed values
  d.entries[key] = { v, src };
  const inp = $(`#in-${key}`);
  if (inp && document.activeElement !== inp) inp.value = v ?? '';
  const rw = $(`.mrow[data-key="${key}"]`); if (rw) { rw._flash = true; setTimeout(() => { rw._flash = false; rw.classList.remove('flash'); }, 700); }
  refresh();
}
function log(msg) { S.log.unshift(`${new Date().toLocaleTimeString()}  ${msg}`); S.log.length = Math.min(S.log.length, 5); const l = $('#devlog'); if (l) l.textContent = S.log.join('\n'); }

function buildVisit() {
  const el = $('#tab-visit'), p = patient();
  if (!p) { el.innerHTML = '<div class="card"><h2>Visit</h2><p>Select or create a patient first (Patients tab).</p></div>'; return; }
  if (!S.draft) S.draft = newDraft();
  if (!p.consent?.given) { el.innerHTML = '<div class="warn">No consent recorded for this patient. Device pairing and saving are locked.</div>'; return; }
  const d = S.draft;
  const row = m => `
    <div class="mrow" data-key="${m.key}">
      <div class="thead"><label for="in-${m.key}">${m.label}</label><span class="badge" data-badge></span></div>
      <div class="tval"><button class="step" data-act="step" data-key="${m.key}" data-d="-1" aria-label="Decrease ${m.label}">−</button>
        <input id="in-${m.key}" type="number" inputmode="decimal" step="${m.step}" data-key="${m.key}" value="${d.entries[m.key].v ?? ''}" placeholder="—" aria-describedby="msg-${m.key}">
        <button class="step" data-act="step" data-key="${m.key}" data-d="1" aria-label="Increase ${m.label}">+</button></div>
      <div class="tfoot"><span class="unit">${m.unit}</span><span class="zone" data-zone></span><button class="btn mini ghost" data-act="clear" data-key="${m.key}" title="Clear this reading" aria-label="Clear ${m.label}">clear</button></div>
      <div class="mmsg" id="msg-${m.key}"></div>
    </div>`;
  el.innerHTML = `
  <div id="sumbar" class="sumbar" aria-live="polite"></div>
  <div class="card"><div class="row" style="justify-content:space-between">
    <div><h2 style="margin:0"><span id="v-pid">${esc(p.id)}</span></h2><span class="muted">Age ${esc(p.age)} · visit #${p.visits.length + 1}</span></div>
    <div><label for="in-weeks" class="muted">Weeks</label> <input id="in-weeks" type="number" style="width:90px" min="${WEEKS_BOUNDS[0]}" max="${WEEKS_BOUNDS[1]}" value="${d.weeks ?? ''}"></div></div></div>

  <div class="card">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">Capture vitals</h2>
      <label class="switch"><input type="checkbox" id="simtoggle" ${S.simOn ? 'checked' : ''}> Demo mode (simulated sensors)</label></div>
    <div class="row" style="margin-top:10px">
      <button class="btn" data-act="ble-connect" ${bleSupported() ? '' : 'title="Web Bluetooth not supported in this browser"'}>Connect Bluetooth</button>
      <span id="simpanel" class="row" ${S.simOn ? '' : 'hidden'}>
        <button class="btn primary" data-act="sim-all">Capture all vitals</button>
        <button class="btn" data-act="sim-watch" id="watchbtn">${S.sim.streaming ? 'Stop live stream' : 'Start live stream'}</button>
        <button class="btn ghost" data-act="sim-glitch" title="Emit an impossible value to demonstrate the plausibility check">Inject glitch</button>
      </span>
    </div>
    <p class="muted" id="bletxt">${S.ble ? `Connected: ${esc(S.ble.name)} · live: ${esc(S.ble.found.join(', ') || 'none')}` : bleSupported() ? '' : 'Bluetooth unavailable in this browser'}</p>
    <div class="log" id="devlog" aria-live="polite">${esc(S.log.join('\n'))}</div>
  </div>

  <div class="card"><h2 style="margin-bottom:2px">Vitals</h2>
    <div class="tiles">${METRICS.map(row).join('')}</div></div>

  <div class="card"><h3>Danger symptoms</h3>
    ${SYMPTOMS.map(s => `<div class="sym"><span id="sl-${s.key}">${s.label}</span><div class="seg" role="group" aria-labelledby="sl-${s.key}">
      <button class="yes" data-act="sym" data-key="${s.key}" data-val="true">Yes</button><button class="no" data-act="sym" data-key="${s.key}" data-val="false">No</button><button class="na" data-act="sym" data-key="${s.key}" data-val="null">Not asked</button></div></div>`).join('')}
  </div>

  <div id="result"></div>
  <div class="card row">
    <button class="btn primary" data-act="save-visit" id="savebtn">Save visit</button>
    <button class="btn" data-act="ref-draft" id="refbtn">Referral message</button>
    <span class="muted" id="savemsg" role="status"></span>
  </div>`;
  refresh();
}

/* ---------- live assessment ---------- */
function compute() {
  const p = patient(), d = S.draft, ev = evaluate(d.entries);
  const overrides = METRICS.filter(m => ev.status[m.key] === 'overridden').map(m => m.key);
  const r = assess({ model: S.model, age: p.age, vals: ev.vals, symptoms: d.symptoms, history: p.visits.map(v => ({ ts: v.ts, vals: v.vals })), blocked: ev.blocked, missing: ev.missing, overrides });
  return { ev, r, overrides };
}
function badgeFor(e, st) {
  if (e.v == null) return ['none', 'MISSING', 'Not measured'];
  return [e.src, SRC[e.src].label, SRC[e.src].title];
}
function refresh() {
  if (S.tab !== 'visit' || !S.draft || !patient() || !$('#result')) return;
  const { ev, r } = compute(); S.lastRisk = r;
  dispatchEvent(new CustomEvent('mg-risk', { detail: r.levelName }));
  const d = S.draft;
  for (const m of METRICS) {
    const row = $(`.mrow[data-key="${m.key}"]`), e = d.entries[m.key], st = ev.status[m.key];
    row.className = 'mrow ' + st + ' z-' + (st === 'invalid' ? 'bad' : zoneOf(m.key, e.v)) + (row._flash ? ' flash' : '');
    $('[data-zone]', row).textContent = st === 'invalid' ? 'implausible' : ZT[zoneOf(m.key, e.v)] || '';
    const b = $('[data-badge]', row), [cls, txt, ttl] = badgeFor(e, st);
    b.className = 'badge ' + cls; b.textContent = txt; b.title = ttl;
    let msg = '';
    if (st === 'invalid' || st === 'overridden') {
      msg = `<div class="warn ${st === 'overridden' ? 'soft' : ''}" role="alert">${st === 'invalid' ? '⚠ BLOCKED, not used in scoring. ' : '⚠ Overridden. '}${esc(ev.msgs[m.key])}
        ${st === 'overridden' ? `<br>Override reason: <b>${esc(e.override.reason)}</b>` : ''}
        <div class="row"><button class="btn mini" data-act="reread" data-key="${m.key}">Re-read</button><button class="btn mini" data-act="correct" data-key="${m.key}">Correct value</button>
        ${st === 'invalid' ? `<button class="btn mini danger" data-act="ov-open" data-key="${m.key}">Override…</button>` : `<button class="btn mini" data-act="ov-remove" data-key="${m.key}">Remove override</button>`}</div>
        ${d.ovOpen[m.key] && st === 'invalid' ? `<div class="row"><input type="text" id="ovr-${m.key}" placeholder="Reason (required), e.g. confirmed with manual cuff" maxlength="140" style="flex:1 1 220px"><button class="btn mini primary" data-act="ov-confirm" data-key="${m.key}">Accept this value</button></div>` : ''}</div>`;
    } else if (st === 'missing') msg = '';
    setHtml($(`#msg-${m.key}`), msg);
  }
  for (const s of SYMPTOMS) for (const b of $$(`.seg button[data-key="${s.key}"]`)) b.setAttribute('aria-pressed', String(String(d.symptoms[s.key]) === b.dataset.val));
  setHtml($('#result'), resultHtml(r, ev));
  const have = METRICS.filter(m => d.entries[m.key].v != null).length, asked = SYMPTOMS.filter(x => d.symptoms[x.key] != null).length, tot = METRICS.length + SYMPTOMS.length, pct = Math.round((have + asked) / tot * 100);
  setHtml($('#sumbar'), `<div class="ring" style="--p:${pct}"><span>${pct}%</span></div><div class="sbtxt"><div class="sbl">Risk now</div><div class="sbv ${r.levelName}">${r.levelName.toUpperCase()}${r.provisional ? ' · provisional' : ''}${r.trend.alert ? ' · trend alert' : ''}</div><div class="muted">${have}/${METRICS.length} vitals · ${asked}/${SYMPTOMS.length} danger-sign answers</div></div>`);
  $('#savebtn').disabled = ev.blocked.length > 0;
  $('#savemsg').textContent = ev.blocked.length ? 'Fix, re-read or override the blocked reading(s) before saving.' : '';
  $('#refbtn').className = 'btn' + (r.referralEligible ? ' danger' : '');
  $('#refbtn').textContent = r.referralEligible ? 'Referral message (recommended)' : 'Referral message';
  $('#refbtn').disabled = !r.referralEligible;
  $('#refbtn').title = r.referralEligible ? '' : 'Available for High risk or a trend alert';
}
function resultHtml(r, ev) {
  const kindTag = { rule: 'SAFETY RULE', model: 'MODEL', trend: 'TREND', missing: 'DATA' };
  const srcs = sourceBreakdown(S.draft.entries);
  return `<div class="card res ${r.levelName}">
    <div class="row" style="justify-content:space-between"><div><span class="muted">Risk level</span><div class="big">${r.levelName.toUpperCase()}${r.provisional ? ' <span class="pill Mid">PROVISIONAL</span>' : ''}${r.trend.alert ? ' <span class="pill High">TREND ALERT</span>' : ''}</div></div>
    <div class="muted" style="text-align:right">${r.modelName ? (r.overridden ? '<span class="pill High">Safety rule / trend overrode the model</span>' : '<span class="pill Low">Model-driven</span>') : ''}<br>${r.modelName ? `Model alone: ${r.modelName}` : 'Model could not run'}</div></div>
    ${r.missing.length ? `<div class="missbox" role="alert"><b>Missing / unusable (${r.missing.length}):</b> ${r.missing.map(m => esc(m.label) + (m.blocked ? ' [blocked]' : '')).join(', ')}.<br>${esc(r.certaintyText)}</div>` : ``}
    <h3>Why this level</h3>
    <ul class="reasons">${r.reasons.filter(x => x.kind !== 'model' || true).map(x => `<li><span class="k ${x.kind}">${kindTag[x.kind]}</span>${esc(x.text)}</li>`).join('') || '<li>No risk factors identified from the data entered.</li>'}</ul>
    ${r.trend.enough ? `<p class="muted"><b>Trend:</b> ${esc(r.trend.text)}</p>` : ''}
    <p class="muted"><b>Sources this visit:</b> ${Object.entries(srcs).map(([k, v]) => `${k}: ${v.length ? v.join(', ') : '–'}`).join(' · ')}</p>
  </div>`;
}

/* ---------- history ---------- */
function renderHistory() {
  const el = $('#tab-history'), p = patient();
  if (!p) { el.innerHTML = '<div class="card"><h2>History</h2><p>Select a patient first.</p></div>'; return; }
  const v = p.visits;
  const cell = (visit, k) => { const e = visit.entries[k]; return e?.v == null ? '<span class="badge none">MISSING</span>' : `${fmtNum(e.v, M[k].dp)} <span class="badge ${e.src}" title="${esc(SRC[e.src].title)}">${SRC[e.src].label}</span>${visit.status[k] === 'overridden' ? ' <span class="pill Mid">override</span>' : ''}`; };
  el.innerHTML = `<div class="card"><h2>${esc(p.id)}: blood pressure across visits</h2>${bpChart(v.map((x, i) => ({ label: `V${i + 1}${x.weeks ? ' · ' + x.weeks + 'w' : ''}`, sbp: x.vals.sbp, dbp: x.vals.dbp })))}
    ${v.length ? `<p><b>Trend:</b> ${esc(v.at(-1).risk.trend.text)} ${v.at(-1).risk.trend.alert ? '<span class="pill High">ALERT</span>' : ''}</p>` : ''}</div>
  <div class="card"><h3>Visits</h3>${v.length ? `<div class="tablewrap"><table><thead><tr><th>#</th><th>Time</th><th>Risk</th>${METRICS.map(m => `<th>${m.label} (${m.unit})</th>`).join('')}<th>Symptoms</th><th></th></tr></thead><tbody>
    ${v.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(fmtTime(x.ts))}</td><td>${riskPill(x.risk)}${x.risk.trend.alert ? ' <span class="pill Mid">trend</span>' : ''}</td>${METRICS.map(m => `<td>${cell(x, m.key)}</td>`).join('')}
    <td>${SYMPTOMS.map(s => `${s.label.split(' ')[0]} ${x.symptoms[s.key] === true ? 'YES' : x.symptoms[s.key] === false ? 'no' : '?'}`).join(', ')}</td>
    <td>${x.risk.referralEligible ? `<button class="btn mini danger" data-act="ref-visit" data-i="${i}">Referral</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No saved visits yet.</p>'}</div>
  <div class="card"><button class="btn" data-act="open" data-pid="${esc(p.id)}">New visit</button></div>`;
}

/* ---------- referral ---------- */
function openReferral(text) {
  $('#reftext').value = text; $('#refnote').textContent = '';
  $('#refshare').hidden = !navigator.share;
  $('#refdlg').showModal(); $('#reftext').focus(); $('#reftext').select();
}

/* ---------- actions ---------- */
async function runMeasure(kind, fast = false) {
  if (S.busy[kind]) return; S.busy[kind] = true;
  log(`Reading ${kind}…`);
  try { const r = await S.sim.measure(kind, fast); log(`${kind}: ${Object.entries(r).map(([k, v]) => k + '=' + v).join(' ')}`); }
  catch (e) { log(`${kind}: ${e.message}`); }
  finally { S.busy[kind] = false; }
}
function simSetup(sc) { S.sim.setProfile(sc?.target || {}, sc?.unavailable || []); }

async function launchScenario(key) {
  const sc = SCENARIOS[key];
  const p = createPatient(sc.age, true); S.flow = null;
  const watchKeys = ['hr', 'spo2', 'sleep', 'stress'];
  sc.prior.forEach(pv => {
    const ts = new Date(Date.now() - pv.weeksAgo * 7 * 864e5).toISOString();
    const entries = Object.fromEntries(METRICS.map(m => [m.key, { v: pv.vals[m.key] ?? null, src: watchKeys.includes(m.key) ? 'simulated_watch' : 'simulated_device' }]));
    const ev = evaluate(entries), symptoms = { headache: false, vision: false, swelling: false, fetal: false };
    const hist = p.visits.map(v => ({ ts: v.ts, vals: v.vals }));
    const risk = assess({ model: S.model, age: p.age, vals: ev.vals, symptoms, history: hist, blocked: ev.blocked, missing: ev.missing });
    store.addVisit(p.id, { id: crypto.randomUUID?.() || String(Math.random()), ts, weeks: pv.weeks, age: p.age, entries, status: ev.status, vals: ev.vals, symptoms, risk, overrides: [] });
  });
  S.pid = p.id; S.draft = newDraft(sc.weeks); S.draft.symptoms = { ...sc.symptoms };
  S.log = []; S.simOn = true; S.sim.stopWatch(); simSetup(sc);
  showTab('visit');
  log(`${sc.name}: capturing…`);
  for (const k of watchKeys) if (sc.target[k] != null) setReading(k, sc.target[k], 'simulated_watch');
  log('Vitals captured (simulated).');
  await Promise.all([runMeasure('bp', true), runMeasure('glucose', true), runMeasure('temp', true)]);
}

function saveVisit() {
  const p = patient(), d = S.draft, { ev, r, overrides } = compute();
  if (ev.blocked.length) return;
  if (!METRICS.some(m => d.entries[m.key].v != null) && SYMPTOMS.every(s => d.symptoms[s.key] == null)) { $('#savemsg').textContent = 'Nothing to save yet: enter or capture at least one reading.'; return; }
  S.sim.stopWatch();
  const visit = { id: crypto.randomUUID?.() || String(Math.random()), ts: nowIso(), weeks: d.weeks, age: p.age, consentTs: p.consent.ts,
    entries: JSON.parse(JSON.stringify(d.entries)), status: ev.status, vals: ev.vals, symptoms: { ...d.symptoms }, risk: r, overrides };
  store.addVisit(p.id, visit);
  S.draft = null; showTab('history');
  if (r.referralEligible) openReferral(buildReferral({ patientId: p.id, age: p.age, visit, risk: r }));
}

function wireEvents() {
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'np-consent') { S.flow.consent = t.checked; $('#flow-next').disabled = !t.checked; }
    if (t.id === 'simtoggle') { S.simOn = t.checked; if (!S.simOn) { S.sim.stopWatch(); } simSetup(null); $('#simpanel').hidden = !S.simOn; $('#watchbtn').textContent = 'Start live stream'; log(S.simOn ? 'Demo mode ON: sensors are simulated.' : 'Demo mode OFF.'); }
  });
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset?.key && t.type === 'number' && S.draft) {
      const v = t.value === '' ? null : parseFloat(t.value);
      S.draft.entries[t.dataset.key] = { v: Number.isNaN(v) ? null : v, src: v == null || Number.isNaN(v) ? null : 'manual_entry' };
      refresh();
    }
    if (t.id === 'np-age') S.flow.age = t.value;
    if (t.id === 'in-weeks' && S.draft) S.draft.weeks = t.value === '' ? null : parseInt(t.value, 10);
  });
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act, key = b.dataset.key, d = S.draft;
    try {
      switch (a) {
        case 'create-patient': {
          const age = parseFloat(S.flow.age), c = checkAge(age);
          if (!c.ok) { S.flow.step = 1; renderFlow(); const m = $('#np-msg'); m.hidden = false; m.textContent = c.msg; return; }
          const p = createPatient(age); S.flow = null; S.pid = p.id; S.draft = newDraft(); S.log = []; showTab('visit'); break;
        }
        case 'flow-next': { if (S.flow.step === 1) { const c = checkAge(parseFloat(S.flow.age)); if (!c.ok) { const m = $('#np-msg'); m.hidden = false; m.textContent = c.msg; return; } } S.flow.step++; renderFlow(); break; }
        case 'flow-back': S.flow.step--; renderFlow(); break;
        case 'scenario': await launchScenario(b.dataset.sc); break;
        case 'open': S.pid = b.dataset.pid; S.draft = newDraft(); S.log = []; S.sim.stopWatch(); S.simOn = false; showTab('visit'); break;
        case 'delete': S.confirmDel = b.dataset.pid; renderPatients(); break;
        case 'delete-cancel': S.confirmDel = null; renderPatients(); break;
        case 'delete-confirm': store.deletePatient(b.dataset.pid); if (S.pid === b.dataset.pid) { S.pid = null; S.draft = null; } S.confirmDel = null; renderPatients(); break;
        case 'delete-all': if (S.confirmAll) { store.deleteAll(); S.pid = null; S.draft = null; S.confirmAll = false; renderPatients(); } else { S.confirmAll = true; b.textContent = 'Click again to permanently delete ALL patient data'; b.classList.add('danger'); } break;
        case 'step': { const m = M[key], cur = d.entries[key].v; const base = cur ?? { hr: 80, spo2: 97, sleep: 70, stress: 40, sbp: 115, dbp: 72, bs: 6.5, temp: 36.8 }[key];
          const nv = Math.round((base + (+b.dataset.d) * m.step) * 10) / 10; d.entries[key] = { v: nv, src: 'manual_entry' }; $(`#in-${key}`).value = nv; refresh(); break; }
        case 'clear': d.entries[key] = { v: null, src: null }; $(`#in-${key}`).value = ''; delete d.ovOpen[key]; refresh(); break;
        case 'sym': d.symptoms[key] = b.dataset.val === 'null' ? null : b.dataset.val === 'true'; refresh(); break;
        case 'correct': $(`#in-${key}`).focus(); $(`#in-${key}`).select(); break;
        case 'reread':
          if (S.simOn) { log(`Re-reading ${M[key].label}…`); d.entries[key] = { v: null, src: null }; await S.sim.reread(key); }
          else { d.entries[key] = { v: null, src: null }; $(`#in-${key}`).value = ''; refresh(); log(S.ble ? `Waiting for the next ${M[key].label} notification from the device.` : `Cleared ${M[key].label}: take the reading again and type it in.`); $(`#in-${key}`).focus(); }
          break;
        case 'ov-open': d.ovOpen[key] = true; refresh(); $(`#ovr-${key}`)?.focus(); break;
        case 'ov-confirm': { const r = $(`#ovr-${key}`).value.trim(); if (r.length < 3) { $(`#ovr-${key}`).focus(); $(`#ovr-${key}`).placeholder = 'A reason is required (3+ characters)'; return; }
          d.entries[key].override = { reason: r, ts: nowIso() }; d.ovOpen[key] = false; refresh(); break; }
        case 'ov-remove': delete d.entries[key].override; refresh(); break;
        case 'ble-connect':
          try { S.ble = await connectBle((k, v) => { if (M[k]) setReading(k, v, 'ble_device'); }, log); log(`Connected to ${S.ble.name}.`); buildVisit(); }
          catch (err) { log('Bluetooth: ' + err.message); }
          break;
        case 'sim-watch': if (S.sim.streaming) { S.sim.stopWatch(); b.textContent = 'Start live stream'; log('Live stream stopped.'); } else { S.sim.startWatch(); b.textContent = 'Stop live stream'; log('Live stream started.'); } break;
        case 'sim-meas': await runMeasure(b.dataset.kind); break;
        case 'sim-all': S.sim.startWatch(); $('#watchbtn').textContent = 'Stop live stream'; await Promise.all([runMeasure('bp'), runMeasure('glucose'), runMeasure('temp')]); break;
        case 'sim-glitch': { const g = S.sim.glitch(); log(`Injected glitch: ${g[0]} = ${g[1]}`); break; }
        case 'save-visit': saveVisit(); break;
        case 'ref-draft': { const p = patient(), { ev, r, overrides } = compute();
          openReferral(buildReferral({ patientId: p.id, age: p.age, visit: { ts: nowIso(), weeks: d.weeks, entries: d.entries, status: ev.status, symptoms: d.symptoms }, risk: r })); break; }
        case 'ref-visit': { const p = patient(), v = p.visits[+b.dataset.i]; openReferral(buildReferral({ patientId: p.id, age: p.age, visit: v, risk: v.risk })); break; }
        case 'ref-copy': { const t = $('#reftext'); t.select(); try { await navigator.clipboard.writeText(t.value); $('#refnote').textContent = 'Copied.'; } catch { document.execCommand?.('copy'); $('#refnote').textContent = 'Selected: press Ctrl/Cmd+C to copy.'; } break; }
        case 'ref-share': try { await navigator.share({ title: 'MamaGuard referral', text: $('#reftext').value }); } catch {} break;
        case 'ref-close': $('#refdlg').close(); break;
      }
    } catch (err) { console.error(err); const m = $('#np-msg') || $('#savemsg'); if (m) { m.hidden = false; m.textContent = err.message; } }
  });
}
boot();
