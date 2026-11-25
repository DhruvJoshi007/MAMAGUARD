// Run: (serve the folder on :8765) NODE_PATH=$(npm root -g) node tests/e2e.cjs
const { chromium } = require('playwright'); const assert = require('assert');
const URL = process.env.URL || 'http://localhost:8765/';
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
  await p.goto(URL); await p.waitForSelector('#gateform');
  await p.fill('#g-name','Test Worker'); await p.fill('#g-pin','1234'); await p.fill('#g-pin2','1234'); await p.click('#gateform button[type=submit]'); await p.waitForSelector('#np-consent');
  assert(await p.locator('#flow-next').isDisabled(), 'flow locked before consent');
  assert.equal(await p.locator('[data-act=scenario]').count(), 0, 'scenarios hidden before consent');
  const flow = async () => { if (!(await p.locator('#np-consent').count())) return; await p.check('#np-consent'); await p.click('#flow-next'); await p.fill('#np-age', '27'); await p.click('[data-act=flow-next]'); };
  await flow();
  // --- scenario 1: rising BP
  await p.click('[data-sc=rising]'); await p.waitForSelector('#result .res');
  await p.waitForFunction(() => document.querySelector('#in-sbp')?.value && document.querySelector('#in-temp')?.value);
  let txt = await p.innerText('#result'); console.log('RISING:\n', txt.slice(0, 700));
  assert(/TREND ALERT/.test(txt)); assert(/Model alone: Low/.test(txt) || /Model alone: Mid/.test(txt));
  await p.screenshot({ path: '/tmp/claude-0/shot-rising.png', fullPage: true });
  assert(await p.locator('.mrow[data-key=sbp] .badge.simulated_device').count() === 1);
  await p.click('#savebtn'); await p.waitForSelector('#refdlg[open]'); const ref = await p.inputValue('#reftext'); console.log(ref);
  assert(/\[simulated_device\]/.test(ref) && /TREND/.test(ref)); await p.click('[data-act=ref-close]');
  await p.waitForSelector('svg.chart'); await p.screenshot({ path: '/tmp/claude-0/shot-history.png', fullPage: true });
  // --- scenario 2: emergency
  await p.click('[data-tab=patients]'); await flow(); await p.click('[data-sc=emergency]'); await p.waitForFunction(() => document.querySelector('#in-sbp')?.value);
  txt = await p.innerText('#result'); console.log('EMERGENCY:\n', txt.slice(0, 500)); assert(/HIGH/.test(txt) && /SAFETY RULE/.test(txt));
  // --- scenario 3: partial
  await p.click('[data-tab=patients]'); await flow(); await p.click('[data-sc=partial]'); await p.waitForFunction(() => document.querySelector('#in-hr')?.value);
  await p.waitForTimeout(400); txt = await p.innerText('#result'); console.log('PARTIAL:\n', txt.slice(0, 600));
  assert(/PROVISIONAL/.test(txt) && /Missing/.test(txt) && !/\nLOW\n/.test(txt)); assert(/not paired/.test(await p.innerText('#devlog')));
  await p.screenshot({ path: '/tmp/claude-0/shot-partial.png', fullPage: true });
  // --- plausibility gate: glitch, override
  await p.fill('#in-spo2', '0'); assert(await p.locator('.mrow[data-key=spo2].invalid').count() === 1);
  assert(/BLOCKED/.test(await p.innerText('#msg-spo2'))); assert(await p.locator('#savebtn').isDisabled());
  await p.click('[data-act=ov-open][data-key=spo2]'); await p.click('[data-act=ov-confirm][data-key=spo2]'); // empty reason rejected
  assert(await p.locator('.mrow[data-key=spo2].invalid').count() === 1);
  await p.fill('#ovr-spo2', 'sensor loose, confirmed 0 unlikely'); await p.click('[data-act=ov-confirm][data-key=spo2]');
  assert(await p.locator('.mrow[data-key=spo2].overridden').count() === 1); assert(!(await p.locator('#savebtn').isDisabled()));
  // --- delete patient
  await p.click('[data-tab=patients]'); await p.waitForSelector('[data-act=open]'); const before = await p.locator('[data-act=open]').count();
  await p.click('[data-act=delete]'); await p.click('[data-act=delete-confirm]'); assert.equal(await p.locator('[data-act=open]').count(), before - 1);
  // --- CTG + model tabs
  await p.click('[data-tab=ctg]'); await p.waitForSelector('#ctgres .big'); console.log('CTG:', await p.innerText('#ctgres .big'));
  await p.click('[data-ctg-preset=Pathological]'); assert(/Pathological/.test(await p.innerText('#ctgres .big')));
  await p.click('[data-tab=model]'); await p.waitForSelector('.cm');
  // --- offline
  await p.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true)); await p.reload(); await p.waitForFunction(() => navigator.serviceWorker.controller);
  await ctx.setOffline(true); await p.reload(); await p.waitForSelector('#np-consent');
  assert.equal(await p.locator('#gate:visible').count(), 0, 'stays logged in after reload');
  console.log('OFFLINE banner:', await p.innerText('#net')); assert(/Offline/.test(await p.innerText('#net')));
  console.log('patients persisted offline:', await p.locator('[data-act=open]').count());
  console.log('ERRORS:', errs); await b.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
