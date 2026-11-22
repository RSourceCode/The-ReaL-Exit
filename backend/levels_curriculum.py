"""The campaign, written as a *curriculum*: every level adds exactly one new idea to the ones before it.

Why: an agent (or a person) learns a hard room far faster when each ingredient has already been met on its own.
The rooms are deliberately small – short episodes make training fast – and the AI Lab unlocks them one after
another as the agent masters the previous one (see ``backend/rl/trainer.py``).

     1  First Steps     just walk to the open door
     2  Press the Button a wall to get around, a button that opens the door
     3  Ice & Pond       slide on ice, wade through water (both harmless)
     4  Acid Hop         acid you must jump over
     5  Spike Row        timed spikes: wait for a gap or jump
     6  Laser Lane       a sweeping laser: time it or jump it
     7  Shock Gate       three electric gates in a doorway: slip through when one is idle
     8  Saw & Spinner    a saw patrolling a gap, then a spinner at the door
     9  Crate Switch     push the crate onto the hold-button
    10  Lift Off         pull the lever, ride the lift, jump onto the tower and press its button
    11  Grand Exit       a longer room with turns that uses the lot

Every room is verified solvable by ``backend/tests/solver.py`` (see ``tests/test_rl.py``).
"""

from typing import Any, Dict, List

from backend.levels_long import Grid, ascii_level

TOWER = {"height": 2.0, "size": 0.95, "color": "#7fb6ff", "collision": True}


def _first_steps() -> Dict[str, Any]:
    g = Grid(9, 9)
    g.set(2, 1, "S").set(6, 8, "D")
    for x, z in ((3, 3), (4, 5), (5, 6)):
        g.set(x, z, "c")
    return ascii_level(
        "First Steps",
        "Walk to the glowing door and step through it. Pick up the coins on the way.",
        g.rows(), {"timeLimit": 25},
    )


def _press_the_button() -> Dict[str, Any]:
    g = Grid(11, 11)
    g.set(5, 1, "S").set(5, 10, "D")
    g.rect(1, 5, 7, 5, "#")                      # a wall to get around (the way round is on the right)
    g.set(2, 8, "p")                             # the button, off to the left
    for x, z in ((8, 3), (9, 6), (4, 8)):
        g.set(x, z, "c")
    return ascii_level(
        "Press the Button",
        "The door is locked. Go round the wall, step on the button, then head for the door.",
        g.rows(), {"timeLimit": 35},
    )


def _ice_and_pond() -> Dict[str, Any]:
    g = Grid(11, 13)
    g.set(5, 1, "S").set(5, 12, "D")
    g.rect(3, 3, 7, 4, "~")                      # a pond: harmless, just slow
    g.rect(1, 7, 9, 9, "I")                      # an icy floor: you keep sliding
    for x, z in ((5, 5), (2, 8), (8, 8), (5, 10)):
        g.set(x, z, "c")
    return ascii_level(
        "Ice & Pond",
        "Water only slows you down and ice makes you slide – neither is dangerous. Reach the door.",
        g.rows(), {"timeLimit": 35},
    )


def _acid_hop() -> Dict[str, Any]:
    g = Grid(11, 13)
    g.set(5, 1, "S").set(5, 12, "D")
    g.rect(1, 6, 9, 6, "A")                      # acid across the whole room: jump it
    for x, z in ((5, 3), (5, 9), (3, 10)):
        g.set(x, z, "c")
    return ascii_level(
        "Acid Hop",
        "Acid is deadly. It is one tile wide – face it and jump (Space) to land on the far side.",
        g.rows(), {"timeLimit": 35},
    )


def _spike_row() -> Dict[str, Any]:
    g = Grid(11, 13)
    g.set(5, 1, "S").set(5, 12, "D")
    g.rect(1, 6, 9, 6, "v")                      # timed spikes: they pop in and out
    for x, z in ((5, 3), (5, 9), (7, 10)):
        g.set(x, z, "c")
    return ascii_level(
        "Spike Row",
        "Spikes pop out of the floor in turns. Wait for a gap – or jump over them.",
        g.rows(), {"timeLimit": 40},
    )


def _laser_lane() -> Dict[str, Any]:
    g = Grid(11, 13)
    g.set(5, 1, "S").set(5, 12, "D")
    for x, z in ((3, 3), (7, 10), (5, 11)):
        g.set(x, z, "c")
    return ascii_level(
        "Laser Lane",
        "A laser sweeps back and forth across the room. Cross when it is far away, or jump over the beam.",
        g.rows(),
        {"lasers": [[5, 6, "z", 1.5, 5, "x", 0.5, 0.9]], "timeLimit": 40},
    )


def _shock_gate() -> Dict[str, Any]:
    g = Grid(11, 13)
    g.set(5, 1, "S").set(5, 12, "D")
    g.rect(1, 6, 3, 6, "#").rect(7, 6, 9, 6, "#")        # a doorway three tiles wide…
    for x, z in ((5, 3), (5, 9), (3, 10)):
        g.set(x, z, "c")
    return ascii_level(
        "Shock Gate",
        "Each shock charges (yellow) then strikes. Slip through the doorway while the one in your way is idle.",
        g.rows(),
        {"shocks": [[4, 6, "down", 3, 3.0, 3.0], [5, 6, "down", 3, 3.0, 3.0], [6, 6, "down", 3, 3.0, 3.0]], "timeLimit": 40},
    )


def _saw_and_spinner() -> Dict[str, Any]:
    g = Grid(13, 13)
    g.set(6, 1, "S").set(6, 12, "D")
    g.rect(1, 5, 4, 5, "#").rect(8, 5, 11, 5, "#")        # a gap with a saw patrolling it
    g.set(6, 9, "r")                                       # and a spinner on the way to the door
    for x, z in ((6, 3), (3, 8), (9, 8)):
        g.set(x, z, "c")
    return ascii_level(
        "Saw & Spinner",
        "Time your run past the patrolling saw, then slip by the spinning bar before the door.",
        g.rows(),
        {"cutters": [[6, 5, "x", 1.0, 0.5, 1.2]], "rotatorSpeed": 1.0, "timeLimit": 45},
    )


def _crate_switch() -> Dict[str, Any]:
    g = Grid(13, 13)
    g.set(6, 1, "S").set(6, 12, "D")
    # a one-tile corridor on the left: push the crate along it onto the hold-button at its end
    g.rect(1, 4, 6, 4, "#").rect(1, 2, 5, 2, "#").set(1, 3, "#")
    g.set(2, 3, "P").set(4, 3, "b")
    for x, z in ((9, 3), (6, 7), (9, 9)):
        g.set(x, z, "c")
    return ascii_level(
        "Crate Switch",
        "The hold-button only stays pressed while something sits on it. Push the crate along the corridor onto it.",
        g.rows(), {"timeLimit": 45},
    )


def _lift_off() -> Dict[str, Any]:
    g = Grid(13, 15)
    g.set(6, 1, "S").set(6, 14, "D")
    g.rect(1, 7, 4, 7, "#").rect(8, 7, 11, 7, "#")         # a wall with a three-tile gap…
    g.rect(5, 6, 5, 7, "A").rect(7, 6, 7, 7, "A")          # …full of acid, with a lift and a tower between
    g.set(6, 6, "u").set(6, 7, "Q").set(3, 3, "l")
    for x, z in ((9, 3), (9, 10), (3, 11)):
        g.set(x, z, "c")
    return ascii_level(
        "Lift Off",
        "Pull the lever (E) to power the lift. Ride it up, jump onto the tower and press the button on top.",
        g.rows(), {"objectProperties": {"platform:6:7": TOWER}, "timeLimit": 60},
    )


def _grand_exit() -> Dict[str, Any]:
    g = Grid(15, 19)
    g.set(2, 1, "S").set(7, 18, "D")
    g.rect(1, 5, 11, 5, "#").rect(3, 10, 13, 10, "#")      # two turns: the openings are on the right, then the left
    # lane 1: ice and a pond
    g.rect(4, 1, 8, 4, "I").rect(10, 2, 11, 3, "~")
    # lane 2: acid to hop, then the button
    g.rect(7, 6, 7, 9, "A").set(2, 8, "p")
    # lane 3: a laser patrol, then three shocks in the doorway
    g.rect(1, 15, 5, 15, "#").rect(9, 15, 13, 15, "#")
    for x, z in ((6, 3), (11, 7), (4, 12), (7, 17)):
        g.set(x, z, "c")
    return ascii_level(
        "Grand Exit",
        "Everything so far in one winding room: slide the ice, hop the acid, press the button, time the laser and the shocks.",
        g.rows(),
        {
            "lasers": [[7, 12, "z", 1.5, 6, "x", 0.5, 0.9]],
            "shocks": [[6, 15, "down", 3, 3.0, 3.0], [7, 15, "down", 3, 3.0, 3.0], [8, 15, "down", 3, 3.0, 3.0]],
            "timeLimit": 90,
        },
    )


CURRICULUM_SPECS: List[Dict[str, Any]] = [
    _first_steps(), _press_the_button(), _ice_and_pond(), _acid_hop(), _spike_row(), _laser_lane(),
    _shock_gate(), _saw_and_spinner(), _crate_switch(), _lift_off(), _grand_exit(),
]

if __name__ == "__main__":
    for spec in CURRICULUM_SPECS:
        print(spec["name"], spec["width"], "x", spec["depth"])
