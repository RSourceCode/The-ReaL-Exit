"""Plugin-facing backend API: level schema / validation / features, bot simulation (ETL) and the dataset store.

All handlers take and return plain JSON-able dicts so the same code serves the HTTP server and the stdio IPC.
"""

from typing import Any, Dict, List, Optional

from backend.app import app
from backend.bot_runner import POLICIES, simulate_level
from backend.dataset_store import DatasetStore
from backend.extensions import registry
from backend.level_tools import extract_features, normalize_level, schema, validate_level

MAX_LEVELS_PER_CALL = 200
MAX_RUNS = 200
_store: Optional[DatasetStore] = None


def store() -> DatasetStore:
    global _store
    if _store is None:
        _store = DatasetStore()
    return _store


def _levels(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    levels = data.get("levels") or ([data["level"]] if data.get("level") else [])
    if not levels:
        raise ValueError("Provide 'level' (one) or 'levels' (a list).")
    if len(levels) > MAX_LEVELS_PER_CALL:
        raise ValueError(f"At most {MAX_LEVELS_PER_CALL} levels per call.")
    return levels


def handle_levels_schema(_data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return schema()


def handle_levels_validate(data: Dict[str, Any]) -> Dict[str, Any]:
    """{level | levels, solve?: bool, maxNodes?: int, addBoundary?: bool} -> per-level validation (+ normalised level)."""
    results = [validate_level(lv, bool(data.get("solve", False)), int(data.get("maxNodes", 20000)), bool(data.get("addBoundary", True)))
               for lv in _levels(data)]
    return {"results": results} if "levels" in data else results[0]


def handle_levels_features(data: Dict[str, Any]) -> Dict[str, Any]:
    """{level | levels} -> {features: [...]} (one numeric dict per level, same order)."""
    return {"features": [extract_features(lv) for lv in _levels(data)]}


def _agent() -> Any:
    return app.trainer.agent if app.trainer and app.trainer.agent else None


def _simulate_one(level: Dict[str, Any], data: Dict[str, Any]) -> Dict[str, Any]:
    policy = data.get("policy", "auto")
    if policy not in POLICIES:
        raise ValueError(f"policy must be one of {list(POLICIES)}")
    kwargs = dict(policy=policy, runs=min(MAX_RUNS, int(data.get("runs", 10))), max_attempts=int(data.get("maxAttempts", 5)),
                  seed=int(data.get("seed", 1)), explore=bool(data.get("explore", True)), rewards=data.get("rewards"),
                  solver_nodes=int(data.get("solverNodes", 20000)))
    if policy in ("auto", "agent"):
        with app.training_lock:   # the agent's weights must not change mid-episode
            return simulate_level(level, agent=_agent(), **kwargs)
    return simulate_level(level, **kwargs)


def handle_levels_simulate(data: Dict[str, Any]) -> Dict[str, Any]:
    """Bot plays each level headlessly.
    {level | levels, policy: auto|agent|solver|random, runs: 10, maxAttempts: 5, seed: 1, explore: true, includeDetails: false}"""
    out = []
    for lv in _levels(data):
        check = validate_level(lv)
        if not check["valid"]:
            out.append({"level_id": (lv or {}).get("id") if isinstance(lv, dict) else None, "error": "invalid level", "errors": check["errors"]})
            continue
        metrics = _simulate_one(check["level"], data)
        if not data.get("includeDetails"):
            metrics.pop("details", None)
        out.append({"level_id": check["level"]["id"], "metrics": metrics})
    return {"results": out} if "levels" in data else out[0]


def handle_dataset_collect(data: Dict[str, Any]) -> Dict[str, Any]:
    """One-call ETL: normalise + validate + features + bot play (+ store).
    {levels, policy, runs, maxAttempts, seed, label?: str | [str per level], store?: true, source?: 'bot'}"""
    levels, labels = _levels(data), data.get("label")
    rows, skipped, to_store = [], [], []
    for i, lv in enumerate(levels):
        check = validate_level(lv)
        if not check["valid"]:
            skipped.append({"index": i, "errors": check["errors"]})
            continue
        level = check["level"]
        metrics = _simulate_one(level, data)
        metrics.pop("details", None)
        label = labels[i] if isinstance(labels, list) else labels
        record = {"level": level, "features": extract_features(level), "metrics": metrics, "label": label, "source": data.get("source", "bot")}
        rows.append({k: v for k, v in record.items() if k != "level"} | {"level_id": level["id"]})
        to_store.append(record)
    saved = store().add(to_store) if data.get("store", True) and to_store else {"added": 0, "ids": []}
    for row, rid in zip(rows, saved["ids"]):
        row["id"] = rid
    return {"collected": rows, "skipped": skipped, "stored": saved["added"]}


def handle_dataset_add(data: Dict[str, Any]) -> Dict[str, Any]:
    """Store ready-made records: {records: [{level, features?, metrics?, label?, source?}]} (features are computed when omitted)."""
    records = []
    for r in data.get("records", []):
        level = normalize_level(r["level"])
        records.append({**r, "level": level, "features": r.get("features") or extract_features(level)})
    return store().add(records)


def handle_dataset_records(data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    d = data or {}
    return store().list(int(d.get("limit", 100)), int(d.get("offset", 0)), d.get("label"), bool(d.get("withLevel", False)))


def handle_dataset_stats(_data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return store().stats()


def handle_dataset_label(data: Dict[str, Any]) -> Dict[str, Any]:
    """{updates: [{id, label}]}  (labels are free-form; the ETL decides e.g. Easy / Medium / Hard)."""
    return store().set_labels(data.get("updates", []))


def handle_dataset_delete(data: Dict[str, Any]) -> Dict[str, Any]:
    return store().delete(data.get("ids"), bool(data.get("all", False)))


def handle_dataset_export(data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    d = data or {}
    return store().export(d.get("format", "csv"), d.get("label"))


def handle_ext_list(_data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {"extensions": registry.describe()}


# path -> (handler, takes_body). Shared by the HTTP server and the IPC loop.
ROUTES = {
    "/api/levels/schema": handle_levels_schema,
    "/api/levels/validate": handle_levels_validate,
    "/api/levels/features": handle_levels_features,
    "/api/levels/simulate": handle_levels_simulate,
    "/api/dataset/collect": handle_dataset_collect,
    "/api/dataset/add": handle_dataset_add,
    "/api/dataset/records": handle_dataset_records,
    "/api/dataset/stats": handle_dataset_stats,
    "/api/dataset/label": handle_dataset_label,
    "/api/dataset/delete": handle_dataset_delete,
    "/api/dataset/export": handle_dataset_export,
    "/api/ext": handle_ext_list,
}
