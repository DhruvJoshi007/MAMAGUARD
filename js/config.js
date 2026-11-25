// Shared constants: metrics, plausibility bounds, source labels, danger symptoms.
export const SRC = {
  ble_device:       { label: 'BLE',     title: 'Live Bluetooth device reading' },
  simulated_watch:  { label: 'SIM·W',   title: 'Simulated smartwatch (demo profile)' },
  simulated_device: { label: 'SIM·D',   title: 'Simulated dedicated device (BP / glucometer / thermometer)' },
  manual_entry:     { label: 'MANUAL',  title: 'Typed in by the health worker' },
};

// group: 'watch' = consumer smartwatch metrics, 'device' = dedicated clinical-type device metrics.
// min/max = physiological plausibility bounds (values outside are almost surely glitches/typos).
export const METRICS = [
  { key: 'hr',     label: 'Heart rate',     unit: 'bpm',    group: 'watch',  min: 30,  max: 220, step: 1,   dp: 0, model: true },
  { key: 'spo2',   label: 'SpO₂',           unit: '%',      group: 'watch',  min: 70,  max: 100, step: 1,   dp: 0 },
  { key: 'sleep',  label: 'Sleep score',    unit: '/100',   group: 'watch',  min: 0,   max: 100, step: 1,   dp: 0 },
  { key: 'stress', label: 'Stress score',   unit: '/100',   group: 'watch',  min: 0,   max: 100, step: 1,   dp: 0 },
  { key: 'sbp',    label: 'Systolic BP',    unit: 'mmHg',   group: 'device', min: 60,  max: 260, step: 1,   dp: 0, model: true },
  { key: 'dbp',    label: 'Diastolic BP',   unit: 'mmHg',   group: 'device', min: 30,  max: 150, step: 1,   dp: 0, model: true },
  { key: 'bs',     label: 'Blood sugar',    unit: 'mmol/L', group: 'device', min: 1.5, max: 40,  step: 0.1, dp: 1, model: true },
  { key: 'temp',   label: 'Body temp',      unit: '°C',     group: 'device', min: 34,  max: 42,  step: 0.1, dp: 1, model: true },
];
export const M = Object.fromEntries(METRICS.map(m => [m.key, m]));
export const AGE_BOUNDS = [19, 55];
export const WEEKS_BOUNDS = [4, 42];

export const SYMPTOMS = [
  { key: 'headache', label: 'Severe headache' },
  { key: 'vision',   label: 'Blurred vision' },
  { key: 'swelling', label: 'Abnormal swelling (face / hands)' },
  { key: 'fetal',    label: 'Reduced fetal movement' },
];

export const DISCLAIMER =
  'Decision support only, not a diagnostic tool; wrist/consumer wellness sensors are not clinical-grade, ' +
  'and sleep/stress scores are not validated predictors of preeclampsia.';

export const cToF = c => c * 9 / 5 + 32;
export const fToC = f => (f - 32) * 5 / 9;
