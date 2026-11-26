"""Headless grid simulation environment for The-ReaL-Exit reinforcement learning.

Simulates movement, grid collisions, hazards, rotators, movers, pressure plates, doors
and coins using the same level specifications as the 3D runtime and the editor.

Skyway update (mirrors ``desktop/js``):

* **Heights.**  Ledges / low walls (``platforms``) and lifts have a top surface.  Deeba can *walk*
  onto a cell at most ``STEP_MAX`` higher than where she stands and *jump* onto one at most
  ``JUMP_REACH`` higher; she can always drop down.  Plates, coins and boosts can sit on top of ledges.
* **Lifts.**  ``lifts`` rest flush with the floor until the power lever is pulled, then rise and
  fall on a fixed schedule (``lift_top``).  A tall tower is only reachable from a raised lift.
* **CatLab hazards.**  ``lasers`` sweep along any axis (x, y or z) and extend along any axis; ``shocks`` strike
  from one direction for a configurable length on a charge / strike cycle; ``cutters`` glide along a rail;
  ``spikes`` pop out of the floor; ``hazards`` is acid and ``water`` is a harmless (slightly slow) wade.
  Every dynamic hazard is a pure function of the world clock (see ``hazard_cells``), so it is part of the
  time-resolved danger layers and the level solver stays exact.  ``w`` / ``d`` footprints (see
  ``levels.expand_level``) stretch walls, ledges, acid, ice and water over several cells.

What makes this environment *learnable* (compared with a raw 7x7 view):

* ``observe()`` returns an egocentric 9x9 window with **time-resolved rotator danger**
  layers (which cells will be swept by a bar during each of the next 4 actions).
* A cached **shortest-path distance field** to the current objective (plate, then exit)
  provides a compass (is each neighbour closer?) and a potential-based shaping reward.
* Training can start every episode on a **random level** with a **random rotator phase**.
"""

import heapq
import math
from collections import deque
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np

from backend.levels import expand_level, migrate_level
from backend.config import (
    ACTIONS,
    DANGER_HORIZON,
    DEFAULT_REWARDS,
    LEVEL_TIME_LIMIT_SECONDS,
    LOCAL_VIEW_CHANNELS,
    LOCAL_VIEW_RADIUS,
    LOCAL_VIEW_SIZE,
    LOCAL_VIEW_WIDTH,
    MAX_TRACKED,
    OBSERVATION_SIZE,
    PLAYER_JUMP_DURATION_SECONDS,
    PLAYER_JUMP_IMPULSE,
    RL_ACTION_DURATION_SECONDS,
    STATIC_CHANNELS,
    WORLD_GRAVITY,
)

Cell = Tuple[int, int]


def key_of(cell) -> str:
    """Serialize a coordinate tuple to a comma-separated key."""
    return f"{cell[0]},{cell[1]}"


def clamp(value: float, min_val: float, max_val: float) -> float:
    """Clamp a numerical value between min_val and max_val."""
    return max(min_val, min(max_val, value))


# Direction vectors indexed by heading (0=+Z, 1=+X, 2=-Z, 3=-X)
_DIRS = [(0, 1), (1, 0), (0, -1), (-1, 0)]
# Skyway constants – keep identical to desktop/js/constants.js
LIFT_OMEGA = 1.1            # rad/s of a lift's up/down cycle
LIFT_REST = 0.04            # top surface of a resting lift (flush with the floor)
LIFT_DEFAULT_HEIGHT = 1.2
LASER_OMEGA = 0.9           # rad/s of a moving laser's sweep
PLATFORM_DEFAULT_HEIGHT = 1.0
PLATFORM_TOP_PAD = 0.12     # platform top = height + pad (matches the 3D collider)
WALL_TOP_PAD = 0.09
CLIMBABLE_WALL_HEIGHT = 1.25  # inner walls up to this height count as low walls (ledges)
STEP_MAX = 0.3              # highest step that can simply be walked up
JUMP_REACH = 1.5            # highest surface a standing jump can reach
MAX_HEIGHT = 3.2            # observation normaliser (pillars are up to ~2.5 m high)
ROTATOR_HALF_LENGTH = 1.04
ROTATOR_HALF_THICKNESS = 0.16
PLAYER_CENTER_Y = 0.42
PLAYER_HALF = 0.37
_LIMIT_X = ROTATOR_HALF_LENGTH + PLAYER_HALF
_LIMIT_Z = ROTATOR_HALF_THICKNESS + PLAYER_HALF
JUMP_COST = 4.0
CLIMB_COST = 3.0
PLAYER_HEIGHT = 1.0          # capsule height (feet -> head)
BEAM_BELOW = 0.15           # a beam this far under the feet still clips Deeba's boots
SHOCK_DIRS = ("down", "up", "xp", "xn", "zp", "zn")
SHOCK_STAGGER = 0.9         # seconds of phase offset per shock index
SHOCK_STRIKE_AT = 0.7       # cycle fraction where the strike starts (0.45..0.7 is the visible charge-up)
CUTTER_OMEGA = 1.3
CUTTER_REACH_PAD = 0.3
CUTTER_HEIGHT_FACTOR = 1.8  # blade is 2r tall; a jump clears 1.8r
SPIKE_STAGGER = 0.7
SPIKE_UP_FRACTION = 0.55
SPIKE_SAFE_HEIGHT = 0.45
LASER_SAFE_HEIGHT = 0.9     # standing this high above the floor is clear of a laser beam
INF = 1.0e9
PAD = LOCAL_VIEW_RADIUS

# Static channel indices
(CH_WALL, CH_BLOCK, CH_HAZARD, CH_MOVER, CH_PLATFORM, CH_COIN, CH_PLATE, CH_DOOR_CLOSED, CH_DOOR_OPEN,
 CH_SWITCH, CH_HEIGHT, CH_HEIGHT_NEXT, CH_RAIL) = range(13)
assert STATIC_CHANNELS == 13


def _round_cell(value: float) -> int:
    """Round a continuous grid coordinate to the cell the 3D scene would show it in."""
    return int(math.floor(value + 0.5))


def _build_offsets():
    """Per-heading (dx, dz) offsets for the egocentric window (row 0 = furthest ahead)."""
    width = LOCAL_VIEW_WIDTH
    dx = np.zeros((4, width, width), dtype=np.int64)
    dz = np.zeros((4, width, width), dtype=np.int64)
    for h, (fx, fz) in enumerate(_DIRS):
        lx, lz = -fz, fx
        for r, local_forward in enumerate(range(LOCAL_VIEW_RADIUS, -LOCAL_VIEW_RADIUS - 1, -1)):
            for c, local_left in enumerate(range(-LOCAL_VIEW_RADIUS, LOCAL_VIEW_RADIUS + 1)):
                dx[h, r, c] = fx * local_forward + lx * local_left
                dz[h, r, c] = fz * local_forward + lz * local_left
    return dx, dz


_DX, _DZ = _build_offsets()
_SCALAR_START = LOCAL_VIEW_SIZE
_FOOTPRINT_CACHE: Dict[str, Dict[str, Set[Any]]] = {}
# Inverse of the window tables: for each heading, (dx, dz) offset from the player -> flat index in the 9x9 view.
_OFFSET_INDEX = [
    {(int(_DX[h].flat[n]), int(_DZ[h].flat[n])): n for n in range(LOCAL_VIEW_WIDTH * LOCAL_VIEW_WIDTH)}
    for h in range(4)
]


class WorldEnvironment:
    """Headless 2D grid simulation driven by level JSON dictionaries."""

    def __init__(self, levels: List[Dict[str, Any]] | Dict[str, Any], options: Optional[Dict[str, Any]] = None):
        raw_levels = levels if isinstance(levels, list) else [levels]
        self.levels = [lvl for lvl in raw_levels if lvl]
        if not self.levels:
            raise ValueError("Select at least one saved level for training.")

        opts = options or {}
        self.seed = int(opts.get("seed", 1))
        custom_rewards = opts.get("rewards") or {}
        self.rewards = {k: float(custom_rewards.get(k, DEFAULT_REWARDS[k])) for k in DEFAULT_REWARDS}
        self.random_state = (self.seed * 2654435761 + 12345) & 0xFFFFFFFF
        for _ in range(4):
            self.random()
        # Training helpers: begin on a random level and with a random rotator phase.
        self.random_start_level = bool(opts.get("randomStartLevel", False))
        self.random_phase = bool(opts.get("randomPhase", True))

        # Tracking variables
        self.level_index = 0
        self.episode_complete = False
        self.episode_steps = 0
        self.simulation_steps = 0.0
        self.collision_count = 0
        self.death_count = 0
        self.total_coins = 0
        self.total_plates = 0
        self.level_changes = 0

        # Level state
        self.level: Dict[str, Any] = {}
        self.level_steps = 0.0
        self.time_limit_steps = 1
        self.size = 13          # longest side (used only to normalise the compass)
        self.size_x = 13
        self.size_z = 13
        self.position = [0, 0]
        self.heading = 0
        self.walls: Set[Cell] = set()
        self.blocks: Set[Cell] = set()
        self.block_cells: List[Cell] = []
        self.hazards: Set[Cell] = set()
        self.water: Set[Cell] = set()
        self.lasers: List[Tuple[int, int, str, float, float, str, float, float]] = []
        self.shocks: List[Tuple[int, int, str, float, float, float]] = []
        self.cutters: List[Tuple[int, int, str, float, float, float]] = []
        self.spikes: List[Tuple[int, int, float]] = []
        self._hazard_cache: Dict[Any, Dict[Cell, List[str]]] = {}
        self.ice: Set[Cell] = set()
        self.ice_momentum: Optional[Cell] = None
        self.powerups: List[Tuple[int, int, str]] = []
        self.powerup_mask = 0
        self.powerup_type: Optional[str] = None
        self.powerup_until = 0.0
        self.levers: Set[Cell] = set()
        self.lever_on = False
        self.rotator_cells: List[List[int]] = []
        self.rotators: Set[Cell] = set()
        self.movers: Set[Cell] = set()
        self.plates: List[List[int]] = []
        self.continuous_plates: Set[Cell] = set()
        self.plate_mask = 0
        self.coins: List[List[int]] = []
        self.coin_mask = 0
        self.switches: List[List[int]] = []
        self._switch_keys: Set[Cell] = set()
        self.switch_on = False
        self.exit_door: List[int] = [0, 0]
        self._exit_door_key: Cell = (0, 0)
        self.doors_open = False
        self.stairs: Set[Cell] = set()
        self.platforms: Set[Cell] = set()
        # Skyway state
        self.static_height: Dict[Cell, float] = {}       # ledges + climbable walls -> top surface
        self.lifts: List[Tuple[int, int, float]] = []    # (x, z, max top)
        self.lift_index: Dict[Cell, int] = {}
        self.climbed: Set[Cell] = set()
        self.lever_rewarded = False

        self._coin_key_to_idx: Dict[Cell, int] = {}
        self._powerup_key_to_idx: Dict[Cell, int] = {}
        self._plate_key_to_idx: Dict[Cell, int] = {}

        # Rotator constants (numpy) – rebuilt per level
        self._rot_x = np.zeros(0)
        self._rot_z = np.zeros(0)
        self._rot_dir = np.zeros(0)
        self._rot_speed = 1.1

        # Static observation tensor and objective distance field
        self._static = np.zeros((STATIC_CHANNELS, 1, 1), dtype=np.float32)
        self._dist: List[float] = []
        self._dist_np = np.zeros((1, 1))
        self._targets: List[Cell] = []
        self._crates_solid = False      # while planning a crate push the crates themselves are obstacles for the walker
        self._crate_left: Optional[int] = None   # pushes still needed by the current crate plan (None = no plan)
        self._crate_total = 0                    # pushes still needed over *all* unfinished hold-buttons
        self._crate_holds = 0                    # how many hold-buttons still need a crate
        self._crate_stand: Optional[Cell] = None # the cell to push from, while a crate plan is active
        self._at_stand = False
        self._plates_remaining = 0
        self._lever_needed = False
        self._obs = np.zeros(OBSERVATION_SIZE, dtype=np.float32)

        self.reset()

    # ── RNG ────────────────────────────────────────────────────────────────────────────
    def random(self) -> float:
        """Linear congruential generator for deterministic simulation."""
        self.random_state = (1664525 * self.random_state + 1013904223) & 0xFFFFFFFF
        return self.random_state / 0x100000000

    # ── Reset / level loading ──────────────────────────────────────────────────────────
    def reset(self, level_index: Optional[int] = None) -> np.ndarray:
        """Reset the environment (to level 0, a given level, or a random level)."""
        if level_index is None:
            level_index = int(self.random() * len(self.levels)) if self.random_start_level else 0
        level_index = max(0, min(len(self.levels) - 1, int(level_index)))
        self.level_index = level_index
        self.episode_complete = False
        self.episode_steps = 0
        # The 3D game's rotators run on the wall clock, so the phase at level start is arbitrary.
        self.simulation_steps = self.random() * 40.0 if self.random_phase else 0.0
        self.collision_count = 0
        self.death_count = 0
        self.total_coins = 0
        self.total_plates = 0
        self.level_changes = 0
        self._load_level(self.levels[level_index])
        return self.observe().copy()

    def _load_level(self, level: Dict[str, Any]) -> None:
        """Load and parse level geometry, hazards, and interactive targets."""
        level = migrate_level(level)
        self.level = level
        raw_level, level = level, expand_level(level)
        self.level = raw_level
        self._hazard_cache = {}
        self.level_steps = 0.0
        self.time_limit_steps = math.ceil(float(level.get("timeLimit", LEVEL_TIME_LIMIT_SECONDS)) / RL_ACTION_DURATION_SECONDS)
        legacy = int(level.get("size", 13))
        self.size_x = max(5, int(level.get("width", legacy)))
        self.size_z = max(5, int(level.get("depth", legacy)))
        self.size = max(self.size_x, self.size_z)
        start_cell = level.get("start") or [self.size_x // 2, 1]
        self.position = [int(start_cell[0]), int(start_cell[1])]
        self.heading = 0

        self.walls = {(int(c[0]), int(c[1])) for c in level.get("walls", [])}
        self.blocks = {(int(c[0]), int(c[1])) for c in level.get("blocks", [])}
        self.block_cells = [(int(c[0]), int(c[1])) for c in level.get("blocks", [])]
        self.hazards = {(int(c[0]), int(c[1])) for c in level.get("hazards", [])}
        self.water = {(int(c[0]), int(c[1])) for c in level.get("water", [])}
        self.ice = {(int(c[0]), int(c[1])) for c in level.get("ice", [])}
        self.ice_momentum = None
        self.powerups = [(int(c[0]), int(c[1]), str(c[2]) if len(c) > 2 else "speed") for c in level.get("powerups", [])[:MAX_TRACKED]]
        self.powerup_mask = 0
        self.powerup_type = None
        self.powerup_until = 0.0
        self.rotator_cells = [[int(c[0]), int(c[1])] for c in level.get("rotators", [])]
        self.rotators = {(c[0], c[1]) for c in self.rotator_cells}
        self.movers = {(int(c[0]), int(c[1])) for c in level.get("movers", [])}
        self.plates = [[int(c[0]), int(c[1])] for c in level.get("plates", [])[:MAX_TRACKED]]
        self.continuous_plates = {(int(c[0]), int(c[1])) for c in level.get("continuousPlates", [])}
        self.plate_mask = 0
        self._plate_paid: Set[int] = set()
        self._door_paid = False
        self.coins = [[int(c[0]), int(c[1])] for c in level.get("coins", [])[:MAX_TRACKED]]
        self.coin_mask = 0
        self.switches = [[int(c[0]), int(c[1])] for c in level.get("switches", [])]
        self.levers = {(int(c[0]), int(c[1])) for c in level.get("levers", [])}
        self._switch_keys = {(s[0], s[1]) for s in self.switches} | self.levers
        self.switch_on = False
        self.lever_on = False
        self.lever_rewarded = False
        self.climbed = set()

        door = level.get("exitDoor") or level.get("goal") or [self.size_x // 2, self.size_z - 1]
        self.exit_door = [int(door[0]), int(door[1])]
        self._exit_door_key = (self.exit_door[0], self.exit_door[1])
        self.doors_open = True  # recomputed in _load_channels
        self.stairs = {(int(c[0]), int(c[1])) for c in level.get("stairs", [])}
        self.platforms = {(int(c[0]), int(c[1])) for c in level.get("platforms", [])}

        self._load_skyway(level)
        self._load_channels(level)

        self._coin_key_to_idx = {(c[0], c[1]): i for i, c in enumerate(self.coins)}
        self._powerup_key_to_idx = {(p[0], p[1]): i for i, p in enumerate(self.powerups)}
        self._plate_key_to_idx = {(p[0], p[1]): i for i, p in enumerate(self.plates)}

        # Rotator constants
        self._rot_speed = float(level.get("rotatorSpeed", 1.1))
        if self.rotator_cells:
            self._rot_x = np.array([c[0] for c in self.rotator_cells], dtype=np.float64)
            self._rot_z = np.array([c[1] for c in self.rotator_cells], dtype=np.float64)
            self._rot_dir = np.array([-1.0 if i % 2 else 1.0 for i in range(len(self.rotator_cells))])
        else:
            self._rot_x = self._rot_z = self._rot_dir = np.zeros(0)

        self._build_static()
        self._refresh_objective()

    # ── Skyway: heights, lifts, moving lasers ──────────────────────────────────────────
    def _load_skyway(self, level: Dict[str, Any]) -> None:
        props = level.get("objectProperties") or {}
        self.static_height = {}
        for c in level.get("platforms", []):
            cell = (int(c[0]), int(c[1]))
            h = float((props.get(f"platform:{cell[0]}:{cell[1]}") or {}).get("height", PLATFORM_DEFAULT_HEIGHT))
            self.static_height[cell] = h + PLATFORM_TOP_PAD
        for cell in list(self.walls):
            if cell[0] in (0, self.size_x - 1) or cell[1] in (0, self.size_z - 1):
                continue  # the outer fence is never climbable
            p = props.get(f"wall:{cell[0]}:{cell[1]}") or {}
            h = float(p.get("height", 1.9))
            if p.get("collision", True) is not False and h <= CLIMBABLE_WALL_HEIGHT:
                self.static_height[cell] = h + WALL_TOP_PAD
                self.walls.discard(cell)  # a low wall is a surface, not a barrier
        self.platforms = set(self.static_height)
        self.lifts = []
        for c in level.get("lifts", []):
            height = float(c[2]) if len(c) > 2 else LIFT_DEFAULT_HEIGHT
            self.lifts.append((int(c[0]), int(c[1]), height))
        self.lift_index = {(x, z): i for i, (x, z, _h) in enumerate(self.lifts)}
        self.lasers = []
        for c in level.get("lasers", []):
            sweep = str(c[2]) if len(c) > 2 and str(c[2]) in ("x", "y", "z") else "z"
            beam = str(c[5]) if len(c) > 5 and str(c[5]) in ("x", "y", "z") else ("x" if sweep != "x" else "z")
            if beam == sweep:
                beam = "x" if sweep != "x" else "z"
            self.lasers.append((int(c[0]), int(c[1]), sweep, float(c[3]) if len(c) > 3 else 2.0,
                                float(c[4]) if len(c) > 4 else 5.0, beam, float(c[6]) if len(c) > 6 else 0.5,
                                float(c[7]) if len(c) > 7 else 1.0))
        self.shocks = []
        for c in level.get("shocks", []):
            d = str(c[2]) if len(c) > 2 and str(c[2]) in SHOCK_DIRS else "down"
            self.shocks.append((int(c[0]), int(c[1]), d, float(c[3]) if len(c) > 3 else 3.0,
                                max(1.0, float(c[4])) if len(c) > 4 else 3.0,
                                float(c[5]) if len(c) > 5 else (0.5 if d not in ("down", "up") else (3.0 if d == "down" else 0.0))))
        self.cutters = []
        for c in level.get("cutters", []):
            self.cutters.append((int(c[0]), int(c[1]), "z" if len(c) > 2 and c[2] == "z" else "x",
                                 float(c[3]) if len(c) > 3 else 2.0, float(c[4]) if len(c) > 4 else 0.5,
                                 float(c[5]) if len(c) > 5 else 1.0))
        self.spikes = [(int(c[0]), int(c[1]), float(c[2]) if len(c) > 2 else 0.0) for c in level.get("spikes", [])]

    # ── Colour-coded wiring (mirrors desktop/js/constants.js CHANNELS) ───────────────────────────────
    def _load_channels(self, level: Dict[str, Any]) -> None:
        """Channel 0 = legacy (plates open the exit gate, levers power channel-0 lifts).  Channels 1-6: a pressed plate
        or a pulled lever switches off every obstacle / powers every lift that carries the same channel."""
        props = level.get("objectProperties") or {}

        def ch(kind: str, x: int, z: int) -> int:
            return max(0, min(6, int((props.get(f"{kind}:{x}:{z}") or {}).get("channel", 0) or 0)))

        self.plate_ch = [ch("plate", p[0], p[1]) for p in self.plates]
        self.lever_ch = {c: ch("lever", c[0], c[1]) for c in self.levers}
        self.lever_state = {c: False for c in self.levers}
        self.lift_ch = [ch("lift", int(c[0]), int(c[1])) for c in level.get("lifts", [])][:len(self.lifts)]
        self.lift_ch += [0] * (len(self.lifts) - len(self.lift_ch))
        self.laser_ch = [ch("laser", int(c[0]), int(c[1])) for c in level.get("lasers", [])]
        self.shock_ch = [ch("shock", int(c[0]), int(c[1])) for c in level.get("shocks", [])]
        self.cutter_ch = [ch("cutter", int(c[0]), int(c[1])) for c in level.get("cutters", [])]
        self.spike_ch = [ch("spikes", int(c[0]), int(c[1])) for c in level.get("spikes", [])]
        self.door_plate_mask = sum(1 << i for i, c in enumerate(self.plate_ch) if c == 0)
        self.channels_on: Set[int] = set()
        self._ch_sig = 0
        self.lever_on = False
        self.doors_open = self.door_plate_mask == 0

    def _recompute_channels(self) -> None:
        on: Set[int] = set()
        for i, c in enumerate(self.plate_ch):
            if c and (self.plate_mask & (1 << i)):
                on.add(c)
        for cell, c in self.lever_ch.items():
            if c and self.lever_state.get(cell):
                on.add(c)
        self.channels_on = on
        self._ch_sig = sum(1 << c for c in on)
        self.lever_on = any(self.lever_state.get(cell) for cell, c in self.lever_ch.items() if c == 0)

    def lift_powered(self, index: int) -> bool:
        c = self.lift_ch[index] if index < len(self.lift_ch) else 0
        return self.lever_on if c == 0 else c in self.channels_on

    def _off(self, kind_list: List[int], i: int) -> bool:
        return i < len(kind_list) and kind_list[i] in self.channels_on and kind_list[i] != 0

    def lift_top(self, index: int, time_seconds: float) -> float:
        """Top surface of lift ``index`` (rests flush until its lever is pulled)."""
        if not self.lift_powered(index):
            return LIFT_REST
        high = self.lifts[index][2]
        wave = 0.5 - 0.5 * math.cos(LIFT_OMEGA * time_seconds + 1.3 * index)
        return LIFT_REST + (high - LIFT_REST) * wave

    def cell_height(self, cell: Cell, time_seconds: float) -> float:
        """Walkable surface height of a cell at ``time_seconds`` (0 for plain floor)."""
        h = self.static_height.get(cell, 0.0)
        i = self.lift_index.get(cell)
        if i is not None:
            h = max(h, self.lift_top(i, time_seconds))
        return h

    # ── CatLab hazards: pure functions of the world clock (mirrored in desktop/js/constants.js) ──────
    def laser_offset(self, index: int, time_seconds: float) -> float:
        """Signed sweep offset of laser ``index`` (cells, or world units when it sweeps along y)."""
        c = self.lasers[index]
        return c[3] * math.sin(LASER_OMEGA * c[7] * time_seconds + 1.9 * index)

    def shock_phase(self, index: int, time_seconds: float) -> float:
        """0..1 position inside shock ``index``'s cycle: idle < 0.45 <= charging < 0.7 <= striking."""
        period = self.shocks[index][4]
        return ((time_seconds + SHOCK_STAGGER * index) % period) / period

    def cutter_position(self, index: int, time_seconds: float) -> Tuple[float, float]:
        cx, cz, axis, rng, _r, speed = self.cutters[index]
        off = rng * math.sin(CUTTER_OMEGA * speed * time_seconds + 1.1 * index)
        return (cx + off, float(cz)) if axis == "x" else (float(cx), cz + off)

    def spike_up(self, index: int, time_seconds: float) -> bool:
        period = self.spikes[index][2]
        return period <= 0 or ((time_seconds + SPIKE_STAGGER * index) % period) < SPIKE_UP_FRACTION * period

    def _lasers_frozen(self, time_seconds: float) -> bool:
        return self.powerup_type == "freeze" and self.powerup_until > time_seconds

    def hazard_cells(self, time_seconds: float) -> Dict[Cell, List[str]]:
        """Every cell that kills a *standing* Deeba at ``time_seconds`` -> hazard kind (feet height is applied by
        :meth:`dynamic_hit`).  Cached per (time, lever) because lifts do not matter at this level."""
        key = (round(time_seconds, 4), self._ch_sig)
        hit = self._hazard_cache.get(key)
        if hit is not None:
            return hit
        out: Dict[Cell, List[str]] = {}
        sx, sz = self.size_x, self.size_z

        def add(cell, kind):
            if 0 <= cell[0] < sx and 0 <= cell[1] < sz and kind not in out.get(cell, ()):
                out.setdefault(cell, []).append(kind)

        for i, (cx, cz, sweep, _rng, half, beam, _y, _sp) in enumerate(self.lasers):
            if self._off(self.laser_ch, i):
                continue
            off = self.laser_offset(i, time_seconds)
            px, pz = (cx + off if sweep == "x" else cx), (cz + off if sweep == "z" else cz)
            if beam == "x":
                for x in range(math.ceil(px - half), math.floor(px + half) + 1):
                    add((x, _round_cell(pz)), "laser")
            elif beam == "z":
                for z in range(math.ceil(pz - half), math.floor(pz + half) + 1):
                    add((_round_cell(px), z), "laser")
            else:
                add((_round_cell(px), _round_cell(pz)), "laser")
        for i, (x, z, d, length, _p, _y) in enumerate(self.shocks):
            if self._off(self.shock_ch, i) or self.shock_phase(i, time_seconds) < SHOCK_STRIKE_AT:
                continue
            n = max(0, int(round(length)))
            if d in ("down", "up"):
                add((x, z), "shock")
            else:
                dx, dz = {"xp": (1, 0), "xn": (-1, 0), "zp": (0, 1), "zn": (0, -1)}[d]
                for k in range(0, n + 1):
                    add((x + dx * k, z + dz * k), "shock")
        for i, (_x, _z, _a, _r, radius, _s) in enumerate(self.cutters):
            if self._off(self.cutter_ch, i):
                continue
            px, pz = self.cutter_position(i, time_seconds)
            reach = radius + CUTTER_REACH_PAD
            for x in range(math.floor(px - reach), math.ceil(px + reach) + 1):
                for z in range(math.floor(pz - reach), math.ceil(pz + reach) + 1):
                    if (x - px) ** 2 + (z - pz) ** 2 <= reach * reach:
                        add((x, z), "cutter")
        for i, (x, z, _p) in enumerate(self.spikes):
            if not self._off(self.spike_ch, i) and self.spike_up(i, time_seconds):
                add((x, z), "spikes")
        if len(self._hazard_cache) > 4096:
            self._hazard_cache.clear()
        self._hazard_cache[key] = out
        return out

    def _kind_lethal(self, kind: str, cell: Cell, feet: float, time_seconds: float) -> bool:
        """Does hazard ``kind`` at ``cell`` hurt Deeba standing with her feet at ``feet``?"""
        if kind == "spikes":
            return feet < SPIKE_SAFE_HEIGHT
        if kind == "cutter":
            return any(not self._off(self.cutter_ch, i) and feet < CUTTER_HEIGHT_FACTOR * c[4] and
                       (cell[0] - self.cutter_position(i, time_seconds)[0]) ** 2 + (cell[1] - self.cutter_position(i, time_seconds)[1]) ** 2
                       <= (c[4] + CUTTER_REACH_PAD) ** 2 for i, c in enumerate(self.cutters))
        if kind == "shock":
            for i, (x, z, d, length, _p, y) in enumerate(self.shocks):
                if self._off(self.shock_ch, i) or self.shock_phase(i, time_seconds) < SHOCK_STRIKE_AT:
                    continue
                if d == "down":
                    ok = (x, z) == cell and feet < y and feet + PLAYER_HEIGHT > y - length
                elif d == "up":
                    ok = (x, z) == cell and feet + PLAYER_HEIGHT > y and feet < y + length
                else:
                    dx, dz = {"xp": (1, 0), "xn": (-1, 0), "zp": (0, 1), "zn": (0, -1)}[d]
                    k = (cell[0] - x) * dx + (cell[1] - z) * dz
                    ok = 0 <= k <= int(round(length)) and (cell[0] - x) * dz == 0 and (cell[1] - z) * dx == 0 \
                        and feet - BEAM_BELOW <= y <= feet + PLAYER_HEIGHT
                if ok:
                    return True
            return False
        # laser
        for i, (cx, cz, sweep, _rng, half, beam, y, _sp) in enumerate(self.lasers):
            if self._off(self.laser_ch, i):
                continue
            off = self.laser_offset(i, time_seconds)
            px, pz = (cx + off if sweep == "x" else cx), (cz + off if sweep == "z" else cz)
            by = y + off if sweep == "y" else y
            if beam == "x":
                ok = abs(cell[0] - px) <= half + 1e-9 and cell[1] == _round_cell(pz)
            elif beam == "z":
                ok = abs(cell[1] - pz) <= half + 1e-9 and cell[0] == _round_cell(px)
            else:
                ok = (cell[0], cell[1]) == (_round_cell(px), _round_cell(pz))
            if not ok:
                continue
            if beam == "y":
                if feet <= y + 2 * half and feet + PLAYER_HEIGHT >= y:
                    return True
            elif feet - BEAM_BELOW <= by <= feet + PLAYER_HEIGHT:
                return True
        return False

    def dynamic_hit(self, cell: Cell, time_seconds: float) -> Optional[str]:
        """Kind of dynamic hazard that kills Deeba standing in ``cell`` (on its surface) at ``time_seconds``."""
        if self._lasers_frozen(time_seconds):
            return None
        kinds = self.hazard_cells(time_seconds).get(cell)
        if not kinds:
            return None
        feet = self.cell_height(cell, time_seconds)
        for kind in kinds:
            if self._kind_lethal(kind, cell, feet, time_seconds):
                return kind
        return None

    def moving_laser_hits(self, cell: Cell, time_seconds: float) -> bool:
        """Back-compat name: True if *any* dynamic hazard kills at ``cell``."""
        return self.dynamic_hit(cell, time_seconds) is not None

    def _climb_kind(self, from_h: float, to_h: float) -> int:
        """0 = walk, 1 = needs a jump, 2 = unreachable (dropping is always fine)."""
        diff = to_h - from_h
        if diff <= STEP_MAX:
            return 0
        return 1 if diff <= JUMP_REACH else 2

    def get_state_key(self) -> str:
        """Compact state key (kept for API compatibility; the neural agents ignore it)."""
        return f"{self.level_index},{self.position[0]},{self.position[1]},{self.heading},{self.plate_mask},{self.coin_mask}"

    def capture(self) -> Dict[str, Any]:
        """Cheap copy of every *dynamic* field (used by the level solver and by tests)."""
        return {
            "level_index": self.level_index, "position": list(self.position), "heading": self.heading,
            "blocks": set(self.blocks), "block_cells": list(self.block_cells),
            "plate_mask": self.plate_mask, "coin_mask": self.coin_mask, "powerup_mask": self.powerup_mask,
            "powerup_type": self.powerup_type, "powerup_until": self.powerup_until,
            "lever_state": dict(self.lever_state), "switch_on": self.switch_on, "doors_open": self.doors_open,
            "ice_momentum": self.ice_momentum, "simulation_steps": self.simulation_steps,
            "level_steps": self.level_steps, "climbed": set(self.climbed), "lever_rewarded": self.lever_rewarded,
            "episode_complete": self.episode_complete,
        }

    def restore(self, saved: Dict[str, Any]) -> None:
        """Inverse of :meth:`capture` (the level itself must be the same)."""
        self.level_index = saved["level_index"]
        self.position = list(saved["position"])
        self.heading = saved["heading"]
        self.blocks = set(saved["blocks"])
        self.block_cells = list(saved["block_cells"])
        self.plate_mask = saved["plate_mask"]
        self.coin_mask = saved["coin_mask"]
        self.powerup_mask = saved["powerup_mask"]
        self.powerup_type = saved["powerup_type"]
        self.powerup_until = saved["powerup_until"]
        self.lever_state = dict(saved["lever_state"])
        self.switch_on = saved["switch_on"]
        self.doors_open = saved["doors_open"]
        self.ice_momentum = saved["ice_momentum"]
        self.simulation_steps = saved["simulation_steps"]
        self.level_steps = saved["level_steps"]
        self.climbed = set(saved["climbed"])
        self.lever_rewarded = saved["lever_rewarded"]
        self.episode_complete = saved["episode_complete"]
        self._recompute_channels()
        self._sync_dynamic()
        self._refresh_objective()

    def snapshot(self) -> Dict[str, Any]:
        """Capture a snapshot of the current environment state."""
        return {
            "level": self.level,
            "levelIndex": self.level_index,
            "position": list(self.position),
            "heading": self.heading,
            "doorsOpen": self.doors_open,
            "plateMask": self.plate_mask,
            "coinMask": self.coin_mask,
            "steps": self.episode_steps,
            "levelSteps": self.level_steps,
            "deaths": self.death_count,
        }

    @property
    def sim_time_seconds(self) -> float:
        """Simulated wall-clock time that drives the rotating bars."""
        return self.simulation_steps * RL_ACTION_DURATION_SECONDS

    # ── Static observation tensor ──────────────────────────────────────────────────────
    def _build_static(self) -> None:
        sx, sz = self.size_x, self.size_z
        st = np.zeros((STATIC_CHANNELS, sx + 2 * PAD, sz + 2 * PAD), dtype=np.float32)
        st[CH_WALL] = 1.0
        st[CH_WALL, PAD:PAD + sx, PAD:PAD + sz] = 0.0

        def mark(channel: int, cells, value: float = 1.0) -> None:
            for (cx, cz) in cells:
                if 0 <= cx < sx and 0 <= cz < sz:
                    st[channel, cx + PAD, cz + PAD] = value

        mark(CH_WALL, self.walls)
        mark(CH_HAZARD, self.hazards)
        mark(CH_HAZARD, self.water, 0.15)  # harmless wade, faint on purpose
        mark(CH_MOVER, self.movers)
        mark(CH_PLATFORM, self.platforms)
        mark(CH_PLATFORM, self.ice, 0.4)
        for cell, top in self.static_height.items():
            mark(CH_HEIGHT, [cell], min(1.0, top / MAX_HEIGHT))
        # Rails: every cell a dynamic hazard can ever cover (a faint hint of where to look; value = type).
        footprints = self._hazard_footprints()
        for kind, value in (("laser", 0.4), ("shock", 0.6), ("cutter", 0.8), ("spikes", 1.0)):
            mark(CH_RAIL, footprints.get(kind, ()), value)
        st[CH_HEIGHT_NEXT] = st[CH_HEIGHT]
        self._static = st
        self._sync_dynamic()

    def _hazard_footprints(self) -> Dict[str, Set[Cell]]:
        """All four footprints in one sampling pass, memoised per level (shared by every environment instance:
        the parallel training environments load the same few levels thousands of times)."""
        if not (self.lasers or self.shocks or self.cutters or self.spikes):
            return {}
        sig = repr((self.lasers, self.shocks, self.cutters, self.spikes, self.laser_ch, self.shock_ch, self.cutter_ch, self.spike_ch))
        cached = _FOOTPRINT_CACHE.get(sig)
        if cached is not None:
            return cached
        out: Dict[str, Set[Cell]] = {"laser": set(), "cutter": set(), "spikes": set(), "shock": set()}
        saved_cache = self._hazard_cache
        self._hazard_cache = {}
        t = 0.0
        while t <= 24.0:
            for cell, kinds in self.hazard_cells(t).items():
                for kind in kinds:
                    if kind in out and kind != "shock":
                        out[kind].add(cell)
            t += 0.2
        for (x, z, d, length, _p, _y) in self.shocks:
            n = max(0, int(round(length)))
            if d in ("down", "up"):
                out["shock"].add((x, z))
            else:
                dx, dz = {"xp": (1, 0), "xn": (-1, 0), "zp": (0, 1), "zn": (0, -1)}[d]
                out["shock"].update((x + dx * k, z + dz * k) for k in range(n + 1))
        self._hazard_cache = saved_cache
        if len(_FOOTPRINT_CACHE) > 128:
            _FOOTPRINT_CACHE.clear()
        _FOOTPRINT_CACHE[sig] = out
        return out

    def _hazard_footprint(self, kind: str) -> Set[Cell]:
        """Union of cells a hazard kind can ever occupy (sampled over one full period)."""
        cells: Set[Cell] = set()
        horizon = 24.0
        step = 0.2
        t = 0.0
        saved_cache = self._hazard_cache
        self._hazard_cache = {}
        while t <= horizon:
            if kind == "shock":
                # strike cells regardless of phase: temporarily ignore the clock by forcing the strike window
                for i, (x, z, d, length, period, _y) in enumerate(self.shocks):
                    n = max(0, int(round(length)))
                    if d in ("down", "up"):
                        cells.add((x, z))
                    else:
                        dx, dz = {"xp": (1, 0), "xn": (-1, 0), "zp": (0, 1), "zn": (0, -1)}[d]
                        cells.update((x + dx * k, z + dz * k) for k in range(n + 1))
                break
            for cell, kinds in self.hazard_cells(t).items():
                if kind in kinds:
                    cells.add(cell)
            t += step
        self._hazard_cache = saved_cache
        return cells

    def _sync_dynamic(self) -> None:
        """Refresh channels that change during play (blocks, coins, plates, door, switch)."""
        st = self._static
        sx, sz = self.size_x, self.size_z
        st[CH_BLOCK] = 0.0
        st[CH_COIN] = 0.0
        st[CH_PLATE] = 0.0
        st[CH_DOOR_CLOSED] = 0.0
        st[CH_DOOR_OPEN] = 0.0
        st[CH_SWITCH] = 0.0
        for (cx, cz) in self.blocks:
            if 0 <= cx < sx and 0 <= cz < sz:
                st[CH_BLOCK, cx + PAD, cz + PAD] = 1.0
        for i, c in enumerate(self.coins):
            if not (self.coin_mask & (1 << i)):
                st[CH_COIN, c[0] + PAD, c[1] + PAD] = 1.0
        for i, (px, pz, _kind) in enumerate(self.powerups):
            if not (self.powerup_mask & (1 << i)):
                st[CH_COIN, px + PAD, pz + PAD] = max(st[CH_COIN, px + PAD, pz + PAD], 0.65)
        for i, p in enumerate(self.plates):
            if not (self.plate_mask & (1 << i)):
                st[CH_PLATE, p[0] + PAD, p[1] + PAD] = 1.0
        ex, ez = self.exit_door
        st[CH_DOOR_OPEN if self.doors_open else CH_DOOR_CLOSED, ex + PAD, ez + PAD] = 1.0
        for (sx, sz) in self._switch_keys:
            st[CH_SWITCH, sx + PAD, sz + PAD] = 1.0 if (self.switch_on or (self.lever_state.get((sx, sz), False))) else 0.5
        self._sync_lifts()

    def _sync_lifts(self) -> None:
        """Lift heights now and one look-ahead later (so a memoryless policy can see which way they move)."""
        if not self.lifts:
            return
        st = self._static
        now = self.sim_time_seconds
        ahead = now + 2.0 * RL_ACTION_DURATION_SECONDS
        for i, (lx, lz, _h) in enumerate(self.lifts):
            base = self.static_height.get((lx, lz), 0.0)
            st[CH_HEIGHT, lx + PAD, lz + PAD] = max(base, self.lift_top(i, now)) / MAX_HEIGHT
            st[CH_HEIGHT_NEXT, lx + PAD, lz + PAD] = max(base, self.lift_top(i, ahead)) / MAX_HEIGHT

    # ── Shortest-path distance field (the "compass") ───────────────────────────────────
    def _standable(self, x: int, z: int) -> bool:
        """Cells the agent can safely stand on, ignoring (time-varying) rotating bars."""
        if x < 0 or z < 0 or x >= self.size_x or z >= self.size_z:
            return False
        c = (x, z)
        # Crates are *pushable*, so the compass is allowed to lead through them (see the extra cost in _field): the
        # agent then walks into the crate and shoves it ahead of itself, e.g. along a corridor onto a hold-button.
        if c in self.walls or c in self.hazards or c in self.movers or c in self.rotators:
            return False
        if self._crates_solid and c in self.blocks:
            return False
        if c == self._exit_door_key and not self.doors_open:
            return False
        return True

    def _static_cell_height(self, cell: Cell, lever_assumed: bool) -> float:
        """Height used by the (time-independent) distance field: lifts count as raised once powered."""
        h = self.static_height.get(cell, 0.0)
        i = self.lift_index.get(cell)
        if i is not None:
            h = max(h, self.lifts[i][2] if lever_assumed else LIFT_REST)
        return h

    def _field(self, targets: List[Cell], lever_assumed: bool) -> List[float]:
        """Dijkstra distance (in action-ish units) from every cell to the nearest target."""
        sx, sz = self.size_x, self.size_z
        dist = [INF] * (sx * sz)
        heap: List[Tuple[float, int, int]] = []
        for (tx, tz) in targets:
            if 0 <= tx < sx and 0 <= tz < sz:
                dist[tx * sz + tz] = 0.0
                heap.append((0.0, tx, tz))
        heapq.heapify(heap)
        jumpables = self.hazards | self.rotators | self.movers
        standable = self._standable
        height = lambda c: self._static_cell_height(c, lever_assumed)  # noqa: E731
        while heap:
            d, x, z = heapq.heappop(heap)
            if d > dist[x * sz + z]:
                continue
            hx = height((x, z))
            for fx, fz in _DIRS:
                nx, nz = x + fx, z + fz
                if standable(nx, nz):
                    kind = self._climb_kind(height((nx, nz)), hx)
                    if kind != 2:
                        cost = d + (1.0 if kind == 0 else CLIMB_COST) + (1.0 if (nx, nz) in self.blocks else 0.0)
                        if cost < dist[nx * sz + nz]:
                            dist[nx * sz + nz] = cost
                            heapq.heappush(heap, (cost, nx, nz))
                # A jump launched from (x - 2f) over a hazard at (x - f) lands here.
                if (x - fx, z - fz) in jumpables:
                    ax, az = x - 2 * fx, z - 2 * fz
                    if standable(ax, az) and self._climb_kind(height((ax, az)), hx) != 2 and d + JUMP_COST < dist[ax * sz + az]:
                        dist[ax * sz + az] = d + JUMP_COST
                        heapq.heappush(heap, (d + JUMP_COST, ax, az))
        return dist

    def _crate_plan(self, plate: Cell) -> Optional[Tuple[int, Cell, Cell, Cell]]:
        """Shortest push sequence that brings a crate onto ``plate``: (pushes, crate cell, push direction, cell to push from).

        BFS over the *crate's* cell (the walker is assumed able to get behind it; the walker's own route to the push
        cell is planned afterwards).  A crate may not be pushed into walls, acid, ledges, other crates or the door.
        """
        sx, sz = self.size_x, self.size_z
        ledges = self.static_height

        def crate_ok(c: Cell, others: Set[Cell]) -> bool:
            return (0 <= c[0] < sx and 0 <= c[1] < sz and c not in self.walls and c not in self.hazards
                    and c not in self.rotators and c not in self.movers and c not in ledges and c not in others
                    and c != self._exit_door_key)

        def walker_ok(c: Cell) -> bool:
            return 0 <= c[0] < sx and 0 <= c[1] < sz and c not in self.walls and c not in self.hazards

        best: Optional[Tuple[int, Cell, Cell, Cell]] = None
        for crate in self.blocks:
            if crate == plate or crate in self.continuous_plates:   # a crate already holding a button is done
                continue
            others = self.blocks - {crate}
            first: Dict[Cell, Cell] = {}
            seen = {crate}
            queue = deque([(crate, 0)])
            found = None
            while queue and found is None:
                c, d = queue.popleft()
                for fx, fz in _DIRS:
                    n = (c[0] + fx, c[1] + fz)
                    back = (c[0] - fx, c[1] - fz)
                    if n in seen or not crate_ok(n, others) or not walker_ok(back):
                        continue
                    seen.add(n)
                    first[n] = first.get(c, (fx, fz)) if c != crate else (fx, fz)
                    if n == plate:
                        found = d + 1
                        break
                    queue.append((n, d + 1))
            if found is not None and (best is None or found < best[0]):
                fd = first[plate]
                best = (found, crate, fd, (crate[0] - fd[0], crate[1] - fd[1]))
        return best

    def _refresh_objective(self) -> None:
        """Recompute targets and the distance field to the nearest objective (plate -> exit).

        If the objective can only be reached with the lifts running (and the power lever is still off)
        the lever itself becomes the objective, so the compass tells the agent to go and pull it.
        """
        targets = [(p[0], p[1]) for i, p in enumerate(self.plates) if self.plate_ch[i] == 0 and not (self.plate_mask & (1 << i))]
        self._plates_remaining = len(targets)
        if not targets:
            targets = [self._exit_door_key]
        sx, sz = self.size_x, self.size_z
        # A hold-button that only a crate can keep pressed: the compass first leads the walker to the cell *behind the
        # crate* (so it pushes the right way), then into the crate; after each push the plan is recomputed.  Ordinary
        # (latching) buttons come first.
        self._crates_solid = False
        self._crate_left = None
        self._crate_total = 0
        self._crate_holds = 0
        self._crate_stand = None
        self._at_stand = False
        holds = [t for t in targets if t in self.continuous_plates and t != self._exit_door_key]
        if self.blocks and holds:                # crate puzzles first: a hold-button cannot be skipped, an ordinary one latches
            plans = [p for p in (self._crate_plan(h) for h in holds) if p is not None]
            if plans:
                pushes, crate, _dir, stand = min(plans, key=lambda p: p[0])
                self._crate_left = pushes
                self._crate_total = sum(p[0] for p in plans)
                self._crate_holds = len(holds)
                self._crates_solid = True
                self._crate_stand = stand
                self._at_stand = tuple(self.position) == stand
                targets = [crate] if self._at_stand else [stand]
        self._lever_needed = False
        if self.lifts and not all(self.lift_powered(i) for i in range(len(self.lifts))):
            dist = self._field(targets, False)
            here = self.position[0] * sz + self.position[1]
            if dist[here] >= INF and self.levers:
                targets = sorted(self.levers)
                dist = self._field(targets, False)
                self._lever_needed = True
        else:
            dist = self._field(targets, bool(self.lifts))
        self._crates_solid = False
        self._targets = targets
        self._dist = dist
        self._dist_np = np.array(dist, dtype=np.float64).reshape(sx, sz)

    def _dist_at(self, x: int, z: int) -> float:
        if x < 0 or z < 0 or x >= self.size_x or z >= self.size_z:
            return INF
        return self._dist[x * self.size_z + z]

    # ── Rotating bars ──────────────────────────────────────────────────────────────────
    def _rotator_matrix(self, xs, zs, times, jump_heights) -> np.ndarray:
        """Overlap of player boxes (S points) against every rotating bar -> bool (S, R)."""
        if self.powerup_type == "freeze" and self.powerup_until > float(np.max(times, initial=0.0)):
            return np.zeros((len(xs), len(self.rotator_cells)), dtype=bool)
        xs = np.asarray(xs, dtype=np.float64)
        zs = np.asarray(zs, dtype=np.float64)
        angle = np.asarray(times, dtype=np.float64)[:, None] * self._rot_speed * self._rot_dir[None, :]
        cosine = np.cos(angle)
        sine = np.sin(angle)
        dx = xs[:, None] - self._rot_x[None, :]
        dz = zs[:, None] - self._rot_z[None, :]
        local_x = dx * cosine - dz * sine
        local_z = dx * sine + dz * cosine
        height_ok = np.abs(PLAYER_CENTER_Y + np.asarray(jump_heights, dtype=np.float64) - 0.55) <= 0.37 + 0.12
        return (np.abs(local_x) <= _LIMIT_X) & (np.abs(local_z) <= _LIMIT_Z) & height_ok[:, None]

    def _rotator_blocker(self, x: float, z: float, time_seconds: Optional[float] = None, jump_height: float = 0.0) -> Optional[List[int]]:
        """Find a rotor overlapping this player position at a specific time."""
        if not self.rotator_cells:
            return None
        if time_seconds is None:
            time_seconds = self.sim_time_seconds
        hit = self._rotator_matrix([x], [z], [time_seconds], [jump_height])[0]
        if hit.any():
            return self.rotator_cells[int(np.argmax(hit))]
        return None

    def _rotator_collision_during_move(self, start: List[int], end: List[int], duration: float, jumping: bool = False,
                                       base_start: float = 0.0, base_end: float = 0.0) -> Optional[List[int]]:
        """Sweep player movement and rotor rotation over the action duration."""
        if not self.rotator_cells:
            return None
        start_time = self.sim_time_seconds
        travel = math.hypot(end[0] - start[0], end[1] - start[1])
        max_speed = max(0.1, self._rot_speed)
        samples = max(6, math.ceil(travel / 0.08), math.ceil(max_speed * duration / 0.06))

        amounts = np.arange(1, samples + 1, dtype=np.float64) / samples
        px = start[0] + (end[0] - start[0]) * amounts
        pz = start[1] + (end[1] - start[1]) * amounts
        times = start_time + duration * amounts
        if jumping:
            jt = duration * amounts
            heights = np.maximum(0.0, PLAYER_JUMP_IMPULSE * jt - 0.5 * WORLD_GRAVITY * jt * jt)
        else:
            heights = np.zeros(samples)
        heights = heights + base_start + (base_end - base_start) * amounts  # standing on a ledge lifts Deeba over the bar
        hits = self._rotator_matrix(px, pz, times, heights)  # (S, R)

        ends = self._rotator_matrix([end[0]], [end[1]], [start_time + duration], [base_end])[0]
        starts = self._rotator_matrix([start[0]], [start[1]], [start_time], [base_start])[0]
        any_hit = hits.any(axis=0)
        for index in range(len(self.rotator_cells)):
            if starts[index] and not ends[index] and not jumping:
                # Let an already-overlapping agent step out of the collider.
                continue
            if any_hit[index]:
                return self.rotator_cells[index]
        return None

    def _danger_layers(self, wx: np.ndarray, wz: np.ndarray, heading: Optional[int] = None) -> np.ndarray:
        """Bool (H, W, W): cell is swept by a bar during action k (k = 0 is the action about to be taken)."""
        horizon = DANGER_HORIZON
        out = np.zeros((horizon, LOCAL_VIEW_WIDTH, LOCAL_VIEW_WIDTH), dtype=np.float32)
        half = RL_ACTION_DURATION_SECONDS / 2.0
        times = self.sim_time_seconds + np.arange(2 * horizon + 1) * half  # (T,)
        if self.rotator_cells and not (self.powerup_type == "freeze" and self.powerup_until > self.sim_time_seconds):
            angle = times[:, None] * self._rot_speed * self._rot_dir[None, :]
            cosine = np.cos(angle)[None, :, :]
            sine = np.sin(angle)[None, :, :]
            dx = wx.reshape(-1, 1, 1) - self._rot_x[None, None, :]
            dz = wz.reshape(-1, 1, 1) - self._rot_z[None, None, :]
            local_x = dx * cosine - dz * sine
            local_z = dx * sine + dz * cosine
            hit = ((np.abs(local_x) <= _LIMIT_X) & (np.abs(local_z) <= _LIMIT_Z)).any(axis=2)
            for k in range(horizon):
                danger = hit[:, 2 * k:2 * k + 3].any(axis=1).reshape(LOCAL_VIEW_WIDTH, LOCAL_VIEW_WIDTH)
                out[k] = np.maximum(out[k], danger.astype(np.float32))
        if not (self.powerup_type == "freeze" and self.powerup_until > self.sim_time_seconds):
            if self.lasers or self.shocks or self.cutters or self.spikes:
                # Walk the (few) lethal cells of each time slice instead of testing all 81 window cells: ~10x faster.
                px, pz = self.position
                inverse = _OFFSET_INDEX[self.heading if heading is None else heading]
                for k in range(horizon):
                    flat = out[k].reshape(-1)
                    for tt in times[2 * k:2 * k + 3]:
                        t = float(tt)
                        for cell in self.hazard_cells(t):
                            n = inverse.get((cell[0] - px, cell[1] - pz))
                            if n is not None and flat[n] < 1.0 and self.dynamic_hit(cell, t) is not None:
                                flat[n] = 1.0
        return out

    def _dynamic_hazard_active(self, cell: Cell, time_seconds: float) -> bool:
        return self.dynamic_hit(cell, time_seconds) is not None

    # ── Observation ────────────────────────────────────────────────────────────────────
    def observe(self) -> np.ndarray:
        """Egocentric local grid + scalar compass features (float32, length OBSERVATION_SIZE)."""
        x, z = self.position
        h = self.heading
        obs = self._obs
        width = LOCAL_VIEW_WIDTH
        self._sync_lifts()

        wx = x + _DX[h]
        wz = z + _DZ[h]
        view = obs[:LOCAL_VIEW_SIZE].reshape(LOCAL_VIEW_CHANNELS, width, width)
        view[:STATIC_CHANNELS] = self._static[:, wx + PAD, wz + PAD]
        view[STATIC_CHANNELS:] = self._danger_layers(wx, wz, h)

        fx, fz = _DIRS[h]
        lx, lz = -fz, fx
        d_cur = self._dist_at(x, z)
        reachable = d_cur < INF
        s = obs[_SCALAR_START:]
        # Compass: +1 -> this move is on a shortest path, -1 -> blocked or moves away.
        for slot, (mx, mz) in enumerate(((fx, fz), (-fx, -fz), (lx, lz), (-lx, -lz))):
            nd = self._dist_at(x + mx, z + mz)
            s[slot] = clamp(d_cur - nd, -1.0, 1.0) if (reachable and nd < INF) else -1.0
        # Jump gain (only meaningful when a hazard / bar / mover sits directly ahead).
        jump_gain = 0.0
        if reachable and (x + fx, z + fz) in (self.hazards | self.rotators | self.movers):
            ld = self._dist_at(x + 2 * fx, z + 2 * fz)
            if ld < INF:
                jump_gain = clamp((d_cur - ld) / JUMP_COST, -1.0, 1.0)
        s[4] = jump_gain
        s[5] = min(d_cur, 40.0) / 40.0 if reachable else 1.0

        tx, tz = min(self._targets, key=lambda t: abs(t[0] - x) + abs(t[1] - z))
        ddx, ddz = tx - x, tz - z
        s[6] = clamp((ddx * fx + ddz * fz) / self.size, -1.0, 1.0)
        s[7] = clamp((ddx * lx + ddz * lz) / self.size, -1.0, 1.0)
        s[8] = 1.0 if self._plates_remaining else 0.0
        s[9] = 0.0 if self._plates_remaining else 1.0
        s[10] = clamp(1.0 - self.level_steps / self.time_limit_steps, 0.0, 1.0)
        s[11] = 1.0 if self.doors_open else 0.0
        s[12] = self._plates_remaining / max(1, len(self.plates))
        s[13] = (len(self.coins) - bin(self.coin_mask).count("1")) / max(1, len(self.coins))
        even = int(self.simulation_steps) % 2 == 0
        s[14] = 1.0 if even else 0.0
        s[15] = 0.0 if even else 1.0
        s[15] = max(s[15], clamp((self.powerup_until - self.sim_time_seconds) / 9.0, 0.0, 1.0))
        s[16] = clamp(self.cell_height((x, z), self.sim_time_seconds) / MAX_HEIGHT, 0.0, 1.0)
        s[17] = 1.0 if self.lever_on else 0.0
        s[18] = 1.0 if self._lever_needed else 0.0
        return obs

    def action_mask(self) -> np.ndarray:
        """Boolean mask of *sensible* actions in the current state (invalid-action masking).

        Masks only actions that can never help: walking into walls, stepping on lava, walking
        into a bar's hub, walking into a ledge that is too high to step onto, jumping with nothing
        to jump over or onto, or pressing E with no lever / switch in reach.
        Everything that needs *judgement* (timing a bar, when to wait, when to jump) stays open.
        """
        mask = np.ones(len(ACTIONS), dtype=bool)
        x, z = self.position
        now = self.sim_time_seconds
        arrive = now + RL_ACTION_DURATION_SECONDS
        here_h = self.cell_height((x, z), now)
        fx, fz = _DIRS[self.heading]
        directions = ((fx, fz), (-fx, -fz), (-fz, fx), (fz, -fx))
        shielded = self.powerup_type == "shield" and self.powerup_until > now
        for slot, (dx, dz) in enumerate(directions):
            cell = (x + dx, z + dz)
            if cell in self.blocks:
                beyond = (cell[0] + dx, cell[1] + dz)
                if self._static_blocked(*beyond):
                    mask[slot] = False
            elif (self._static_blocked(*cell) or (cell in self.hazards and not shielded) or cell in self.rotators
                  or (self._dynamic_hazard_active(cell, now) and not shielded)
                  or self._climb_kind(here_h, self.cell_height(cell, arrive)) != 0):
                mask[slot] = False
        first = (x + fx, z + fz)
        powered_jump = self.powerup_type == "jump" and self.powerup_until > now
        jump_distance = 3 if powered_jump else 2
        landing = (x + jump_distance * fx, z + jump_distance * fz)
        over_something = (
            first in self.hazards or first in self.rotators or first in self.movers
            or self.moving_laser_hits(first, now)
            or powered_jump
        )
        first_h = self.cell_height(first, arrive)
        climb = (
            not self._static_blocked(*first) and first not in self.hazards and first not in self.rotators
            and self._climb_kind(here_h, first_h) == 1
        )
        hop_ok = (
            over_something and not self._static_blocked(*landing) and landing not in self.hazards
            and landing not in self.movers
            and self._climb_kind(here_h, self.cell_height(landing, now + PLAYER_JUMP_DURATION_SECONDS)) != 2
        )
        mask[6] = bool(hop_ok or climb)
        mask[7] = first in self._switch_keys or (x, z) in self._switch_keys
        return mask

    # ── Dynamics ───────────────────────────────────────────────────────────────────────
    def _static_blocked(self, x: int, z: int) -> bool:
        """Check walls, blocks, and sealed doors without moving obstacles."""
        if x < 0 or z < 0 or x >= self.size_x or z >= self.size_z:
            return True
        k = (x, z)
        return k in self.walls or k in self.blocks or (k == self._exit_door_key and not self.doors_open)

    def _blocked(self, x: int, z: int) -> bool:
        return self._static_blocked(x, z)

    def _push_from_rotator(self, position: List[int], rotor: List[int], fallback: Optional[List[int]] = None):
        """Move the agent clear of the rotor sweep and return the push vector."""
        dx = position[0] - rotor[0]
        dz = position[1] - rotor[1]
        if abs(dx) >= abs(dz) and dx:
            direction = [int(math.copysign(1, dx)), 0]
        elif dz:
            direction = [0, int(math.copysign(1, dz))]
        elif fallback:
            direction = [fallback[0], fallback[1]]
        else:
            fx, fz = _DIRS[self.heading]
            direction = [-fx, -fz]

        pushed = list(position)
        for _ in range(4):
            pushed = [pushed[0] + direction[0], pushed[1] + direction[1]]
            if self._static_blocked(*pushed):
                return list(position), {"x": direction[0] * 8.0, "z": direction[1] * 8.0}
            if self._rotator_blocker(*pushed) is None:
                return pushed, {"x": direction[0] * 8.0, "z": direction[1] * 8.0}
        return list(position), {"x": direction[0] * 8.0, "z": direction[1] * 8.0}

    def step(self, action: int) -> Dict[str, Any]:
        """Advance the environment by taking one action."""
        rw = self.rewards
        reward = rw["timeStep"]
        done = False
        success = False
        level_changed = False
        collision = False
        hazard = False
        death = False
        timed_out = False
        rotator_hit = False
        objective_changed = False
        knockback: Optional[Dict[str, float]] = None
        jump_over_key: Optional[Cell] = None
        previous_position = list(self.position)
        dist_before = self._dist_at(previous_position[0], previous_position[1])

        action_id = ACTIONS[action]["id"] if 0 <= action < len(ACTIONS) else "wait"
        fx, fz = _DIRS[self.heading]
        move: Optional[List[int]] = None
        time_steps_used = 1.0
        jumping = action_id == "jump"

        if action_id == "turnLeft":
            self.heading = (self.heading + 3) % 4
        elif action_id == "turnRight":
            self.heading = (self.heading + 1) % 4
        elif action_id == "forward":
            move = [fx, fz]
        elif action_id == "backward":
            move = [-fx, -fz]
        elif action_id == "strafeLeft":
            move = [-fz, fx]
        elif action_id == "strafeRight":
            move = [fz, -fx]
        elif action_id == "jump":
            time_steps_used = PLAYER_JUMP_DURATION_SECONDS / RL_ACTION_DURATION_SECONDS
            if tuple(self.position) in self.rotators:
                move = [0, 0]
            else:
                now = self.sim_time_seconds
                land_t = now + PLAYER_JUMP_DURATION_SECONDS
                here_h = self.cell_height(tuple(self.position), now)
                first_cell = (self.position[0] + fx, self.position[1] + fz)
                jump_distance = 3 if self.powerup_type == "jump" and self.powerup_until > now else 2
                landing = (self.position[0] + fx * jump_distance, self.position[1] + fz * jump_distance)
                obstacle = (
                    first_cell in (self.hazards | self.rotators | self.movers)
                    or self.moving_laser_hits(first_cell, now)
                )
                jumpable = obstacle or jump_distance == 3
                landing_is_hazard = landing in self.hazards or landing in self.movers
                climbing = (
                    not obstacle and not self._static_blocked(*first_cell)
                    and self._climb_kind(here_h, self.cell_height(first_cell, land_t)) == 1
                )
                if climbing:
                    move = [fx, fz]  # jump up onto the ledge / lift in front of us
                elif (jumpable and not self._blocked(landing[0], landing[1]) and not landing_is_hazard
                      and self._climb_kind(here_h, self.cell_height(landing, land_t)) != 2):
                    move = [fx * jump_distance, fz * jump_distance]
                    jump_over_key = first_cell
                else:
                    move = [fx, fz]
        elif action_id == "interact":
            here = (self.position[0], self.position[1])
            facing = (self.position[0] + fx, self.position[1] + fz)
            target = facing if facing in self._switch_keys else (here if here in self._switch_keys else None)
            if target is not None:
                if target in self.levers:
                    self.lever_state[target] = not self.lever_state.get(target, False)
                    self._recompute_channels()
                    self.switch_on = any(self.lever_state.values())
                else:
                    self.switch_on = not self.switch_on
                if not self.lever_rewarded:
                    self.lever_rewarded = True
                    reward += rw["switch"]
                objective_changed = True
                self._sync_dynamic()
                self._refresh_objective()
            else:
                reward += rw["invalidInteract"]

        ice_pending: Optional[Cell] = None
        if not jumping and tuple(self.position) in self.ice:
            direction = None if not move or move == [0, 0] else (int(math.copysign(1, move[0])) if move[0] else 0, int(math.copysign(1, move[1])) if move[1] else 0)
            if self.ice_momentum and (direction is None or direction != self.ice_momentum):
                ice_pending = direction
                move = [self.ice_momentum[0], self.ice_momentum[1]]
            elif direction:
                self.ice_momentum = direction

        if move and not jumping and self.powerup_type == "speed" and self.powerup_until > self.sim_time_seconds:
            first_speed = (self.position[0] + move[0], self.position[1] + move[1])
            second_speed = (self.position[0] + move[0] * 2, self.position[1] + move[1] * 2)
            level_a = self.cell_height(tuple(self.position), self.sim_time_seconds)
            clear_mid = (not self._static_blocked(*first_speed) and first_speed not in self.blocks
                         and self._climb_kind(level_a, self.cell_height(first_speed, self.sim_time_seconds)) == 0)
            clear_end = (not self._static_blocked(*second_speed) and second_speed not in self.blocks
                         and self._climb_kind(level_a, self.cell_height(second_speed, self.sim_time_seconds)) == 0)
            clear_hazards = all(c not in self.hazards and not self._dynamic_hazard_active(c, self.sim_time_seconds + RL_ACTION_DURATION_SECONDS) for c in (first_speed, second_speed))
            if clear_mid and clear_end and (clear_hazards or (self.powerup_type == "shield" and self.powerup_until > self.sim_time_seconds)):
                move = [move[0] * 2, move[1] * 2]
                time_steps_used = 0.65

        if move:
            nx, nz = self.position[0] + move[0], self.position[1] + move[1]
            key = (nx, nz)

            if key in self.blocks:
                beyond = (nx + move[0], nz + move[1])
                beyond_blocked = (
                    beyond[0] < 0 or beyond[1] < 0 or beyond[0] >= self.size_x or beyond[1] >= self.size_z
                    or beyond in self.walls or beyond in self.blocks
                    or (beyond == self._exit_door_key and not self.doors_open)
                )
                if not beyond_blocked:
                    self.blocks.remove(key)
                    self.blocks.add(beyond)
                    try:
                        self.block_cells[self.block_cells.index(key)] = beyond
                    except ValueError:
                        self.block_cells.append(beyond)
                    reward += rw["pushBlock"]
                    objective_changed = True
                    self._sync_dynamic()
                    before_left, before_holds = self._crate_left, self._crate_holds
                    self._refresh_objective()  # a pushed block can alter the maze
                    if before_left is not None and self._crate_left is not None and before_holds == self._crate_holds:
                        # progress on the crate plan: +/- per push that gets the crate nearer / further from the button
                        reward += rw.get("cratePlan", 0.4) * (before_left - self._crate_left)

            move_start = self.sim_time_seconds
            move_end = move_start + time_steps_used * RL_ACTION_DURATION_SECONDS
            from_h = self.cell_height((previous_position[0], previous_position[1]), move_start)
            to_h = self.cell_height(key, move_end)
            reach = self._climb_kind(from_h, to_h)
            too_high = (reach == 2) if jumping else (reach != 0)
            rotor = self._rotator_collision_during_move(
                previous_position, [nx, nz], time_steps_used * RL_ACTION_DURATION_SECONDS, jumping, from_h, to_h,
            )
            if self._static_blocked(nx, nz):
                collision = True
                self.collision_count += 1
                reward += rw["collision"]
            elif too_high and (nx, nz) != (previous_position[0], previous_position[1]):
                collision = True
                self.collision_count += 1
                reward += rw["platformCollision"]
            elif rotor:
                collision = True
                rotator_hit = True
                self.collision_count += 1
                reward += rw["rotatorCollision"]
                self.position, knockback = self._push_from_rotator(previous_position, rotor, [-fx, -fz])
            else:
                self.position = [nx, nz]
                hazard_time = self.sim_time_seconds + time_steps_used * RL_ACTION_DURATION_SECONDS
                dynamic_kind = self.dynamic_hit(key, hazard_time)
                hit_hazard = key in self.hazards or dynamic_kind is not None
                shielded = self.powerup_type == "shield" and self.powerup_until > hazard_time
                if hit_hazard and not shielded:
                    hazard = True
                    death = True
                    self.death_count += 1
                    self.collision_count += 1
                    reward += rw.get({"laser": "laserHit", "shock": "shockHit", "cutter": "cutterHit", "spikes": "spikeHit"}.get(dynamic_kind or "", ""), rw["hazard"]) + rw["deathPenalty"]
                    self._load_level(self.level)
                else:
                    if jump_over_key and (nx - fx, nz - fz) == jump_over_key:
                        reward += rw["jumpHazard"]
                    if jumping and to_h - from_h > STEP_MAX and key not in self.climbed:
                        self.climbed.add(key)
                        reward += rw["climb"]

                    ci = self._coin_key_to_idx.get(key, -1)
                    if ci >= 0 and not (self.coin_mask & (1 << ci)):
                        self.coin_mask |= 1 << ci
                        self.total_coins += 1
                        reward += rw["coin"]
                        self._sync_dynamic()

                    pui = self._powerup_key_to_idx.get(key, -1)
                    if pui >= 0 and not (self.powerup_mask & (1 << pui)):
                        self.powerup_mask |= 1 << pui
                        self.powerup_type = self.powerups[pui][2]
                        self.powerup_until = hazard_time + 9.0
                        reward += rw.get("powerup", rw["coin"])
                        self._sync_dynamic()

                    pi = self._plate_key_to_idx.get(key, -1)
                    if pi >= 0 and not (self.plate_mask & (1 << pi)):
                        self.plate_mask |= 1 << pi
                        # Paid once per button: a hold-button released and pressed again must not pay out again.
                        if pi not in self._plate_paid:
                            self._plate_paid.add(pi)
                            self.total_plates += 1
                            reward += rw["plate"]
                        objective_changed = True
                        self._recompute_channels()
                        if self.door_plate_mask and (self.plate_mask & self.door_plate_mask) == self.door_plate_mask:
                            if not self._door_paid:
                                self._door_paid = True
                                reward += rw["doorOpen"]
                            self.doors_open = True
                        self._sync_dynamic()
                        self._refresh_objective()

                    if key in self.movers and int(self.simulation_steps) % 2 == 0:
                        collision = True
                        self.collision_count += 1
                        reward += rw["moverCollision"]


        # While steering a crate the compass points at the cell behind it, then at the crate: refresh when that changes.
        if self._crate_stand is not None and (tuple(self.position) == self._crate_stand) != self._at_stand:
            self._refresh_objective()

        # Hold plates require the player or a movable crate to remain on the switch.
        for i, plate in enumerate(self.plates):
            pcell = (plate[0], plate[1])
            if pcell not in self.continuous_plates:
                continue
            held = tuple(self.position) == pcell or pcell in self.blocks
            was_held = bool(self.plate_mask & (1 << i))
            if held != was_held:
                if held:
                    self.plate_mask |= 1 << i
                    if i not in self._plate_paid:       # paid once: stepping on and off a hold-button must not farm reward
                        self._plate_paid.add(i)
                        self.total_plates += 1
                        reward += rw["plate"]
                else:
                    self.plate_mask &= ~(1 << i)
                objective_changed = True
                self._sync_dynamic()
                self._refresh_objective()
        if self.plates:
            self._recompute_channels()
            self.doors_open = (self.plate_mask & self.door_plate_mask) == self.door_plate_mask
            self._sync_dynamic()

        if tuple(self.position) in self.ice:
            if ice_pending is not None:
                self.ice_momentum = ice_pending
            elif move and move != [0, 0]:
                self.ice_momentum = (int(math.copysign(1, move[0])) if move[0] else 0, int(math.copysign(1, move[1])) if move[1] else 0)
        else:
            self.ice_momentum = None

        stand_h = self.cell_height((previous_position[0], previous_position[1]), self.sim_time_seconds)
        if not move and (rotor := self._rotator_collision_during_move(
            previous_position, previous_position, time_steps_used * RL_ACTION_DURATION_SECONDS, jumping, stand_h, stand_h,
        )) is not None:
            collision = True
            rotator_hit = True
            self.collision_count += 1
            reward += rw["rotatorCollision"]
            self.position, knockback = self._push_from_rotator(previous_position, rotor, [-fx, -fz])

        # Standing still (waiting / turning / pressing E) inside a pulsing or scanning laser is just as fatal.
        if not death and (not move or move == [0, 0]):
            stand = (self.position[0], self.position[1])
            t_start = self.sim_time_seconds
            span = time_steps_used * RL_ACTION_DURATION_SECONDS
            shielded_now = self.powerup_type == "shield" and self.powerup_until > t_start + span
            stand_kind = self.dynamic_hit(stand, t_start + span * 0.5) or self.dynamic_hit(stand, t_start + span)
            if not shielded_now and stand_kind is not None:
                hazard = True
                death = True
                self.death_count += 1
                self.collision_count += 1
                reward += rw.get({"laser": "laserHit", "shock": "shockHit", "cutter": "cutterHit", "spikes": "spikeHit"}.get(stand_kind, ""), rw["hazard"]) + rw["deathPenalty"]
                self._load_level(self.level)

        elevation_before = self.cell_height((previous_position[0], previous_position[1]), self.sim_time_seconds)
        self.episode_steps += 1
        self.simulation_steps += time_steps_used
        if self.powerup_type and self.powerup_until <= self.sim_time_seconds:
            self.powerup_type = None
        if not death:
            self.level_steps += time_steps_used

        pos_key = (self.position[0], self.position[1])
        if not death and pos_key in self.water:
            reward += rw.get("waterStep", 0.0)  # wading is harmless but slow: a tiny extra cost
        if not done and not death and self.doors_open and pos_key == self._exit_door_key:
            reward += rw["goal"]
            reward += rw["speedBonus"] * clamp(1.0 - self.level_steps / self.time_limit_steps, 0.0, 1.0)
            if self.level_index + 1 < len(self.levels):
                self.level_index += 1
                self.level_changes += 1
                self._load_level(self.levels[self.level_index])
                level_changed = True
            else:
                done = True
                success = True
                self.episode_complete = True

        if not done and not death and not level_changed and self.level_steps >= self.time_limit_steps:
            death = True
            timed_out = True
            self.death_count += 1
            reward += rw["deathPenalty"]
            self._load_level(self.level)

        # Potential-based shaping on the shortest-path distance to the current objective.
        # (Skipped on steps where the objective itself changed: plate pressed, level loaded...)
        if not (death or level_changed or done or objective_changed):
            dist_after = self._dist_at(self.position[0], self.position[1])
            if dist_before < INF and dist_after < INF:
                reward += rw["progress"] * (dist_before - dist_after)

        return {
            "observation": self.observe().copy(),
            "reward": reward,
            "done": done,
            "success": success,
            "hazard": hazard,
            "death": death,
            "timedOut": timed_out,
            "collision": collision,
            "rotatorHit": rotator_hit,
            "knockback": knockback,
            "jumpOverKey": key_of(jump_over_key) if jump_over_key else None,
            "timeStepsUsed": time_steps_used,
            "blocks": [list(c) for c in self.block_cells],
            "powerupType": self.powerup_type if self.powerup_until > self.sim_time_seconds else None,
            "powerupRemaining": max(0.0, self.powerup_until - self.sim_time_seconds),
            "leverOn": self.lever_on,
            "channelsOn": sorted(self.channels_on),
            "elevation": self.cell_height((self.position[0], self.position[1]), self.sim_time_seconds),
            "elevationBefore": elevation_before,
            "levelChanged": level_changed,
            "steps": self.episode_steps,
            "levelSteps": self.level_steps,
            "deaths": self.death_count,
            "collisions": self.collision_count,
            "coins": self.total_coins,
            "plates": self.total_plates,
            "level": self.level_index,
            "simTime": self.sim_time_seconds,
        }
