/**
 * The-ReaL-Exit Game Constants & Level Data
 * Defines grid dimensions, the Skyway campaign, shared timing formulas and persistence keys.
 *
 * The level specs between the `generated:levels` markers are produced from backend/levels.py by
 * `python -m backend.tools.gen_levels`, so the 3D game and the RL environment always agree.
 */

export const GRID_SIZE = 17;               // default room size (levels may be any width x depth, see worldDims)
export const HALF_GRID = (GRID_SIZE - 1) / 2;
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
    "name": "Intake Bay",
    "hint": "Jump (Space) onto the low wall and stand on the button, then slip past the spinner. Mind the spikes.",
    "walls": [[3, 12], [4, 12], [5, 12], [6, 12], [10, 12], [11, 12], [12, 12], [13, 12], [1, 12], [2, 12], [14, 12], [15, 12], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [9, 4], [10, 4], [11, 4], [12, 4]],
    "platforms": [[7, 9], [8, 9], [9, 9]],
    "plates": [[8, 9]],
    "spikes": [[5, 14, 0], [11, 14, 0]],
    "water": [[4, 9], [5, 9], [4, 10], [5, 10], [11, 9], [12, 9], [11, 10], [12, 10]],
    "coins": [[5, 7], [11, 7], [9, 9], [8, 14]],
    "rotators": [[8, 12]],
    "rotatorSpeed": 0.9
  },
  {
    "name": "Cargo Bay",
    "hint": "Push the crate onto the glowing hold-button. Then cross the shock gate while the bolts are charging.",
    "walls": [[10, 9], [10, 10], [10, 11], [12, 9], [12, 10], [12, 11], [3, 14], [4, 14], [5, 14], [6, 14], [10, 14], [11, 14], [12, 14], [13, 14], [1, 14], [2, 14], [14, 14], [15, 14], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [9, 4], [10, 4], [11, 4], [12, 4]],
    "blocks": [[11, 8]],
    "plates": [[11, 11]],
    "continuousPlates": [[11, 11]],
    "platforms": [[5, 10]],
    "coins": [[4, 7], [12, 7], [7, 10], [5, 10], [4, 13]],
    "shocks": [[7, 14, "down", 3, 3.0, 3.0], [8, 14, "down", 3, 3.0, 3.0], [9, 14, "down", 3, 3.0, 3.0]],
    "rotators": [],
    "rotatorSpeed": 1.0
  },
  {
    "name": "Laser Lane",
    "hint": "Lasers sweep along any axis. Time your dash, jump the low beam, or wait on a ledge. The gold button in the far corner switches the door-side laser off.",
    "walls": [[1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [9, 4], [10, 4], [11, 4], [12, 4]],
    "lasers": [[8, 10, "z", 1, 7.0, "x", 0.5, 1.0], [8, 14, "y", 0.9, 7.0, "x", 1.0, 1.0]],
    "platforms": [[5, 14], [11, 10]],
    "plates": [[8, 12], [13, 8]],
    "coins": [[5, 7], [11, 7], [4, 12], [12, 12], [5, 14], [11, 10]],
    "rotators": [],
    "rotatorSpeed": 1.0,
    "objectProperties": {
      "plate:13:8": {
        "channel": 1
      },
      "laser:8:14": {
        "channel": 1
      }
    }
  },
  {
    "name": "Acid Bridge",
    "hint": "Hop onto the low-wall bridge to cross the acid. One of the two buttons sits on a ledge island; a cutter patrols the exit.",
    "walls": [[1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [9, 4], [10, 4], [11, 4], [12, 4]],
    "hazards": [[3, 10], [4, 10], [5, 10], [6, 10], [7, 10], [9, 10], [10, 10], [11, 10], [12, 10], [13, 10], [3, 11], [4, 11], [5, 11], [6, 11], [7, 11], [9, 11], [10, 11], [11, 11], [12, 11], [13, 11], [1, 10], [2, 10], [14, 10], [15, 10], [1, 11], [2, 11], [14, 11], [15, 11]],
    "platforms": [[8, 10], [8, 11], [12, 13], [12, 14], [11, 14]],
    "plates": [[8, 8], [12, 14]],
    "cutters": [[8, 14, "x", 5.0, 0.5, 1.0]],
    "coins": [[4, 7], [12, 7], [8, 11], [11, 14], [5, 13]],
    "rotators": [],
    "rotatorSpeed": 1.0
  },
  {
    "name": "Lift Off",
    "hint": "Pull the power lever (E), step on the lift, and jump from it onto the tower to reach the button.",
    "walls": [[3, 12], [4, 12], [5, 12], [6, 12], [10, 12], [11, 12], [12, 12], [13, 12], [1, 12], [2, 12], [14, 12], [15, 12], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [9, 4], [10, 4], [11, 4], [12, 4]],
    "hazards": [[7, 11], [9, 11], [7, 12], [9, 12]],
    "levers": [[4, 6]],
    "lifts": [[8, 11, 1.2]],
    "platforms": [[8, 12]],
    "objectProperties": {
      "platform:8:12": {
        "height": 2.0,
        "size": 0.95,
        "color": "#7fb6ff",
        "collision": true
      }
    },
    "plates": [[8, 12]],
    "coins": [[5, 8], [11, 8], [8, 9], [4, 10], [12, 10], [8, 15]],
    "rotators": [[8, 14]],
    "rotatorSpeed": 1.3,
    "timeLimit": 69
  },
  {
    "name": "The Real Exit",
    "hint": "Slide across the ice, hop onto the ledge for the button, then beat the laser, the cutter and the shock gate. Good luck, Deeba! The pink lever (E) powers down the shocks.",
    "walls": [[9, 9], [9, 10], [9, 11], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [9, 4], [10, 4], [11, 4], [12, 4]],
    "plates": [[11, 11]],
    "platforms": [[11, 11], [12, 11]],
    "hazards": [[10, 9], [10, 10], [10, 11]],
    "ice": [[6, 8], [7, 8], [8, 8], [9, 8]],
    "lasers": [[8, 10, "z", 1, 7.0, "x", 0.5, 1.0]],
    "cutters": [[8, 13, "x", 5.0, 0.5, 1.0]],
    "shocks": [[7, 15, "down", 3, 3.0, 3.0], [8, 15, "down", 3, 3.0, 3.0], [9, 15, "down", 3, 3.0, 3.0]],
    "coins": [[4, 7], [4, 13], [12, 8], [11, 11], [8, 13]],
    "powerups": [[8, 8, "jump"]],
    "timeLimit": 89,
    "levers": [[4, 14]],
    "objectProperties": {
      "lever:4:14": {
        "channel": 1
      },
      "shock:7:15": {
        "channel": 1
      },
      "shock:8:15": {
        "channel": 1
      },
      "shock:9:15": {
        "channel": 1
      }
    }
  },
  {
    "name": "Switchback",
    "hint": "A long winding corridor: hop the spikes, wade the pond, slide the ice, dodge the laser, grab the button and beat the shock gate.",
    "width": 15,
    "depth": 21,
    "start": [2, 2],
    "exitDoor": [14, 18],
    "coins": [[4, 19], [12, 19], [3, 14], [10, 13], [12, 11], [7, 10], [3, 7], [11, 6], [9, 3], [12, 2], [3, 1]],
    "walls": [[3, 16], [4, 16], [5, 16], [6, 16], [7, 16], [8, 16], [9, 16], [10, 16], [11, 16], [12, 16], [13, 16], [1, 12], [2, 12], [3, 12], [4, 12], [5, 12], [6, 12], [7, 12], [8, 12], [9, 12], [10, 12], [11, 12], [3, 8], [4, 8], [5, 8], [6, 8], [7, 8], [8, 8], [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [9, 4], [10, 4], [11, 4]],
    "plates": [[2, 15]],
    "ice": [[4, 11], [5, 11], [6, 11], [7, 11], [8, 11], [9, 11], [4, 10], [5, 10], [6, 10], [8, 10], [9, 10], [4, 9], [5, 9], [6, 9], [7, 9], [8, 9], [9, 9]],
    "hazards": [[11, 11], [11, 10], [11, 9]],
    "water": [[8, 7], [9, 7], [8, 6], [9, 6], [8, 5], [9, 5]],
    "spikes": [[6, 3, 3.0], [6, 2, 3.0], [6, 1, 3.0]],
    "cutters": [[4, 6, "z", 1.0, 0.5, 1.0]],
    "lasers": [[7, 14, "x", 2.5, 1, "z", 0.5, 0.9]],
    "shocks": [[8, 17, "down", 3, 3.0, 3.0], [8, 18, "down", 3, 3.0, 3.0], [8, 19, "down", 3, 3.0, 3.0]],
    "timeLimit": 120,
    "rotatorSpeed": 1.0
  },
  {
    "name": "Crate Canyon",
    "hint": "Push the crate onto the gold button to power down the shock gate. Bridge the acid, pull the lever, ride the lift to the tower button, and slip past the spinner.",
    "width": 17,
    "depth": 27,
    "start": [2, 3],
    "exitDoor": [8, 26],
    "coins": [[3, 24], [13, 24], [5, 20], [13, 17], [8, 15], [3, 13], [11, 9], [2, 7], [13, 5], [6, 1]],
    "rotators": [[8, 24]],
    "walls": [[1, 22], [2, 22], [3, 22], [4, 22], [5, 22], [6, 22], [10, 22], [11, 22], [12, 22], [13, 22], [14, 22], [15, 22], [1, 18], [2, 18], [3, 18], [4, 18], [5, 18], [6, 18], [7, 18], [8, 18], [9, 18], [10, 18], [11, 18], [12, 18], [4, 12], [5, 12], [6, 12], [7, 12], [8, 12], [9, 12], [10, 12], [11, 12], [12, 12], [13, 12], [14, 12], [15, 12], [8, 11], [8, 7], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6], [8, 6], [9, 6], [10, 6], [11, 6], [12, 6]],
    "hazards": [[7, 22], [9, 22], [7, 21], [9, 21], [7, 17], [8, 17], [9, 17], [7, 16], [8, 16], [9, 16], [7, 14], [8, 14], [9, 14], [7, 13], [8, 13], [9, 13]],
    "platforms": [[8, 22], [7, 15], [8, 15], [9, 15]],
    "plates": [[8, 22], [11, 3]],
    "lifts": [[8, 21, 1.2]],
    "levers": [[13, 20]],
    "water": [[3, 10], [4, 10], [5, 10], [3, 9], [4, 9], [5, 9], [3, 8], [4, 8], [5, 8]],
    "blocks": [[4, 3]],
    "continuousPlates": [[11, 3]],
    "shocks": [[8, 8, "down", 3, 3.0, 3.0], [8, 9, "down", 3, 3.0, 3.0], [8, 10, "down", 3, 3.0, 3.0]],
    "cutters": [[13, 15, "z", 1.5, 0.5, 1.0]],
    "objectProperties": {
      "platform:8:22": {
        "height": 2.0,
        "size": 0.95,
        "color": "#7fb6ff",
        "collision": true
      },
      "plate:11:3": {
        "channel": 1
      },
      "shock:8:8": {
        "channel": 1
      },
      "shock:8:9": {
        "channel": 1
      },
      "shock:8:10": {
        "channel": 1
      }
    },
    "rotatorSpeed": 1.1,
    "timeLimit": 150
  },
  {
    "name": "Frozen Gallery",
    "hint": "Slide across the ice, jump the sweeping laser (or grab the shield first), time the spikes and the saw, press the button and finish past the shocks and spinner.",
    "width": 21,
    "depth": 19,
    "start": [2, 3],
    "exitDoor": [20, 15],
    "coins": [[6, 17], [6, 15], [2, 9], [12, 7], [8, 4], [14, 3], [8, 2]],
    "walls": [[10, 17], [10, 13], [4, 12], [5, 12], [6, 12], [7, 12], [8, 12], [9, 12], [10, 12], [11, 12], [12, 12], [13, 12], [14, 12], [15, 12], [16, 12], [17, 12], [18, 12], [19, 12], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6], [8, 6], [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6], [15, 6], [16, 6]],
    "water": [[14, 17], [15, 17], [14, 16], [15, 16], [14, 15], [15, 15], [14, 14], [15, 14], [14, 13], [15, 13]],
    "rotators": [[17, 15]],
    "plates": [[3, 10]],
    "spikes": [[6, 10, 3.0], [6, 8, 3.0]],
    "powerups": [[2, 5, "shield"]],
    "ice": [[3, 5], [4, 5], [5, 5], [6, 5], [7, 5], [8, 5], [9, 5], [10, 5], [11, 5], [12, 5], [13, 5], [14, 5], [15, 5], [16, 5], [17, 5], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [9, 4], [10, 4], [11, 4], [12, 4], [13, 4], [14, 4], [15, 4], [16, 4], [17, 4], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3], [10, 3], [11, 3], [12, 3], [13, 3], [15, 3], [16, 3], [17, 3], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [9, 2], [10, 2], [11, 2], [12, 2], [13, 2], [14, 2], [15, 2], [16, 2], [17, 2], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [13, 1], [14, 1], [15, 1], [16, 1], [17, 1]],
    "lasers": [[10, 3, "x", 4.0, 2, "z", 0.5, 0.7]],
    "cutters": [[10, 9, "z", 2.0, 0.5, 1.2]],
    "shocks": [[10, 14, "down", 3, 3.0, 3.0], [10, 15, "down", 3, 3.0, 3.0], [10, 16, "down", 3, 3.0, 3.0]],
    "rotatorSpeed": 1.0,
    "timeLimit": 110
  },
  {
    "name": "Deeba's Grand Exit",
    "hint": "Everything you have learned, in one long run: crate button, ice, acid bridge, laser patrol, lever and lift, and a spinner at the door.",
    "width": 23,
    "depth": 33,
    "start": [2, 3],
    "exitDoor": [11, 32],
    "rotators": [[11, 30]],
    "coins": [[5, 29], [17, 29], [17, 25], [19, 23], [5, 21], [3, 17], [10, 15], [19, 13], [3, 11], [16, 7], [9, 3], [13, 3], [17, 1]],
    "walls": [[1, 27], [2, 27], [3, 27], [4, 27], [5, 27], [6, 27], [7, 27], [8, 27], [9, 27], [13, 27], [14, 27], [15, 27], [16, 27], [17, 27], [18, 27], [19, 27], [20, 27], [21, 27], [4, 24], [5, 24], [6, 24], [7, 24], [8, 24], [9, 24], [10, 24], [11, 24], [12, 24], [13, 24], [14, 24], [15, 24], [16, 24], [17, 24], [18, 24], [19, 24], [20, 24], [21, 24], [1, 18], [2, 18], [3, 18], [4, 18], [5, 18], [6, 18], [7, 18], [8, 18], [9, 18], [10, 18], [11, 18], [12, 18], [13, 18], [14, 18], [15, 18], [16, 18], [17, 18], [18, 18], [4, 12], [5, 12], [6, 12], [7, 12], [8, 12], [9, 12], [10, 12], [11, 12], [12, 12], [13, 12], [14, 12], [15, 12], [16, 12], [17, 12], [18, 12], [19, 12], [20, 12], [21, 12], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6], [8, 6], [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6], [15, 6], [16, 6], [17, 6], [18, 6]],
    "hazards": [[10, 27], [12, 27], [10, 26], [12, 26], [9, 17], [10, 17], [11, 17], [9, 16], [10, 16], [11, 16], [9, 14], [10, 14], [11, 14], [9, 13], [10, 13], [11, 13]],
    "platforms": [[11, 27], [9, 15], [10, 15], [11, 15]],
    "plates": [[11, 27], [7, 9]],
    "lifts": [[11, 26, 1.2]],
    "levers": [[4, 25]],
    "spikes": [[14, 23, 3.0], [14, 22, 3.0], [14, 21, 3.0], [14, 20, 3.0], [14, 19, 3.0], [7, 5, 3.0], [7, 4, 3.0], [7, 3, 3.0], [7, 2, 3.0], [7, 1, 3.0]],
    "water": [[12, 11], [13, 11], [12, 10], [13, 10], [12, 9], [13, 9], [12, 8], [13, 8], [12, 7], [13, 7]],
    "continuousPlates": [[7, 9]],
    "blocks": [[19, 9]],
    "powerups": [[3, 5, "jump"]],
    "ice": [[11, 5], [12, 5], [13, 5], [14, 5], [15, 5], [16, 5], [11, 4], [12, 4], [13, 4], [14, 4], [15, 4], [16, 4], [11, 3], [12, 3], [14, 3], [15, 3], [16, 3], [11, 2], [12, 2], [13, 2], [14, 2], [15, 2], [16, 2], [11, 1], [12, 1], [13, 1], [14, 1], [15, 1], [16, 1]],
    "cutters": [[16, 15, "z", 1.5, 0.5, 1.0]],
    "lasers": [[10, 21, "x", 4.0, 2, "z", 0.5, 0.9]],
    "objectProperties": {
      "platform:11:27": {
        "height": 2.0,
        "size": 0.95,
        "color": "#7fb6ff",
        "collision": true
      },
      "plate:7:9": {
        "channel": 1
      },
      "laser:10:21": {
        "channel": 1
      }
    },
    "rotatorSpeed": 1.2,
    "timeLimit": 210
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
        const seen = Number.isFinite(saved.builtinSeen) ? saved.builtinSeen : 6;
        CAMPAIGN_SPECS.forEach((_, i) => { if (i >= seen) saved.levels.push(makeLevel(i)); });
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
