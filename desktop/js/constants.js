/**
 * The-ReaL-Exit Game Constants & Level Data
 * Defines grid dimensions, default levels, and persistence keys.
 */

export const GRID_SIZE = 13;
export const HALF_GRID = (GRID_SIZE - 1) / 2;
export const EXIT_OPENING_WIDTH = 1.5;
export const LEVEL_TIME_LIMIT_SECONDS = 8;
export const RL_ACTION_DURATION_SECONDS = 0.32;
export const SAVE_KEY = 'worldforge-levels-v1';
export const RENAMED_SAVE_KEY = 'The-ReaL-Exit-levels-v1';
export const CAMERA_KEY = 'worldforge-camera-v2';
export const RENAMED_CAMERA_KEY = 'The-ReaL-Exit-camera-v2';

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

/**
 * Construct starter campaign level definition.
 */
export function makeLevel(index = 0) {
  const exitDoor = [6, GRID_SIZE - 1];
  const rotatorSets = [
    [[6, 8]],
    [[4, 8], [8, 8]],
    [[4, 7], [8, 7], [6, 9]],
    [[4, 6], [8, 6], [4, 9], [8, 9]],
  ];
  const sideWalls = [
    [[4, 6], [8, 6]],
    [[3, 6], [9, 6], [6, 7]],
    [[3, 5], [9, 5], [3, 9], [9, 9]],
    [[3, 5], [9, 5], [3, 8], [9, 8], [6, 10]],
  ];
  return {
    version: 4,
    name: `Level ${index + 1}`,
    walls: boundaryWalls(exitDoor).concat(sideWalls[index % 4]),
    blocks: [],
    platforms: [],
    stairs: [],
    hazards: [],
    switches: [],
    painted: [],
    coins: [],
    springs: [],
    portals: [],
    checkpoints: [],
    movers: [],
    plates: [[6, 4]],
    rotators: rotatorSets[index % 4].map((cell) => [...cell]),
    rotatorSpeed: [1.0, 1.25, 1.55, 1.9][index % 4],
    exitDoor,
    objectProperties: {},
    start: [6, 2],
    goal: exitDoor,
    standalone: false,
  };
}

/**
 * Generate starter 4-level campaign.
 */
export function freshCampaign() {
  return [0, 1, 2, 3].map(makeLevel);
}

/**
 * Load campaign levels from localStorage or fallback to starter levels.
 */
export function loadCampaign() {
  for (const key of [SAVE_KEY, RENAMED_SAVE_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const saved = JSON.parse(raw);
      if (Array.isArray(saved?.levels) && saved.levels.length) {
        if (key !== SAVE_KEY) localStorage.setItem(SAVE_KEY, raw);
        return saved.levels;
      }
    } catch {
      // Try the next compatible save key before falling back to starter worlds.
    }
  }
  return freshCampaign();
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
  return list.some(([gx, gz]) => gx === x && gz === z);
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

