/**
 * The-ReaL-Exit Game Constants & Level Data
 * Defines grid dimensions, the Skyway campaign, shared timing formulas and persistence keys.
 *
 * The level specs between the `generated:levels` markers are produced from backend/levels.py by
 * `python -m backend.tools.gen_levels`, so the 3D game and the RL environment always agree.
 */

export const GRID_SIZE = 17;               // default room size (levels may be any width x depth, see worldDims)
export const HALF_GRID = (GRID_SIZE - 1) / 2;
export const CAMPAIGN_VERSION = 4;     // bump when the built-in campaign changes
export const MIN_GRID = 9;
export const MAX_GRID = 41;
export const EXIT_OPENING_WIDTH = 1.5;     // legacy
export const DOOR_SPAN = 3;                // the exit gate fills 3 wall cells
export const DOOR_CLEAR = 2.4;             // clear width between the gate pillars (metres)

// The room being played / edited.  Live bindings: every importer sees the new values after setActiveGrid().
export let GRID_W = GRID_SIZE;
export let GRID_D = GRID_SIZE;
export let HALF_X = HALF_GRID;
export let HALF_Z = HALF_GRID;
export function worldDims(world) {
  const legacy = Number(world?.size) || GRID_SIZE;
  const clampDim = (v) => Math.max(MIN_GRID, Math.min(MAX_GRID, Math.round(Number(v) || legacy)));
  return { w: clampDim(world?.width), d: clampDim(world?.depth) };
}
export function setActiveGrid(w, d) {
  GRID_W = w; GRID_D = d; HALF_X = (w - 1) / 2; HALF_Z = (d - 1) / 2;
}
export function activateWorld(world) { const { w, d } = worldDims(world); setActiveGrid(w, d); return { w, d }; }

/** Which wall is the door on, and where along it?  side: 'z1' (far), 'z0', 'x1', 'x0'. */
export function doorSide(door, w = GRID_W, d = GRID_D) {
  if (!door) return null;
  if (door[1] === d - 1) return 'z1';
  if (door[1] === 0) return 'z0';
  if (door[0] === w - 1) return 'x1';
  if (door[0] === 0) return 'x0';
  return null;
}
/** Move a stray door to the nearest wall, clear of the corners (a gate needs 3 wall cells). */
export function snapDoorToWall(door, w, d) {
  const [x, z] = door;
  const gaps = { x0: x, x1: w - 1 - x, z0: z, z1: d - 1 - z };
  const side = Object.keys(gaps).reduce((a, b) => (gaps[b] < gaps[a] ? b : a));
  const cx = Math.max(2, Math.min(w - 3, x)), cz = Math.max(2, Math.min(d - 3, z));
  return side === 'x0' ? [0, cz] : side === 'x1' ? [w - 1, cz] : side === 'z0' ? [cx, 0] : [cx, d - 1];
}
export const LEVEL_TIME_LIMIT_SECONDS = 45;
export const RL_ACTION_DURATION_SECONDS = 0.32;
export const SAVE_KEY = 'the-real-exit-levels-v3';
export const LEGACY_SAVE_KEYS = ['the-real-exit-levels-v2', 'worldforge-levels-v1', 'The-ReaL-Exit-levels-v1'];
export const CAMERA_KEY = 'worldforge-camera-v2';
export const RENAMED_CAMERA_KEY = 'The-ReaL-Exit-camera-v2';

// ── Shared "world clock" formulas (must match backend/rl/environment.py) ──────────────────────────
export const LIFT_OMEGA = 1.1;
export const LIFT_REST = 0.04;
export const LIFT_DEFAULT_HEIGHT = 1.2;
export const LASER_OMEGA = 0.9;
export const PLATFORM_DEFAULT_HEIGHT = 1.0;
export const PLATFORM_TOP_PAD = 0.12;
export const WALL_TOP_PAD = 0.09;
export const CLIMBABLE_WALL_HEIGHT = 1.25;
export const LASER_SAFE_HEIGHT = 0.9;
export const INNER_WALL_HEIGHT = 1.9;

/** Top surface of a lift at world-clock time `t` (rests flush with the floor while the lever is off). */
export function liftTop(index, high, t, powered) {
  if (!powered) return LIFT_REST;
  const wave = 0.5 - 0.5 * Math.cos(LIFT_OMEGA * t + 1.3 * index);
  return LIFT_REST + (high - LIFT_REST) * wave;
}

/** Signed sweep offset of laser `index` (cells, or world units when it sweeps along y). */
export function laserOffset(range, index, t, speed = 1) {
  return range * Math.sin(LASER_OMEGA * speed * t + 1.9 * index);
}

/** Normalise a laser entry [cx, cz, sweep, range, half, beam, y, speed]; sweep and beam are x|y|z and differ. */
export function laserSpec(entry) {
  const ok = (a) => (a === 'x' || a === 'y' || a === 'z');
  const sweep = ok(entry[2]) ? entry[2] : 'z';
  let beam = ok(entry[5]) ? entry[5] : (sweep === 'x' ? 'z' : 'x');
  if (beam === sweep) beam = sweep === 'x' ? 'z' : 'x';
  return {
    cx: entry[0], cz: entry[1], sweep, beam,
    range: Number(entry[3] ?? 2), half: Number(entry[4] ?? 5),
    y: Number(entry[6] ?? 0.5), speed: Number(entry[7] ?? 1),
  };
}

/** Current grid-space centre (px, pz) and beam height (by) of a laser. */
export function laserCenter(entry, index, t) {
  const spec = laserSpec(entry);
  const off = laserOffset(spec.range, index, t, spec.speed);
  return {
    ...spec, off,
    px: spec.sweep === 'x' ? spec.cx + off : spec.cx,
    pz: spec.sweep === 'z' ? spec.cz + off : spec.cz,
    by: spec.sweep === 'y' ? spec.y + off : spec.y,
  };
}

/** Colour-coded wiring. Channel 0 = default (plates open the exit gate, levers drive channel-0 lifts). */
export const CHANNELS = [
  { id: 0, name: 'Green · exit gate / default', color: '#3ddc84' },
  { id: 1, name: 'Gold', color: '#ffc21a' },
  { id: 2, name: 'Blue', color: '#3aa0ff' },
  { id: 3, name: 'Pink', color: '#ff5fa8' },
  { id: 4, name: 'Orange', color: '#ff7a2e' },
  { id: 5, name: 'Purple', color: '#a468ff' },
  { id: 6, name: 'Teal', color: '#19d3d3' },
];
export const channelColor = (id) => (CHANNELS[id] || CHANNELS[0]).color;
/** Channel (0..6) assigned to the piece `kind` anchored on `cell`. */
export function channelOf(world, kind, cell) {
  return Math.max(0, Math.min(6, Number(world.objectProperties?.[`${kind}:${cell[0]}:${cell[1]}`]?.channel) || 0));
}

export const SHOCK_DIRS = ['down', 'up', 'xp', 'xn', 'zp', 'zn'];
export const SHOCK_STAGGER = 0.9;
export const SHOCK_CHARGE_AT = 0.45;
export const SHOCK_STRIKE_AT = 0.7;
export const CUTTER_OMEGA = 1.3;
export const CUTTER_REACH_PAD = 0.3;
export const CUTTER_HEIGHT_FACTOR = 1.8;
export const SPIKE_STAGGER = 0.7;
export const SPIKE_UP_FRACTION = 0.55;
export const SPIKE_SAFE_HEIGHT = 0.45;
export const PLAYER_HEIGHT = 1.0;
export const BEAM_BELOW = 0.15;

/** Normalise a shocks entry [x, z, dir, length, period, y]. */
export function shockSpec(entry) {
  const dir = SHOCK_DIRS.includes(entry[2]) ? entry[2] : 'down';
  return {
    x: entry[0], z: entry[1], dir, length: Number(entry[3] ?? 3), period: Math.max(1, Number(entry[4] ?? 3)),
    y: Number(entry[5] ?? (dir === 'down' ? 3 : dir === 'up' ? 0 : 0.5)),
  };
}

/** Cycle fraction 0..1 of shock `index`: idle < 0.45 <= charging < 0.7 <= striking. */
export function shockPhase(entry, index, t) {
  const { period } = shockSpec(entry);
  return (((t + SHOCK_STAGGER * index) % period) + period) % period / period;
}

/** Normalise a cutters entry [x, z, axis, range, radius, speed]. */
export function cutterSpec(entry) {
  return {
    x: entry[0], z: entry[1], axis: entry[2] === 'z' ? 'z' : 'x',
    range: Number(entry[3] ?? 2), radius: Number(entry[4] ?? 0.5), speed: Number(entry[5] ?? 1),
  };
}

export function cutterPosition(entry, index, t) {
  const c = cutterSpec(entry);
  const off = c.range * Math.sin(CUTTER_OMEGA * c.speed * t + 1.1 * index);
  return c.axis === 'x' ? { px: c.x + off, pz: c.z, ...c } : { px: c.x, pz: c.z + off, ...c };
}

export function spikeUp(entry, index, t) {
  const period = Number(entry[2] ?? 0);
  return period <= 0 || ((((t + SPIKE_STAGGER * index) % period) + period) % period) < SPIKE_UP_FRACTION * period;
}

/**
 * Which dynamic hazard (if any) kills Deeba whose feet are at `feet` and whose grid-space position is (gx, gz)
 * at world-clock time `t`?  Continuous counterpart of backend/rl/environment.py::_kind_lethal.
 */
export function lethalHazard(world, gx, gz, feet, t, channelsOn = null) {
  const off = (kind, entry) => channelsOn && channelsOn.size > 0 && channelsOn.has(channelOf(world, kind, entry));
  const head = feet + PLAYER_HEIGHT;
  const R = 0.36;
  const lasers = world.lasers || [];
  for (let i = 0; i < lasers.length; i++) {
    if (off('laser', lasers[i])) continue;
    const c = laserCenter(lasers[i], i, t);
    if (c.beam === 'x') {
      if (Math.abs(gx - c.px) <= c.half + 0.5 && Math.abs(gz - c.pz) < R && feet - BEAM_BELOW <= c.by && c.by <= head) return 'laser';
    } else if (c.beam === 'z') {
      if (Math.abs(gz - c.pz) <= c.half + 0.5 && Math.abs(gx - c.px) < R && feet - BEAM_BELOW <= c.by && c.by <= head) return 'laser';
    } else if (Math.hypot(gx - c.px, gz - c.pz) < R + 0.1 && feet <= c.y + 2 * c.half && head >= c.y) return 'laser';
  }
  const shocks = world.shocks || [];
  for (let i = 0; i < shocks.length; i++) {
    if (off('shock', shocks[i]) || shockPhase(shocks[i], i, t) < SHOCK_STRIKE_AT) continue;
    const s = shockSpec(shocks[i]);
    if (s.dir === 'down' || s.dir === 'up') {
      if (Math.abs(gx - s.x) > 0.5 + 0.1 || Math.abs(gz - s.z) > 0.5 + 0.1) continue;
      if (s.dir === 'down' ? (feet < s.y && head > s.y - s.length) : (head > s.y && feet < s.y + s.length)) return 'shock';
    } else {
      const dx = s.dir === 'xp' ? 1 : s.dir === 'xn' ? -1 : 0;
      const dz = s.dir === 'zp' ? 1 : s.dir === 'zn' ? -1 : 0;
      const along = (gx - s.x) * dx + (gz - s.z) * dz;
      const across = Math.abs((gx - s.x) * dz) + Math.abs((gz - s.z) * dx);
      if (along >= -0.5 && along <= Math.round(s.length) + 0.5 && across < R && feet - BEAM_BELOW <= s.y && s.y <= head) return 'shock';
    }
  }
  const cutters = world.cutters || [];
  for (let i = 0; i < cutters.length; i++) {
    if (off('cutter', cutters[i])) continue;
    const c = cutterPosition(cutters[i], i, t);
    if (feet < CUTTER_HEIGHT_FACTOR * c.radius && Math.hypot(gx - c.px, gz - c.pz) < c.radius + 0.3) return 'cutter';
  }
  const spikes = world.spikes || [];
  for (let i = 0; i < spikes.length; i++) {
    if (!off('spikes', spikes[i]) && feet < SPIKE_SAFE_HEIGHT && Math.abs(gx - spikes[i][0]) < 0.55 && Math.abs(gz - spikes[i][1]) < 0.55 && spikeUp(spikes[i], i, t)) return 'spikes';
  }
  return null;
}

const RESIZABLE = [['walls', 'wall'], ['platforms', 'platform'], ['hazards', 'hazard'], ['ice', 'ice'], ['water', 'water']];

/** Upgrade a Skyway-era level in place (movingLasers -> lasers, fixed lasers dropped, electricBarriers -> shocks). */
export function migrateLevel(level) {
  const legacySize = Number(level.size) || GRID_SIZE;
  level.width = Math.max(MIN_GRID, Math.min(MAX_GRID, Math.round(Number(level.width) || legacySize)));
  level.depth = Math.max(MIN_GRID, Math.min(MAX_GRID, Math.round(Number(level.depth) || legacySize)));
  level.size = Math.max(level.width, level.depth);
  if (Array.isArray(level.exitDoor)) { level.exitDoor = snapDoorToWall(level.exitDoor, level.width, level.depth); level.goal = [...level.exitDoor]; }
  const old = level.movingLasers; delete level.movingLasers;
  const lasers = (level.lasers || []).filter((e) => e.length >= 4).map((e) => [...e]);
  for (const e of old || []) {
    const axis = e[2] === 'x' ? 'x' : 'z';
    lasers.push([e[0], e[1], axis, Number(e[3] ?? 2), Number(e[4] ?? 5), axis === 'z' ? 'x' : 'z', 0.5, 1]);
  }
  level.lasers = lasers;
  const barriers = level.electricBarriers; delete level.electricBarriers;
  if (barriers?.length) level.shocks = [...(level.shocks || []), ...barriers.map((c) => [c[0], c[1], 'down', 3, 3, 3])];
  for (const key of LIST_FIELDS) if (!Array.isArray(level[key])) level[key] = [];
  level.objectProperties ||= {};
  level.version = 7;
  return level;
}

/** Copy of `world` with every resizable object expanded to the cells its w x d footprint covers. */
export function expandLevel(world) {
  const props = world.objectProperties || {};
  if (!Object.values(props).some((p) => p && (p.w > 1 || p.d > 1))) return world;
  const out = { ...world, objectProperties: { ...props } };
  const { w: maxX, d: maxZ } = worldDims(world);
  for (const [field, kind] of RESIZABLE) {
    const seen = new Set((world[field] || []).map((c) => `${c[0]},${c[1]}`));
    const cells = (world[field] || []).map((c) => [...c]);
    for (const c of world[field] || []) {
      const p = props[`${kind}:${c[0]}:${c[1]}`] || {};
      const w = Math.max(1, p.w | 0), d = Math.max(1, p.d | 0);
      for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
        const nx = c[0] + i, nz = c[1] + j, k = `${nx},${nz}`;
        if ((i || j) && !seen.has(k) && nx >= 0 && nz >= 0 && nx < maxX && nz < maxZ) {
          seen.add(k); cells.push([nx, nz]);
          const { w: _w, d: _d, ...rest } = p;
          out.objectProperties[`${kind}:${nx}:${nz}`] = rest;
        }
      }
    }
    out[field] = cells;
  }
  return out;
}

/**
 * Generate boundary wall coordinates for a room, omitting the door opening.
 */
export function boundaryWalls(exitDoor, w = GRID_SIZE, d = GRID_SIZE) {
  const cells = [];
  for (let x = 0; x < w; x++) cells.push([x, 0]);
  for (let z = 1; z < d; z++) cells.push([w - 1, z]);
  for (let x = w - 2; x >= 0; x--) cells.push([x, d - 1]);
  for (let z = d - 2; z > 0; z--) cells.push([0, z]);
  return cells.filter(([x, z]) => !exitDoor || x !== exitDoor[0] || z !== exitDoor[1]);
}

// <generated:levels>
export const CAMPAIGN_SPECS = [
  {
    "name": "First Steps",
    "hint": "Walk to the glowing door and step through it. Pick up the coins on the way.",
    "width": 9,
    "depth": 9,
    "start": [2, 1],
    "exitDoor": [6, 8],
    "coins": [[5, 6], [4, 5], [3, 3]],
    "timeLimit": 25,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Press the Button",
    "hint": "The door is locked. Go round the wall, step on the button, then head for the door.",
    "width": 11,
    "depth": 11,
    "start": [5, 1],
    "exitDoor": [5, 10],
    "plates": [[2, 8]],
    "coins": [[4, 8], [9, 6], [8, 3]],
    "walls": [[1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 5]],
    "timeLimit": 35,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Ice & Pond",
    "hint": "Water only slows you down and ice makes you slide \u2013 neither is dangerous. Reach the door.",
    "width": 11,
    "depth": 13,
    "start": [5, 1],
    "exitDoor": [5, 12],
    "coins": [[5, 10], [2, 8], [8, 8], [5, 5]],
    "ice": [[1, 9], [2, 9], [3, 9], [4, 9], [5, 9], [6, 9], [7, 9], [8, 9], [9, 9], [1, 8], [3, 8], [4, 8], [5, 8], [6, 8], [7, 8], [9, 8], [1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7], [7, 7], [8, 7], [9, 7]],
    "water": [[3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3]],
    "timeLimit": 35,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Acid Hop",
    "hint": "Acid is deadly. It is one tile wide \u2013 face it and jump (Space) to land on the far side.",
    "width": 11,
    "depth": 13,
    "start": [5, 1],
    "exitDoor": [5, 12],
    "coins": [[3, 10], [5, 9], [5, 3]],
    "hazards": [[1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6], [8, 6], [9, 6]],
    "timeLimit": 35,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Spike Row",
    "hint": "Spikes pop out of the floor in turns. Wait for a gap \u2013 or jump over them.",
    "width": 11,
    "depth": 13,
    "start": [5, 1],
    "exitDoor": [5, 12],
    "coins": [[7, 10], [5, 9], [5, 3]],
    "spikes": [[1, 6, 3.0], [2, 6, 3.0], [3, 6, 3.0], [4, 6, 3.0], [5, 6, 3.0], [6, 6, 3.0], [7, 6, 3.0], [8, 6, 3.0], [9, 6, 3.0]],
    "timeLimit": 40,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Laser Lane",
    "hint": "A laser sweeps back and forth across the room. Cross when it is far away, or jump over the beam.",
    "width": 11,
    "depth": 13,
    "start": [5, 1],
    "exitDoor": [5, 12],
    "coins": [[5, 11], [7, 10], [3, 3]],
    "lasers": [[5, 6, "z", 1.5, 5, "x", 0.5, 0.9]],
    "timeLimit": 40,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Shock Gate",
    "hint": "Each shock charges (yellow) then strikes. Slip through the doorway while the one in your way is idle.",
    "width": 11,
    "depth": 13,
    "start": [5, 1],
    "exitDoor": [5, 12],
    "coins": [[3, 10], [5, 9], [5, 3]],
    "walls": [[1, 6], [2, 6], [3, 6], [7, 6], [8, 6], [9, 6]],
    "shocks": [[4, 6, "down", 3, 3.0, 3.0], [5, 6, "down", 3, 3.0, 3.0], [6, 6, "down", 3, 3.0, 3.0]],
    "timeLimit": 40,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Saw & Spinner",
    "hint": "Time your run past the patrolling saw, then slip by the spinning bar before the door.",
    "width": 13,
    "depth": 13,
    "start": [6, 1],
    "exitDoor": [6, 12],
    "rotators": [[6, 9]],
    "coins": [[3, 8], [9, 8], [6, 3]],
    "walls": [[1, 5], [2, 5], [3, 5], [4, 5], [8, 5], [9, 5], [10, 5], [11, 5]],
    "cutters": [[6, 5, "x", 1.0, 0.5, 1.2]],
    "rotatorSpeed": 1.0,
    "timeLimit": 45
  },
  {
    "name": "Crate Switch",
    "hint": "The hold-button only stays pressed while something sits on it. Push the crate along the corridor onto it.",
    "width": 13,
    "depth": 13,
    "start": [6, 1],
    "exitDoor": [6, 12],
    "coins": [[9, 9], [6, 7], [9, 3]],
    "walls": [[1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [1, 3], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2]],
    "plates": [[2, 3]],
    "continuousPlates": [[2, 3]],
    "blocks": [[4, 3]],
    "timeLimit": 45,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Lift Off",
    "hint": "Pull the lever (E) to power the lift. Ride it up, jump onto the tower and press the button on top.",
    "width": 13,
    "depth": 15,
    "start": [6, 1],
    "exitDoor": [6, 14],
    "coins": [[3, 11], [9, 10], [9, 3]],
    "walls": [[1, 7], [2, 7], [3, 7], [4, 7], [8, 7], [9, 7], [10, 7], [11, 7]],
    "hazards": [[5, 7], [7, 7], [5, 6], [7, 6]],
    "platforms": [[6, 7]],
    "plates": [[6, 7]],
    "lifts": [[6, 6, 1.2]],
    "levers": [[3, 3]],
    "objectProperties": {
      "platform:6:7": {
        "height": 2.0,
        "size": 0.95,
        "color": "#7fb6ff",
        "collision": true
      }
    },
    "timeLimit": 60,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Grand Exit",
    "hint": "Everything so far in one winding room: slide the ice, hop the acid, press the button, time the laser and the shocks.",
    "width": 15,
    "depth": 19,
    "start": [2, 1],
    "exitDoor": [7, 18],
    "coins": [[7, 17], [4, 12], [11, 7], [6, 3]],
    "walls": [[1, 15], [2, 15], [3, 15], [4, 15], [5, 15], [9, 15], [10, 15], [11, 15], [12, 15], [13, 15], [3, 10], [4, 10], [5, 10], [6, 10], [7, 10], [8, 10], [9, 10], [10, 10], [11, 10], [12, 10], [13, 10], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 5], [8, 5], [9, 5], [10, 5], [11, 5]],
    "hazards": [[7, 9], [7, 8], [7, 7], [7, 6]],
    "plates": [[2, 8]],
    "ice": [[4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [4, 3], [5, 3], [7, 3], [8, 3], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1]],
    "water": [[10, 3], [11, 3], [10, 2], [11, 2]],
    "lasers": [[7, 12, "z", 1.5, 6, "x", 0.5, 0.9]],
    "shocks": [[6, 15, "down", 3, 3.0, 3.0], [7, 15, "down", 3, 3.0, 3.0], [8, 15, "down", 3, 3.0, 3.0]],
    "timeLimit": 90,
    "rotatorSpeed": 1.0
  },
  {
    "name": "One Push",
    "hint": "The hold-button stays pressed only while something sits on it. The crate is a single push away \u2013 you just have to get behind it.",
    "width": 11,
    "depth": 13,
    "start": [5, 1],
    "exitDoor": [5, 12],
    "coins": [[8, 10], [6, 9], [9, 3]],
    "walls": [[3, 8], [2, 7], [3, 6], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4]],
    "plates": [[3, 7]],
    "continuousPlates": [[3, 7]],
    "blocks": [[4, 7]],
    "timeLimit": 40,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Box Hunt",
    "hint": "The button needs a crate on it \u2013 and the crate is nowhere near. Find it, get it out of its chamber, and push it all the way across.",
    "width": 13,
    "depth": 15,
    "start": [6, 1],
    "exitDoor": [6, 14],
    "walls": [[2, 13], [1, 12], [3, 12], [4, 8], [5, 8], [6, 8], [7, 8], [8, 8], [9, 6], [10, 6], [11, 6], [9, 5], [9, 4], [9, 2], [9, 1]],
    "plates": [[2, 12]],
    "continuousPlates": [[2, 12]],
    "coins": [[8, 12], [5, 11], [11, 10], [6, 4]],
    "blocks": [[10, 2]],
    "timeLimit": 80,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Two Boxes",
    "hint": "Two buttons, two crates, one gap in the wall: steer each crate through it and across to its button.",
    "width": 13,
    "depth": 15,
    "start": [6, 1],
    "exitDoor": [6, 14],
    "coins": [[1, 12], [6, 12], [11, 12], [6, 8], [6, 4]],
    "walls": [[2, 10], [10, 10], [1, 6], [2, 6], [3, 6], [4, 6], [8, 6], [9, 6], [10, 6], [11, 6]],
    "plates": [[3, 10], [9, 10]],
    "continuousPlates": [[3, 10], [9, 10]],
    "blocks": [[3, 3], [10, 2]],
    "timeLimit": 110,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Pillar Steps",
    "hint": "The button is on top of a pillar built like a staircase. Jump onto the first step, then the next, then the next \u2013 each one is higher.",
    "width": 11,
    "depth": 15,
    "start": [5, 1],
    "exitDoor": [5, 14],
    "coins": [[6, 12], [8, 11], [9, 3]],
    "walls": [[3, 10], [4, 10], [5, 10], [2, 9], [3, 8], [4, 8], [5, 8], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 5]],
    "platforms": [[3, 9], [4, 9], [5, 9]],
    "plates": [[3, 9]],
    "objectProperties": {
      "platform:5:9": {
        "height": 0.8,
        "size": 0.95,
        "color": "#8fb8ff",
        "collision": true
      },
      "platform:4:9": {
        "height": 1.6,
        "size": 0.95,
        "color": "#7aa6f5",
        "collision": true
      },
      "platform:3:9": {
        "height": 2.4,
        "size": 0.95,
        "color": "#6592e8",
        "collision": true
      }
    },
    "timeLimit": 50,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Pillar Hop",
    "hint": "An acid lake, and the button on a pillar in the middle of it. Hop from pillar to pillar \u2013 up to the button, then down the other side.",
    "width": 13,
    "depth": 17,
    "start": [6, 1],
    "exitDoor": [6, 16],
    "coins": [[4, 15], [8, 15], [4, 3], [8, 3]],
    "hazards": [[1, 13], [2, 13], [3, 13], [4, 13], [5, 13], [7, 13], [8, 13], [9, 13], [10, 13], [11, 13], [1, 12], [2, 12], [3, 12], [4, 12], [5, 12], [6, 12], [7, 12], [8, 12], [9, 12], [10, 12], [11, 12], [1, 11], [2, 11], [3, 11], [4, 11], [5, 11], [7, 11], [8, 11], [9, 11], [10, 11], [11, 11], [1, 10], [2, 10], [3, 10], [4, 10], [5, 10], [6, 10], [7, 10], [8, 10], [9, 10], [10, 10], [11, 10], [1, 9], [2, 9], [3, 9], [4, 9], [5, 9], [7, 9], [8, 9], [9, 9], [10, 9], [11, 9], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [6, 8], [7, 8], [8, 8], [9, 8], [10, 8], [11, 8], [1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [7, 7], [8, 7], [9, 7], [10, 7], [11, 7], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6], [8, 6], [9, 6], [10, 6], [11, 6], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [7, 5], [8, 5], [9, 5], [10, 5], [11, 5]],
    "platforms": [[6, 13], [6, 11], [6, 9], [6, 7], [6, 5]],
    "plates": [[6, 9]],
    "objectProperties": {
      "platform:6:5": {
        "height": 0.8,
        "size": 0.95,
        "color": "#8fb8ff",
        "collision": true
      },
      "platform:6:7": {
        "height": 1.6,
        "size": 0.95,
        "color": "#7aa6f5",
        "collision": true
      },
      "platform:6:9": {
        "height": 2.4,
        "size": 0.95,
        "color": "#6592e8",
        "collision": true
      },
      "platform:6:11": {
        "height": 1.6,
        "size": 0.95,
        "color": "#7aa6f5",
        "collision": true
      },
      "platform:6:13": {
        "height": 0.8,
        "size": 0.95,
        "color": "#8fb8ff",
        "collision": true
      }
    },
    "timeLimit": 60,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Grand Finale",
    "hint": "A crate to carry through the spikes, a pillar to climb, and a laser guarding the door. Both buttons must be pressed.",
    "width": 15,
    "depth": 23,
    "start": [2, 1],
    "exitDoor": [12, 22],
    "coins": [[4, 20], [10, 20], [7, 16], [5, 14], [5, 10], [4, 3], [10, 3]],
    "walls": [[1, 18], [2, 18], [3, 18], [4, 18], [5, 18], [6, 18], [7, 18], [8, 18], [9, 18], [10, 18], [11, 18], [11, 16], [12, 16], [13, 16], [11, 14], [12, 14], [13, 14], [3, 12], [4, 12], [5, 12], [6, 12], [7, 12], [8, 12], [9, 12], [10, 12], [11, 12], [12, 12], [13, 12], [2, 8], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 5], [8, 5], [9, 5], [10, 5], [11, 5]],
    "platforms": [[11, 15], [12, 15], [13, 15]],
    "plates": [[13, 15], [3, 8]],
    "spikes": [[8, 10, 3.0], [8, 9, 3.0], [8, 8, 3.0], [8, 7, 3.0], [8, 6, 3.0], [7, 4, 3.0], [7, 3, 3.0], [7, 2, 3.0], [7, 1, 3.0]],
    "continuousPlates": [[3, 8]],
    "blocks": [[12, 8]],
    "lasers": [[11, 20, "x", 2.0, 1, "z", 0.5, 1.0]],
    "objectProperties": {
      "platform:11:15": {
        "height": 0.8,
        "size": 0.95,
        "color": "#8fb8ff",
        "collision": true
      },
      "platform:12:15": {
        "height": 1.6,
        "size": 0.95,
        "color": "#7aa6f5",
        "collision": true
      },
      "platform:13:15": {
        "height": 2.4,
        "size": 0.95,
        "color": "#6592e8",
        "collision": true
      }
    },
    "timeLimit": 150,
    "rotatorSpeed": 1.0
  },
];
// </generated:levels>

export const LIST_FIELDS = ['walls', 'blocks', 'platforms', 'stairs', 'hazards', 'switches', 'painted', 'coins', 'springs', 'portals', 'checkpoints', 'movers', 'plates', 'rotators', 'lasers', 'shocks', 'cutters', 'spikes', 'water', 'ice', 'powerups', 'levers', 'continuousPlates', 'lifts'];

const copyCells = (cells) => (cells || []).map((cell) => [...cell]);

/**
 * Build campaign level `index` – or a friendly generic level when the index is beyond the campaign.
 */
export function makeLevel(index = 0) {
  const spec = CAMPAIGN_SPECS[index];
  const width = spec?.width || GRID_SIZE, depth = spec?.depth || GRID_SIZE;
  const exitDoor = spec?.exitDoor ? [...spec.exitDoor] : [width >> 1, depth - 1];
  const level = {
    version: 7, name: `Level ${index + 1}`, hint: '', exitDoor, goal: [...exitDoor], start: spec?.start ? [...spec.start] : [width >> 1, 2],
    width, depth, size: Math.max(width, depth), objectProperties: {}, rotatorSpeed: 1, standalone: false,
  };
  for (const key of LIST_FIELDS) level[key] = [];
  if (spec) {
    for (const [key, value] of Object.entries(spec)) {
      if (['width', 'depth', 'start', 'exitDoor'].includes(key)) continue;
      if (key === 'walls') level.walls = boundaryWalls(exitDoor, width, depth).concat(copyCells(value));
      else if (key === 'objectProperties') level.objectProperties = JSON.parse(JSON.stringify(value));
      else if (Array.isArray(value)) level[key] = copyCells(value);
      else level[key] = value;
    }
    if (!spec.walls) level.walls = boundaryWalls(exitDoor, width, depth);
    level.id = `catlab-${index + 1}`;
    return level;
  }
  Object.assign(level, {
    walls: boundaryWalls(exitDoor, width, depth).concat([[4, 6], [8, 6]]),
    plates: [[6, 4]], coins: [[5, 3], [7, 3], [6, 6]],
    rotators: [[GRID_SIZE >> 1, 8]], rotatorSpeed: 1.1, shocks: [[GRID_SIZE >> 1, 6, 'down', 3, 3, 3]], levers: [[2, 2]],
    blocks: index % 2 ? [[7, 4]] : [],
  });
  return level;
}

/**
 * Generate the starter campaign.
 */
export function freshCampaign() {
  return CAMPAIGN_SPECS.map((_, i) => makeLevel(i));
}

/**
 * Load campaign levels from localStorage or fall back to the Skyway campaign.
 * Saves from older builds are left untouched (the key changed) so nothing is ever lost.
 */
export function loadCampaign() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (Array.isArray(saved?.levels) && saved.levels.length) {
        for (const level of saved.levels) {
          migrateLevel(level);
        }
        // Built-in rooms added in later versions appear at the end of an existing campaign.
        // The built-in campaign is a curriculum that changes between versions: an older save gets the new built-in
        // levels, while the player's own levels (anything that is not a "catlab-N" built-in) are kept after them.
        if (saved.campaignVersion !== CAMPAIGN_VERSION) {
          const isBuiltin = (l) => /^catlab-\d+$/.test(String(l.id || ''));
          const custom = saved.levels.filter((l) => !isBuiltin(l));
          let builtin = saved.levels.filter(isBuiltin);
          if ((saved.campaignVersion || 0) >= 3) {
            // Same curriculum, more levels: keep the player's copies of the built-ins and append the new rooms.
            const have = new Set(builtin.map((l) => l.id));
            CAMPAIGN_SPECS.forEach((_, i) => { if (!have.has(`catlab-${i + 1}`)) builtin.push(makeLevel(i)); });
          } else {
            builtin = CAMPAIGN_SPECS.map((_, i) => makeLevel(i));
          }
          saved.levels = builtin.concat(custom);
        }
        return saved.levels;
      }
    }
  } catch {
    // Corrupt save: fall through to the starter campaign.
  }
  return freshCampaign();
}

/** Does this saved campaign come from before the Skyway update? (used to offer a one-time notice) */
export function hasLegacySave() {
  try { return LEGACY_SAVE_KEYS.some((key) => !!localStorage.getItem(key)); } catch { return false; }
}

/**
 * Convert discrete grid coordinates to continuous world coordinates.
 */
export function gridToWorld(x, z) {
  return { x: x - HALF_X, z: z - HALF_Z };
}

/**
 * Convert single grid index to world offset.
 */
export function indexToWorld(index, axis = 'x') {
  return index - (axis === 'z' ? HALF_Z : HALF_X);
}

/**
 * Helper to check if a 2D cell is contained in an array of cells.
 */
export function hasCell(list, x, z) {
  return (list || []).some(([gx, gz]) => gx === x && gz === z);
}

/**
 * Generate property dictionary key for configured objects.
 */
export function propertyKey(kind, cell) {
  return `${kind}:${cell[0]}:${cell[1]}`;
}

/**
 * Clone arbitrary serializable data via JSON.
 */
export function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Top-surface height of a platform / low wall at `cell` (walkable ledge height), 0 if none. */
export function platformTop(world, cell) {
  const key = propertyKey('platform', cell);
  if (!hasCell(world.platforms, cell[0], cell[1])) return 0;
  const props = world.objectProperties?.[key] || {};
  return (props.height ?? PLATFORM_DEFAULT_HEIGHT) + PLATFORM_TOP_PAD;
}
