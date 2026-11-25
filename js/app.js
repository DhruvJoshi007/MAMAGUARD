import { METRICS, M, SRC, SYMPTOMS, DISCLAIMER, AGE_BOUNDS, WEEKS_BOUNDS } from './config.js';
import { esc, $, $$, nowIso, fmtTime, fmtNum, sleep } from './util.js';
import { evaluate, checkAge } from './validate.js';
import { assess } from './risk.js';
import * as store from './store.js';
import { Simulator, SCENARIOS, WATCH_PROFILE } from './sim.js';
import { connectBle, bleSupported } from './ble.js';
import { buildReferral, sourceBreakdown, patientSummary } from './referral.js';
import { t as tt, getLang, setLang, LANGS, hasKey } from './i18n.js';
import { parseSpeech, voiceSupported, listen } from './voice.js';
import { suggest, dueState, ics, ymd } from './followup.js';
import { bpChart } from './chart.js';
import { initCtg } from './ctg.js';
import { renderModelTab } from './modeltab.js';
import './bg.js';
import * as auth from './auth.js';
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
const BLE_HINT = 'Watches like the Amazfit Pop 2 have no heart-rate broadcast mode and use a private protocol, so a web page cannot read them over Bluetooth. Use Voice entry or manual entry for their readings, or a device that supports standard Bluetooth health services (chest strap, BP cuff, thermometer, oximeter).';
const fuText = fu => { const st = dueState(fu.due); return st.state === 'overdue' ? tt('fu_overdue', { d: -st.days }) : st.state === 'today' ? tt('fu_today') : tt('fu_in', { d: st.days }); };
const overdueList = () => store.patients().filter(p => p.followup && dueState(p.followup.due).state === 'overdue');
function followupsHtml() {
  const L = store.patients().filter(p => p.followup).sort((a, b) => a.followup.due.localeCompare(b.followup.due));
  const perm = typeof Notification === 'undefined' ? null : Notification.permission;
  const btn = perm === null ? '' : perm === 'granted' ? `<span class="pill Low">${tt('fu_alert_ok')}</span>` : perm === 'denied' ? `<span class="muted">${tt('fu_blocked')}</span>` : `<button class="btn mini" data-act="fu-notify">${tt('fu_alert_on')}</button>`;
  return `<div class="card" id="fucard"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${tt('fu_list')}</h2>${btn}</div>
    ${L.length ? `<ul class="fulist">${L.map(p => { const st = dueState(p.followup.due).state; return `<li class="fu ${st}"><b>${esc(p.id)}</b> <span class="pill ${p.followup.level}">${lvlW(p.followup.level)}</span> <span class="fud">${esc(p.followup.due)}</span> <span class="fus">${fuText(p.followup)}</span> <button class="btn mini" data-act="open" data-pid="${esc(p.id)}">${tt('open')}</button> <button class="btn mini ghost" data-act="fu-ics" data-pid="${esc(p.id)}">${tt('fu_ics')}</button></li>`; }).join('')}</ul>` : `<p class="muted">${tt('fu_none')}</p>`}
    <p class="muted" style="font-size:.78rem;margin:8px 0 0">${tt('fu_note')}</p></div>`;
}
function downloadIcs(pid, due, level) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([ics(pid, due, level)], { type: 'text/calendar' })); a.download = `mamaguard-followup-${pid}.ics`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// missed-visit alerts: logged once per missed follow-up, shown as a notification when permitted. Fires while the app is open or when it is opened.
function checkOverdue() {
  let changed = false;
  for (const p of overdueList()) {
    if (p.followup.alerted) continue;
    store.patchFollowup(p.id, { alerted: true }); changed = true;
    const text = tt('fu_missed_log', { id: p.id, date: p.followup.due }); store.addLog('alert', p.id, text);
    try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(tt('fu_alert_title'), { body: tt('fu_alert_body', { id: p.id, date: p.followup.due }), tag: 'mg-' + p.id }); } catch {}
  }
  if (changed && S.tab === 'patients') renderPatients();
}
const patient = () => store.getPatient(S.pid);
const mLabel = m => hasKey('m_' + m.key) ? tt('m_' + m.key) : m.label;
const sLabel = s => hasKey('y_' + s.key) ? tt('y_' + s.key) : s.label;
const LVN = ['Low', 'Mid', 'High'];
const lvlW = n => tt('lv_w_' + n), lvlU = n => tt('lv_' + n);
const trArg = (k, v) => k === 'signs' || k === 'list' ? (v || []).map(x => hasKey('y_' + x) ? tt('y_' + x) : hasKey('m_' + x) ? tt('m_' + x) : x === 'age' ? tt('age_w') : x).join(', ') : v;
function trReason(x) {
  if (!x.key || getLang() === 'en' || !hasKey(x.key)) return x.text;
  const a = {}; for (const [k, v] of Object.entries(x.args || {})) a[k] = trArg(k, v);
  if (x.key === 'r_model') { const pr = x.args.p || []; return tt('r_model', { lvl: lvlW(LVN[x.args.lvl]), pl: LVN.map((l, i) => `${lvlW(l)} ${pr[i]}%`).join(' / ') }) + (x.args.thr ? ' ' + tt('r_thr', { thr: x.args.thr }) : ''); }
  return tt(x.key, a);
}
function applyStatic() {
  document.querySelectorAll('#tabs button').forEach(b => { b.textContent = tt('n_' + ({ patients: 'dash', visit: 'visit', history: 'hist', ctg: 'ctg', model: 'model' })[b.dataset.tab]); });
  $('#signout').textContent = tt('signout');
  $('#refttl').textContent = tt('ref_title');
  for (const [id, k] of [['ref-copy', 'ref_copy'], ['ref-wa', 'ref_wa'], ['ref-sms', 'ref_sms'], ['ref-print', 'ref_print'], ['ref-share', 'ref_share'], ['ref-close', 'close']]) { const b = document.querySelector(`[data-act="${id}"]`); if (b) b.textContent = tt(k); }
  $('#settingsbtn-t').textContent = tt('settings'); document.querySelector('[data-act="set-close"]').textContent = tt('close'); if ($('#setdlg').open) renderSettings();
}
const THEMES = ['auto', 'light', 'dark', 'midnight', 'ocean', 'rose', 'sepia'];
function applyTheme(th, from) {
  const root = document.documentElement, set = () => { th === 'auto' ? root.removeAttribute('data-theme') : root.dataset.theme = th; dispatchEvent(new Event('mg-theme')); setTimeout(() => document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--meta').trim() || '#0f766e'), 80); };
  try { localStorage.setItem('mamaguard.theme', th); } catch {}
  if (!from) return set();
  const r = from.getBoundingClientRect(); root.style.setProperty('--tx', Math.round(r.left + r.width / 2) + 'px'); root.style.setProperty('--ty', Math.round(r.top + r.height / 2) + 'px');
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(set);
  else { root.classList.add('theming'); set(); setTimeout(() => root.classList.remove('theming'), 650); }
}
let curTheme = 'auto';
function wireTheme() { try { curTheme = localStorage.getItem('mamaguard.theme') || 'auto'; } catch {} if (!THEMES.includes(curTheme)) curTheme = 'auto'; applyTheme(curTheme); }
function changeLang(l) { setLang(l); S.lang = getLang(); applyStatic(); if (!$('#gate').hidden) { location.reload(); return; } S.draft && S.tab === 'visit' ? buildVisit() : showTab(S.tab); if (S.tab === 'patients') renderPatients(); }
const SW = { auto: 'linear-gradient(90deg,#f3f7f6 50%,#0d1a19 50%)', light: '#f3f7f6', dark: '#0d1a19', midnight: '#000', ocean: '#0a1626', rose: '#fff3f5', sepia: '#f6efe2' };
function renderSettings() {
  $('#setttl').textContent = tt('settings');
  $('#setbody').innerHTML = `<h3>${tt('th_label')}</h3><div class="swgrid" role="radiogroup" aria-label="${tt('th_label')}">${THEMES.map(k => `<button class="swb" role="radio" aria-checked="${k === curTheme}" data-act="set-theme" data-v="${k}"><i style="background:${SW[k]}"></i>${tt('th_' + k)}</button>`).join('')}</div>
    <h3>${tt('langl')}</h3><div class="swgrid" role="radiogroup" aria-label="${tt('langl')}">${Object.entries(LANGS).map(([k, v]) => `<button class="swb" role="radio" aria-checked="${k === getLang()}" data-act="set-lang" data-v="${k}">${v}</button>`).join('')}</div>`;
}

/* ---------- one-time device login ---------- */
function showWho() { const on = auth.isLoggedIn(); $('#who').hidden = $('#signout').hidden = !on; $('#who').textContent = on ? (auth.workerName() || tt('signed_in')) : ''; }
function gate() {
  return new Promise(resolve => {
    const g = $('#gate'), setup = !auth.isSetUp();
    g.hidden = false; $('main').setAttribute('inert', ''); $('#tabs').setAttribute('inert', '');
    g.innerHTML = `<form class="gatecard" id="gateform" autocomplete="off">
      <img src="icons/icon.svg" alt="" width="56" height="56"><h1>${tt(setup ? 'g_setup' : 'g_welcome')}</h1>
      <p class="muted">${tt(setup ? 'g_setup_p' : 'g_pin_p')}</p>
      ${setup ? `<label for="g-name">${tt('g_name')}</label><input id="g-name" type="text" maxlength="40" placeholder="e.g. A. Rao" required>` : ''}
      <label for="g-pin">${tt(setup ? 'g_pin_new' : 'g_pin')}</label><input id="g-pin" type="password" inputmode="numeric" pattern="\\d{4,6}" maxlength="6" autocomplete="${setup ? 'new-password' : 'current-password'}" required>
      ${setup ? `<label for="g-pin2">${tt('g_pin2')}</label><input id="g-pin2" type="password" inputmode="numeric" pattern="\\d{4,6}" maxlength="6" required>` : ''}
      <div id="g-msg" class="warn" hidden></div>
      <button class="btn primary big" type="submit">${tt(setup ? 'g_save' : 'g_signin')}</button>
      ${setup ? '' : `<button class="btn ghost" type="button" id="g-reset">${tt('g_forgot')}</button>`}
      <p class="muted" style="font-size:.78rem">${tt('g_local')}</p></form>`;
    $('#g-pin').focus();
    const msg = t => { const m = $('#g-msg'); m.hidden = !t; m.textContent = t || ''; };
    $('#gateform').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        if (setup) { if ($('#g-pin').value !== $('#g-pin2').value) return msg(tt('pin_mismatch')); await auth.setup($('#g-name').value, $('#g-pin').value); }
        else await auth.signIn($('#g-pin').value);
        g.hidden = true; g.innerHTML = ''; $('main').removeAttribute('inert'); $('#tabs').removeAttribute('inert'); showWho(); resolve();
      } catch (err) { msg(err.message); }
    });
    $('#g-reset')?.addEventListener('click', () => {
      if (!$('#g-reset').dataset.sure) { $('#g-reset').dataset.sure = '1'; $('#g-reset').textContent = tt('reset_sure'); $('#g-reset').classList.add('danger'); return; }
      store.deleteAll(); auth.resetProfile(); S.pid = null; location.reload();
    });
  });
}

/* ---------- boot ---------- */
async function boot() {
  store.load(); S.lang = getLang(); wireTheme(); applyStatic();
  try { S.model = await getJson('js/model_artifact.json'); S.metrics = S.model.evaluation; }
  catch (e) { document.querySelector('main').innerHTML = `<div class="warn">Could not load the risk model (${esc(e.message)}). Reload while online once.</div>`; return; }
  if (!auth.isLoggedIn()) await gate(); else showWho();
  S.pid = store.lastPid();
  S.sim = new Simulator((k, v, src) => setReading(k, v, src, { stream: src === 'simulated_watch' && S.sim.streaming }));
  wireNet(); wireEvents(); showTab('patients');
  checkOverdue(); setInterval(checkOverdue, 600000); document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkOverdue(); if (S.tab === 'patients') renderPatients(); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(() => { S.swReady = true; wireNet(); }).catch(() => {});
}
function wireNet() {
  const upd = () => {
    const on = navigator.onLine, n = $('#net');
    n.className = 'net ' + (on ? 'online' : 'offline');
    $('#net-text').textContent = on ? tt('online') : tt('offline') ;
    if (S.swReady || navigator.serviceWorker?.controller) $('#net-text').textContent += ' · ' + tt('cached');
  };
  if (!S.netWired) { addEventListener('online', upd); addEventListener('offline', upd); S.netWired = true; }
  upd();
}

/* ---------- tabs ---------- */
function showTab(t) {
  S.tab = t; applyStatic();
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
function riskPill(r) { return r ? `<span class="pill ${r.levelName}">${lvlW(r.levelName)}${r.provisional ? ' (' + tt('prov') + ')' : ''}</span>` : `<span class="pill none">${tt('no_visits')}</span>`; }
const STEPS = () => [tt('s_consent'), tt('s_patient'), tt('s_start')];
function flowHtml() {
  const f = S.flow, steps = `<ol class="steps">${STEPS().map((s, i) => `<li class="${i < f.step ? 'done' : i === f.step ? 'on' : ''}"><span>${i < f.step ? '✓' : i + 1}</span>${s}</li>`).join('')}</ol>`;
  let body = '';
  if (f.step === 0) body = `<h2>${tt('c_title')}</h2>
    <label class="consent" for="np-consent"><input id="np-consent" type="checkbox" ${f.consent ? 'checked' : ''}><span>${tt('c_text')}</span></label>
    <div class="row end"><button class="btn primary" data-act="flow-next" id="flow-next" ${f.consent ? '' : 'disabled'}>${tt('cont')}</button></div>`;
  if (f.step === 1) body = `<h2>${tt('p_title')}</h2>
    <label for="np-age">${tt('age')}</label><input id="np-age" type="number" inputmode="numeric" min="${AGE_BOUNDS[0]}" max="${AGE_BOUNDS[1]}" value="${esc(f.age)}" placeholder="e.g. 27">
    <p class="muted">${tt('p_note')}</p>
    <div id="np-msg" class="warn" hidden></div>
    <div class="row end"><button class="btn ghost" data-act="flow-back">${tt('back')}</button><button class="btn primary" data-act="flow-next">${tt('cont')}</button></div>`;
  if (f.step === 2) body = `<h2>${tt('st_title')}</h2>
    <button class="btn primary big" data-act="create-patient" id="np-create">${tt('st_live')}</button>
    <p class="muted" style="text-align:center;margin:10px 0 6px">${tt('st_demo')}</p>
    <div class="scn">${Object.entries(SCENARIOS).map(([k, s]) => `<button class="btn" data-act="scenario" data-sc="${k}"><b>${esc(hasKey('sc_'+k) ? tt('sc_'+k) : s.name)}</b><small>${esc(hasKey('sc_'+k+'_b') ? tt('sc_'+k+'_b') : s.blurb)}</small></button>`).join('')}</div>
    <div class="row end"><button class="btn ghost" data-act="flow-back">${tt('back')}</button></div>`;
  return steps + body;
}
function renderPatients() {
  const el = $('#tab-patients'), list = store.patients();
  if (!S.flow) S.flow = { step: 0, consent: false, age: '' };
  const all = list.flatMap(p => p.visits), hi = all.filter(v => v.risk.levelName === 'High').length, al = list.filter(p => p.visits.at(-1)?.risk.trend?.alert).length;
  el.innerHTML = `
  <section class="hero3d" id="hero3d">
    <div class="hl"><canvas id="heart3d" aria-label="Interactive 3D heart: drag to rotate" role="img"></canvas>
      <h1>${esc(tt('d_title')).replace('\n','<br>')}</h1><p class="muted">${tt('d_sub')}</p></div>
    <div class="flowcard" id="flowcard">${store.isPersistent() ? '' : '<p class="warn">Storage is blocked in this browser: data will be lost on reload.</p>'}<div id="flowbody">${flowHtml()}</div></div>
  </section>
  <div class="stats"><div class="stat"><b>${list.length}</b><span>${tt('stat_p')}</span></div><div class="stat"><b>${all.length}</b><span>${tt('stat_v')}</span></div><div class="stat ${hi ? 'hi' : ''}"><b>${hi}</b><span>${tt('stat_h')}</span></div><div class="stat ${al ? 'md' : ''}"><b>${al}</b><span>${tt('stat_t')}</span></div></div>
  ${overdueList().length ? `<div class="warn" role="alert">⏰ ${overdueList().map(p => esc(p.id) + ' · ' + fuText(p.followup)).join(' | ')}</div>` : ''}
  ${followupsHtml()}
  <h2>${tt('recent')}</h2>
  ${list.length ? list.map(p => { const last = p.visits.at(-1)?.risk; return `
    <div class="card"><div class="row" style="justify-content:space-between">
      <div><b style="font-size:1.1rem">${esc(p.id)}</b> ${riskPill(last)} ${p.followup ? `<span class="pill ${dueState(p.followup.due).state === 'overdue' ? 'High' : 'none'}">${tt('fu_title')}: ${esc(p.followup.due)}</span>` : ''} ${last?.trend?.alert ? `<span class="pill Mid">${tt('trend_alert')}</span>` : ''}<br>
      <span class="muted">${tt('age_w')} ${esc(p.age)} · ${p.visits.length} ${tt('stat_v')} · ${tt('s_consent')} ${esc(fmtTime(p.consent.ts))}</span></div>
      <div class="row"><button class="btn" data-act="open" data-pid="${esc(p.id)}">${tt('open')}</button>
      ${S.confirmDel === p.id ? `<button class="btn danger" data-act="delete-confirm" data-pid="${esc(p.id)}">${tt('delc')}</button><button class="btn ghost" data-act="delete-cancel">${tt('cancel')}</button>`
        : `<button class="btn danger" data-act="delete" data-pid="${esc(p.id)}">${tt('del')}</button>`}</div></div></div>`; }).join('') : `<p class="muted">${tt('none')}</p>`}
  ${list.length ? `<button class="btn ghost" data-act="delete-all">${tt('delall')}</button>` : ''}`;
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
  return { weeks, entries: Object.fromEntries(METRICS.map(m => [m.key, { v: null, src: null }])), symptoms: Object.fromEntries(SYMPTOMS.map(s => [s.key, null])), ovOpen: {}, ctx: { protein: null, weight: null, height: null, hx: { prior_pe: false, chronic_htn: false, diabetes: false, gest_dm: false, mental: false } } };
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
const LOGKEY = 'mamaguard.devlog';
S.log = (() => { try { return JSON.parse(localStorage.getItem(LOGKEY) || '[]'); } catch { return []; } })();
function log(msg) {
  S.log.push({ ts: nowIso(), pid: S.pid || null, msg }); if (S.log.length > 300) S.log.splice(0, S.log.length - 300);
  try { localStorage.setItem(LOGKEY, JSON.stringify(S.log)); } catch {}
  const b = $('#logcount'); if (b) b.textContent = S.log.length; if ($('#logdlg')?.open) renderLogDlg();
}
const logLines = () => S.log.map(l => `${new Date(l.ts).toLocaleString()}${l.pid ? '  [' + l.pid + ']' : ''}  ${l.msg}`);
function renderLogDlg() { $('#logbody').textContent = logLines().slice().reverse().join('\n') || tt('act_empty'); }

function buildVisit() {
  const el = $('#tab-visit'), p = patient();
  if (!p) { el.innerHTML = `<div class="card"><h2>${tt('n_visit')}</h2><p>${tt('need_patient')}</p></div>`; return; }
  if (!S.draft) S.draft = newDraft();
  if (!p.consent?.given) { el.innerHTML = `<div class="warn">${tt('no_consent')}</div>`; return; }
  const d = S.draft;
  const row = m => `
    <div class="mrow" data-key="${m.key}">
      <div class="thead"><label for="in-${m.key}">${mLabel(m)}</label><span class="badge" data-badge></span></div>
      <div class="tval"><button class="step" data-act="step" data-key="${m.key}" data-d="-1" aria-label="− ${mLabel(m)}">−</button>
        <input id="in-${m.key}" type="number" inputmode="decimal" step="${m.step}" data-key="${m.key}" value="${d.entries[m.key].v ?? ''}" placeholder="—" aria-describedby="msg-${m.key}">
        <button class="step" data-act="step" data-key="${m.key}" data-d="1" aria-label="+ ${mLabel(m)}">+</button></div>
      <div class="tfoot"><span class="unit">${m.unit}</span><span class="zone" data-zone></span><button class="btn mini ghost" data-act="clear" data-key="${m.key}" title="${tt('clear')}" aria-label="${tt('clear')} ${mLabel(m)}">${tt('clear')}</button></div>
      <div class="mmsg" id="msg-${m.key}"></div>
    </div>`;
  el.innerHTML = `
  <div id="sumbar" class="sumbar" aria-live="polite"></div>
  <div class="card"><div class="row" style="justify-content:space-between">
    <div><h2 style="margin:0"><span id="v-pid">${esc(p.id)}</span></h2><span class="muted">${tt('age_w')} ${esc(p.age)} · ${tt('visitn')} #${p.visits.length + 1}</span></div>
    <div><label for="in-weeks" class="muted">${tt('weeks')}</label> <input id="in-weeks" type="number" style="width:90px" min="${WEEKS_BOUNDS[0]}" max="${WEEKS_BOUNDS[1]}" value="${d.weeks ?? ''}"></div></div></div>

  <div class="card">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">${tt('cap')}</h2>
      <label class="switch"><input type="checkbox" id="simtoggle" ${S.simOn ? 'checked' : ''}> ${tt('demo')}</label></div>
    <div class="row" style="margin-top:10px">
      <button class="btn" data-act="ble-connect" ${bleSupported() ? '' : 'title="Web Bluetooth not supported in this browser"'}>${tt('ble')}</button>
      <button class="btn" data-act="voice" id="voicebtn" title="Speak vitals and danger-sign answers (uses your browser speech service)">${tt('voice')}</button>
      <button class="btn" data-act="log-open" id="logbtn" title="${tt('log_title')}">📋 ${tt('log_btn')} <span class="pill none" id="logcount">${S.log.length}</span></button>
      <span id="simpanel" class="row" ${S.simOn ? '' : 'hidden'}>
        <button class="btn primary" data-act="sim-all">${tt('capall')}</button>
        <button class="btn" data-act="sim-watch" id="watchbtn">${S.sim.streaming ? tt('lstop') : tt('lstart')}</button>
        <button class="btn ghost" data-act="sim-glitch" title="Emit an impossible value to demonstrate the plausibility check">${tt('glitch')}</button>
      </span>
    </div>
    <p class="muted" style="font-size:.78rem">${tt('voice_note')}</p><p class="muted" id="bletxt">${S.ble ? `Connected: ${esc(S.ble.name)} · live: ${esc(S.ble.found.join(', ') || 'none')}` : bleSupported() ? '' : 'Bluetooth unavailable in this browser'}</p>
    <div id="vchat" class="vchat" ${S.chatOpen ? '' : 'hidden'}>
      <div class="row" style="justify-content:space-between"><b>🎤 ${tt('chat_title')}</b><button class="btn mini ghost" data-act="chat-close" aria-label="${tt('close')}">✕</button></div>
      <div id="chatlist" class="chatlist" aria-live="polite">${chatHtml()}</div>
      <form id="chatform" class="row" autocomplete="off"><input id="chatin" type="text" placeholder="${tt('chat_ph')}" style="flex:1 1 200px"><button class="btn primary mini" type="submit">${tt('chat_send')}</button></form>
    </div>
  </div>

  <div class="card"><h2 style="margin-bottom:2px">${tt('vitals')}</h2>
    <div class="tiles">${METRICS.map(row).join('')}</div></div>

  <div class="card"><h3>${tt('danger')}</h3>
    ${SYMPTOMS.map(s => `<div class="sym"><span id="sl-${s.key}">${sLabel(s)}</span><div class="seg" role="group" aria-labelledby="sl-${s.key}">
      <button class="yes" data-act="sym" data-key="${s.key}" data-val="true">${tt('yes')}</button><button class="no" data-act="sym" data-key="${s.key}" data-val="false">${tt('no')}</button><button class="na" data-act="sym" data-key="${s.key}" data-val="null">${tt('na')}</button></div></div>`).join('')}
  </div>

  <div class="card"><h3>${tt('ctx_t')} <span class="muted">${tt('ctx_note')}</span></h3>
    <div class="grid2">
      <div><label for="ctx-protein">${tt('ctx_prot')}</label><select id="ctx-protein"><option value="">${tt('not_tested')}</option>${['neg', 'trace', '1+', '2+', '3+'].map(x => `<option value="${x}" ${d.ctx.protein === x ? 'selected' : ''}>${x === 'neg' ? tt('neg') : x === 'trace' ? tt('trace') : x}</option>`).join('')}</select></div>
      <div class="row"><div style="flex:1"><label for="ctx-weight">${tt('ctx_w')}</label><input id="ctx-weight" type="number" inputmode="decimal" value="${d.ctx.weight ?? ''}"></div><div style="flex:1"><label for="ctx-height">${tt('ctx_h')}</label><input id="ctx-height" type="number" inputmode="decimal" value="${d.ctx.height ?? ''}"></div></div>
    </div>
    <div class="row" style="margin-top:8px">${[['prior_pe', tt('hx_pe')], ['chronic_htn', tt('hx_ht')], ['diabetes', tt('hx_dm')], ['gest_dm', tt('hx_gdm')], ['mental', tt('hx_mh')]].map(([k, l]) => `<label class="switch"><input type="checkbox" data-hx="${k}" ${d.ctx.hx[k] ? 'checked' : ''}> ${l}</label>`).join('')}<span class="muted" id="bmi"></span></div>
  </div>

  <div id="result"></div>
  <div class="card row">
    <button class="btn primary" data-act="save-visit" id="savebtn">${tt('save')}</button>
    <button class="btn" data-act="ref-draft" id="refbtn">${tt('refmsg')}</button>
    <span class="muted" id="savemsg" role="status"></span>
  </div>`;
  refresh();
}

/* ---------- live assessment ---------- */
function compute() {
  const p = patient(), d = S.draft, ev = evaluate(d.entries);
  const overrides = METRICS.filter(m => ev.status[m.key] === 'overridden').map(m => m.key);
  const r = assess({ model: S.model, age: p.age, vals: ev.vals, symptoms: d.symptoms, history: p.visits.map(v => ({ ts: v.ts, vals: v.vals })), blocked: ev.blocked, missing: ev.missing, overrides, context: d.ctx });
  return { ev, r, overrides };
}
function badgeFor(e, st) {
  if (e.v == null) return ['none', tt('missing'), 'Not measured'];
  return [e.src, SRC[e.src].label, SRC[e.src].title];
}
function refresh() {
  if (S.tab !== 'visit' || !S.draft || !patient() || !$('#result')) return;
  const { ev, r } = compute(); S.lastRisk = r;
  dispatchEvent(new CustomEvent('mg-risk', { detail: r.levelName }));
  const d = S.draft;
  S.fuS = suggest(r, d.weeks); if (!d.nextEdited) d.next = S.fuS.date;
  for (const m of METRICS) {
    const row = $(`.mrow[data-key="${m.key}"]`), e = d.entries[m.key], st = ev.status[m.key];
    row.className = 'mrow ' + st + ' z-' + (st === 'invalid' ? 'bad' : zoneOf(m.key, e.v)) + (row._flash ? ' flash' : '');
    $('[data-zone]', row).textContent = st === 'invalid' ? tt('z_bad') : (zoneOf(m.key, e.v) in ZT ? tt('z_' + zoneOf(m.key, e.v)) : '');
    const b = $('[data-badge]', row), [cls, txt, ttl] = badgeFor(e, st);
    b.className = 'badge ' + cls; b.textContent = txt; b.title = ttl;
    let msg = '';
    if (st === 'invalid' || st === 'overridden') {
      msg = `<div class="warn ${st === 'overridden' ? 'soft' : ''}" role="alert">${st === 'invalid' ? '⚠ ' + tt('blocked') + ' ' : '⚠ ' + tt('overridden') + ' '}${esc(ev.msgs[m.key])}
        ${st === 'overridden' ? `<br>Override reason: <b>${esc(e.override.reason)}</b>` : ''}
        <div class="row"><button class="btn mini" data-act="reread" data-key="${m.key}">${tt('reread')}</button><button class="btn mini" data-act="correct" data-key="${m.key}">${tt('correct')}</button>
        ${st === 'invalid' ? `<button class="btn mini danger" data-act="ov-open" data-key="${m.key}">${tt('override')}</button>` : `<button class="btn mini" data-act="ov-remove" data-key="${m.key}">${tt('rmov')}</button>`}</div>
        ${d.ovOpen[m.key] && st === 'invalid' ? `<div class="row"><input type="text" id="ovr-${m.key}" placeholder="Reason (required), e.g. confirmed with manual cuff" maxlength="140" style="flex:1 1 220px"><button class="btn mini primary" data-act="ov-confirm" data-key="${m.key}">${tt('accept')}</button></div>` : ''}</div>`;
    } else if (st === 'missing') msg = '';
    setHtml($(`#msg-${m.key}`), msg);
  }
  for (const s of SYMPTOMS) for (const b of $$(`.seg button[data-key="${s.key}"]`)) b.setAttribute('aria-pressed', String(String(d.symptoms[s.key]) === b.dataset.val));
  setHtml($('#result'), resultHtml(r, ev));
  { const c = d.ctx; $('#bmi').textContent = c.weight && c.height ? `BMI ${(c.weight / ((c.height / 100) ** 2)).toFixed(1)}` : ''; }
  const have = METRICS.filter(m => d.entries[m.key].v != null).length, asked = SYMPTOMS.filter(x => d.symptoms[x.key] != null).length, tot = METRICS.length + SYMPTOMS.length, pct = Math.round((have + asked) / tot * 100);
  setHtml($('#sumbar'), `<div class="ring" style="--p:${pct}"><span>${pct}%</span></div><div class="sbtxt"><div class="sbl">${tt('risk_now')}</div><div class="sbv ${r.levelName}">${lvlU(r.levelName)}${r.provisional ? ' · ' + tt('prov') : ''}${r.trend.alert ? ' · ' + tt('trend_alert') : ''}</div><div class="muted">${tt('vit_count', { a: have, b: METRICS.length, c: asked, d: SYMPTOMS.length })}</div></div>`);
  $('#savebtn').disabled = ev.blocked.length > 0;
  $('#savemsg').textContent = ev.blocked.length ? tt('save_fix') : '';
  $('#refbtn').className = 'btn' + (r.referralEligible ? ' danger' : '');
  $('#refbtn').textContent = r.referralEligible ? tt('refmsg') + ' (' + tt('recommended') + ')' : tt('refmsg');
  $('#refbtn').disabled = !r.referralEligible;
  $('#refbtn').title = r.referralEligible ? '' : 'Available for High risk or a trend alert';
}
function resultHtml(r, ev) {
  const kindTag = { rule: tt('k_rule'), model: tt('k_model'), trend: tt('k_trend'), missing: tt('k_data') };
  const srcs = sourceBreakdown(S.draft.entries);
  return `<div class="card res ${r.levelName}">
    <div class="row" style="justify-content:space-between"><div><span class="muted">${tt('risk_level')}</span><div class="big">${lvlU(r.levelName)}${r.provisional ? ` <span class="pill Mid">${tt('prov')}</span>` : ''}${r.trend.alert ? ` <span class="pill High">${tt('trend_alert')}</span>` : ''}</div></div>
    <div class="muted" style="text-align:right">${r.modelName ? (r.overridden ? `<span class="pill High">${tt('overrode')}</span>` : `<span class="pill Low">${tt('model_driven')}</span>`) : ''}<br>${r.modelName ? `${tt('model_alone')}: ${lvlW(r.modelName)}` : tt('model_norun')}</div></div>
    ${r.missing.length ? `<div class="missbox" role="alert"><b>${tt('miss_title')} (${r.missing.length}):</b> ${r.missing.map(m => esc(hasKey('m_' + m.key) ? tt('m_' + m.key) : m.key === 'age' ? tt('age_w') : m.label) + (m.blocked ? ' [' + tt('blk') + ']' : '')).join(', ')}.<br>${esc(r.certaintyText)}</div>` : ``}
    <h3>${tt('why')}</h3>
    <ul class="reasons">${r.reasons.filter(x => x.kind !== 'model' || true).map(x => `<li><span class="k ${x.kind}">${kindTag[x.kind]}</span>${esc(trReason(x))}</li>`).join('') || `<li>${tt('no_factors')}</li>`}</ul>
    ${r.trend.enough ? `<p class="muted"><b>${tt('trend')}:</b> ${esc(r.trend.text)}</p>` : ''}
    <div class="nextv"><b>${tt('fu_next')}</b><div class="row"><input type="date" id="fu-date" value="${esc(S.draft.next || '')}" aria-label="${tt('fu_date')}"><span class="muted">${tt(S.fuS.why, S.fuS.args)}</span></div></div>
    <p class="muted"><b>${tt('sources')}:</b> ${Object.entries(srcs).map(([k, v]) => `${k}: ${v.length ? v.join(', ') : '–'}`).join(' · ')}</p>
  </div>`;
}

/* ---------- history ---------- */
const ICON = { alert: '⏰', patient: '+', visit: '●', referral: '↗', delete: '✕' };
function logHtml() {
  const L = store.logs().slice(0, 40);
  return L.length ? `<ul class="log2">${L.map(l => `<li class="${l.type}"><span class="ic">${ICON[l.type] || '•'}</span><span class="tx">${esc(l.text)}</span><time>${esc(fmtTime(l.ts))}</time></li>`).join('')}</ul>` : `<p class="muted">${tt('act_empty')}</p>`;
}
function renderHistory() {
  const el = $('#tab-history'), p = patient(), list = store.patients();
  const picker = list.length ? `<label for="hpick" class="muted">${tt('s_patient')}</label> <select id="hpick" style="width:auto">${list.map(x => `<option value="${esc(x.id)}" ${p && x.id === p.id ? 'selected' : ''}>${esc(x.id)} · ${x.visits.length} ${tt('stat_v')}</option>`).join('')}</select>` : '';
  const activity = `<div class="card"><h2>${tt('h_activity')}</h2>${logHtml()}</div>`;
  if (!p) { el.innerHTML = `<div class="card row" style="justify-content:space-between"><h2 style="margin:0">${tt('n_hist')}</h2><div>${picker}</div></div>${activity}`; return; }
  const v = p.visits;
  const cell = (visit, k) => { const e = visit.entries[k]; return e?.v == null ? `<span class="badge none">${tt('missing')}</span>` : `${fmtNum(e.v, M[k].dp)} <span class="badge ${e.src}" title="${esc(SRC[e.src].title)}">${SRC[e.src].label}</span>${visit.status[k] === 'overridden' ? ' <span class="pill Mid">override</span>' : ''}`; };
  el.innerHTML = `<div class="card row" style="justify-content:space-between"><h2 style="margin:0">${esc(p.id)}</h2><div>${picker}</div></div>
  <div class="card"><h3>${tt('h_bp')}</h3>${bpChart(v.map((x, i) => ({ label: `V${i + 1}${x.weeks ? ' · ' + x.weeks + 'w' : ''}`, sbp: x.vals.sbp, dbp: x.vals.dbp })))}
    ${v.length ? `<p><b>${tt('trend')}:</b> ${esc(v.at(-1).risk.trend.text)} ${v.at(-1).risk.trend.alert ? `<span class="pill High">${tt('alert')}</span>` : ''}</p>` : ''}</div>
  ${activity}
  <div class="card"><h3>${tt('h_visits')}</h3>${v.length ? `<div class="tablewrap"><table><thead><tr><th>#</th><th>${tt('time')}</th><th>${tt('risk_level')}</th>${METRICS.map(m => `<th>${mLabel(m)} (${m.unit})</th>`).join('')}<th>${tt('danger')}</th><th></th></tr></thead><tbody>
    ${v.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(fmtTime(x.ts))}</td><td>${riskPill(x.risk)}${x.risk.trend.alert ? ` <span class="pill Mid">${tt('trend_alert')}</span>` : ''}</td>${METRICS.map(m => `<td>${cell(x, m.key)}</td>`).join('')}
    <td>${SYMPTOMS.map(s => `${sLabel(s).split(' ')[0]} ${x.symptoms[s.key] === true ? tt('yes') : x.symptoms[s.key] === false ? tt('no') : '?'}`).join(', ')}</td>
    <td>${x.risk.referralEligible ? `<button class="btn mini danger" data-act="ref-visit" data-i="${i}">Referral</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : `<p class="muted">${tt('no_saved')}</p>`}</div>
  <div class="card row"><button class="btn" data-act="open" data-pid="${esc(p.id)}">${tt('h_new')}</button><button class="btn" data-act="print-summary">${tt('h_print')}</button></div>`;
}

/* ---------- referral ---------- */
function openReferral(text) {
  if (S.pid) { store.addLog('referral', S.pid, 'Referral message generated'); if (S.tab === 'history') renderHistory(); }
  $('#reftext').value = text; $('#refnote').textContent = '';
  $('#refshare').hidden = !navigator.share;
  $('#refdlg').showModal(); $('#reftext').focus(); $('#reftext').select();
}

/* ---------- print + voice ---------- */
function printText(title, text) {
  const pa = $('#printarea'); pa.innerHTML = `<h1>${esc(title)}</h1><pre>${esc(text)}</pre>`;
  const done = () => { pa.innerHTML = ''; removeEventListener('afterprint', done); };
  addEventListener('afterprint', done); print();
}
let rec = null;
S.chat = S.chat || [];
const chatHtml = () => S.chat.map(m => `<div class="bub ${m.who}">${esc(m.text)}</div>`).join('') || `<div class="bub sys">${tt('chat_hint')}</div>`;
function chatPush(who, text) { S.chat.push({ who, text }); const l = $('#chatlist'); if (l) { l.innerHTML = chatHtml(); l.scrollTop = l.scrollHeight; } }
function applyUtterance(text) {
  const r = parseSpeech(text), got = [];
  for (const [k, v] of Object.entries(r.metrics)) { setReading(k, v, 'manual_entry'); got.push(`${M[k].label} ${v}`); }
  for (const [k, v] of Object.entries(r.symptoms)) { S.draft.symptoms[k] = v; got.push(`${SYMPTOMS.find(s => s.key === k).label}: ${v ? 'yes' : 'no'}`); }
  refresh(); log(`Voice/chat: “${text}” → ${got.length ? got.join(', ') : 'nothing recognised'}`);
  chatPush('sys', got.length ? '✓ ' + got.join(', ') : tt('chat_none'));
}
function openChat() { S.chatOpen = true; const c = $('#vchat'); if (c) { c.hidden = false; const l = $('#chatlist'); l.innerHTML = chatHtml(); l.scrollTop = l.scrollHeight; } }
function setLive(txt) { let el = $('#chatlive'); if (!txt) { el?.remove(); return; } if (!el) { el = document.createElement('div'); el.id = 'chatlive'; el.className = 'bub me live'; $('#chatlist')?.appendChild(el); } el.textContent = txt + ' …'; $('#chatlist').scrollTop = 1e6; }
function startVoice(btn) {
  openChat();
  if (!voiceSupported()) { chatPush('sys', tt('chat_nosr')); log('Voice entry needs Chrome or Edge (speech recognition).'); return; }
  if (rec) { rec.stop(); return; }
  btn.classList.add('listening'); chatPush('sys', tt('chat_listen')); log('Voice: listening');
  rec = listen('en-IN', text => { setLive(''); chatPush('me', text); applyUtterance(text); },
    err => { rec = null; setLive(''); btn.classList.remove('listening'); if (err && err !== 'no-speech' && err !== 'aborted') { chatPush('sys', `${tt('chat_err')}: ${err}`); log(`Voice error: ${err}`); } else chatPush('sys', tt('chat_stop')); },
    live => setLive(live));
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
  S.pid = p.id; store.setLast(p.id); S.draft = newDraft(sc.weeks); S.draft.symptoms = { ...sc.symptoms };
  S.simOn = true; S.sim.stopWatch(); simSetup(sc);
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
    entries: JSON.parse(JSON.stringify(d.entries)), status: ev.status, vals: ev.vals, symptoms: { ...d.symptoms }, context: JSON.parse(JSON.stringify(d.ctx)), risk: r, overrides };
  store.addVisit(p.id, visit);
  { const sg = suggest(r, d.weeks); store.setFollowup(p.id, { due: d.next || sg.date, level: r.levelName, days: sg.days, setTs: nowIso() }); }
  store.addLog('visit', p.id, `Visit #${p.visits.length} saved: ${r.levelName.toUpperCase()}${r.provisional ? ' (provisional)' : ''}${r.trend.alert ? ' + trend alert' : ''}${visit.vals.sbp != null ? `, BP ${visit.vals.sbp}/${visit.vals.dbp}` : ', BP not measured'}${r.missing.length ? `, ${r.missing.length} missing` : ''}`);
  S.draft = null; showTab('history');
  if (r.referralEligible) openReferral(buildReferral({ patientId: p.id, age: p.age, visit, risk: r }));
}

// material-style ripple on buttons
document.addEventListener('pointerdown', e => {
  const b = e.target.closest?.('.btn,.swb,.tabs button'); if (!b || b.disabled || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2, s = document.createElement('span'); s.className = 'rip';
  Object.assign(s.style, { width: d + 'px', height: d + 'px', left: e.clientX - r.left - d / 2 + 'px', top: e.clientY - r.top - d / 2 + 'px' });
  b.appendChild(s); setTimeout(() => s.remove(), 650);
}, { passive: true });
function wireEvents() {
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
  document.addEventListener('submit', e => { if (e.target.id === 'chatform') { e.preventDefault(); const i = $('#chatin'), v = i.value.trim(); if (!v) return; i.value = ''; chatPush('me', v); applyUtterance(v); } });
  document.addEventListener('change', e => {
    if (e.target.id === 'fu-date' && S.draft) { S.draft.next = e.target.value; S.draft.nextEdited = true; refresh(); return; }
    const t = e.target;
    if (t.id === 'ctx-protein' && S.draft) { S.draft.ctx.protein = t.value || null; refresh(); }
    if (t.dataset?.hx && S.draft) { S.draft.ctx.hx[t.dataset.hx] = t.checked; refresh(); }
    if (t.id === 'hpick') { S.pid = t.value; store.setLast(S.pid); renderHistory(); }
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
    if ((t.id === 'ctx-weight' || t.id === 'ctx-height') && S.draft) { S.draft.ctx[t.id.slice(4)] = t.value === '' ? null : parseFloat(t.value); refresh(); }
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
          const p = createPatient(age); S.flow = null; S.pid = p.id; store.setLast(p.id); S.draft = newDraft(); showTab('visit'); break;
        }
        case 'signout': auth.signOut(); S.sim.stopWatch(); location.reload(); break;
        case 'flow-next': { if (S.flow.step === 1) { const c = checkAge(parseFloat(S.flow.age)); if (!c.ok) { const m = $('#np-msg'); m.hidden = false; m.textContent = c.msg; return; } } S.flow.step++; renderFlow(); break; }
        case 'flow-back': S.flow.step--; renderFlow(); break;
        case 'scenario': await launchScenario(b.dataset.sc); break;
        case 'open': S.pid = b.dataset.pid; store.setLast(S.pid); S.draft = newDraft(); S.sim.stopWatch(); S.simOn = false; showTab('visit'); break;
        case 'delete': S.confirmDel = b.dataset.pid; renderPatients(); break;
        case 'delete-cancel': S.confirmDel = null; renderPatients(); break;
        case 'delete-confirm': store.deletePatient(b.dataset.pid); store.addLog('delete', null, 'A patient record and its data were deleted'); if (S.pid === b.dataset.pid) { S.pid = null; S.draft = null; } S.confirmDel = null; renderPatients(); break;
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
          try { S.ble = await connectBle((k, v) => { if (M[k]) setReading(k, v, 'ble_device'); }, log); log(`Connected to ${S.ble.name}.`); if (!S.ble.found.length) log('Connected, but this device exposes no standard health service (heart rate, BP, temp, glucose, SpO₂), so nothing can stream. ' + BLE_HINT); buildVisit(); }
          catch (err) { log('Bluetooth: ' + err.message); if (err.name === 'NotFoundError') log(BLE_HINT); }
          break;
        case 'sim-watch': if (S.sim.streaming) { S.sim.stopWatch(); b.textContent = 'Start live stream'; log('Live stream stopped.'); } else { S.sim.startWatch(); b.textContent = 'Stop live stream'; log('Live stream started.'); } break;
        case 'sim-meas': await runMeasure(b.dataset.kind); break;
        case 'sim-all': S.sim.startWatch(); $('#watchbtn').textContent = 'Stop live stream'; await Promise.all([runMeasure('bp'), runMeasure('glucose'), runMeasure('temp')]); break;
        case 'sim-glitch': { const g = S.sim.glitch(); log(`Injected glitch: ${g[0]} = ${g[1]}`); break; }
        case 'save-visit': saveVisit(); break;
        case 'ref-draft': { const p = patient(), { ev, r, overrides } = compute();
          openReferral(buildReferral({ patientId: p.id, age: p.age, visit: { ts: nowIso(), weeks: d.weeks, entries: d.entries, status: ev.status, symptoms: d.symptoms, context: d.ctx }, risk: r })); break; }
        case 'ref-visit': { const p = patient(), v = p.visits[+b.dataset.i]; openReferral(buildReferral({ patientId: p.id, age: p.age, visit: v, risk: v.risk })); break; }
        case 'ref-copy': { const t = $('#reftext'); t.select(); try { await navigator.clipboard.writeText(t.value); $('#refnote').textContent = 'Copied.'; } catch { document.execCommand?.('copy'); $('#refnote').textContent = 'Selected: press Ctrl/Cmd+C to copy.'; } break; }
        case 'ref-share': try { await navigator.share({ title: 'MamaGuard referral', text: $('#reftext').value }); } catch {} break;
        case 'ref-wa': window.open('https://wa.me/?text=' + encodeURIComponent($('#reftext').value), '_blank', 'noopener'); break;
        case 'ref-sms': location.href = 'sms:?&body=' + encodeURIComponent($('#reftext').value); break;
        case 'ref-print': printText('MamaGuard referral', $('#reftext').value); break;
        case 'print-summary': printText('MamaGuard patient summary', patientSummary(patient())); break;
        case 'voice': startVoice(b); break;
        case 'settings': renderSettings(); $('#setdlg').showModal(); break;
        case 'set-close': $('#setdlg').close(); break;
        case 'set-theme': curTheme = b.dataset.v; applyTheme(curTheme, b); renderSettings(); break;
        case 'set-lang': changeLang(b.dataset.v); break;
        case 'fu-notify': if (typeof Notification !== 'undefined') { await Notification.requestPermission(); renderPatients(); checkOverdue(); } break;
        case 'fu-ics': { const q = store.getPatient(b.dataset.pid); if (q?.followup) downloadIcs(q.id, q.followup.due, q.followup.level); break; }
        case 'log-open': renderLogDlg(); $('#logdlg').showModal(); break;
        case 'log-close': $('#logdlg').close(); break;
        case 'log-copy': try { await navigator.clipboard.writeText(logLines().join('\n')); $('#lognote').textContent = tt('copied'); } catch { $('#lognote').textContent = ''; } break;
        case 'log-dl': { const a2 = document.createElement('a'); a2.href = URL.createObjectURL(new Blob([logLines().join('\n')], { type: 'text/plain' })); a2.download = 'mamaguard-log.txt'; document.body.appendChild(a2); a2.click(); a2.remove(); break; }
        case 'log-clear': S.log = []; try { localStorage.removeItem(LOGKEY); } catch {} renderLogDlg(); { const c = $('#logcount'); if (c) c.textContent = 0; } break;
        case 'chat-close': if (rec) rec.stop(); S.chatOpen = false; $('#vchat').hidden = true; break;
        case 'ref-close': $('#refdlg').close(); break;
      }
    } catch (err) { console.error(err); const m = $('#np-msg') || $('#savemsg'); if (m) { m.hidden = false; m.textContent = err.message; } }
  });
}
boot();
