/**
 * Three.js Material & Mesh Utility Functions
 * Provides helpers for standard materials, box creation, group disposal, and object properties.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import { GRID_SIZE, propertyKey } from './constants.js';

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
  const borderWall = kind === 'wall' && (cell[0] === 0 || cell[0] === GRID_SIZE - 1 || cell[1] === 0 || cell[1] === GRID_SIZE - 1);
  const defaults = kind === 'wall'
    ? (borderWall ? { height: 8.5, size: 1, color: '#965a32', collision: true } : { height: 1.58, size: 0.94, color: '#596b73', collision: true })
    : kind === 'block'
      ? { height: 0.78, size: 0.78, color: '#b77148', collision: true }
      : kind === 'platform'
        ? { height: 1.15, size: 0.95, color: '#62bf72', collision: true }
        : { height: 1, size: 1, color: '#82909a', collision: true };

  return { ...defaults, ...(world.objectProperties?.[propertyKey(kind, cell)] || {}) };
}

