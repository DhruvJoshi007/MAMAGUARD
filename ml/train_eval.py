"""
MamaGuard: leak-free training + cross-validated evaluation + JSON model export.

Usage:  python train_eval.py            -> writes ../js/model_artifact.json, metrics.json
        python train_eval.py --no-ctg   (skip the optional fetal-health module)
Needs:  scikit-learn, pandas, numpy

Dataset: UCI Maternal Health Risk (id 863; Ahmed & Kashem 2020; CC BY 4.0)
         Age, SystolicBP, DiastolicBP, BS (mmol/L), BodyTemp (degF), HeartRate -> low / mid / high risk

LEAKAGE CONTROL (the important part)
  1. 562 of the 1014 rows are exact duplicates. If they stay in, copies of one record land in both the
     training and the test fold and every score is inflated. We drop exact duplicate rows first.
  2. 35 feature vectors still carry different labels (same vitals, different risk). We keep them (we do not
     invent a label) but put identical feature vectors in the same fold (StratifiedGroupKFold), so no vector
     is ever seen in training and testing.
  3. Preprocessing (StandardScaler) lives inside a Pipeline, so it is fitted on the training part of each
     fold only.
  4. All metrics are out-of-fold. The 5-fold split is repeated over 5 seeds and averaged for stability.
  For contrast we also print the naive result (plain StratifiedKFold on all 1014 rows, duplicates kept).

MODEL SELECTION: highest mean High-risk recall among models that are also "clinically reliable":
  High-risk precision >= 0.60 and macro-F1 within 0.05 of the best model. Ties (within 0.01 recall)
  go to the higher macro-F1.
"""
import json, os, sys
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, average_precision_score, confusion_matrix, f1_score, precision_recall_fscore_support, roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold, StratifiedKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_JS = os.path.join(HERE, "..", "js")
FEATURES = ["Age", "SystolicBP", "DiastolicBP", "BS", "BodyTemp", "HeartRate"]
LABELS = ["low risk", "mid risk", "high risk"]          # class index 0,1,2 ; "High" = 2
SEEDS, K = [0, 1, 2, 3, 4], 5


FS = ["base", "engineered"]
ENG_NAMES = ["PulsePressure", "MAP", "ShockIndex", "BP>=130/80", "BP>=140/90", "BS>7.8", "Age<18", "Age>=35"]


def feats(d, fs):
    """Row-wise deterministic features (no fitting), so computing them before CV cannot leak.
    Must match rowFor() in js/model.js exactly. BodyTemp stays in degF."""
    b = d[FEATURES].to_numpy(float)
    if fs == "base": return b
    age, sbp, dbp, bs, t, hr = b.T
    pp = sbp - dbp
    extra = np.c_[pp, dbp + pp / 3, hr / sbp, (sbp >= 130) | (dbp >= 80), (sbp >= 140) | (dbp >= 90), bs > 7.8, age < 18, age >= 35].astype(float)
    return np.c_[b, extra]


def make_models():
    return {
        "logistic_regression": lambda s: make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000, class_weight="balanced", random_state=s)),
        "random_forest": lambda s: make_pipeline(StandardScaler(), RandomForestClassifier(n_estimators=300, min_samples_leaf=3, max_depth=8, class_weight="balanced_subsample", random_state=s, n_jobs=-1)),
        "gradient_boosting": lambda s: make_pipeline(StandardScaler(), GradientBoostingClassifier(n_estimators=100, max_depth=3, learning_rate=0.1, random_state=s)),
    }


def resolve_conflicts(raw):
    """Majority vote per identical feature vector over the ORIGINAL rows; ties go to the higher (safer) risk class."""
    r = raw.copy(); r["y"] = r.RiskLevel.map({l: i for i, l in enumerate(LABELS)})
    def vote(g):
        c = np.bincount(g.y, minlength=3); return int(np.flatnonzero(c == c.max()).max())
    out = r.groupby(FEATURES, sort=False).apply(vote, include_groups=False).rename("y").reset_index()
    out["RiskLevel"] = out.y.map(dict(enumerate(LABELS))); return out.drop(columns="y")


def cross_validate(make, X, y, groups=None, seeds=SEEDS):
    cm = np.zeros((3, 3), int); rows = []
    for s in seeds:
        cv = StratifiedGroupKFold(K, shuffle=True, random_state=s) if groups is not None else StratifiedKFold(K, shuffle=True, random_state=s)
        pr = np.zeros((len(y), 3))
        for tr, te in (cv.split(X, y, groups) if groups is not None else cv.split(X, y)):
            pr[te] = make(s).fit(X[tr], y[tr]).predict_proba(X[te])      # scaler fitted on the train fold only
        pred = pr.argmax(1); hi = (y == 2)
        p, r, f, _ = precision_recall_fscore_support(y, pred, labels=[0, 1, 2], zero_division=0)
        cm += confusion_matrix(y, pred, labels=[0, 1, 2])
        rows.append({"accuracy": accuracy_score(y, pred), "macro_f1": f1_score(y, pred, average="macro"), "weighted_f1": f1_score(y, pred, average="weighted"),
                     "high_recall": r[2], "high_precision": p[2], "high_f1": f[2], "high_specificity": ((pred != 2) & ~hi).sum() / (~hi).sum(),
                     "high_roc_auc": roc_auc_score(hi, pr[:, 2]), "high_pr_auc": average_precision_score(hi, pr[:, 2]),
                     "mid_recall": r[1], "low_recall": r[0]})
    agg = {k: {"mean": round(float(np.mean([r[k] for r in rows])), 4), "std": round(float(np.std([r[k] for r in rows])), 4)} for k in rows[0]}
    return {"metrics": agg, "confusion_matrix_summed_over_seeds": cm.tolist()}


# ---------- JSON export (the JS side re-implements predict_proba from exactly these numbers) ----------
def tree_json(t, scalar=False):
    v = t.value[:, 0, :]
    if scalar: vals = [round(float(a), 6) for a in v[:, 0]]
    else:
        v = v / v.sum(axis=1, keepdims=True); vals = [[round(float(a), 4) for a in r] for r in v]
    return {"f": t.feature.tolist(), "t": [float(a) for a in t.threshold], "l": t.children_left.tolist(), "r": t.children_right.tolist(), "v": vals}


def export_model(name, scaler, est):
    if name == "logistic_regression":
        return {"type": "logistic_regression", "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(), "coef": est.coef_.tolist(), "intercept": est.intercept_.tolist()}
    if name == "random_forest":
        return {"type": "random_forest", "trees": [tree_json(e.tree_) for e in est.estimators_]}
    if name == "gradient_boosting":
        return {"type": "gradient_boosting", "learning_rate": est.learning_rate, "init": np.log(est.init_.class_prior_).tolist(),
                "stages": [[tree_json(t.tree_, scalar=True) for t in stage] for stage in est.estimators_]}
    raise ValueError(name)


def select(table):
    best_f1 = max(r["metrics"]["macro_f1"]["mean"] for r in table.values())
    ok = {k: r for k, r in table.items() if r["metrics"]["high_precision"]["mean"] >= 0.60 and r["metrics"]["macro_f1"]["mean"] >= best_f1 - 0.05}
    pool = ok or table
    top = max(r["metrics"]["high_recall"]["mean"] for r in pool.values())
    near = {k: r for k, r in pool.items() if r["metrics"]["high_recall"]["mean"] >= top - 0.01}
    return max(near, key=lambda k: near[k]["metrics"]["macro_f1"]["mean"])


TARGET_RECALL = 0.88


def pick_threshold(make, X, y, groups, seed):
    """Largest P(High) threshold whose out-of-fold High recall (inner 3-fold on the training data only) reaches the target."""
    pr = np.zeros((len(y), 3))
    for tr, te in StratifiedGroupKFold(3, shuffle=True, random_state=seed).split(X, y, groups):
        pr[te] = make(seed).fit(X[tr], y[tr]).predict_proba(X[te])
    hi = y == 2
    for t in np.arange(0.60, 0.099, -0.01):
        if (pr[hi, 2] >= t).mean() >= TARGET_RECALL: return round(float(t), 2)
    return 0.10


def triage_eval(make, X, y, groups, seeds=(0, 1, 2)):
    """NESTED: the threshold is chosen inside each outer training fold, then applied to the untouched outer test fold."""
    rows, ts = [], []
    for s in seeds:
        pred = np.zeros(len(y), int)
        for tr, te in StratifiedGroupKFold(K, shuffle=True, random_state=s).split(X, y, groups):
            t = pick_threshold(make, X[tr], y[tr], groups[tr], s); ts.append(t)
            p = make(s).fit(X[tr], y[tr]).predict_proba(X[te])
            pred[te] = np.where(p[:, 2] >= t, 2, p[:, :2].argmax(1))
        hi = y == 2; pp, rr, _, _ = precision_recall_fscore_support(y, pred, labels=[2], zero_division=0)
        rows.append({"high_recall": rr[0], "high_precision": pp[0], "high_specificity": ((pred != 2) & ~hi).sum() / (~hi).sum(), "accuracy": accuracy_score(y, pred),
                     "macro_f1": f1_score(y, pred, average="macro"), "cm": confusion_matrix(y, pred, labels=[0, 1, 2])})
    agg = {k: {"mean": round(float(np.mean([r[k] for r in rows])), 4), "std": round(float(np.std([r[k] for r in rows])), 4)} for k in rows[0] if k != "cm"}
    return {"metrics": agg, "confusion_matrix_summed_over_seeds": sum(r["cm"] for r in rows).tolist(), "inner_thresholds_mean": round(float(np.mean(ts)), 3), "target_high_recall": TARGET_RECALL}


def line(tag, r):
    m = r["metrics"]; print(f"  {tag:34s} acc={m['accuracy']['mean']:.3f} mF1={m['macro_f1']['mean']:.3f} | HIGH rec={m['high_recall']['mean']:.3f}±{m['high_recall']['std']:.3f} prec={m['high_precision']['mean']:.3f} spec={m['high_specificity']['mean']:.3f} ROC-AUC={m['high_roc_auc']['mean']:.3f} PR-AUC={m['high_pr_auc']['mean']:.3f}")


def main():
    raw = pd.read_csv(os.path.join(HERE, "data", "maternal_health_risk.csv"), encoding="utf-8-sig")
    print("== DATA ==")
    print(f"rows: {len(raw)}   class counts: {raw.RiskLevel.value_counts().to_dict()}")
    dup = int(raw.duplicated().sum()); ded = raw.drop_duplicates().reset_index(drop=True)
    conflicts = int((ded.groupby(FEATURES).RiskLevel.nunique() > 1).sum()); res = resolve_conflicts(raw).reset_index(drop=True)
    print(f"exact duplicate rows: {dup} ({dup / len(raw):.0%}) -> raw-dedup set has {len(ded)} rows ({ded.RiskLevel.value_counts().to_dict()})")
    print(f"feature vectors with conflicting labels: {conflicts}; conflict-resolved set (majority vote, ties -> higher risk): {len(res)} rows ({res.RiskLevel.value_counts().to_dict()})")
    print(f"min HeartRate = {int(raw.HeartRate.min())} bpm (implausible, left as published)")
    lab = lambda d: d.RiskLevel.map({l: i for i, l in enumerate(LABELS)}).to_numpy()
    grp = lambda d: d[FEATURES].astype(str).agg("|".join, axis=1).factorize()[0]
    sets = {"raw_dedup": (ded, lab(ded), grp(ded)), "conflict_resolved": (res, lab(res), grp(res))}

    tables = {"raw_dedup": {}, "conflict_resolved": {}, "naive_leaky": {}}
    for pname, (d, y, g) in sets.items():
        print(f"\n== {pname.upper()} : stratified-group {K}-fold x {len(SEEDS)} seeds, out-of-fold ==")
        for fs in FS:
            X = feats(d, fs)
            for name, make in make_models().items():
                r = cross_validate(make, X, y, g); tables[pname][f"{name}|{fs}"] = r; line(f"{name} [{fs}]", r)
    print("\n== NAIVE (all 1014 rows, duplicates kept, plain StratifiedKFold; leaks, shown for contrast only) ==")
    yr = lab(raw)
    for name, make in make_models().items():
        r = cross_validate(make, feats(raw, "base"), yr, None); tables["naive_leaky"][f"{name}|base"] = r; line(f"{name} [base]", r)

    win = select(tables["raw_dedup"]); wname, wfs = win.split("|")
    print(f"\n== SELECTED (raw-dedup protocol): {wname} with {wfs} features ==")
    line("selected", tables["raw_dedup"][win])
    cmx = np.array(tables["raw_dedup"][win]["confusion_matrix_summed_over_seeds"]); tot = cmx[2].sum()
    print(f"  actual High -> Low {cmx[2][0] / tot:.1%}, Mid {cmx[2][1] / tot:.1%}, High {cmx[2][2] / tot:.1%}")

    d, y, g = sets["raw_dedup"]; X = feats(d, wfs)
    print("\n== HIGH-RISK TRIAGE (nested threshold selection, target High recall >= 88%) ==")
    tri = triage_eval(make_models()[wname], X, y, g); m = tri["metrics"]
    print(f"  threshold P(High) >= t (inner mean t={tri['inner_thresholds_mean']}): recall={m['high_recall']['mean']:.3f} precision={m['high_precision']['mean']:.3f} specificity={m['high_specificity']['mean']:.3f} acc={m['accuracy']['mean']:.3f}")
    thr = pick_threshold(make_models()[wname], X, y, g, 42); print(f"  deployed threshold (chosen on out-of-fold data): {thr}")

    mk = make_models()[wname]; final = mk(42).fit(X, y); scaler, est = final.steps[0][1], final.steps[1][1]
    if wname != "logistic_regression":
        est.fit(X, y); final = est; scaler = None       # trees on raw features: JS needs no scaler
    low_ref = {f: float(d.loc[y == 0, f].median()) for f in FEATURES}
    artifact = {"type": None, "features": FEATURES, "engineered": wfs == "engineered", "engineered_features": ENG_NAMES if wfs == "engineered" else [],
                "classes": ["Low", "Mid", "High"], "high_threshold": thr,
                "feature_units": {"BS": "mmol/L", "BodyTemp": "degF", "SystolicBP": "mmHg", "DiastolicBP": "mmHg", "HeartRate": "bpm", "Age": "years"},
                "low_risk_reference": low_ref, "training_ranges": {f: [float(d[f].min()), float(d[f].max())] for f in FEATURES}}
    artifact.update(export_model(wname, scaler, est)); artifact["type"] = wname
    ev = {"dataset": "UCI Maternal Health Risk (id 863), CC BY 4.0",
          "dataset_facts": {"rows": int(len(raw)), "exact_duplicate_rows": dup, "raw_dedup_rows": int(len(ded)), "conflicting_feature_vectors": conflicts,
                            "conflict_resolved_rows": int(len(res)), "class_counts": {l: int((yr == i).sum()) for i, l in enumerate(LABELS)},
                            "class_counts_raw_dedup": {l: int((y == i).sum()) for i, l in enumerate(LABELS)},
                            "class_counts_conflict_resolved": {l: int((lab(res) == i).sum()) for i, l in enumerate(LABELS)}},
          "protocol": (f"Stratified {K}-fold (StratifiedGroupKFold: identical feature vectors share a fold) repeated over seeds {SEEDS}; scaler inside the per-fold pipeline; "
                       "engineered features are deterministic row-wise formulas (nothing is fitted, so no leakage). Metrics are out-of-fold, mean ± std over seeds; confusion matrices are summed over seeds. "
                       "RAW-DEDUP drops exact duplicate rows and keeps conflicting labels (test labels are the untouched originals; this is the headline). "
                       "CONFLICT-RESOLVED relabels identical vitals by majority vote (ties to the higher risk class); it also cleans the TEST labels, so it is easier and shown for transparency, not as a headline. "
                       "NAIVE keeps all 1014 rows and duplicates, which leaks."),
          "selection_rule": "Among model × feature-set combinations on the raw-dedup protocol: highest mean High-risk recall among those with High precision >= 0.60 and macro-F1 within 0.05 of the best; ties within 0.01 recall go to higher macro-F1.",
          "chosen": {"model": wname, "feature_set": wfs}, "labels_order": ["Low", "Mid", "High"], "tables": tables, "triage": tri, "deployed_high_threshold": thr,
          "limitations": ["Single-visit, cross-sectional data (rural Bangladesh, IoT monitoring); no longitudinal repeat visits, so the 3-visit trend alert is rule-based, not learned.",
                          f"Only {len(ded)} unique records ({len(res)} unique vitals): estimates are noisy (see ± across seeds) and the model is not externally validated.",
                          "No gestational age, proteinuria, SpO2, sleep or stress in the data: those inputs never enter the model.",
                          f"Labels are the dataset authors' risk labels, not clinical outcomes; {conflicts} feature vectors carry conflicting labels.",
                          "Contains an implausible value (HeartRate = 7) kept as published.",
                          "Decision support only, not a clinical diagnostic system."]}
    artifact["evaluation"] = ev
    with open(os.path.join(OUT_JS, "model_artifact.json"), "w") as fh: json.dump(artifact, fh, separators=(",", ":"))
    with open(os.path.join(HERE, "metrics.json"), "w") as fh: json.dump(ev, fh, indent=2)
    idx = np.random.RandomState(7).choice(len(X), 40, replace=False)
    with open(os.path.join(HERE, "fixtures.json"), "w") as fh:
        json.dump([{"base": d[FEATURES].to_numpy(float)[i].tolist(), "p": [round(float(v), 6) for v in final.predict_proba(X[i:i + 1])[0]]} for i in idx], fh)
    print("wrote js/model_artifact.json", os.path.getsize(os.path.join(OUT_JS, "model_artifact.json")), "bytes, ml/metrics.json, ml/fixtures.json")
    if "--no-ctg" not in sys.argv: ctg()


def ctg():
    path = os.path.join(HERE, "data", "fetal_health.csv")
    if not os.path.exists(path): print("fetal_health.csv not found: skipping CTG"); return
    df = pd.read_csv(path); feats = [c for c in df.columns if c != "fetal_health"]
    dup = int(df.duplicated().sum()); df = df.drop_duplicates().reset_index(drop=True)
    X = df[feats].to_numpy(float); y = df.fetal_health.astype(int).to_numpy() - 1
    groups = df[feats].astype(str).agg("|".join, axis=1).factorize()[0]
    mk = lambda s: make_pipeline(StandardScaler(), RandomForestClassifier(n_estimators=40, max_depth=9, min_samples_leaf=3, class_weight="balanced", random_state=s, n_jobs=-1))
    cm = np.zeros((3, 3), int); acc = []; prec = []; rec = []
    for s in SEEDS[:3]:
        pred = np.empty_like(y)
        for tr, te in StratifiedGroupKFold(K, shuffle=True, random_state=s).split(X, y, groups): pred[te] = mk(s).fit(X[tr], y[tr]).predict(X[te])
        p, r, _, _ = precision_recall_fscore_support(y, pred, labels=[0, 1, 2], zero_division=0)
        cm += confusion_matrix(y, pred, labels=[0, 1, 2]); acc.append(accuracy_score(y, pred)); prec.append(p[2]); rec.append(r[2])
    rf = mk(42).steps[1][1].fit(X, y)          # trees on raw features (scale-invariant), matches the JS port
    print(f"\n== CTG (Kaggle fetal_health, {dup} duplicate rows dropped, {len(df)} used) == acc={np.mean(acc):.3f} Pathological recall={np.mean(rec):.3f} precision={np.mean(prec):.3f}")
    json.dump({"features": feats, "classes": ["Normal", "Suspect", "Pathological"], "trees": [tree_json(e.tree_) for e in rf.estimators_],
               "medians": {f: float(df[f].median()) for f in feats}, "ranges": {f: [float(df[f].min()), float(df[f].max())] for f in feats}},
              open(os.path.join(OUT_JS, "ctg_model.json"), "w"), separators=(",", ":"))
    imp = sorted(zip(feats, rf.feature_importances_), key=lambda a: -a[1])[:6]
    m = {"rows": int(len(df)), "duplicates_dropped": dup, "protocol": f"{K}-fold StratifiedGroupKFold x3 seeds on de-duplicated rows, scaler inside pipeline; confusion matrix summed over seeds",
         "accuracy_mean": round(float(np.mean(acc)), 3), "pathological_recall_mean": round(float(np.mean(rec)), 3), "pathological_precision_mean": round(float(np.mean(prec)), 3),
         "confusion_matrix": cm.tolist(), "labels": ["Normal", "Suspect", "Pathological"], "top_features": [[a, round(float(b), 3)] for a, b in imp],
         "class_counts": [int((y == i).sum()) for i in range(3)]}
    json.dump(m, open(os.path.join(OUT_JS, "ctg_metrics.json"), "w"), separators=(",", ":")); json.dump(m, open(os.path.join(HERE, "ctg_metrics.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
