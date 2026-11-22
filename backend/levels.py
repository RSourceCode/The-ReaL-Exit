"""Starter campaign (Python mirror of ``desktop/js/constants.js``).

Used by the headless trainer (``python -m backend.train_cli``) and the tests.  The JavaScript copy
of these specs is *generated* from this file (see ``backend/tools/gen_levels.py``) so the 3D game and
the RL environment can never drift apart.

Coordinates are ``[x, z]`` grid cells on a 13 x 13 board.  Deeba starts at ``[6, 2]`` and the exit
door is in the far wall at ``[6, 12]``.  Interactive piece formats:

* ``platforms``       – low walls / ledges Deeba can jump onto.  Plates, coins and boosts may sit on top.
                        Heights are in ``objectProperties["platform:x:z"]["height"]`` (default 1.0).
* ``lifts``           – ``[x, z, top]`` tiles that rise and fall once a ``lever`` is pulled.
* ``lasers``          – ``[cx, cz, sweep, range, half, beam, y, speed]`` scanning beams.  ``sweep`` (x|y|z) is the axis
                        the beam travels along, ``beam`` (x|y|z) the axis it extends along, ``y`` its height.
* ``shocks``          – ``[x, z, dir, length, period, y]`` electric strikes (dir: down|up|xp|xn|zp|zn).
* ``cutters``         – ``[x, z, axis, range, radius, speed]`` saw blades gliding along a rail.
* ``spikes``          – ``[x, z, period]`` floor spikes (period 0 = always out).
* ``hazards`` is acid, ``water`` is a harmless wade.  ``objectProperties`` may carry ``w`` / ``d`` (footprint in
  cells, growing towards +x / +z) and ``height`` for walls, ledges, acid, ice and water.
* ``blocks``          – pushable crates; ``continuousPlates`` are hold-plates that need a player or a crate.
"""

import copy
from typing import Any, Dict, List, Optional

from backend.levels_curriculum import CURRICULUM_SPECS

GRID_SIZE = 17
EXIT_DOOR = [GRID_SIZE // 2, GRID_SIZE - 1]
START = [GRID_SIZE // 2, 2]
SHIFT_X, SHIFT_Z = 2, 4   # the 13x13 chamber designs below are re-homed into the longer 17x17 lab


def boundary_walls(exit_door, width: int = GRID_SIZE, depth: int = GRID_SIZE) -> List[List[int]]:
    """Every cell of the outer ring of a ``width`` x ``depth`` room except the exit door."""
    cells = []
    for x in range(width):
        cells.append([x, 0])
    for z in range(1, depth):
        cells.append([width - 1, z])
    for x in range(width - 2, -1, -1):
        cells.append([x, depth - 1])
    for z in range(depth - 2, 0, -1):
        cells.append([0, z])
    return [c for c in cells if c != list(exit_door)]


def snap_door_to_wall(door, width: int, depth: int) -> List[int]:
    """Doors live in the outer wall: move a stray door to the nearest wall, keeping it clear of the corners."""
    x, z = int(door[0]), int(door[1])
    gaps = {"x0": x, "x1": width - 1 - x, "z0": z, "z1": depth - 1 - z}
    side = min(gaps, key=gaps.get)
    if side == "x0":
        return [0, max(2, min(depth - 3, z))]
    if side == "x1":
        return [width - 1, max(2, min(depth - 3, z))]
    if side == "z0":
        return [max(2, min(width - 3, x)), 0]
    return [max(2, min(width - 3, x)), depth - 1]


def row(z: int, x0: int, x1: int, skip=()) -> List[List[int]]:
    """Cells ``(x0..x1, z)`` except the x values in ``skip`` (handy for gates with openings)."""
    return [[x, z] for x in range(x0, x1 + 1) if x not in skip]


def col(x: int, z0: int, z1: int) -> List[List[int]]:
    return [[x, z] for z in range(z0, z1 + 1)]


def tower(*cells, height: float = 2.0) -> Dict[str, Dict[str, Any]]:
    """objectProperties for tall ledges (they keep the default green look)."""
    return {f"platform:{x}:{z}": {"height": height, "size": 0.95, "color": "#7fb6ff", "collision": True} for x, z in cells}


# ── The six-level "CatLab" campaign (short on purpose) ───────────────────────────────────────────
_SMALL_SPECS: List[Dict[str, Any]] = [
    {   # 1 · jump on a low wall, press the button on top, slip past a slow spinner and floor spikes
        "name": "Intake Bay",
        "hint": "Jump (Space) onto the low wall and stand on the button, then slip past the spinner. Mind the spikes.",
        "walls": row(8, 1, 4) + row(8, 8, 11),
        "platforms": [[5, 5], [6, 5], [7, 5]],
        "plates": [[6, 5]],
        "spikes": [[3, 10, 0], [9, 10, 0]],
        "water": [[2, 5], [3, 5], [2, 6], [3, 6], [9, 5], [10, 5], [9, 6], [10, 6]],
        "coins": [[3, 3], [9, 3], [7, 5], [6, 10]],
        "rotators": [[6, 8]], "rotatorSpeed": 0.9,
    },
    {   # 2 · crate on a hold-button, then a gate of electric shocks
        "name": "Cargo Bay",
        "hint": "Push the crate onto the glowing hold-button. Then cross the shock gate while the bolts are charging.",
        "walls": [[8, 5], [8, 6], [8, 7], [10, 5], [10, 6], [10, 7]] + row(10, 1, 4) + row(10, 8, 11),
        "blocks": [[9, 4]],
        "plates": [[9, 7]], "continuousPlates": [[9, 7]],
        "platforms": [[3, 6]],
        "coins": [[2, 3], [10, 3], [5, 6], [3, 6], [2, 9]],
        "shocks": [[5, 10, "down", 3, 3.0, 3.0], [6, 10, "down", 3, 3.0, 3.0], [7, 10, "down", 3, 3.0, 3.0]],
        "rotators": [], "rotatorSpeed": 1.0,
    },
    {   # 3 · a horizontal scanner and a vertical-sweeping scanner; ledges are laser-safe
        "name": "Laser Lane",
        "hint": "Lasers sweep along any axis. Time your dash, jump the low beam, or wait on a ledge.",
        "walls": [],
        "lasers": [[6, 6, "z", 1, 5, "x", 0.5, 1.0], [6, 10, "y", 0.9, 5, "x", 1.0, 1.0]],
        "platforms": [[3, 10], [9, 6]],
        "plates": [[6, 8]],
        "coins": [[3, 3], [9, 3], [2, 8], [10, 8], [3, 10], [9, 6]],
        "rotators": [], "rotatorSpeed": 1.0,
    },
    {   # 4 · acid moat crossed by a low-wall bridge, a sawblade patrols the far side
        "name": "Acid Bridge",
        "hint": "Hop onto the low-wall bridge to cross the acid. One of the two buttons sits on a ledge island; a cutter patrols the exit.",
        "walls": [],
        "hazards": row(6, 1, 11, skip=[6]) + row(7, 1, 11, skip=[6]),
        "platforms": [[6, 6], [6, 7], [10, 9], [10, 10], [9, 10]],
        "plates": [[6, 4], [10, 10]],
        "cutters": [[6, 10, "x", 3, 0.5, 1.0]],
        "coins": [[2, 3], [10, 3], [6, 7], [9, 10], [3, 9]],
        "rotators": [], "rotatorSpeed": 1.0,
    },
    {   # 5 · pull the lever, ride the lift, jump to the tower and press the button on top
        "name": "Lift Off",
        "hint": "Pull the power lever (E), step on the lift, and jump from it onto the tower to reach the button.",
        "walls": row(8, 1, 4) + row(8, 8, 11),
        "hazards": [[5, 7], [7, 7], [5, 8], [7, 8]],
        "levers": [[2, 2]],
        "lifts": [[6, 7, 1.2]],
        "platforms": [[6, 8]], "objectProperties": tower((6, 8), height=2.0),
        "plates": [[6, 8]],
        "coins": [[3, 4], [9, 4], [6, 5], [2, 6], [10, 6], [6, 11]],
        "rotators": [[6, 10]], "rotatorSpeed": 1.3,
        "timeLimit": 55,
    },
    {   # 6 · final exam: icy approach, ledge button, acid, a cutter patrol, a laser and a shock gate
        "name": "The Real Exit",
        "hint": "Slide across the ice, hop onto the ledge for the button, then beat the laser, the cutter and the shock gate. Good luck, Deeba!",
        "walls": [[7, 5], [7, 6], [7, 7]],
        "plates": [[9, 7]],
        "platforms": [[9, 7], [10, 7]],
        "hazards": [[8, 5], [8, 6], [8, 7]],
        "ice": [[4, 4], [5, 4], [6, 4], [7, 4]],
        "lasers": [[6, 6, "z", 1, 5, "x", 0.5, 1.0]],
        "cutters": [[6, 9, "x", 3, 0.5, 1.0]],
        "shocks": [[5, 11, "down", 3, 3.0, 3.0], [6, 11, "down", 3, 3.0, 3.0], [7, 11, "down", 3, 3.0, 3.0]],
        "coins": [[2, 3], [2, 9], [10, 4], [9, 7], [6, 9]],
        "powerups": [[6, 4, "jump"]],
        "timeLimit": 75,
    },
]

def _enlarge(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Re-home a 13x13 chamber into the 17x17 lab: shift it (+2, +4), stretch full-width walls / acid to the new
    side lanes, and add an entry corridor with a turn (a long wall with its opening on the far side)."""
    out: Dict[str, Any] = {}
    last = GRID_SIZE - 2
    for key, value in spec.items():
        if key in ("name", "hint"):
            out[key] = value
        elif key == "objectProperties":
            moved = {}
            for k, v in value.items():
                kind, x, z = k.split(":")
                moved[f"{kind}:{int(x) + SHIFT_X}:{int(z) + SHIFT_Z}"] = dict(v)
            out[key] = moved
        elif key == "timeLimit":
            out[key] = value + 14
        elif isinstance(value, list):
            cells = []
            for c in value:
                c = list(c)
                c[0] += SHIFT_X
                c[1] += SHIFT_Z
                if key == "lasers":
                    if len(c) > 5 and c[5] == "x":
                        c[4] = float(c[4]) + SHIFT_X
                    if len(c) > 2 and c[2] == "x":
                        c[3] = float(c[3]) + 0
                elif key == "cutters" and len(c) > 3:
                    c[3] = float(c[3]) + 2
                cells.append(c)
            if key in ("walls", "hazards"):
                for c in list(cells):
                    if c[0] == 1 + SHIFT_X:
                        cells += [[x, c[1]] for x in range(1, 1 + SHIFT_X)]
                    if c[0] == 11 + SHIFT_X:
                        cells += [[x, c[1]] for x in range(12 + SHIFT_X, last + 1)]
            out[key] = cells
        else:
            out[key] = value
    out.setdefault("walls", [])
    out["walls"] = out["walls"] + row(4, 1, last - 3)  # entry turn: the opening is on the right
    return out


LIST_FIELDS = (
    "walls", "blocks", "platforms", "stairs", "hazards", "switches", "painted", "coins", "springs", "portals",
    "checkpoints", "movers", "plates", "rotators", "lasers", "shocks", "cutters", "spikes", "water", "ice", "powerups", "levers",
    "continuousPlates", "lifts",
)

# The original six hand-built rooms (kept for the regression tests and as examples); the campaign proper is the
# curriculum in levels_curriculum.py.
LEGACY_SPECS: List[Dict[str, Any]] = [_enlarge(spec) for spec in _SMALL_SPECS]


def _wire(spec: Dict[str, Any], source_list: str, source_cell, targets) -> None:
    """Colour-code a button / lever (``source_cell``) with the obstacles it switches off (``targets``: (list, cell))."""
    kinds = {"plates": "plate", "levers": "lever", "lasers": "laser", "shocks": "shock", "cutters": "cutter", "spikes": "spikes", "lifts": "lift"}
    props = spec.setdefault("objectProperties", {})
    channel = 1 + max([int(p.get("channel", 0)) for p in props.values()] + [0])
    spec["objectProperties"][f"{kinds[source_list]}:{source_cell[0]}:{source_cell[1]}"] = {"channel": channel}
    for name, cell in targets:
        spec["objectProperties"][f"{kinds[name]}:{cell[0]}:{cell[1]}"] = {"channel": channel}


# Laser Lane: a gold button in the far corner switches the door-side laser off.
LEGACY_SPECS[2].setdefault("plates", []).append([13, 8])
LEGACY_SPECS[2]["hint"] += " The gold button in the far corner switches the door-side laser off."
_wire(LEGACY_SPECS[2], "plates", [13, 8], [("lasers", [8, 14])])
# The Real Exit: a pink lever tucked beside the coins powers down the three door shocks.
LEGACY_SPECS[5].setdefault("levers", []).append([4, 14])
LEGACY_SPECS[5]["hint"] += " The pink lever (E) powers down the shocks."
_wire(LEGACY_SPECS[5], "levers", [4, 14], [("shocks", [7, 15]), ("shocks", [8, 15]), ("shocks", [9, 15])])

# The campaign: an 11-level curriculum, one new element per level (see levels_curriculum.py).
CAMPAIGN_SPECS: List[Dict[str, Any]] = CURRICULUM_SPECS

# Fields whose cells can be stretched with ``objectProperties[kind:x:z] = {"w": n, "d": m}``.
RESIZABLE = (("walls", "wall"), ("platforms", "platform"), ("hazards", "hazard"), ("ice", "ice"), ("water", "water"))


def migrate_level(level: Dict[str, Any]) -> Dict[str, Any]:
    """Upgrade a Skyway-era level in place: ``movingLasers`` -> ``lasers``, old fixed lasers dropped,
    ``electricBarriers`` -> ``shocks``.  Idempotent."""
    old = level.pop("movingLasers", None)
    lasers = [list(e) for e in level.get("lasers", []) if len(e) >= 4]  # a 2-element entry is the removed fixed laser
    for e in old or []:
        axis = e[2] if len(e) > 2 and e[2] in ("x", "z") else "z"
        rng = float(e[3]) if len(e) > 3 else 2.0
        half = float(e[4]) if len(e) > 4 else 5
        lasers.append([e[0], e[1], axis, rng, half, "x" if axis == "z" else "z", 0.5, 1.0])
    level["lasers"] = lasers
    barriers = level.pop("electricBarriers", None)
    if barriers:
        level.setdefault("shocks", [])
        level["shocks"] += [[c[0], c[1], "down", 3, 3.0, 3.0] for c in barriers]
    for key in LIST_FIELDS:
        level.setdefault(key, [])
    legacy = int(level.get("size", GRID_SIZE))
    level["width"] = max(5, int(level.get("width", legacy)))
    level["depth"] = max(5, int(level.get("depth", legacy)))
    level["size"] = max(level["width"], level["depth"])
    if level.get("exitDoor"):
        level["exitDoor"] = snap_door_to_wall(level["exitDoor"], level["width"], level["depth"])
        level["goal"] = list(level["exitDoor"])
    level["version"] = 7
    return level


def expand_level(level: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy whose resizable objects are expanded to every cell they cover (``w`` x ``d`` footprints)."""
    props = level.get("objectProperties") or {}
    if not any(("w" in v or "d" in v) for v in props.values()):
        return level
    out = dict(level)
    new_props = dict(props)
    legacy = int(level.get("size", GRID_SIZE))
    size_x, size_z = int(level.get("width", legacy)), int(level.get("depth", legacy))
    for field, kind in RESIZABLE:
        seen = {(int(c[0]), int(c[1])) for c in level.get(field, [])}
        cells = [list(c) for c in level.get(field, [])]
        for c in level.get(field, []):
            p = props.get(f"{kind}:{c[0]}:{c[1]}") or {}
            w, d = max(1, int(p.get("w", 1))), max(1, int(p.get("d", 1)))
            for i in range(w):
                for j in range(d):
                    n = (int(c[0]) + i, int(c[1]) + j)
                    if (i or j) and n not in seen and 0 <= n[0] < size_x and 0 <= n[1] < size_z:
                        seen.add(n)
                        cells.append([n[0], n[1]])
                        new_props[f"{kind}:{n[0]}:{n[1]}"] = {k: v for k, v in p.items() if k not in ("w", "d")}
        out[field] = cells
    out["objectProperties"] = new_props
    return out


def make_level(index: int = 0, specs: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """Build campaign level ``index`` (or a moderately interesting generic level beyond the campaign)."""
    specs = CAMPAIGN_SPECS if specs is None else specs
    spec = specs[index] if 0 <= index < len(specs) else {}
    width = int(spec.get("width", GRID_SIZE))
    depth = int(spec.get("depth", GRID_SIZE))
    door = list(spec.get("exitDoor", [width // 2, depth - 1]))
    start = list(spec.get("start", [width // 2, 2]))
    base: Dict[str, Any] = {
        "version": 7, "name": f"Level {index + 1}", "hint": "",
        "exitDoor": door, "objectProperties": {}, "rotatorSpeed": 1.0,
        "start": start, "goal": list(door), "standalone": False, "width": width, "depth": depth, "size": max(width, depth),
    }
    for key in LIST_FIELDS:
        base[key] = []
    if spec:
        for key, value in spec.items():
            if key in ("width", "depth", "start", "exitDoor"):
                continue
            if key == "walls":
                base["walls"] = boundary_walls(door, width, depth) + [list(c) for c in value]
            elif key == "objectProperties":
                base[key] = {k: dict(v) for k, v in value.items()}
            elif isinstance(value, list):
                base[key] = [list(c) for c in value]
            else:
                base[key] = value
        if "walls" not in spec:
            base["walls"] = boundary_walls(door, width, depth)
        base["id"] = f"catlab-{index + 1}"
        return base
    # Generic extra level (used by the editor's "Add level"): a plate, a crate, a spinner and a few coins.
    base.update({
        "walls": boundary_walls(door, width, depth) + [[4, 6], [8, 6]],
        "plates": [[6, 4]], "coins": [[5, 3], [7, 3], [6, 6]],
        "rotators": [[6, 8]], "rotatorSpeed": 1.1, "shocks": [[6, 6, "down", 3, 3.0, 3.0]], "levers": [[2, 2]],
        "blocks": [[7, 4]] if index % 2 else [],
    })
    return base


_CELL_LISTS = tuple(f for f in LIST_FIELDS if f != "walls") + ("walls",)


def mirror_level(level: Dict[str, Any]) -> Dict[str, Any]:
    """Left-right mirror image of a level (x -> width - 1 - x).

    Used by the trainer as cheap data augmentation: the agent sees every room both ways round, so it learns
    "go round the wall", "jump the acid", ... rather than memorising which side things are on.  Everything that has a
    side is flipped consistently (cells, laser / cutter rails, shock directions, wiring keys, start and door).
    """
    level = migrate_level(copy.deepcopy(level))
    width = int(level["width"])
    flip = lambda x: width - 1 - int(x)  # noqa: E731
    out = dict(level)
    for field in _CELL_LISTS:
        out[field] = [[flip(c[0]), *c[1:]] for c in level.get(field, [])]
    out["shocks"] = [[flip(c[0]), c[1], {"xp": "xn", "xn": "xp"}.get(c[2], c[2]), *c[3:]] if len(c) > 2 else [flip(c[0]), *c[1:]]
                     for c in level.get("shocks", [])]
    out["start"] = [flip(level["start"][0]), level["start"][1]]
    out["exitDoor"] = [flip(level["exitDoor"][0]), level["exitDoor"][1]]
    out["goal"] = list(out["exitDoor"])
    props = {}
    for key, value in (level.get("objectProperties") or {}).items():
        parts = key.split(":")
        if len(parts) == 3 and parts[1].lstrip("-").isdigit():
            parts[1] = str(flip(parts[1]))
        props[":".join(parts)] = copy.deepcopy(value)
    out["objectProperties"] = props
    out["name"] = f"{level.get('name', 'Level')} (mirrored)"
    return out


def starter_campaign(count: Optional[int] = None) -> List[Dict[str, Any]]:
    """The curriculum campaign (first ``count`` levels)."""
    count = len(CAMPAIGN_SPECS) if count is None else count
    return [make_level(i) for i in range(min(count, len(CAMPAIGN_SPECS)))]


def legacy_campaign(count: Optional[int] = None) -> List[Dict[str, Any]]:
    """The original six 17 x 17 rooms (regression tests / examples)."""
    count = len(LEGACY_SPECS) if count is None else count
    return [make_level(i, LEGACY_SPECS) for i in range(min(count, len(LEGACY_SPECS)))]
