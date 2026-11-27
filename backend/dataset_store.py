"""Local SQLite store for the difficulty dataset (levels + features + bot metrics + label).

Location: ``$REAL_EXIT_DATA_DIR`` or ``%APPDATA%/The-ReaL-Exit/data`` (Windows) / ``~/.the-real-exit/data``.
"""

import csv
import io
import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


def _data_dir() -> Path:
    env = os.environ.get("REAL_EXIT_DATA_DIR")
    if env:
        return Path(env)
    if os.name == "nt" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "The-ReaL-Exit" / "data"
    return Path.home() / ".the-real-exit" / "data"


class DatasetStore:
    def __init__(self, path: Optional[Path] = None):
        self.path = Path(path) if path else _data_dir() / "levels_dataset.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self._db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS records (
                id INTEGER PRIMARY KEY AUTOINCREMENT, level_id TEXT, created_at REAL, source TEXT, label TEXT,
                features TEXT NOT NULL, metrics TEXT NOT NULL, level TEXT NOT NULL)""")
            db.execute("CREATE INDEX IF NOT EXISTS idx_label ON records(label)")

    def _db(self) -> sqlite3.Connection:
        return sqlite3.connect(str(self.path))

    def add(self, records: List[Dict[str, Any]]) -> Dict[str, Any]:
        """record = {level, features, metrics, label?, source?}"""
        rows = [(r["level"].get("id"), time.time(), r.get("source", "bot"), r.get("label"),
                 json.dumps(r.get("features", {})), json.dumps(r.get("metrics", {})), json.dumps(r["level"])) for r in records]
        with self.lock, self._db() as db:
            first = db.execute("SELECT COALESCE(MAX(id), 0) FROM records").fetchone()[0]
            db.executemany("INSERT INTO records (level_id, created_at, source, label, features, metrics, level) VALUES (?,?,?,?,?,?,?)", rows)
        return {"added": len(rows), "ids": list(range(first + 1, first + 1 + len(rows)))}

    def list(self, limit: int = 100, offset: int = 0, label: Optional[str] = None, with_level: bool = False) -> Dict[str, Any]:
        where, args = ("WHERE label = ?", [label]) if label else ("", [])
        with self.lock, self._db() as db:
            total = db.execute(f"SELECT COUNT(*) FROM records {where}", args).fetchone()[0]
            rows = db.execute(f"SELECT id, level_id, created_at, source, label, features, metrics, level FROM records {where} ORDER BY id LIMIT ? OFFSET ?",
                              args + [int(limit), int(offset)]).fetchall()
        out = []
        for i, lid, ts, src, lab, feat, met, lvl in rows:
            rec = {"id": i, "level_id": lid, "created_at": ts, "source": src, "label": lab, "features": json.loads(feat), "metrics": json.loads(met)}
            if with_level:
                rec["level"] = json.loads(lvl)
            out.append(rec)
        return {"total": total, "records": out}

    def stats(self) -> Dict[str, Any]:
        with self.lock, self._db() as db:
            total = db.execute("SELECT COUNT(*) FROM records").fetchone()[0]
            labels = dict(db.execute("SELECT COALESCE(label, 'unlabelled'), COUNT(*) FROM records GROUP BY label").fetchall())
        return {"total": total, "labels": labels, "path": str(self.path)}

    def set_labels(self, updates: List[Dict[str, Any]]) -> Dict[str, Any]:
        with self.lock, self._db() as db:
            db.executemany("UPDATE records SET label = ? WHERE id = ?", [(u.get("label"), int(u["id"])) for u in updates])
        return {"updated": len(updates)}

    def delete(self, ids: Optional[List[int]] = None, delete_all: bool = False) -> Dict[str, Any]:
        with self.lock, self._db() as db:
            if delete_all:
                n = db.execute("DELETE FROM records").rowcount
            else:
                n = db.executemany("DELETE FROM records WHERE id = ?", [(int(i),) for i in ids or []]).rowcount
        return {"deleted": n}

    def export(self, fmt: str = "csv", label: Optional[str] = None) -> Dict[str, Any]:
        """CSV: one flat row per level (feature_*, metric_* columns + label). JSONL: full records incl. the level JSON."""
        rows = self.list(limit=10 ** 9, label=label, with_level=True)["records"]
        if fmt == "jsonl":
            return {"format": "jsonl", "count": len(rows), "content": "\n".join(json.dumps(r) for r in rows)}
        flat = []
        for r in rows:
            m = {k: v for k, v in r["metrics"].items() if k != "details" and not isinstance(v, dict)}
            m.update({f"death_{k}": v for k, v in r["metrics"].get("death_causes", {}).items()})
            flat.append({"id": r["id"], "level_id": r["level_id"], "label": r["label"], "source": r["source"],
                         **{f"feature_{k}": v for k, v in r["features"].items()}, **{f"metric_{k}": v for k, v in m.items()}})
        cols = list(dict.fromkeys(k for row in flat for k in row))
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=cols)
        writer.writeheader()
        writer.writerows(flat)
        return {"format": "csv", "count": len(rows), "content": buf.getvalue()}
