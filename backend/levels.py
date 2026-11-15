"""Starter campaign (Python mirror of ``desktop/js/constants.js``).

Used by the headless trainer (``python -m backend.train_cli``) and the tests.  Keep the
level data in sync with ``makeLevel`` in ``constants.js``.
"""

from typing import Any, Dict, List

GRID_SIZE = 13
EXIT_DOOR = [6, GRID_SIZE - 1]


def boundary_walls(exit_door) -> List[List[int]]:
    edge = GRID_SIZE - 1
    cells = []
    for i in range(GRID_SIZE * 4 - 4):
        if i < GRID_SIZE:
            cell = [i, 0]
        elif i < GRID_SIZE * 2 - 1:
            cell = [edge, i - (GRID_SIZE - 1)]
        elif i < GRID_SIZE * 3 - 2:
            cell = [edge - (i - (GRID_SIZE * 2 - 2)), edge]
        else:
            cell = [0, edge - (i - (GRID_SIZE * 3 - 3))]
        if cell != list(exit_door):
            cells.append(cell)
    return cells


def _lava_line(z: int) -> List[List[int]]:
    return [[x, z] for x in range(1, GRID_SIZE - 1)]


# index -> spec for the four bonus rooms (levels 5-8)
BONUS_LEVELS = [
    {  # 5: one lava moat to jump, then a lone spinner
        "name": "Lava Line",
        "walls": [[3, 5], [9, 5]],
        "hazards": _lava_line(7),
        "plates": [[6, 4]],
        "coins": [[6, 5], [3, 9], [9, 9]],
        "rotators": [[6, 10]],
        "rotatorSpeed": 1.3,
    },
    {  # 6: two plates, spinner in the middle
        "name": "Twin Plates",
        "walls": [[3, 6], [9, 6]],
        "hazards": [],
        "plates": [[4, 4], [8, 4]],
        "coins": [[2, 4], [10, 4], [6, 6]],
        "rotators": [[6, 8]],
        "rotatorSpeed": 1.2,
    },
    {  # 7: lava moat then a spinner on each side of the corridor
        "name": "Moat Run",
        "walls": [[2, 5], [10, 5]],
        "hazards": _lava_line(6),
        "plates": [[6, 4]],
        "coins": [[3, 7], [9, 7], [6, 8]],
        "rotators": [[3, 9], [9, 9]],
        "rotatorSpeed": 1.6,
    },
    {  # 8: lava + three fast spinners guarding the exit
        "name": "Final Gauntlet",
        "walls": [[3, 5], [9, 5]],
        "hazards": _lava_line(6),
        "plates": [[6, 4]],
        "coins": [[2, 8], [10, 8], [6, 11]],
        "rotators": [[6, 9], [4, 10], [8, 10]],
        "rotatorSpeed": 1.9,
    },
]

ROTATOR_SETS = [
    [[6, 8]],
    [[4, 8], [8, 8]],
    [[4, 7], [8, 7], [6, 9]],
    [[4, 6], [8, 6], [4, 9], [8, 9]],
]
SIDE_WALLS = [
    [[4, 6], [8, 6]],
    [[3, 6], [9, 6], [6, 7]],
    [[3, 5], [9, 5], [3, 9], [9, 9]],
    [[3, 5], [9, 5], [3, 8], [9, 8], [6, 10]],
]
ROTATOR_SPEEDS = [1.0, 1.25, 1.55, 1.9]


def make_level(index: int = 0) -> Dict[str, Any]:
    """Build one starter level (identical to ``makeLevel`` in constants.js)."""
    base: Dict[str, Any] = {
        "version": 4,
        "name": f"Level {index + 1}",
        "blocks": [], "platforms": [], "stairs": [], "hazards": [], "switches": [],
        "painted": [], "coins": [], "springs": [], "portals": [], "checkpoints": [],
        "movers": [], "plates": [[6, 4]],
        "exitDoor": list(EXIT_DOOR), "objectProperties": {},
        "start": [6, 2], "goal": list(EXIT_DOOR), "standalone": False, "size": GRID_SIZE,
    }
    if 4 <= index < 4 + len(BONUS_LEVELS):
        spec = BONUS_LEVELS[index - 4]
        base.update({
            "name": spec["name"],
            "walls": boundary_walls(EXIT_DOOR) + [list(c) for c in spec["walls"]],
            "hazards": [list(c) for c in spec["hazards"]],
            "plates": [list(c) for c in spec["plates"]],
            "coins": [list(c) for c in spec["coins"]],
            "rotators": [list(c) for c in spec["rotators"]],
            "rotatorSpeed": spec["rotatorSpeed"],
        })
        return base
    k = index % 4
    base.update({
        "walls": boundary_walls(EXIT_DOOR) + [list(c) for c in SIDE_WALLS[k]],
        "rotators": [list(c) for c in ROTATOR_SETS[k]],
        "rotatorSpeed": ROTATOR_SPEEDS[k],
    })
    return base


def starter_campaign(count: int = 8) -> List[Dict[str, Any]]:
    return [make_level(i) for i in range(count)]
