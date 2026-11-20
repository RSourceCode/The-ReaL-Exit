/**
 * Three.js Material & Mesh Utility Functions
 * Provides helpers for standard materials, box creation, group disposal, and object properties.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import { GRID_W, GRID_D, propertyKey, WALL_TOP_PAD } from './constants.js';

/**
 * Create a MeshStandardMaterial with default roughness and metalness.
 */
export function createMaterial(color, roughness = 0.82, metalness = 0.02, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}

/**
 * Dispose geometries and materials in an Object3D hierarchy to prevent WebGL memory leaks.
 */
export function disposeGroup(group) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      if (node.material) {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((mat) => mat.dispose());
      }
    });
  }
}

/**
 * Create and attach a standard shaded box mesh to a parent group.
 */
export function addBox(group, size, position, color, opts = {}) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    createMaterial(color, opts.roughness ?? 0.82, opts.metalness ?? 0.02, opts.material || {})
  );
  mesh.position.set(...position);
  mesh.castShadow = opts.castShadow ?? true;
  mesh.receiveShadow = opts.receiveShadow ?? true;
  group.add(mesh);
  return mesh;
}

/**
 * Retrieve configured or default visual and physical properties for a level object.
 */
export function getObjectProperties(world, kind, cell) {
  const borderWall = kind === 'wall' && (cell[0] === 0 || cell[0] === GRID_W - 1 || cell[1] === 0 || cell[1] === GRID_D - 1);
  const defaults = kind === 'wall'
    ? (borderWall ? { height: 8.5, size: 1, color: '#965a32', collision: true } : { height: 1.9, size: 0.94, color: '#8d8f98', collision: true })
    : kind === 'block'
      ? { height: 0.78, size: 0.78, color: '#b77148', collision: true }
      : kind === 'platform'
        ? { height: 1.0, size: 0.95, color: '#9fb4bf', collision: true }
        : { height: 1, size: 1, color: '#82909a', collision: true };

  return { ...defaults, ...(world.objectProperties?.[propertyKey(kind, cell)] || {}) };
}


/**
 * Greedy-merge grid cells into the fewest axis-aligned rectangles.  `keyFn(cell)` groups cells that may be
 * merged (same height, colour …).  Returns [{ x0, z0, x1, z1, key, cell }] in grid indices (inclusive).
 * Used by both physics and visuals so walls become long seamless runs instead of one block per cell.
 */
export function mergeCells(cells, keyFn = () => '') {
  const map = new Map();
  for (const cell of cells) map.set(`${cell[0]},${cell[1]}`, { cell, key: keyFn(cell), used: false });
  const rects = [];
  const sorted = [...map.values()].sort((a, b) => a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0]);
  for (const entry of sorted) {
    if (entry.used) continue;
    const [x0, z0] = entry.cell;
    let x1 = x0;
    const same = (x, z) => { const e = map.get(`${x},${z}`); return e && !e.used && e.key === entry.key; };
    while (same(x1 + 1, z0)) x1++;
    let z1 = z0;
    outer: while (true) {
      for (let x = x0; x <= x1; x++) if (!same(x, z1 + 1)) break outer;
      z1++;
    }
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) map.get(`${x},${z}`).used = true;
    rects.push({ x0, z0, x1, z1, key: entry.key, cell: entry.cell });
  }
  return rects;
}

/** Walking surface height at a grid cell (0 = ground, ledge tops for platforms). */
export function surfaceHeightAt(world, gx, gz) {
  let top = 0;
  if ((world.platforms || []).some(([x, z]) => x === gx && z === gz)) {
    const props = getObjectProperties(world, 'platform', [gx, gz]);
    if (props.collision !== false) top = props.height + 0.12;
  }
  // Walls count as surfaces too, so coins, crates, plates, levers and power-ups can sit on top of them.
  const border = gx === 0 || gz === 0 || gx === GRID_W - 1 || gz === GRID_D - 1;
  if (!border && (world.walls || []).some(([x, z]) => x === gx && z === gz)) {
    const props = getObjectProperties(world, 'wall', [gx, gz]);
    if (props.collision !== false) top = Math.max(top, props.height + WALL_TOP_PAD);
  }
  return top;
}
