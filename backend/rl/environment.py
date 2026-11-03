"""Headless grid simulation environment for The-ReaL-Exit reinforcement learning.

Simulates movement, physics-grid collisions, hazards, rotators, movers,
pressure plates, doors, and coins using the same level specifications as the
3D runtime and editor.
"""

import math
from typing import Any, Dict, List, Optional, Set, Tuple

from backend.config import (
    ACTIONS,
    DEFAULT_REWARDS,
    LEVEL_TIME_LIMIT_STEPS,
    LOCAL_VIEW_CHANNELS,
    LOCAL_VIEW_RADIUS,
    MAX_TRACKED,
    OBSERVATION_SIZE,
    RL_ACTION_DURATION_SECONDS,
    PLAYER_JUMP_DURATION_SECONDS,
    PLAYER_JUMP_IMPULSE,
    WORLD_GRAVITY,
)


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
        self.random_state = self.seed & 0xFFFFFFFF

        # Tracking variables
        self.level_index = 0
        self.episode_complete = False
        self.episode_steps = 0
        self.simulation_steps = 0
        self.collision_count = 0
        self.death_count = 0
        self.total_coins = 0
        self.total_plates = 0
        self.level_changes = 0

        # Level state
        self.level: Dict[str, Any] = {}
        self.level_steps = 0
        self.size = 13
        self.position = [0, 0]
        self.heading = 0
        self.walls: Set[str] = set()
        self.blocks: Set[str] = set()
        self.hazards: Set[str] = set()
        self.rotator_cells: List[List[int]] = []
        self.rotators: Set[str] = set()
        self.rotator_footprint: Set[str] = set()
        self.movers: Set[str] = set()
        self.plates: List[List[int]] = []
        self.plate_mask = 0
        self.coins: List[List[int]] = []
        self.coin_mask = 0
        self.switches: List[List[int]] = []
        self._switch_keys: Set[str] = set()  # O(1) lookup cache
        self.switch_on = False
        self.exit_door: List[int] = [0, 0]
        self._exit_door_key: str = ""
        self.doors_open = False
        self.stairs: Set[str] = set()
        self.platforms: Set[str] = set()

        # O(1) lookup maps for coin/plate indices by cell key
        self._coin_key_to_idx: Dict[str, int] = {}
        self._plate_key_to_idx: Dict[str, int] = {}

        # Cached observation array — reused each call to avoid per-step allocation
        self._obs = [0.0] * OBSERVATION_SIZE

        self.reset()

    def random(self) -> float:
        """Linear congruential generator matching runtime RNG for deterministic simulation."""
        self.random_state = (1664525 * self.random_state + 1013904223) & 0xFFFFFFFF
        return self.random_state / 0x100000000

    def reset(self) -> List[float]:
        """Reset the environment to the beginning of the campaign/level set."""
        self.level_index = 0
        self.episode_complete = False
        self.episode_steps = 0
        self.simulation_steps = 0
        self.collision_count = 0
        self.death_count = 0
        self.total_coins = 0
        self.total_plates = 0
        self.level_changes = 0
        self._load_level(self.levels[0])
        return self.observe()

    def _load_level(self, level: Dict[str, Any]) -> None:
        """Load and parse level geometry, hazards, and interactive targets."""
        self.level = level
        self.level_steps = 0
        self.size = int(level.get("size", 13))
        start_cell = level.get("start") or [self.size // 2, 1]
        self.position = [int(start_cell[0]), int(start_cell[1])]
        self.heading = 0  # 0: +Z forward, 1: +X right, 2: -Z back, 3: -X left

        self.walls = {key_of(c) for c in level.get("walls", [])}
        self.blocks = {key_of(c) for c in level.get("blocks", [])}
        self.hazards = {key_of(c) for c in level.get("hazards", [])}
        self.rotator_cells = [list(c) for c in level.get("rotators", [])]
        self.rotators = {key_of(c) for c in self.rotator_cells}
        self.rotator_footprint = set()
        self.movers = {key_of(c) for c in level.get("movers", [])}
        self.plates = [list(c) for c in level.get("plates", [])[:MAX_TRACKED]]
        self.plate_mask = 0
        self.coins = [list(c) for c in level.get("coins", [])[:MAX_TRACKED]]
        self.coin_mask = 0
        self.switches = [list(c) for c in level.get("switches", [])]
        self._switch_keys = {key_of(s) for s in self.switches}
        self.switch_on = False

        door = level.get("exitDoor") or level.get("goal") or [self.size // 2, self.size - 1]
        self.exit_door = [int(door[0]), int(door[1])]
        self._exit_door_key = key_of(self.exit_door)
        self.doors_open = len(self.plates) == 0
        self.stairs = {key_of(c) for c in level.get("stairs", [])}
        self.platforms = {key_of(c) for c in level.get("platforms", [])}

        # Build O(1) lookup maps for coins and plates
        self._coin_key_to_idx = {key_of(c): i for i, c in enumerate(self.coins)}
        self._plate_key_to_idx = {key_of(p): i for i, p in enumerate(self.plates)}

    def get_state_key(self) -> str:
        """Return a compact discretized state key for tabular policies.

        Uses only the most discriminative features (heading, masks, door sensor)
        rather than the full 726-element vector — much cheaper than calling observe().
        """
        timer_bucket = min(5, math.floor(self.level_steps / LEVEL_TIME_LIMIT_STEPS * 6))
        door_sensor = self._visible_door_sensor(10.0)
        return (
            f"{self.heading},{self.plate_mask},{self.coin_mask},{self.level_index},"
            f"{int(self.doors_open)},{timer_bucket},{min(10, self.death_count)},"
            f"{int(door_sensor['visible'])},{round(door_sensor['lateral'] * 10)},{round(door_sensor['forward'] * 10)}"
        )

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

    def observe(self) -> List[float]:
        """Construct the heading-relative local grid and scalar status vector."""
        x, z = self.position
        obs = self._obs
        i = 0

        # One-hot heading (4)
        for d in range(4):
            obs[i] = 1.0 if self.heading == d else 0.0
            i += 1

        # Tracked plate mask bits (8)
        for bit in range(MAX_TRACKED):
            obs[i] = 1.0 if bool(self.plate_mask & (1 << bit)) else 0.0
            i += 1

        # Tracked coin mask bits (8)
        for bit in range(MAX_TRACKED):
            obs[i] = 1.0 if bool(self.coin_mask & (1 << bit)) else 0.0
            i += 1

        # One-hot level index (8)
        for lvl in range(MAX_TRACKED):
            obs[i] = 1.0 if lvl == self.level_index else 0.0
            i += 1

        # Door state, time remaining, death ratio, episode complete
        obs[i] = 1.0 if self.doors_open else 0.0; i += 1
        obs[i] = clamp(1.0 - self.level_steps / LEVEL_TIME_LIMIT_STEPS, 0.0, 1.0); i += 1
        obs[i] = clamp(self.death_count / 10.0, 0.0, 1.0); i += 1
        obs[i] = 1.0 if self.episode_complete else 0.0; i += 1

        # Door sensor (visible, lateral, forward)
        door_sensor = self._visible_door_sensor(10.0)
        obs[i] = float(door_sensor["visible"]); i += 1
        obs[i] = float(door_sensor["lateral"]); i += 1
        obs[i] = float(door_sensor["forward"]); i += 1

        # Moving obstacle phase features
        rotator_visible = self._visible_set(self.rotators)
        mover_visible = self._visible_set(self.movers)
        sim_step = self.simulation_steps
        for phase in range(3):
            obs[i] = 1.0 if (rotator_visible and int(sim_step) % 3 == phase) else 0.0; i += 1
        for phase in range(2):
            obs[i] = 1.0 if (mover_visible and int(sim_step) % 2 == phase) else 0.0; i += 1

        # Heading direction vectors (precomputed from direction table)
        fwd_x, fwd_z = _DIRS[self.heading]
        left_x, left_z = -fwd_z, fwd_x

        # Cache attribute lookups in locals — avoids repeated self. resolution in inner loop
        walls = self.walls
        blocks = self.blocks
        hazards = self.hazards
        rotators = self._current_rotator_footprint()
        movers = self.movers
        platforms = self.platforms
        stairs = self.stairs
        coin_mask = self.coin_mask
        coin_key_idx = self._coin_key_to_idx
        plate_mask = self.plate_mask
        plate_key_idx = self._plate_key_to_idx
        switch_keys = self._switch_keys
        switch_on = self.switch_on
        exit_door_key = self._exit_door_key
        doors_open = self.doors_open
        size = self.size
        los = self._has_line_of_sight
        RADIUS = LOCAL_VIEW_RADIUS
        CHANNELS = LOCAL_VIEW_CHANNELS

        # Local view grid: 7 x 7 cells, LOCAL_VIEW_CHANNELS features each
        for local_forward in range(RADIUS, -RADIUS - 1, -1):
            for local_left in range(-RADIUS, RADIUS + 1):
                wx = x + fwd_x * local_forward + left_x * local_left
                wz = z + fwd_z * local_forward + left_z * local_left
                key = f"{wx},{wz}"

                if los([wx, wz], RADIUS):
                    out_of_bounds = wx < 0 or wz < 0 or wx >= size or wz >= size
                    obs[i]     = 1.0 if (out_of_bounds or key in walls) else 0.0
                    obs[i + 1] = 1.0 if key in blocks else 0.0
                    obs[i + 2] = 1.0 if key in hazards else 0.0
                    obs[i + 3] = 1.0 if key in rotators else 0.0
                    obs[i + 4] = 1.0 if key in movers else 0.0
                    obs[i + 5] = 1.0 if key in platforms else 0.0
                    obs[i + 6] = 1.0 if key in stairs else 0.0

                    # Coin: visible and not yet collected
                    ci = coin_key_idx.get(key, -1)
                    obs[i + 7] = 1.0 if (ci >= 0 and not (coin_mask & (1 << ci))) else 0.0

                    # Plate: uncollected (ch8) or already collected (ch9)
                    pi = plate_key_idx.get(key, -1)
                    if pi >= 0:
                        collected = bool(plate_mask & (1 << pi))
                        obs[i + 8] = 0.0 if collected else 1.0
                        obs[i + 9] = 1.0 if collected else 0.0
                    else:
                        obs[i + 8] = 0.0; obs[i + 9] = 0.0

                    # Switch: off (ch10) or on (ch13)
                    if key in switch_keys:
                        obs[i + 10] = 0.0 if switch_on else 1.0
                        obs[i + 11] = 0.0; obs[i + 12] = 0.0
                        obs[i + 13] = 1.0 if switch_on else 0.0
                    elif key == exit_door_key:
                        # Exit door: closed (ch11) or open (ch12)
                        obs[i + 10] = 0.0
                        obs[i + 11] = 0.0 if doors_open else 1.0
                        obs[i + 12] = 1.0 if doors_open else 0.0
                        obs[i + 13] = 0.0
                    else:
                        obs[i + 10] = 0.0; obs[i + 11] = 0.0
                        obs[i + 12] = 0.0; obs[i + 13] = 0.0
                else:
                    for j in range(CHANNELS):
                        obs[i + j] = 0.0

                i += CHANNELS

        return obs

    def _has_line_of_sight(self, target: List[int], max_distance: float) -> bool:
        """Check line-of-sight ray between agent position and target cell."""
        x, z = self.position
        dx = target[0] - x
        dz = target[1] - z
        distance = math.hypot(dx, dz)
        if distance > max_distance:
            return False

        steps = math.ceil(max(abs(dx), abs(dz)))
        walls = self.walls
        blocks = self.blocks
        for step in range(1, steps):
            sx = round(x + dx * step / steps)
            sz = round(z + dz * step / steps)
            k = f"{sx},{sz}"
            if k in walls or k in blocks:
                return False
        return True

    def _visible_set(self, cells: Set[str]) -> bool:
        """Check if any cell in a given set is within radius and line-of-sight."""
        px, pz = self.position
        RADIUS = LOCAL_VIEW_RADIUS
        los = self._has_line_of_sight
        for key in cells:
            cx, cz = map(int, key.split(","))
            if max(abs(cx - px), abs(cz - pz)) <= RADIUS and los([cx, cz], RADIUS):
                return True
        return False

    def _visible_door_sensor(self, max_distance: float) -> Dict[str, float]:
        """Compute relative forward and lateral distance to the exit door if visible."""
        x, z = self.position
        door_x, door_z = self.exit_door
        dx = door_x - x
        dz = door_z - z
        distance = math.hypot(dx, dz)
        if distance == 0 or not self._has_line_of_sight(self.exit_door, max_distance):
            return {"visible": 0.0, "lateral": 0.0, "forward": 0.0}

        fwd_x, fwd_z = _DIRS[self.heading]
        left_x, left_z = -fwd_z, fwd_x
        return {
            "visible": 1.0,
            "lateral": (dx * left_x + dz * left_z) / max_distance,
            "forward": (dx * fwd_x + dz * fwd_z) / max_distance,
        }

    def _visible_objective_target(self) -> Optional[List[int]]:
        """Identify the closest visible objective (remaining plate or exit door)."""
        remaining_plates = [p for idx, p in enumerate(self.plates) if not (self.plate_mask & (1 << idx))]
        if remaining_plates:
            px, pz = self.position
            RADIUS = LOCAL_VIEW_RADIUS
            los = self._has_line_of_sight
            visible = [
                p for p in remaining_plates
                if max(abs(p[0] - px), abs(p[1] - pz)) <= RADIUS and los(p, RADIUS)
            ]
            if not visible:
                return None
            return min(visible, key=lambda c: abs(c[0] - self.position[0]) + abs(c[1] - self.position[1]))

        return self.exit_door if self._visible_door_sensor(10.0)["visible"] else None

    def _static_blocked(self, x: int, z: int) -> bool:
        """Check walls, blocks, and sealed doors without moving obstacles."""
        if x < 0 or z < 0 or x >= self.size or z >= self.size:
            return True
        k = f"{x},{z}"
        return k in self.walls or k in self.blocks or (k == self._exit_door_key and not self.doors_open)

    def _rotator_overlaps(self, x: float, z: float, rotor: List[int], time_seconds: float, jump_height: float = 0.0, index: int = 0) -> bool:
        """Test the player's box against the rotating Rapier bar collider."""
        player_center_y = PLAYER_CENTER_Y + jump_height
        if abs(player_center_y - 0.55) > 0.37 + 0.12:
            return False

        speed = float(self.level.get("rotatorSpeed", 1.1))
        direction = -1.0 if index % 2 else 1.0
        angle = time_seconds * speed * direction
        cosine = math.cos(angle)
        sine = math.sin(angle)
        dx = x - rotor[0]
        dz = z - rotor[1]
        local_x = dx * cosine - dz * sine
        local_z = dx * sine + dz * cosine

        # Minkowski-expand the bar by the player's half-width so contact is
        # registered before the rendered box can visibly clip into the beam.
        return abs(local_x) <= ROTATOR_HALF_LENGTH + 0.37 and abs(local_z) <= ROTATOR_HALF_THICKNESS + 0.37

    def _rotator_blocker(self, x: float, z: float, time_seconds: Optional[float] = None, jump_height: float = 0.0) -> Optional[List[int]]:
        """Find a rotor overlapping this player position at a specific time."""
        if time_seconds is None:
            time_seconds = self.simulation_steps * RL_ACTION_DURATION_SECONDS
        for index, rotor in enumerate(self.rotator_cells):
            if self._rotator_overlaps(x, z, rotor, time_seconds, jump_height, index):
                return rotor
        return None

    def _rotator_collision_during_move(self, start: List[int], end: List[int], duration: float, jumping: bool = False) -> Optional[List[int]]:
        """Sweep player movement and rotor rotation over the action duration."""
        start_time = self.simulation_steps * RL_ACTION_DURATION_SECONDS
        travel = math.hypot(end[0] - start[0], end[1] - start[1])
        max_speed = max(0.1, float(self.level.get("rotatorSpeed", 1.1)))
        samples = max(6, math.ceil(travel / 0.08), math.ceil(max_speed * duration / 0.06))

        for index, rotor in enumerate(self.rotator_cells):
            starts_overlapping = self._rotator_overlaps(start[0], start[1], rotor, start_time, 0.0, index)
            ends_overlapping = self._rotator_overlaps(end[0], end[1], rotor, start_time + duration, 0.0, index)
            if starts_overlapping and not ends_overlapping and not jumping:
                # Let an already-overlapping agent step out of the collider.
                continue

            for sample in range(1, samples + 1):
                amount = sample / samples
                px = start[0] + (end[0] - start[0]) * amount
                pz = start[1] + (end[1] - start[1]) * amount
                jump_time = duration * amount if jumping else 0.0
                jump_height = max(0.0, PLAYER_JUMP_IMPULSE * jump_time - 0.5 * WORLD_GRAVITY * jump_time * jump_time)
                if self._rotator_overlaps(px, pz, rotor, start_time + duration * amount, jump_height, index):
                    return rotor
        return None

    def _current_rotator_footprint(self) -> Set[str]:
        """Rasterize the currently visible collider footprint into perception cells."""
        time_seconds = self.simulation_steps * RL_ACTION_DURATION_SECONDS
        footprint: Set[str] = set()
        for index, rotor in enumerate(self.rotator_cells):
            for dx in range(-2, 3):
                for dz in range(-2, 3):
                    x, z = rotor[0] + dx, rotor[1] + dz
                    if (0 <= x < self.size and 0 <= z < self.size
                            and self._rotator_overlaps(x, z, rotor, time_seconds, 0.0, index)):
                        footprint.add(key_of([x, z]))
        return footprint

    def _blocked(self, x: int, z: int) -> bool:
        """Check walls, blocks, and sealed doors; rotors are checked over time."""
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
        reward = self.rewards["timeStep"]
        done = False
        success = False
        level_changed = False
        collision = False
        hazard = False
        death = False
        timed_out = False
        rotator_hit = False
        knockback: Optional[Dict[str, float]] = None
        jump_over_key: Optional[str] = None
        previous_position = list(self.position)

        action_id = ACTIONS[action]["id"] if 0 <= action < len(ACTIONS) else "wait"
        visible_target = self._visible_objective_target()
        before_distance = (
            abs(visible_target[0] - self.position[0]) + abs(visible_target[1] - self.position[1])
            if visible_target else None
        )

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
            if key_of(self.position) in self.rotators:
                move = [0, 0]
            else:
                first_cell = [self.position[0] + fx, self.position[1] + fz]
                landing = [self.position[0] + fx * 2, self.position[1] + fz * 2]
                first_key = key_of(first_cell)
                landing_key = key_of(landing)
                jumpable = first_key in self.hazards or first_key in self.rotators or first_key in self.movers
                landing_is_hazard = landing_key in self.hazards or landing_key in self.movers
                if jumpable and not self._blocked(landing[0], landing[1]) and not landing_is_hazard:
                    move = [fx * 2, fz * 2]
                    jump_over_key = first_key
                else:
                    move = [fx, fz]
        elif action_id == "interact":
            facing_key = key_of([self.position[0] + fx, self.position[1] + fz])
            if facing_key in self._switch_keys:
                self.switch_on = not self.switch_on
                reward += self.rewards["switch"]
            else:
                reward += self.rewards["invalidInteract"]

        if move:
            nx, nz = self.position[0] + move[0], self.position[1] + move[1]
            key = f"{nx},{nz}"

            if key in self.blocks:
                beyond = [nx + move[0], nz + move[1]]
                beyond_key = key_of(beyond)
                beyond_blocked = (
                    beyond[0] < 0 or beyond[1] < 0 or beyond[0] >= self.size or beyond[1] >= self.size
                    or beyond_key in self.walls or beyond_key in self.blocks
                    or (beyond_key == self._exit_door_key and not self.doors_open)
                )
                if not beyond_blocked:
                    self.blocks.remove(key)
                    self.blocks.add(beyond_key)
                    reward += self.rewards["pushBlock"]

            rotor = self._rotator_collision_during_move(
                previous_position,
                [nx, nz],
                time_steps_used * RL_ACTION_DURATION_SECONDS,
                jumping,
            )
            if self._static_blocked(nx, nz):
                collision = True
                self.collision_count += 1
                reward += self.rewards["collision"]
            elif rotor:
                collision = True
                rotator_hit = True
                self.collision_count += 1
                reward += self.rewards["rotatorCollision"]
                self.position, knockback = self._push_from_rotator(
                    previous_position, rotor, [-fx, -fz]
                )
            else:
                self.position = [nx, nz]
                if key in self.hazards:
                    hazard = True
                    death = True
                    self.death_count += 1
                    self.collision_count += 1
                    reward += self.rewards["hazard"] + self.rewards["deathPenalty"]
                    self._load_level(self.level)
                else:
                    if jump_over_key and key_of([nx - fx, nz - fz]) == jump_over_key:
                        reward += self.rewards["jumpHazard"]

                    ci = self._coin_key_to_idx.get(key, -1)
                    if ci >= 0 and not (self.coin_mask & (1 << ci)):
                        self.coin_mask |= 1 << ci
                        self.total_coins += 1
                        reward += self.rewards["coin"]

                    pi = self._plate_key_to_idx.get(key, -1)
                    if pi >= 0 and not (self.plate_mask & (1 << pi)):
                        self.plate_mask |= 1 << pi
                        self.total_plates += 1
                        reward += self.rewards["plate"]
                        if self.plate_mask == (1 << len(self.plates)) - 1:
                            self.doors_open = True
                            reward += self.rewards["doorOpen"]

                    if key in self.movers and int(self.simulation_steps) % 2 == 0:
                        collision = True
                        self.collision_count += 1
                        reward += self.rewards["moverCollision"]

                    if key in self.platforms:
                        collision = True
                        self.collision_count += 1
                        reward += self.rewards["platformCollision"]

        elif (rotor := self._rotator_collision_during_move(
            previous_position,
            previous_position,
            time_steps_used * RL_ACTION_DURATION_SECONDS,
            jumping,
        )) is not None:
            # A rotating bar can strike a stationary agent during wait, turn,
            # or interaction actions as well as during translation.
            collision = True
            rotator_hit = True
            self.collision_count += 1
            reward += self.rewards["rotatorCollision"]
            self.position, knockback = self._push_from_rotator(
                previous_position, rotor, [-fx, -fz]
            )

        self.episode_steps += 1
        self.simulation_steps += time_steps_used
        if not death:
            self.level_steps += time_steps_used

        # Check door reach / level clear
        pos_key = key_of(self.position)
        if not done and not death and self.doors_open and pos_key == self._exit_door_key:
            reward += self.rewards["goal"]
            reward += self.rewards["speedBonus"] * clamp(1.0 - self.level_steps / LEVEL_TIME_LIMIT_STEPS, 0.0, 1.0)
            if self.level_index + 1 < len(self.levels):
                self.level_index += 1
                self.level_changes += 1
                self._load_level(self.levels[self.level_index])
                level_changed = True
            else:
                done = True
                success = True
                self.episode_complete = True

        # Timeout penalty & restart
        if not done and not death and not level_changed and self.level_steps >= LEVEL_TIME_LIMIT_STEPS:
            death = True
            timed_out = True
            self.death_count += 1
            reward += self.rewards["deathPenalty"]
            self._load_level(self.level)

        # Progress reward based on distance to visible target
        if not done and not death and not level_changed and move and not collision and visible_target:
            after_distance = abs(visible_target[0] - self.position[0]) + abs(visible_target[1] - self.position[1])
            if after_distance < before_distance:
                reward += self.rewards["progress"]
            elif after_distance > before_distance:
                reward -= self.rewards["progress"]

        return {
            "observation": list(self.observe()),  # list() copies the cached array
            "reward": reward,
            "done": done,
            "success": success,
            "hazard": hazard,
            "death": death,
            "timedOut": timed_out,
            "collision": collision,
            "rotatorHit": rotator_hit,
            "knockback": knockback,
            "jumpOverKey": jump_over_key,
            "timeStepsUsed": time_steps_used,
            "levelChanged": level_changed,
            "steps": self.episode_steps,
            "levelSteps": self.level_steps,
            "deaths": self.death_count,
            "collisions": self.collision_count,
            "coins": self.total_coins,
            "plates": self.total_plates,
            "level": self.level_index,
        }
