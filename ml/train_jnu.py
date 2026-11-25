"""Train and evaluate fetal models on JNU-CTG (CC BY 4.0; 20,769 CTG recordings, 12,606 pregnancies), patient-level CV.
Usage (from repo root): python ml/train_jnu.py path/to/JNU-CTG/metadata.csv
Writes ml/metrics_jnu.json and js/jnu_metrics.json. Only the metadata table (pre-extracted features) is used; waveforms are not needed.
Leak control: StratifiedGroupKFold on patient_id (a pregnancy never spans train and test); deep latent features (NetFea_*) are excluded
because they may have been trained on the labels; post-birth variables (Apgar, birth weight, delivery mode, meconium at birth, labor) are never used."""
import sys, json, warnings; import numpy as np, pandas as pd; warnings.filterwarnings('ignore')
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.impute import SimpleImputer
from sklearn.metrics import roc_auc_score, average_precision_score, accuracy_score, recall_score, precision_score, balanced_accuracy_score
m = pd.read_csv(sys.argv[1], low_memory=False)
ga = m.gestational_age.astype(str).str.extract(r'(\d+)(?:\+(\d))?').astype(float); m['ga_weeks'] = ga[0] + ga[1].fillna(0) / 7
m['bmi'] = m.bmi.where(m.bmi.between(12, 60)); m['maternal_age'] = m.maternal_age.where(m.maternal_age.between(15, 55))
antenatal = ['maternal_age', 'bmi', 'ga_weeks', 'gravidity', 'parity', 'gestational_diabetes', 'gestational_hypertension', 'pregnancy_anemia', 'fetal_growth_restriction', 'oligohydramnios', 'thyroid_disease']
fhr = [c for c in m.columns if c.startswith('F_') and not c.startswith('FU_')]; uc = [c for c in m.columns if c.startswith('U_')]
simple = ['F_BL', 'F_A_N', 'F_D_N', 'F_ED_N', 'F_VD_N', 'F_LD_N', 'F_PD_N', 'F_LTV', 'F_STV', 'F_II', 'F_DBMM']   # interpretable, clinician-style CTG indices
for c in set(antenatal + fhr + uc):
    if c not in ('ga_weeks',): m[c] = pd.to_numeric(m[c], errors='coerce')   # a few cells hold stray characters
sets = {'Interpretable CTG indices (11)': simple, 'All FHR features': fhr, 'FHR + UC features': fhr + uc, 'Antenatal clinical only': antenatal, 'FHR + UC + antenatal clinical': fhr + uc + antenatal}
def cv(X, y, g, kind):
    p = np.zeros(len(y))
    for a, b in StratifiedGroupKFold(5, shuffle=True, random_state=0).split(X, y, g):
        mdl = HistGradientBoostingClassifier(max_iter=300, learning_rate=.06, max_leaf_nodes=15, l2_regularization=1., class_weight='balanced', random_state=0) if kind == 'gbm' else \
              make_pipeline(SimpleImputer(strategy='median'), StandardScaler(), LogisticRegression(max_iter=2000, class_weight='balanced', C=.3))
        p[b] = mdl.fit(X.iloc[a], y.iloc[a]).predict_proba(X.iloc[b])[:, 1]
    return p
def score(y, p, thr=None):
    thr = .5 if thr is None else thr; pr = p >= thr
    top = np.argsort(-p)[:int(len(p) * .2)]
    return dict(auc=round(roc_auc_score(y, p), 3), pr_auc=round(average_precision_score(y, p), 3), accuracy=round(accuracy_score(y, pr), 3), balanced_accuracy=round(balanced_accuracy_score(y, pr), 3),
                recall=round(recall_score(y, pr), 3), precision=round(precision_score(y, pr, zero_division=0), 3), recall_in_top20pct=round(float(y.iloc[top].sum() / y.sum()), 3))
out = dict(source='JNU-CTG v1.0.0, Jinan University First Affiliated Hospital (CC BY 4.0)', recordings=int(len(m)), pregnancies=int(m.patient_id.nunique()), targets={})
# Target 1: FIGO morphological label (agreement with a rule-based visual reading, NOT a clinical outcome)
d = m.dropna(subset=['figo_label']); y = d.figo_label.astype(int); g = d.patient_id
t1 = dict(description='Agreement with the FIGO morphological label (0 normal, 1 abnormal). This label is derived from the trace itself, so this measures how well the model reproduces the reading, not whether the baby is well.', n=int(len(d)), positive=int(y.sum()), results=[])
for name, cols in sets.items():
    if name == 'Antenatal clinical only': continue
    for kind in (['gbm', 'lr'] if name.startswith('Interpretable') else ['gbm']):
        t1['results'].append(dict(inputs=name, model='gradient boosting' if kind == 'gbm' else 'logistic regression', **score(y, cv(d[cols], y, g, kind))))
out['targets']['figo'] = t1
# Target 2: neonatal asphyxia (clinical outcome, rare)
d = m.dropna(subset=['neonatal_asphyxia']); y = d.neonatal_asphyxia.astype(int); g = d.patient_id
t2 = dict(description='Neonatal asphyxia diagnosis (real outcome). Very rare, so accuracy is meaningless; read AUC, PR-AUC (random = prevalence) and recall among the 20% highest-scored recordings.', n=int(len(d)), positive=int(y.sum()), prevalence=round(float(y.mean()), 4), results=[])
for name, cols in sets.items():
    t2['results'].append(dict(inputs=name, model='gradient boosting', **score(y, cv(d[cols], y, g, 'gbm'))))
t2['results'].append(dict(inputs='Interpretable CTG indices (11)', model='logistic regression', **score(y, cv(d[simple], y, g, 'lr'))))
out['targets']['asphyxia'] = t2
out['previous_kaggle_ctg'] = json.load(open('ml/ctg_metrics.json'))
json.dump(out, open('ml/metrics_jnu.json', 'w'), indent=1); json.dump(out, open('js/jnu_metrics.json', 'w'))
for k, t in out['targets'].items():
    print(k, t['n'], t['positive']); [print('  ', r['inputs'], '|', r['model'], '| AUC', r['auc'], 'PR', r['pr_auc'], 'acc', r['accuracy'], 'bal', r['balanced_accuracy'], 'rec', r['recall'], 'prec', r['precision'], 'top20', r['recall_in_top20pct']) for r in t['results']]
