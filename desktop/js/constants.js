/**
 * The-ReaL-Exit Game Constants & Level Data
 * Defines grid dimensions, the Skyway campaign, shared timing formulas and persistence keys.
 *
 * The level specs between the `generated:levels` markers are produced from backend/levels.py by
 * `python -m backend.tools.gen_levels`, so the 3D game and the RL environment always agree.
 */

export const GRID_SIZE = 17;
export const HALF_GRID = (GRID_SIZE - 1) / 2;
export const EXIT_OPENING_WIDTH = 1.5;
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
  level.version = 6;
  return level;
}

/** Copy of `world` with every resizable object expanded to the cells its w x d footprint covers. */
export function expandLevel(world) {
  const props = world.objectProperties || {};
  if (!Object.values(props).some((p) => p && (p.w > 1 || p.d > 1))) return world;
  const out = { ...world, objectProperties: { ...props } };
  for (const [field, kind] of RESIZABLE) {
    const seen = new Set((world[field] || []).map((c) => `${c[0]},${c[1]}`));
    const cells = (world[field] || []).map((c) => [...c]);
    for (const c of world[field] || []) {
      const p = props[`${kind}:${c[0]}:${c[1]}`] || {};
      const w = Math.max(1, p.w | 0), d = Math.max(1, p.d | 0);
      for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
        const nx = c[0] + i, nz = c[1] + j, k = `${nx},${nz}`;
        if ((i || j) && !seen.has(k) && nx >= 0 && nz >= 0 && nx < GRID_SIZE && nz < GRID_SIZE) {
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
export function boundaryWalls(exitDoor) {
  const edge = GRID_SIZE - 1;
  return Array.from({ length: GRID_SIZE * 4 - 4 }, (_, i) => {
    if (i < GRID_SIZE) return [i, 0];
    if (i < GRID_SIZE * 2 - 1) return [edge, i - (GRID_SIZE - 1)];
    if (i < GRID_SIZE * 3 - 2) return [edge - (i - (GRID_SIZE * 2 - 2)), edge];
    return [0, edge - (i - (GRID_SIZE * 3 - 3))];
  }).filter(([x, z]) => x !== exitDoor[0] || z !== exitDoor[1]);
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
];
// </generated:levels>

export const LIST_FIELDS = ['walls', 'blocks', 'platforms', 'stairs', 'hazards', 'switches', 'painted', 'coins', 'springs', 'portals', 'checkpoints', 'movers', 'plates', 'rotators', 'lasers', 'shocks', 'cutters', 'spikes', 'water', 'ice', 'powerups', 'levers', 'continuousPlates', 'lifts'];

const copyCells = (cells) => (cells || []).map((cell) => [...cell]);

/**
 * Build campaign level `index` – or a friendly generic level when the index is beyond the campaign.
 */
export function makeLevel(index = 0) {
  const exitDoor = [GRID_SIZE >> 1, GRID_SIZE - 1];
  const level = {
    version: 6, name: `Level ${index + 1}`, hint: '', exitDoor, goal: [...exitDoor], start: [GRID_SIZE >> 1, 2],
    objectProperties: {}, rotatorSpeed: 1, standalone: false,
  };
  for (const key of LIST_FIELDS) level[key] = [];
  const spec = CAMPAIGN_SPECS[index];
  if (spec) {
    for (const [key, value] of Object.entries(spec)) {
      if (key === 'walls') level.walls = boundaryWalls(exitDoor).concat(copyCells(value));
      else if (key === 'objectProperties') level.objectProperties = JSON.parse(JSON.stringify(value));
      else if (Array.isArray(value)) level[key] = copyCells(value);
      else level[key] = value;
    }
    if (!spec.walls) level.walls = boundaryWalls(exitDoor);
    level.id = `catlab-${index + 1}`;
    return level;
  }
  Object.assign(level, {
    walls: boundaryWalls(exitDoor).concat([[4, 6], [8, 6]]),
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
  return { x: x - HALF_GRID, z: z - HALF_GRID };
}

/**
 * Convert single grid index to world offset.
 */
export function indexToWorld(index) {
  return index - HALF_GRID;
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
