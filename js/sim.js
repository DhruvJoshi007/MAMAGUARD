// Simulation Mode: a demo smartwatch profile + dedicated BP / glucometer / thermometer, and preset scenarios.
// "GoBoult Mustang" here is only the label of a DEMO PROFILE. No claim is made that the real watch is read.
import { sleep } from './util.js';

export const WATCH_PROFILE = 'GoBoult Mustang (demo profile)';
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const BASELINE = { hr: 82, spo2: 98, sleep: 72, stress: 35, sbp: 114, dbp: 72, bs: 6.4, temp: 36.8 };

export const SCENARIOS = {
  rising: {
    name: '3-visit rising BP trend',
    blurb: 'Normal-looking readings, BP climbing each visit',
    age: 27,
    prior: [
      { weeksAgo: 8, weeks: 24, vals: { hr: 78, spo2: 98, sleep: 78, stress: 30, sbp: 108, dbp: 68, bs: 6.2, temp: 36.7 } },
      { weeksAgo: 4, weeks: 28, vals: { hr: 80, spo2: 98, sleep: 74, stress: 34, sbp: 115, dbp: 73, bs: 6.3, temp: 36.8 } },
    ],
    weeks: 32,
    target: { hr: 84, spo2: 98, sleep: 68, stress: 42, sbp: 122, dbp: 78, bs: 6.2, temp: 36.8 },
    symptoms: { headache: false, vision: false, swelling: false, fetal: false },
  },
  emergency: {
    name: 'Severe BP + danger symptoms',
    blurb: '172/114 with headache, blurred vision, swelling',
    age: 31, prior: [], weeks: 35,
    target: { hr: 112, spo2: 96, sleep: 40, stress: 82, sbp: 172, dbp: 114, bs: 7.4, temp: 37.1 },
    symptoms: { headache: true, vision: true, swelling: true, fetal: false },
  },
  partial: {
    name: 'Partial-sensor visit',
    blurb: 'Heart rate and SpO₂ only, no BP, sugar or temp',
    age: 23, prior: [], weeks: 30,
    target: { hr: 79, spo2: 98, sleep: 70, stress: 38 },
    unavailable: ['sbp', 'dbp', 'bs', 'temp'],
    symptoms: { headache: false, vision: false, swelling: false, fetal: null },
  },
};

export class Simulator {
  constructor(onReading) {
    this.onReading = onReading;      // (key, value, source)
    this.target = { ...BASELINE };
    this.unavailable = new Set();
    this.timer = null;
    this.state = {};
  }
  setProfile(target, unavailable = []) {
    this.target = { ...BASELINE, ...target };
    this.unavailable = new Set(unavailable);
  }
  get streaming() { return !!this.timer; }
  startWatch() {
    if (this.timer) return;
    const tick = () => {
      const t = this.target, s = this.state;
      s.hr = clamp((s.hr ?? t.hr) + rnd(-2.5, 2.5) + (t.hr - (s.hr ?? t.hr)) * 0.2, t.hr - 7, t.hr + 7);
      s.spo2 = clamp(t.spo2 + rnd(-1, 1), 70, 100);
      s.sleep = clamp((s.sleep ?? t.sleep) + rnd(-0.6, 0.6), t.sleep - 3, t.sleep + 3);
      s.stress = clamp((s.stress ?? t.stress) + rnd(-1.5, 1.5), t.stress - 6, t.stress + 6);
      for (const k of ['hr', 'spo2', 'sleep', 'stress']) {
        if (t[k] == null || this.unavailable.has(k)) continue;
        this.onReading(k, Math.round(s[k]), 'simulated_watch');
      }
    };
    tick(); this.timer = setInterval(tick, 1500);
  }
  stopWatch() { clearInterval(this.timer); this.timer = null; }
  // one-shot reading from a dedicated device; resolves with {key: value}
  async measure(kind, fast = false) {
    const keys = { bp: ['sbp', 'dbp'], glucose: ['bs'], temp: ['temp'] }[kind];
    if (keys.some(k => this.unavailable.has(k)))
      throw new Error({ bp: 'BP cuff', glucose: 'Glucometer', temp: 'Thermometer' }[kind] + ' not paired / no reading (simulated unavailable device).');
    await sleep(fast ? 60 : rnd(1100, 1900));
    const t = this.target, out = {};
    if (kind === 'bp') { out.sbp = Math.round(t.sbp + rnd(-1.5, 1.5)); out.dbp = Math.round(t.dbp + rnd(-1.5, 1.5)); }
    if (kind === 'glucose') out.bs = Math.round((t.bs + rnd(-0.15, 0.15)) * 10) / 10;
    if (kind === 'temp') out.temp = Math.round((t.temp + rnd(-0.1, 0.1)) * 10) / 10;
    for (const [k, v] of Object.entries(out)) this.onReading(k, v, 'simulated_device');
    return out;
  }
  // deliberately emit nonsense so the plausibility gate can be demonstrated
  glitch() {
    const g = [['spo2', 0], ['hr', 255], ['sbp', 21]][Math.floor(Math.random() * 3)];
    this.onReading(g[0], g[1], g[0] === 'sbp' ? 'simulated_device' : 'simulated_watch');
    return g;
  }
  async reread(key) {          // used by the "Re-read" button
    if (['hr', 'spo2', 'sleep', 'stress'].includes(key)) {
      await sleep(250);
      this.onReading(key, Math.round(this.target[key]), 'simulated_watch');
    } else await this.measure(key === 'bs' ? 'glucose' : key === 'temp' ? 'temp' : 'bp');
  }
}
