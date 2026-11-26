"""The expert tier (levels 12-17): puzzles that need planning, not just reflexes.

Levels 1-11 teach one idea at a time.  These six combine them into things that have to be *worked out*:

    12  One Push       the crate is one push from the button - but the button sits in a nook that only opens on one side
    13  Box Hunt       the crate is hidden in a side chamber far from the button: find it, push it out and across the room
    14  Two Boxes      two buttons, two crates, a wall with a gap in the middle: both crates have to be steered through it
    15  Pillar Steps   the button is on top of a three-step pillar: consecutive jumps, each one higher
    16  Pillar Hop     the button is on a pillar in an acid lake: hop from pillar to pillar, up and then down again
    17  Grand Finale   a crate through spikes, a pillar button, and a laser at the door

All six (and their mirror images) are verified solvable by ``backend/tests/solver.py``.
"""

from typing import Any, Dict, List

from backend.levels_long import Grid, ascii_level


def _pillar(props: Dict[str, Any], x: int, z: int, height: float) -> None:
    """A climbable pillar of the given height (its top is ~0.12 above)."""
    shade = ["#8fb8ff", "#7aa6f5", "#6592e8", "#5a84d8"][min(3, int(height / 0.85))]
    props[f"platform:{x}:{z}"] = {"height": height, "size": 0.95, "color": shade, "collision": True}


def _one_push() -> Dict[str, Any]:
    g = Grid(11, 13)
    g.set(5, 1, "S").set(5, 12, "D")
    g.rect(1, 4, 7, 4, "#")                                   # a wall: the way on is round its right-hand end
    g.set(3, 7, "P").set(4, 7, "b")                           # the crate is ONE push from the button…
    g.set(3, 6, "#").set(3, 8, "#").set(2, 7, "#")            # …which sits in a nook that is only open on the crate's side
    for x, z in ((9, 3), (8, 10), (6, 9)):
        g.set(x, z, "c")
    return ascii_level(
        "One Push",
        "The hold-button stays pressed only while something sits on it. The crate is a single push away – you just have to get behind it.",
        g.rows(), {"timeLimit": 40},
    )


def _box_hunt() -> Dict[str, Any]:
    g = Grid(13, 15)
    g.set(6, 1, "S").set(6, 14, "D")
    g.set(2, 12, "P").set(1, 12, "#").set(3, 12, "#").set(2, 13, "#")       # the button, in a nook at the top left
    # the crate is out of sight in a side chamber at the bottom right
    for z in (1, 2, 4, 5, 6):
        g.set(9, z, "#")
    g.set(10, 6, "#").set(11, 6, "#")
    g.set(10, 2, "b")                                                        # (it must be nudged north first, then west through the gap)
    g.rect(4, 8, 8, 8, "#")                                                  # something to walk round on the way
    for x, z in ((6, 4), (11, 10), (5, 11), (8, 12)):
        g.set(x, z, "c")
    return ascii_level(
        "Box Hunt",
        "The button needs a crate on it – and the crate is nowhere near. Find it, get it out of its chamber, and push it all the way across.",
        g.rows(), {"timeLimit": 80},
    )


def _two_boxes() -> Dict[str, Any]:
    g = Grid(13, 15)
    g.set(6, 1, "S").set(6, 14, "D")
    g.rect(1, 6, 4, 6, "#").rect(8, 6, 11, 6, "#")                           # a wall with a gap in the middle
    g.set(3, 10, "P").set(2, 10, "#")                                        # two buttons, each with a stop-wall behind it
    g.set(9, 10, "P").set(10, 10, "#")
    g.set(3, 3, "b").set(10, 2, "b")
    for x, z in ((6, 4), (6, 8), (6, 12), (1, 12), (11, 12)):
        g.set(x, z, "c")
    return ascii_level(
        "Two Boxes",
        "Two buttons, two crates, one gap in the wall: steer each crate through it and across to its button.",
        g.rows(), {"timeLimit": 110},
    )


def _pillar_steps() -> Dict[str, Any]:
    g = Grid(11, 15)
    g.set(5, 1, "S").set(5, 14, "D")
    g.rect(1, 5, 7, 5, "#")                                                  # a wall to go round first
    props: Dict[str, Any] = {}
    # the pillar: three steps, each higher than the last, in a corridor so there is no way round
    g.set(5, 9, "L").set(4, 9, "L").set(3, 9, "Q")
    _pillar(props, 5, 9, 0.8); _pillar(props, 4, 9, 1.6); _pillar(props, 3, 9, 2.4)
    for cell in ((5, 8), (4, 8), (3, 8), (5, 10), (4, 10), (3, 10), (2, 9)):
        g.set(*cell, "#")
    for x, z in ((9, 3), (8, 11), (6, 12)):
        g.set(x, z, "c")
    return ascii_level(
        "Pillar Steps",
        "The button is on top of a pillar built like a staircase. Jump onto the first step, then the next, then the next – each one is higher.",
        g.rows(), {"objectProperties": props, "timeLimit": 50},
    )


def _pillar_hop() -> Dict[str, Any]:
    g = Grid(13, 17)
    g.set(6, 1, "S").set(6, 16, "D")
    g.rect(1, 5, 11, 13, "A")                                                # an acid lake across the whole room…
    props: Dict[str, Any] = {}
    for z, h, ch in ((5, 0.8, "L"), (7, 1.6, "L"), (9, 2.4, "Q"), (11, 1.6, "L"), (13, 0.8, "L")):
        g.set(6, z, ch)                                                      # …with pillars to hop between: up, the button, down
        _pillar(props, 6, z, h)
    for x, z in ((4, 3), (8, 3), (4, 15), (8, 15)):
        g.set(x, z, "c")
    return ascii_level(
        "Pillar Hop",
        "An acid lake, and the button on a pillar in the middle of it. Hop from pillar to pillar – up to the button, then down the other side.",
        g.rows(), {"objectProperties": props, "timeLimit": 60},
    )


def _grand_finale() -> Dict[str, Any]:
    g = Grid(15, 23)
    g.set(2, 1, "S").set(12, 22, "D")
    g.rect(1, 5, 11, 5, "#").rect(3, 12, 13, 12, "#").rect(1, 18, 11, 18, "#")      # four lanes: east, west, east, west-ish
    props: Dict[str, Any] = {}
    # lane 1: timed spikes
    g.rect(7, 1, 7, 4, "v")
    # lane 2 (heading west): a crate to carry to the hold-button, through a column of timed spikes
    g.set(12, 8, "b").set(3, 8, "P").set(2, 8, "#")
    g.rect(8, 6, 8, 10, "v")
    # lane 3 (heading east): a pillar staircase with the second button on top
    g.set(11, 15, "L").set(12, 15, "L").set(13, 15, "Q")
    _pillar(props, 11, 15, 0.8); _pillar(props, 12, 15, 1.6); _pillar(props, 13, 15, 2.4)
    for cell in ((11, 14), (12, 14), (13, 14), (11, 16), (12, 16), (13, 16)):
        g.set(*cell, "#")
    for x, z in ((4, 3), (10, 3), (5, 10), (5, 14), (7, 16), (4, 20), (10, 20)):
        g.set(x, z, "c")
    return ascii_level(
        "Grand Finale",
        "A crate to carry through the spikes, a pillar to climb, and a laser guarding the door. Both buttons must be pressed.",
        g.rows(),
        {"lasers": [[11, 20, "x", 2.0, 1, "z", 0.5, 1.0]], "objectProperties": props, "timeLimit": 150},
    )


EXPERT_SPECS: List[Dict[str, Any]] = [_one_push(), _box_hunt(), _two_boxes(), _pillar_steps(), _pillar_hop(), _grand_finale()]

if __name__ == "__main__":
    for spec in EXPERT_SPECS:
        print(spec["name"], spec["width"], "x", spec["depth"])
