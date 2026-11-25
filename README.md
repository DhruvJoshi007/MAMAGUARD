# MamaGuard

Offline-first progressive web app (PWA) for maternal and fetal risk screening at antenatal check-ups. It pulls vitals from Bluetooth devices, a built-in simulator or manual entry, scores risk with a model trained on real data, applies hard safety rules on top, and writes a referral message.

> **Decision support only, not a diagnostic tool.** Wrist/consumer wellness sensors are not clinical-grade, and sleep/stress scores are not validated predictors of preeclampsia.

## Features
- **Consent first.** Patient creation, device pairing and saving a visit stay locked until a consent box is ticked; the consent time is recorded.
- **Local-first and anonymous.** Records use random Patient IDs (no names anywhere) and live in browser local storage. Each patient has a "Delete patient data" action.
- **Source on every value.** Each metric carries `ble_device`, `simulated_watch`, `simulated_device` or `manual_entry`. The breakdown is stored with the visit and printed in the referral.
- **Vitals:** heart rate, SpO₂, sleep score, stress score, systolic/diastolic BP, blood sugar, body temperature, plus four danger-sign questions (severe headache, blurred vision, abnormal swelling, reduced fetal movement).
- **Web Bluetooth + simulation.** Standard GATT profiles (heart rate, blood pressure, thermometer, glucose, pulse oximeter), plus a demo mode with three scenarios: 3-visit rising BP, severe BP with danger signs, and a partial-sensor visit.
- **Plausibility checks.** Out-of-range readings are blocked and highlighted. The worker can re-read, correct, or override with a written reason.
- **Strict missing-data rule.** Missing readings are listed prominently and never score as Low. A Low result needs all model inputs and all danger-sign answers.
- **Risk = model + safety rules.** The model gives Low/Mid/High; rules can only raise it (BP ≥160/110, danger signs with raised BP, and more). The UI says whether the model or a rule drove the result.
- **3-visit trend alert** (rule-based): BP higher at each of the last three visits, even if every reading looks borderline.
- **Referral message** with Patient ID, vitals, source tags, symptoms, reasons, trend and timestamp; copy or share.
- **Offline PWA** with online/offline banner, manifest and service worker.
- **Fetal health (CTG) tab** (optional) using the Kaggle Fetal Health structure.

## Run it
No build step.

```bash
cd mamaguard
python3 -m http.server 8765
# open http://localhost:8765 in Chrome or Edge
```
Web Bluetooth needs `localhost` or HTTPS and Chrome/Edge (not iOS Safari). For a phone, host the folder on any HTTPS static host (e.g. GitHub Pages: Settings → Pages → deploy from `main`, root).

**About real devices:** most consumer smartwatches use proprietary protocols and sync through their own app, so they usually expose only the standard heart-rate service. Sleep and stress have no standard Bluetooth profile. Use demo mode or manual entry for the rest.

## Model and honest metrics
Data: [UCI Maternal Health Risk](https://archive.ics.uci.edu/dataset/863/maternal+health+risk) (Ahmed & Kashem, 2020; CC BY 4.0): Age, SystolicBP, DiastolicBP, BS, BodyTemp, HeartRate → Low / Mid / High.

- 562 of the 1,014 rows are exact duplicates. They are dropped before evaluation (452 unique rows remain); identical feature vectors share a fold; scaling is fitted inside each fold. Naive k-fold on all rows reports about 81% accuracy because of this leak.
- Leak-free 5-fold CV, 5 repeats, shipped random forest: accuracy **70.6%**, macro-F1 63.8%, **High-risk recall 81.1%**, High-risk precision 73.0%. Logistic regression and gradient boosting were compared; the winner is chosen by High-risk recall (rule in `ml/train_eval.py`).
- Ceiling: 35 identical sets of vitals carry different labels, and most errors are Low vs Mid. The model alone misses some true High cases, which is why safety rules sit on top.
- No gestational age, urine protein, SpO₂, sleep or stress in the data, so those never enter the model. No repeat visits exist, so the trend alert is rule-based, not learned.
- CTG model: accuracy 91.4%, Pathological recall 93.1% (same protocol on de-duplicated rows). Not externally validated.

Retrain and re-export everything:
```bash
pip install scikit-learn pandas numpy
python ml/train_eval.py        # writes js/model_artifact.json (model + metrics), ml/metrics.json
```

## Project layout
| Path | Purpose |
|---|---|
| `index.html`, `styles.css`, `manifest.webmanifest`, `sw.js`, `icons/` | PWA shell |
| `js/app.js` | UI and state |
| `js/risk.js` | model + safety rules + missing-data logic + trend |
| `js/model.js` | in-browser inference for the exported model |
| `js/validate.js`, `js/config.js` | plausibility bounds, metric definitions |
| `js/ble.js`, `js/sim.js` | Web Bluetooth parsers, simulator and scenarios |
| `js/store.js`, `js/referral.js`, `js/chart.js`, `js/ctg.js`, `js/modeltab.js`, `js/bg.js` | storage, referral text, BP chart, CTG tab, model tab, background |
| `js/model_artifact.json` | trained model and cross-validated metrics |
| `ml/train_eval.py`, `ml/data/` | training, evaluation and datasets |
| `tests/unit.mjs`, `tests/e2e.cjs` | tests |

## Tests
```bash
node tests/unit.mjs                                   # 15 tests: inference parity, safety rules, missing data, trend, BLE parsers, referral
python3 -m http.server 8765 &                         # then:
NODE_PATH=$(npm root -g) node tests/e2e.cjs           # needs Playwright
```

## Limitations
Research prototype. Not validated clinically, not a medical device, and the Bluetooth path has only been tested against sample packets, not real hardware.

## Credits
UCI Maternal Health Risk dataset: Ahmed, M. & Kashem, M. A. (2020), CC BY 4.0. Fetal Health (CTG) data: Ayres de Campos et al., via the Kaggle "Fetal Health Classification" dataset.
