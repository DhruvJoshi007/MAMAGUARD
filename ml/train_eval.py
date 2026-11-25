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
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, precision_recall_fscore_support
from sklearn.model_selection import StratifiedGroupKFold, StratifiedKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_JS = os.path.join(HERE, "..", "js")
FEATURES = ["Age", "SystolicBP", "DiastolicBP", "BS", "BodyTemp", "HeartRate"]
LABELS = ["low risk", "mid risk", "high risk"]          # class index 0,1,2 ; "High" = 2
SEEDS, K = [0, 1, 2, 3, 4], 5


def make_models():
    return {
        "logistic_regression": lambda s: make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000, class_weight="balanced", random_state=s)),
        "random_forest": lambda s: make_pipeline(StandardScaler(), RandomForestClassifier(n_estimators=300, min_samples_leaf=3, max_depth=8, class_weight="balanced_subsample", random_state=s, n_jobs=-1)),
        "gradient_boosting": lambda s: make_pipeline(StandardScaler(), GradientBoostingClassifier(n_estimators=100, max_depth=3, learning_rate=0.1, random_state=s)),
    }


def cross_validate(make, X, y, groups=None):
    """Out-of-fold predictions for each seed; returns mean/std metrics and summed confusion matrix."""
    cm = np.zeros((3, 3), int); rows = []
    for s in SEEDS:
        cv = StratifiedGroupKFold(K, shuffle=True, random_state=s) if groups is not None else StratifiedKFold(K, shuffle=True, random_state=s)
        pred = np.empty_like(y)
        for tr, te in (cv.split(X, y, groups) if groups is not None else cv.split(X, y)):
            pred[te] = make(s).fit(X[tr], y[tr]).predict(X[te])       # scaler fitted on train fold only
        p, r, f, _ = precision_recall_fscore_support(y, pred, labels=[0, 1, 2], zero_division=0)
        cm += confusion_matrix(y, pred, labels=[0, 1, 2])
        rows.append({"accuracy": accuracy_score(y, pred), "macro_f1": f1_score(y, pred, average="macro"),
                     "weighted_f1": f1_score(y, pred, average="weighted"),
                     "high_recall": r[2], "high_precision": p[2], "high_f1": f[2], "mid_recall": r[1], "low_recall": r[0]})
    agg = {k: {"mean": round(float(np.mean([r[k] for r in rows])), 4), "std": round(float(np.std([r[k] for r in rows])), 4)} for k in rows[0]}
    return agg, cm


# ---------- JSON export (the JS side re-implements predict_proba from exactly these numbers) ----------
def tree_json(t, scalar=False):
    v = t.value[:, 0, :]
    if scalar: vals = [round(float(a), 6) for a in v[:, 0]]
    else:
        v = v / v.sum(axis=1, keepdims=True); vals = [[round(float(a), 4) for a in r] for r in v]
    return {"f": t.feature.tolist(), "t": [float(a) for a in t.threshold], "l": t.children_left.tolist(), "r": t.children_right.tolist(), "v": vals}


def export_model(name, scaler, est):
    if name == "logistic_regression":
        return {"type": "logistic_regression", "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
                "coef": est.coef_.tolist(), "intercept": est.intercept_.tolist()}
    # trees are scale-invariant, so the scaler is ignored for them: refit them on raw features (see main)
    if name == "random_forest":
        return {"type": "random_forest", "trees": [tree_json(e.tree_) for e in est.estimators_]}
    if name == "gradient_boosting":
        return {"type": "gradient_boosting", "learning_rate": est.learning_rate,
                "init": np.log(est.init_.class_prior_).tolist(),
                "stages": [[tree_json(t.tree_, scalar=True) for t in stage] for stage in est.estimators_]}
    raise ValueError(name)


def select(results):
    best_f1 = max(r["metrics"]["macro_f1"]["mean"] for r in results.values())
    ok = {k: r for k, r in results.items() if r["metrics"]["high_precision"]["mean"] >= 0.60 and r["metrics"]["macro_f1"]["mean"] >= best_f1 - 0.05}
    pool = ok or results
    top = max(r["metrics"]["high_recall"]["mean"] for r in pool.values())
    near = {k: r for k, r in pool.items() if r["metrics"]["high_recall"]["mean"] >= top - 0.01}
    return max(near, key=lambda k: near[k]["metrics"]["macro_f1"]["mean"])


def print_block(title, agg, cm):
    print(f"  {title:34s} acc={agg['accuracy']['mean']:.3f}  macroF1={agg['macro_f1']['mean']:.3f}  wF1={agg['weighted_f1']['mean']:.3f} | "
          f"HIGH recall={agg['high_recall']['mean']:.3f}±{agg['high_recall']['std']:.3f}  prec={agg['high_precision']['mean']:.3f}  F1={agg['high_f1']['mean']:.3f}")


def main():
    raw = pd.read_csv(os.path.join(HERE, "data", "maternal_health_risk.csv"), encoding="utf-8-sig")
    print("== DATA ==")
    print(f"rows: {len(raw)}   class counts: {raw.RiskLevel.value_counts().to_dict()}")
    dup = int(raw.duplicated().sum())
    df = raw.drop_duplicates().reset_index(drop=True)
    conflicts = int((df.groupby(FEATURES).RiskLevel.nunique() > 1).sum())
    print(f"exact duplicate rows: {dup} ({dup / len(raw):.0%}) -> dropped; {len(df)} unique rows remain")
    print(f"after dedup class counts: {df.RiskLevel.value_counts().to_dict()}")
    print(f"feature vectors with conflicting labels: {conflicts} (kept; grouped into the same fold)")
    print(f"min HeartRate = {int(raw.HeartRate.min())} bpm (implausible, left as published)")

    X = df[FEATURES].to_numpy(float); y = df.RiskLevel.map({l: i for i, l in enumerate(LABELS)}).to_numpy()
    groups = df[FEATURES].astype(str).agg("|".join, axis=1).factorize()[0]
    Xr = raw[FEATURES].to_numpy(float); yr = raw.RiskLevel.map({l: i for i, l in enumerate(LABELS)}).to_numpy()

    print(f"\n== {K}-FOLD CV x {len(SEEDS)} seeds (out-of-fold; leak-free = dedup + grouped + per-fold scaling) ==")
    results = {}
    for name, make in make_models().items():
        agg, cm = cross_validate(make, X, y, groups)
        nagg, ncm = cross_validate(make, Xr, yr, None)
        results[name] = {"metrics": agg, "cm": cm, "naive": nagg, "naive_cm": ncm}
        print(name); print_block("leak-free", agg, cm); print_block("NAIVE (dups kept; inflated)", nagg, ncm)
        print("  confusion matrix, rows=actual cols=predicted [Low Mid High] (summed over seeds):")
        for lab, row in zip(["Low ", "Mid ", "High"], cm): print("   ", lab, row.tolist())
        tot = cm[2].sum(); print(f"  actual High -> predicted Low: {cm[2][0] / tot:.1%}, Mid: {cm[2][1] / tot:.1%}, High: {cm[2][2] / tot:.1%}")

    winner = select(results)
    print(f"\n== SELECTED: {winner}  (highest High-risk recall among clinically reliable models) ==")

    # final fit on all unique rows. Tree models get raw features (scale-invariant) so JS needs no scaler for them.
    mk = make_models()[winner]
    final = mk(42).fit(X, y)
    scaler, est = final.steps[0][1], final.steps[1][1]
    if winner != "logistic_regression":
        est.fit(X, y); final = est; scaler = None       # trees on raw features: JS needs no scaler
    low_ref = {f: float(df.loc[y == 0, f].median()) for f in FEATURES}
    artifact = {"type": None, "features": FEATURES, "classes": ["Low", "Mid", "High"],
                "feature_units": {"BS": "mmol/L", "BodyTemp": "degF", "SystolicBP": "mmHg", "DiastolicBP": "mmHg", "HeartRate": "bpm", "Age": "years"},
                "low_risk_reference": low_ref,
                "training_ranges": {f: [float(df[f].min()), float(df[f].max())] for f in FEATURES}}
    artifact.update(export_model(winner, scaler, est))
    ev = {
        "dataset": "UCI Maternal Health Risk (id 863), CC BY 4.0",
        "dataset_facts": {"rows": int(len(raw)), "exact_duplicate_rows": dup, "unique_rows_used": int(len(df)),
                          "unique_feature_vectors": int(len(np.unique(groups))), "feature_vectors_with_conflicting_labels": conflicts,
                          "class_counts": {l: int((yr == i).sum()) for i, l in enumerate(LABELS)},
                          "class_counts_after_dedup": {l: int((y == i).sum()) for i, l in enumerate(LABELS)}},
        "protocol": (f"{K}-fold StratifiedGroupKFold on the {len(df)} de-duplicated rows (identical feature vectors share a fold), "
                     f"scaler inside the per-fold pipeline, repeated over seeds {SEEDS}; metrics are out-of-fold, mean ± std over seeds. "
                     f"Confusion matrices are summed over the {len(SEEDS)} repeats. 'Naive' = plain StratifiedKFold on all {len(raw)} rows "
                     "with duplicates kept: it leaks and is shown only for contrast."),
        "selection_rule": "highest mean High-risk recall among models with High-risk precision >= 0.60 and macro-F1 within 0.05 of the best; ties within 0.01 recall go to higher macro-F1.",
        "chosen_model": winner, "labels_order": ["Low", "Mid", "High"],
        "results": {k: {"grouped_cv": {"metrics": r["metrics"], "confusion_matrix_summed_over_seeds": r["cm"].tolist()},
                        "plain_cv_optimistic": {"metrics": r["naive"], "confusion_matrix_summed_over_seeds": r["naive_cm"].tolist()}} for k, r in results.items()},
        "limitations": [
            "Single-visit, cross-sectional data (rural Bangladesh, IoT monitoring); there are no longitudinal repeat visits, so the 3-visit trend alert is rule-based, not learned.",
            "Only ~450 unique records after de-duplication: estimates are noisy (see ± across seeds) and the model is not externally validated.",
            "No gestational age, proteinuria, SpO2, sleep or stress in the data: those inputs never enter the model.",
            "Labels are the dataset authors' risk labels, not clinical outcomes; 35 feature vectors have conflicting labels.",
            "Contains an implausible value (HeartRate = 7) kept as published.",
            "Decision support only, not a clinical diagnostic system."]}
    artifact["type"] = artifact.get("type") or winner
    artifact["evaluation"] = ev
    with open(os.path.join(OUT_JS, "model_artifact.json"), "w") as fh: json.dump(artifact, fh, separators=(",", ":"))
    with open(os.path.join(HERE, "metrics.json"), "w") as fh: json.dump(ev, fh, indent=2)

    # parity fixtures for the JS port (node tests/unit.mjs compares against these)
    idx = np.random.RandomState(7).choice(len(X), 40, replace=False)
    with open(os.path.join(HERE, "fixtures.json"), "w") as fh:
        json.dump([{"x": X[i].tolist(), "p": [round(float(v), 6) for v in final.predict_proba(X[i:i + 1])[0]]} for i in idx], fh)
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
