"""Headless grid simulation environment for The-ReaL-Exit reinforcement learning.

Simulates movement, grid collisions, hazards, rotators, movers, pressure plates, doors
and coins using the same level specifications as the 3D runtime and the editor.

What makes this environment *learnable* (compared with a raw 7x7 view):

* ``observe()`` returns an egocentric 9x9 window with **time-resolved rotator danger**
  layers (which cells will be swept by a bar during each of the next 4 actions).
* A cached **shortest-path distance field** to the current objective (plate, then exit)
  provides a compass (is each neighbour closer?) and a potential-based shaping reward.
* Training can start every episode on a **random level** with a **random rotator phase**.
"""

import heapq
import math
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np

from backend.config import (
    ACTIONS,
    DANGER_HORIZON,
    DEFAULT_REWARDS,
    LEVEL_TIME_LIMIT_STEPS,
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
ROTATOR_HALF_LENGTH = 1.04
ROTATOR_HALF_THICKNESS = 0.16
PLAYER_CENTER_Y = 0.42
PLAYER_HALF = 0.37
_LIMIT_X = ROTATOR_HALF_LENGTH + PLAYER_HALF
_LIMIT_Z = ROTATOR_HALF_THICKNESS + PLAYER_HALF
JUMP_COST = 4.0
INF = 1.0e9
PAD = LOCAL_VIEW_RADIUS

# Static channel indices
CH_WALL, CH_BLOCK, CH_HAZARD, CH_MOVER, CH_PLATFORM, CH_COIN, CH_PLATE, CH_DOOR_CLOSED, CH_DOOR_OPEN, CH_SWITCH = range(10)
assert STATIC_CHANNELS == 10


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
        self.size = 13
        self.position = [0, 0]
        self.heading = 0
        self.walls: Set[Cell] = set()
        self.blocks: Set[Cell] = set()
        self.hazards: Set[Cell] = set()
        self.rotator_cells: List[List[int]] = []
        self.rotators: Set[Cell] = set()
        self.movers: Set[Cell] = set()
        self.plates: List[List[int]] = []
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

        self._coin_key_to_idx: Dict[Cell, int] = {}
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
        self._plates_remaining = 0
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
        self.level = level
        self.level_steps = 0.0
        self.size = int(level.get("size", 13))
        start_cell = level.get("start") or [self.size // 2, 1]
        self.position = [int(start_cell[0]), int(start_cell[1])]
        self.heading = 0

        self.walls = {(int(c[0]), int(c[1])) for c in level.get("walls", [])}
        self.blocks = {(int(c[0]), int(c[1])) for c in level.get("blocks", [])}
        self.hazards = {(int(c[0]), int(c[1])) for c in level.get("hazards", [])}
        self.rotator_cells = [[int(c[0]), int(c[1])] for c in level.get("rotators", [])]
        self.rotators = {(c[0], c[1]) for c in self.rotator_cells}
        self.movers = {(int(c[0]), int(c[1])) for c in level.get("movers", [])}
        self.plates = [[int(c[0]), int(c[1])] for c in level.get("plates", [])[:MAX_TRACKED]]
        self.plate_mask = 0
        self.coins = [[int(c[0]), int(c[1])] for c in level.get("coins", [])[:MAX_TRACKED]]
        self.coin_mask = 0
        self.switches = [[int(c[0]), int(c[1])] for c in level.get("switches", [])]
        self._switch_keys = {(s[0], s[1]) for s in self.switches}
        self.switch_on = False

        door = level.get("exitDoor") or level.get("goal") or [self.size // 2, self.size - 1]
        self.exit_door = [int(door[0]), int(door[1])]
        self._exit_door_key = (self.exit_door[0], self.exit_door[1])
        self.doors_open = len(self.plates) == 0
        self.stairs = {(int(c[0]), int(c[1])) for c in level.get("stairs", [])}
        self.platforms = {(int(c[0]), int(c[1])) for c in level.get("platforms", [])}

        self._coin_key_to_idx = {(c[0], c[1]): i for i, c in enumerate(self.coins)}
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

    def get_state_key(self) -> str:
        """Compact state key (kept for API compatibility; the neural agents ignore it)."""
        return f"{self.level_index},{self.position[0]},{self.position[1]},{self.heading},{self.plate_mask},{self.coin_mask}"

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
        size = self.size
        st = np.zeros((STATIC_CHANNELS, size + 2 * PAD, size + 2 * PAD), dtype=np.float32)
        st[CH_WALL] = 1.0
        st[CH_WALL, PAD:PAD + size, PAD:PAD + size] = 0.0

        def mark(channel: int, cells, value: float = 1.0) -> None:
            for (cx, cz) in cells:
                if 0 <= cx < size and 0 <= cz < size:
                    st[channel, cx + PAD, cz + PAD] = value

        mark(CH_WALL, self.walls)
        mark(CH_HAZARD, self.hazards)
        mark(CH_MOVER, self.movers)
        mark(CH_PLATFORM, self.platforms)
        self._static = st
        self._sync_dynamic()

    def _sync_dynamic(self) -> None:
        """Refresh channels that change during play (blocks, coins, plates, door, switch)."""
        st = self._static
        size = self.size
        st[CH_BLOCK] = 0.0
        st[CH_COIN] = 0.0
        st[CH_PLATE] = 0.0
        st[CH_DOOR_CLOSED] = 0.0
        st[CH_DOOR_OPEN] = 0.0
        st[CH_SWITCH] = 0.0
        for (cx, cz) in self.blocks:
            if 0 <= cx < size and 0 <= cz < size:
                st[CH_BLOCK, cx + PAD, cz + PAD] = 1.0
        for i, c in enumerate(self.coins):
            if not (self.coin_mask & (1 << i)):
                st[CH_COIN, c[0] + PAD, c[1] + PAD] = 1.0
        for i, p in enumerate(self.plates):
            if not (self.plate_mask & (1 << i)):
                st[CH_PLATE, p[0] + PAD, p[1] + PAD] = 1.0
        ex, ez = self.exit_door
        st[CH_DOOR_OPEN if self.doors_open else CH_DOOR_CLOSED, ex + PAD, ez + PAD] = 1.0
        for (sx, sz) in self._switch_keys:
            st[CH_SWITCH, sx + PAD, sz + PAD] = 1.0 if self.switch_on else 0.5

    # ── Shortest-path distance field (the "compass") ───────────────────────────────────
    def _standable(self, x: int, z: int) -> bool:
        """Cells the agent can safely stand on, ignoring (time-varying) rotating bars."""
        if x < 0 or z < 0 or x >= self.size or z >= self.size:
            return False
        c = (x, z)
        if c in self.walls or c in self.blocks or c in self.hazards or c in self.movers or c in self.rotators:
            return False
        if c == self._exit_door_key and not self.doors_open:
            return False
        return True

    def _refresh_objective(self) -> None:
        """Recompute targets and the Dijkstra distance field to the nearest objective."""
        targets = [(p[0], p[1]) for i, p in enumerate(self.plates) if not (self.plate_mask & (1 << i))]
        self._plates_remaining = len(targets)
        if not targets:
            targets = [self._exit_door_key]
        self._targets = targets

        size = self.size
        dist = [INF] * (size * size)
        heap: List[Tuple[float, int, int]] = []
        for (tx, tz) in targets:
            if 0 <= tx < size and 0 <= tz < size:
                dist[tx * size + tz] = 0.0
                heap.append((0.0, tx, tz))
        heapq.heapify(heap)
        jumpables = self.hazards | self.rotators | self.movers
        standable = self._standable
        while heap:
            d, x, z = heapq.heappop(heap)
            if d > dist[x * size + z]:
                continue
            for fx, fz in _DIRS:
                nx, nz = x + fx, z + fz
                if standable(nx, nz) and d + 1.0 < dist[nx * size + nz]:
                    dist[nx * size + nz] = d + 1.0
                    heapq.heappush(heap, (d + 1.0, nx, nz))
                # A jump launched from (x - 2f) over a hazard at (x - f) lands here.
                if (x - fx, z - fz) in jumpables:
                    ax, az = x - 2 * fx, z - 2 * fz
                    if standable(ax, az) and d + JUMP_COST < dist[ax * size + az]:
                        dist[ax * size + az] = d + JUMP_COST
                        heapq.heappush(heap, (d + JUMP_COST, ax, az))
        self._dist = dist
        self._dist_np = np.array(dist, dtype=np.float64).reshape(size, size)

    def _dist_at(self, x: int, z: int) -> float:
        if x < 0 or z < 0 or x >= self.size or z >= self.size:
            return INF
        return self._dist[x * self.size + z]

    # ── Rotating bars ──────────────────────────────────────────────────────────────────
    def _rotator_matrix(self, xs, zs, times, jump_heights) -> np.ndarray:
        """Overlap of player boxes (S points) against every rotating bar -> bool (S, R)."""
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

    def _rotator_collision_during_move(self, start: List[int], end: List[int], duration: float, jumping: bool = False) -> Optional[List[int]]:
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
        hits = self._rotator_matrix(px, pz, times, heights)  # (S, R)

        ends = self._rotator_matrix([end[0]], [end[1]], [start_time + duration], [0.0])[0]
        starts = self._rotator_matrix([start[0]], [start[1]], [start_time], [0.0])[0]
        any_hit = hits.any(axis=0)
        for index in range(len(self.rotator_cells)):
            if starts[index] and not ends[index] and not jumping:
                # Let an already-overlapping agent step out of the collider.
                continue
            if any_hit[index]:
                return self.rotator_cells[index]
        return None

    def _danger_layers(self, wx: np.ndarray, wz: np.ndarray) -> np.ndarray:
        """Bool (H, W, W): cell is swept by a bar during action k (k = 0 is the action about to be taken)."""
        horizon = DANGER_HORIZON
        out = np.zeros((horizon, LOCAL_VIEW_WIDTH, LOCAL_VIEW_WIDTH), dtype=np.float32)
        if not self.rotator_cells:
            return out
        half = RL_ACTION_DURATION_SECONDS / 2.0
        times = self.sim_time_seconds + np.arange(2 * horizon + 1) * half  # (T,)
        angle = times[:, None] * self._rot_speed * self._rot_dir[None, :]  # (T, R)
        cosine = np.cos(angle)[None, :, :]
        sine = np.sin(angle)[None, :, :]
        dx = (wx.reshape(-1, 1, 1) - self._rot_x[None, None, :])
        dz = (wz.reshape(-1, 1, 1) - self._rot_z[None, None, :])
        local_x = dx * cosine - dz * sine
        local_z = dx * sine + dz * cosine
        hit = ((np.abs(local_x) <= _LIMIT_X) & (np.abs(local_z) <= _LIMIT_Z)).any(axis=2)  # (N, T)
        for k in range(horizon):
            out[k] = hit[:, 2 * k:2 * k + 3].any(axis=1).reshape(LOCAL_VIEW_WIDTH, LOCAL_VIEW_WIDTH)
        return out

    # ── Observation ────────────────────────────────────────────────────────────────────
    def observe(self) -> np.ndarray:
        """Egocentric local grid + scalar compass features (float32, length OBSERVATION_SIZE)."""
        x, z = self.position
        h = self.heading
        obs = self._obs
        width = LOCAL_VIEW_WIDTH

        wx = x + _DX[h]
        wz = z + _DZ[h]
        view = obs[:LOCAL_VIEW_SIZE].reshape(LOCAL_VIEW_CHANNELS, width, width)
        view[:STATIC_CHANNELS] = self._static[:, wx + PAD, wz + PAD]
        view[STATIC_CHANNELS:] = self._danger_layers(wx, wz)

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
        s[10] = clamp(1.0 - self.level_steps / LEVEL_TIME_LIMIT_STEPS, 0.0, 1.0)
        s[11] = 1.0 if self.doors_open else 0.0
        s[12] = self._plates_remaining / max(1, len(self.plates))
        s[13] = (len(self.coins) - bin(self.coin_mask).count("1")) / max(1, len(self.coins))
        even = int(self.simulation_steps) % 2 == 0
        s[14] = 1.0 if even else 0.0
        s[15] = 0.0 if even else 1.0
        return obs

    def action_mask(self) -> np.ndarray:
        """Boolean mask of *sensible* actions in the current state (invalid-action masking).

        Masks only actions that can never help: walking into walls, stepping on lava, walking
        into a bar's hub, jumping with nothing to jump over, or pressing E with no switch ahead.
        Everything that needs *judgement* (timing a bar, when to wait, when to jump) stays open.
        """
        mask = np.ones(len(ACTIONS), dtype=bool)
        x, z = self.position
        fx, fz = _DIRS[self.heading]
        directions = ((fx, fz), (-fx, -fz), (-fz, fx), (fz, -fx))
        for slot, (dx, dz) in enumerate(directions):
            cell = (x + dx, z + dz)
            if cell in self.blocks:
                beyond = (cell[0] + dx, cell[1] + dz)
                if self._static_blocked(*beyond):
                    mask[slot] = False
            elif self._static_blocked(*cell) or cell in self.hazards or cell in self.rotators:
                mask[slot] = False
        first = (x + fx, z + fz)
        landing = (x + 2 * fx, z + 2 * fz)
        mask[6] = (
            first in self.hazards or first in self.rotators or first in self.movers
        ) and not self._static_blocked(*landing) and landing not in self.hazards and landing not in self.movers
        mask[7] = first in self._switch_keys
        return mask

    # ── Dynamics ───────────────────────────────────────────────────────────────────────
    def _static_blocked(self, x: int, z: int) -> bool:
        """Check walls, blocks, and sealed doors without moving obstacles."""
        if x < 0 or z < 0 or x >= self.size or z >= self.size:
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
                first_cell = (self.position[0] + fx, self.position[1] + fz)
                landing = (self.position[0] + fx * 2, self.position[1] + fz * 2)
                jumpable = first_cell in self.hazards or first_cell in self.rotators or first_cell in self.movers
                landing_is_hazard = landing in self.hazards or landing in self.movers
                if jumpable and not self._blocked(landing[0], landing[1]) and not landing_is_hazard:
                    move = [fx * 2, fz * 2]
                    jump_over_key = first_cell
                else:
                    move = [fx, fz]
        elif action_id == "interact":
            facing = (self.position[0] + fx, self.position[1] + fz)
            if facing in self._switch_keys:
                self.switch_on = not self.switch_on
                reward += rw["switch"]
                self._sync_dynamic()
            else:
                reward += rw["invalidInteract"]

        if move:
            nx, nz = self.position[0] + move[0], self.position[1] + move[1]
            key = (nx, nz)

            if key in self.blocks:
                beyond = (nx + move[0], nz + move[1])
                beyond_blocked = (
                    beyond[0] < 0 or beyond[1] < 0 or beyond[0] >= self.size or beyond[1] >= self.size
                    or beyond in self.walls or beyond in self.blocks
                    or (beyond == self._exit_door_key and not self.doors_open)
                )
                if not beyond_blocked:
                    self.blocks.remove(key)
                    self.blocks.add(beyond)
                    reward += rw["pushBlock"]
                    objective_changed = True
                    self._sync_dynamic()
                    self._refresh_objective()  # a pushed block can alter the maze

            rotor = self._rotator_collision_during_move(
                previous_position, [nx, nz], time_steps_used * RL_ACTION_DURATION_SECONDS, jumping,
            )
            if self._static_blocked(nx, nz):
                collision = True
                self.collision_count += 1
                reward += rw["collision"]
            elif rotor:
                collision = True
                rotator_hit = True
                self.collision_count += 1
                reward += rw["rotatorCollision"]
                self.position, knockback = self._push_from_rotator(previous_position, rotor, [-fx, -fz])
            else:
                self.position = [nx, nz]
                if key in self.hazards:
                    hazard = True
                    death = True
                    self.death_count += 1
                    self.collision_count += 1
                    reward += rw["hazard"] + rw["deathPenalty"]
                    self._load_level(self.level)
                else:
                    if jump_over_key and (nx - fx, nz - fz) == jump_over_key:
                        reward += rw["jumpHazard"]

                    ci = self._coin_key_to_idx.get(key, -1)
                    if ci >= 0 and not (self.coin_mask & (1 << ci)):
                        self.coin_mask |= 1 << ci
                        self.total_coins += 1
                        reward += rw["coin"]
                        self._sync_dynamic()

                    pi = self._plate_key_to_idx.get(key, -1)
                    if pi >= 0 and not (self.plate_mask & (1 << pi)):
                        self.plate_mask |= 1 << pi
                        self.total_plates += 1
                        reward += rw["plate"]
                        objective_changed = True
                        if self.plate_mask == (1 << len(self.plates)) - 1:
                            self.doors_open = True
                            reward += rw["doorOpen"]
                        self._sync_dynamic()
                        self._refresh_objective()

                    if key in self.movers and int(self.simulation_steps) % 2 == 0:
                        collision = True
                        self.collision_count += 1
                        reward += rw["moverCollision"]

                    if key in self.platforms:
                        collision = True
                        self.collision_count += 1
                        reward += rw["platformCollision"]

        elif (rotor := self._rotator_collision_during_move(
            previous_position, previous_position, time_steps_used * RL_ACTION_DURATION_SECONDS, jumping,
        )) is not None:
            collision = True
            rotator_hit = True
            self.collision_count += 1
            reward += rw["rotatorCollision"]
            self.position, knockback = self._push_from_rotator(previous_position, rotor, [-fx, -fz])

        self.episode_steps += 1
        self.simulation_steps += time_steps_used
        if not death:
            self.level_steps += time_steps_used

        pos_key = (self.position[0], self.position[1])
        if not done and not death and self.doors_open and pos_key == self._exit_door_key:
            reward += rw["goal"]
            reward += rw["speedBonus"] * clamp(1.0 - self.level_steps / LEVEL_TIME_LIMIT_STEPS, 0.0, 1.0)
            if self.level_index + 1 < len(self.levels):
                self.level_index += 1
                self.level_changes += 1
                self._load_level(self.levels[self.level_index])
                level_changed = True
            else:
                done = True
                success = True
                self.episode_complete = True

        if not done and not death and not level_changed and self.level_steps >= LEVEL_TIME_LIMIT_STEPS:
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
