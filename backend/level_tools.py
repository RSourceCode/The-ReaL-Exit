"""Level utilities for plugins: schema, normalisation, validation, solvability and feature extraction.

Everything here works on the same level JSON the game saves (see ``backend/levels.py``), so a level
produced by a generator can be validated here and then loaded straight into the 3D game.
"""

import copy
import hashlib
import json
from collections import deque
from typing import Any, Dict, List, Optional

from backend.config import RL_ACTION_DURATION_SECONDS, LEVEL_TIME_LIMIT_SECONDS
from backend.levels import GRID_SIZE, LIST_FIELDS, boundary_walls, expand_level, migrate_level, snap_door_to_wall
from backend.rl.environment import MAX_TRACKED

MIN_GRID, MAX_GRID = 9, 41
CHANNELS = list(range(7))
POWERUP_TYPES = ["speed", "jump", "freeze", "shield"]
SHOCK_DIRS = ["down", "up", "xp", "xn", "zp", "zn"]

# Cell entry formats: first two numbers are always the grid cell [x, z].
ENTRY_FORMATS = {
    "walls": "[x, z]", "blocks": "[x, z]  pushable crate", "platforms": "[x, z]  ledge, height in objectProperties",
    "stairs": "[x, z]", "hazards": "[x, z]  acid (deadly)", "water": "[x, z]  slows only", "ice": "[x, z]  slippery",
    "coins": f"[x, z]  (at most {MAX_TRACKED} are tracked by the bot)", "plates": f"[x, z]  (at most {MAX_TRACKED})",
    "continuousPlates": "[x, z]  hold-plate, must also appear in plates", "levers": "[x, z]", "switches": "[x, z]",
    "rotators": "[x, z]  spinning bar", "movers": "[x, z]",
    "powerups": f"[x, z, 'speed'|'jump'|'freeze'|'shield']  (at most {MAX_TRACKED})",
    "lifts": "[x, z, maxTop]  rises once a lever is pulled",
    "lasers": "[cx, cz, sweep 'x'|'y'|'z', range, half, beam 'x'|'y'|'z', y, speed]",
    "shocks": "[x, z, dir, length, period, y]  dir: " + "|".join(SHOCK_DIRS),
    "cutters": "[x, z, axis 'x'|'z', range, radius, speed]", "spikes": "[x, z, period]  period 0 = always out",
}


def schema() -> Dict[str, Any]:
    """Machine-readable description of the level format (for generators and validators)."""
    return {
        "version": 7,
        "grid": {"min": MIN_GRID, "max": MAX_GRID, "default": GRID_SIZE},
        "required": ["width", "depth", "start", "exitDoor"],
        "optional": {"name": "str", "id": "str", "hint": "str", "timeLimit": f"seconds (default {LEVEL_TIME_LIMIT_SECONDS})",
                      "rotatorSpeed": "float (default 1.0)", "standalone": "bool", "objectProperties": "dict, keys 'kind:x:z'"},
        "listFields": list(LIST_FIELDS),
        "entryFormats": ENTRY_FORMATS,
        "objectProperties": {"keyFormat": "kind:x:z (kind = wall|platform|hazard|ice|water|plate|lever|laser|shock|cutter|spikes ...)",
                              "props": {"height": "float", "w": "int footprint (+x)", "d": "int footprint (+z)", "channel": "0..6 wiring colour",
                                        "size": "float", "color": "css colour", "collision": "bool"}},
        "rules": ["exitDoor lies on the outer wall, at least 2 cells from a corner", "the outer ring of walls (minus the door) is added by normalize_level",
                  "start must not be on a wall, crate or acid", "channel 0 plates open the exit gate"],
        "limits": {"maxTracked": MAX_TRACKED, "timeStepSeconds": RL_ACTION_DURATION_SECONDS},
        "powerupTypes": POWERUP_TYPES, "channels": CHANNELS,
    }


def _cell(c) -> Optional[tuple]:
    try:
        return int(c[0]), int(c[1])
    except Exception:
        return None


def normalize_level(level: Dict[str, Any], add_boundary: bool = True) -> Dict[str, Any]:
    """Return a complete, game-ready copy: defaults filled, door snapped to the wall, boundary walls added, ids set."""
    lv = copy.deepcopy(level)
    w = int(lv.get("width") or lv.get("size") or GRID_SIZE)
    d = int(lv.get("depth") or lv.get("size") or GRID_SIZE)
    lv["width"], lv["depth"] = w, d
    lv.setdefault("exitDoor", [w // 2, d - 1])
    lv.setdefault("start", [w // 2, 2])
    migrate_level(lv)
    lv["exitDoor"] = snap_door_to_wall(lv["exitDoor"], lv["width"], lv["depth"])
    lv["goal"] = list(lv["exitDoor"])
    if add_boundary:
        have = {_cell(c) for c in lv["walls"]}
        door = tuple(lv["exitDoor"])
        lv["walls"] = [c for c in lv["walls"] if _cell(c) != door]
        lv["walls"] += [c for c in boundary_walls(lv["exitDoor"], lv["width"], lv["depth"]) if tuple(c) not in have]
    lv.setdefault("objectProperties", {})
    lv.setdefault("rotatorSpeed", 1.0)
    lv.setdefault("timeLimit", LEVEL_TIME_LIMIT_SECONDS)
    lv.setdefault("hint", "")
    lv.setdefault("standalone", True)
    if not lv.get("id"):
        lv["id"] = "gen-" + hashlib.sha1(json.dumps(lv, sort_keys=True).encode()).hexdigest()[:10]
    lv.setdefault("name", f"Generated {lv['id'][-4:]}")
    return lv


def validate_level(level: Any, solve: bool = False, max_nodes: int = 20000, add_boundary: bool = True) -> Dict[str, Any]:
    """Check a level. ``solve=True`` also searches for a winning action sequence with the real game rules."""
    errors: List[str] = []
    warnings: List[str] = []
    if not isinstance(level, dict):
        return {"valid": False, "errors": ["level must be a JSON object"], "warnings": [], "level": None, "solvable": None}
    for key in ("width", "depth", "start", "exitDoor"):
        if key not in level:
            errors.append(f"missing required field '{key}'")
    try:
        lv = normalize_level(level, add_boundary)
    except Exception as err:
        return {"valid": False, "errors": errors + [f"cannot normalise level: {err}"], "warnings": warnings, "level": None, "solvable": None}
    w, d = lv["width"], lv["depth"]
    if not (MIN_GRID <= w <= MAX_GRID and MIN_GRID <= d <= MAX_GRID):
        errors.append(f"width/depth must be {MIN_GRID}..{MAX_GRID} (got {w} x {d})")
    cells: Dict[str, set] = {}
    for field in LIST_FIELDS:
        entries = lv.get(field, [])
        if not isinstance(entries, list):
            errors.append(f"'{field}' must be a list")
            continue
        cells[field] = set()
        for e in entries:
            c = _cell(e) if isinstance(e, (list, tuple)) else None
            if c is None:
                errors.append(f"'{field}' entry {e!r} is not [x, z, ...]")
            elif not (0 <= c[0] < w and 0 <= c[1] < d):
                errors.append(f"'{field}' entry {list(e)!r} is outside the {w} x {d} room")
            else:
                cells[field].add(c)
    for field, limit in (("coins", MAX_TRACKED), ("plates", MAX_TRACKED), ("powerups", MAX_TRACKED)):
        if len(lv.get(field, [])) > limit:
            warnings.append(f"only the first {limit} '{field}' are tracked")
    for p in lv.get("powerups", []):
        if len(p) > 2 and p[2] not in POWERUP_TYPES:
            errors.append(f"unknown powerup type {p[2]!r}")
    for s in lv.get("shocks", []):
        if len(s) > 2 and s[2] not in SHOCK_DIRS:
            errors.append(f"unknown shock direction {s[2]!r}")
    for lz in lv.get("lasers", []):
        if len(lz) < 4:
            errors.append("laser entries need at least [cx, cz, sweep, range]")
    if not cells.get("plates", set()) >= cells.get("continuousPlates", set()):
        errors.append("every continuousPlates cell must also be listed in plates")
    for kind, ch in ((k.split(":")[0], v.get("channel", 0)) for k, v in lv["objectProperties"].items() if isinstance(v, dict)):
        if ch not in CHANNELS:
            errors.append(f"channel {ch!r} on '{kind}' must be 0..6")
    start, door = _cell(lv["start"]), tuple(lv["exitDoor"])
    walls = cells.get("walls", set())
    if start is None or not (0 <= start[0] < w and 0 <= start[1] < d):
        errors.append(f"start {lv['start']!r} is outside the {w} x {d} room")
        start = None
    elif start in walls | cells.get("blocks", set()) | cells.get("hazards", set()):
        errors.append("start cell is on a wall, crate or acid")
    if float(lv["timeLimit"]) <= 0:
        errors.append("timeLimit must be positive")
    if not errors and start is not None:
        dist = _bfs(lv, start, avoid_hazards=False)
        if door not in dist:
            warnings.append("exit door is not reachable on foot (needs jumps, lifts or crates?)")
    result = {"valid": not errors, "errors": errors, "warnings": warnings, "level": lv, "solvable": None}
    if solve and not errors:
        result.update(check_solvable(lv, max_nodes))
    return result


def check_solvable(level: Dict[str, Any], max_nodes: int = 20000) -> Dict[str, Any]:
    """Best-first search with the real environment. ``solvable=False`` only means *not found within the node budget*."""
    from backend.tests.solver import solve_level
    found = solve_level(level, max_nodes=max_nodes)
    if found is None:
        return {"solvable": False, "solutionSteps": None, "minTimeSeconds": None, "searchBudget": max_nodes}
    actions, level_steps = found
    return {"solvable": True, "solutionSteps": len(actions), "minTimeSeconds": round(level_steps * RL_ACTION_DURATION_SECONDS, 3),
            "solution": actions, "searchBudget": max_nodes}


def _bfs(lv: Dict[str, Any], src, avoid_hazards: bool) -> Dict[tuple, int]:
    play = expand_level(lv)
    blocked = {_cell(c) for c in play.get("walls", [])}
    if avoid_hazards:
        blocked |= {_cell(c) for c in play.get("hazards", [])}
    blocked.discard(tuple(lv["exitDoor"]))
    dist, queue = {src: 0}, deque([src])
    while queue:
        x, z = queue.popleft()
        for n in ((x + 1, z), (x - 1, z), (x, z + 1), (x, z - 1)):
            if n not in dist and n not in blocked and 0 <= n[0] < lv["width"] and 0 <= n[1] < lv["depth"]:
                dist[n] = dist[(x, z)] + 1
                queue.append(n)
    return dist


def extract_features(level: Dict[str, Any]) -> Dict[str, float]:
    """Numeric feature dict (one dataset row). Same function for ETL and for the classifier, so they never drift apart."""
    lv = normalize_level(level)
    play = expand_level(lv)
    w, d = lv["width"], lv["depth"]
    area = w * d
    count = lambda k: len(lv.get(k, []))  # noqa: E731
    boundary = {tuple(c) for c in boundary_walls(lv["exitDoor"], w, d)}
    inner_walls = sum(1 for c in play["walls"] if _cell(c) not in boundary)
    start, door = _cell(lv["start"]), tuple(lv["exitDoor"])
    hazard_cells = len({_cell(c) for c in play.get("hazards", [])})
    dynamic = sum(count(k) for k in ("lasers", "shocks", "cutters", "rotators", "spikes", "movers"))
    direct = _bfs(lv, start, avoid_hazards=False).get(door, -1)
    safe = _bfs(lv, start, avoid_hazards=True).get(door, -1)
    # walk start -> every gate plate (nearest first) -> exit
    chain, here = 0, start
    todo = [_cell(p) for p in lv.get("plates", []) if int(lv["objectProperties"].get(f"plate:{p[0]}:{p[1]}", {}).get("channel", 0) or 0) == 0]
    ok = direct >= 0
    while todo and ok:
        dist = _bfs(lv, here, avoid_hazards=False)
        reach = [(dist[p], p) for p in todo if p in dist]
        if not reach:
            ok = False
            break
        step, nxt = min(reach)
        chain, here = chain + step, nxt
        todo.remove(nxt)
    if ok:
        last = _bfs(lv, here, avoid_hazards=False).get(door, -1)
        ok = last >= 0
        chain += max(last, 0)
    f = {
        "width": w, "depth": d, "area": area, "time_limit": float(lv["timeLimit"]), "rotator_speed": float(lv["rotatorSpeed"]),
        "inner_walls": inner_walls, "crates": count("blocks"), "platforms": count("platforms"), "lifts": count("lifts"),
        "acid_cells": hazard_cells, "water_cells": len(play.get("water", [])), "ice_cells": len(play.get("ice", [])),
        "coins": count("coins"), "plates": count("plates"), "hold_plates": count("continuousPlates"), "levers": count("levers"),
        "switches": count("switches"), "powerups": count("powerups"),
        "rotators": count("rotators"), "lasers": count("lasers"), "shocks": count("shocks"), "cutters": count("cutters"), "spikes": count("spikes"),
        "dynamic_hazards": dynamic, "obstacles_total": dynamic + hazard_cells + inner_walls + count("blocks") + count("platforms"),
        "dynamic_density": round(dynamic / area, 5), "obstacle_density": round((dynamic + hazard_cells + inner_walls) / area, 5),
        "start_x": start[0], "start_z": start[1], "exit_x": door[0], "exit_z": door[1],
        "start_exit_manhattan": abs(start[0] - door[0]) + abs(start[1] - door[1]),
        "path_len_direct": direct, "path_len_safe": safe, "path_len_via_plates": chain if ok else -1,
        "channels_used": len({v.get("channel", 0) for v in lv["objectProperties"].values() if isinstance(v, dict)} - {0}),
    }
    return {k: (float(v) if isinstance(v, float) else int(v)) for k, v in f.items()}
