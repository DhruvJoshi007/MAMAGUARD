"""Evaluate the user-supplied 'Dataset - Updated' (ml/data/maternal_updated.csv) with the same leak-free protocol as train_eval.py.
Writes ml/metrics_dataset_b.json (+ a copy in js/ for the Model tab). Evaluation only: this dataset is NOT used by the deployed model (see findings).
Run from the repo root: python ml/train_dataset_b.py"""
import json, warnings; import numpy as np, pandas as pd; warnings.filterwarnings('ignore')
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score, accuracy_score, recall_score, precision_score
raw = pd.read_csv('ml/data/maternal_updated.csv'); uci = pd.read_csv('ml/data/maternal_health_risk.csv')
core = ['Age', 'Systolic BP', 'Diastolic', 'BS', 'Body Temp', 'Heart Rate']; ext = ['BMI', 'Previous Complications', 'Preexisting Diabetes', 'Gestational Diabetes', 'Mental Health']; feat = core + ext
n0 = len(raw); d = raw.dropna(); n_nan = n0 - len(d)
d = d[d.Age.between(15, 60) & d.BMI.between(12, 60) & (d['Diastolic'] < d['Systolic BP'])]; n_bad = n0 - n_nan - len(d)
conf = int((d.groupby(feat)['Risk Level'].nunique() > 1).sum()); d = d.drop_duplicates(feat).copy(); d['y'] = (d['Risk Level'] == 'High').astype(int)
grp = d.groupby(core).ngroup()
def cv(df, cols, y, groups):
    p = np.zeros(len(df))
    for a, b in StratifiedGroupKFold(5, shuffle=True, random_state=0).split(df, y, groups):
        p[b] = RandomForestClassifier(400, min_samples_leaf=2, random_state=0, n_jobs=-1).fit(df.iloc[a][cols], y.iloc[a]).predict_proba(df.iloc[b][cols])[:, 1]
    return p
def row(name, p, y): pr = p >= .5; return dict(name=name, auc=round(roc_auc_score(y, p), 3), accuracy=round(accuracy_score(y, pr), 3), recall_high=round(recall_score(y, pr), 3), precision_high=round(precision_score(y, pr), 3))
rows = [row(n_, cv(d, c, d.y, grp), d.y) for n_, c in [('Core vitals only (6)', core), ('Core + BMI', core + ['BMI']), ('Core + all 5 new fields', feat), ('The 5 new fields ONLY', ext)]]
# same protocol on UCI collapsed to High vs not-High, for an apples-to-apples comparison
u = uci.drop_duplicates().copy(); uc = ['Age', 'SystolicBP', 'DiastolicBP', 'BS', 'BodyTemp', 'HeartRate']; u['y'] = (u.RiskLevel == 'high risk').astype(int)
rows.append(row('UCI original, High vs not-High (core 6)', cv(u, uc, u.y, u.groupby(uc).ngroup()), u.y))
single = {c: round(roc_auc_score(d.y, d[c]), 3) for c in ext}
m = d.merge(uci.rename(columns={'SystolicBP': 'Systolic BP', 'DiastolicBP': 'Diastolic', 'BodyTemp': 'Body Temp', 'HeartRate': 'Heart Rate'}).drop_duplicates(core), on=core)
xt = pd.crosstab(m['Risk Level'], m['RiskLevel'].str.split().str[0]).to_dict()
out = dict(rows_raw=n0, dropped_missing=n_nan, dropped_implausible=n_bad, conflicting_groups=conf, rows_used=len(d), high=int(d.y.sum()), classes='Low / High only (no Mid)', results=rows, single_feature_auc=single, overlap_with_uci=len(m), overlap_crosstab=xt,
  findings=['The labels are binary (Low/High); the app and the UCI model use Low/Mid/High, so the two are not directly comparable.',
            'The five new fields separate the classes almost perfectly on their own (AUC about 0.998). Real clinical risk factors do not do this, which suggests the labels or the columns were derived from each other.',
            'Core-vitals AUC is higher than on the original UCI data collapsed to High vs not-High with the same protocol (0.977 vs 0.935), consistent with re-mapped labels or augmented rows, though not proof of it.',
            'Only part of the file overlaps the UCI rows, and where it does, UCI Mid rows are mostly relabelled Low. The provenance of the extra columns is unverified.',
            'Decision: not used to train the deployed model. The new fields are collected in the app and act through safety rules only.'])
json.dump(out, open('ml/metrics_dataset_b.json', 'w'), indent=1); json.dump(out, open('js/dataset_b_metrics.json', 'w'))
print(json.dumps(out, indent=1)[:2500])
