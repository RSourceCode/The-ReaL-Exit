/**
 * Level Geometry & 3D Model Builders
 * Constructs Three.js scene representations for game elements and decor.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import { GRID_SIZE, HALF_GRID, EXIT_OPENING_WIDTH, gridToWorld, hasCell } from './constants.js';
import { createMaterial, addBox, disposeGroup, getObjectProperties } from './materials.js';

/**
 * Construct the full 3D board scene graph based on level JSON and runtime activations.
 */
export function buildBoard(groups, world, runtimeState) {
  const { boardGroup, objectsGroup, coinsGroup, decorationGroup } = groups;
  const { activatedPlates, collected, switchActivated, doorsOpen } = runtimeState;

  disposeGroup(boardGroup);
  disposeGroup(objectsGroup);
  disposeGroup(coinsGroup);
  disposeGroup(decorationGroup);

  const floorTargets = [];
  const coinMeshes = [];
  const switchMeshes = [];
  const switchCrystalMeshes = [];
  const movingMeshes = [];
  const physicsVisuals = [];
  const rotatorMeshes = [];
  const plateMeshes = [];
  let exitDoorMesh = null;
  let exitDoorGroup = null;

  // Board Foundation
  const foundation = new THREE.Mesh(
    new THREE.BoxGeometry(GRID_SIZE + 0.26, 0.42, GRID_SIZE + 0.26),
    createMaterial('#263d4a', 0.94)
  );
  foundation.position.y = -0.30;
  foundation.receiveShadow = true;
  boardGroup.add(foundation);

  // Floor Tiles
  for (let z = 0; z < GRID_SIZE; z++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const { x: wx, z: wz } = gridToWorld(x, z);
      const painted = hasCell(world.painted, x, z);
      const tileColor = painted ? '#62806c' : ((x + z) % 2 ? '#405665' : '#495f6c');
      const tile = new THREE.Mesh(new THREE.BoxGeometry(0.975, 0.13, 0.975), createMaterial(tileColor, 0.88));
      tile.position.set(wx, -0.055, wz);
      tile.receiveShadow = true;
      tile.userData = { gx: x, gz: z, kind: 'floor' };
      boardGroup.add(tile);
      floorTargets.push(tile);

      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(0.975, 0.13, 0.975)),
        new THREE.LineBasicMaterial({ color: '#78909a', transparent: true, opacity: 0.38 })
      );
      edge.position.copy(tile.position);
      boardGroup.add(edge);
    }
  }

  // Inner Walls
  for (const cell of world.walls) {
    if (world.exitDoor && cell[0] === world.exitDoor[0] && cell[1] === world.exitDoor[1]) continue;
    const isBorder = cell[0] === 0 || cell[0] === GRID_SIZE - 1 || cell[1] === 0 || cell[1] === GRID_SIZE - 1;
    if (isBorder) continue;
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const props = getObjectProperties(world, 'wall', cell);
    const wall = addBox(objectsGroup, [props.size, props.height, props.size], [x, props.height / 2, z], props.color, { roughness: 0.9 });
    wall.userData = { kind: 'wall', cell };
    addBox(objectsGroup, [props.size + 0.02, 0.09, props.size + 0.02], [x, props.height, z], '#839196', { castShadow: false });
  }

  // Room Shell (boundary walls and sconces)
  buildRoomShell(objectsGroup, world.exitDoor);

  // Pushable Physics Blocks
  for (const cell of world.blocks) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const props = getObjectProperties(world, 'block', cell);
    const blockGroup = new THREE.Group();
    const block = addBox(blockGroup, [props.size, props.height, props.size], [0, -0.035, 0], props.color, { roughness: 0.72 });
    block.userData = { kind: 'block', cell };
    addBox(blockGroup, [props.size + 0.02, 0.07, props.size + 0.02], [0, props.height / 2, 0], '#e1a26a', { castShadow: false });
    blockGroup.position.set(x, (props.height + 0.07) / 2, z);
    blockGroup.userData = { kind: 'block', cell };
    objectsGroup.add(blockGroup);
    physicsVisuals.push({ kind: 'block', cell, mesh: blockGroup });
  }

  // Platforms
  for (const cell of world.platforms || []) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const props = getObjectProperties(world, 'platform', cell);
    const base = new THREE.Mesh(new THREE.BoxGeometry(props.size, props.height, props.size), createMaterial('#32363a', 0.78, 0.12));
    base.position.set(x, props.height / 2, z);
    base.castShadow = true;
    base.receiveShadow = true;
    base.userData = { kind: 'platform', cell };
    objectsGroup.add(base);
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(props.size + 0.08, 0.12, props.size + 0.08),
      createMaterial(props.color, 0.54, 0.08, { emissive: props.color, emissiveIntensity: 0.1 })
    );
    top.position.set(x, props.height + 0.06, z);
    top.castShadow = true;
    top.receiveShadow = true;
    objectsGroup.add(top);
  }

  // Stairs
  for (const cell of world.stairs) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    for (let step = 0; step < 4; step++) {
      const height = 0.23 * (step + 1);
      const stair = addBox(objectsGroup, [0.24, height, 0.82], [x - 0.36 + step * 0.24, height / 2, z], step % 2 ? '#7d9b94' : '#9ab6a5');
      stair.userData = { kind: 'stairs', cell };
    }
  }

  // Lava Hazards
  for (const cell of world.hazards) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const pool = new THREE.Mesh(new THREE.BoxGeometry(0.91, 0.055, 0.91), createMaterial('#d94b26', 0.35, 0.05, { emissive: '#cf3d0c', emissiveIntensity: 1.2 }));
    pool.position.set(x, 0.045, z);
    pool.receiveShadow = true;
    objectsGroup.add(pool);
    const inner = new THREE.Mesh(new THREE.CircleGeometry(0.31, 20), createMaterial('#ffb044', 0.35, 0, { emissive: '#ff6b19', emissiveIntensity: 2 }));
    inner.rotation.x = -Math.PI / 2;
    inner.position.set(x, 0.078, z);
    objectsGroup.add(inner);
    const glow = new THREE.PointLight('#ff6427', 1.15, 2.3);
    glow.position.set(x, 0.45, z);
    objectsGroup.add(glow);
  }

  // Switches
  for (const cell of world.switches) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.35, 8), createMaterial('#374b5b', 0.48, 0.36));
    pedestal.position.set(x, 0.17, z);
    pedestal.castShadow = true;
    objectsGroup.add(pedestal);
    const crystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.3, 0),
      createMaterial(switchActivated ? '#75f0ce' : '#8b91ff', 0.2, 0.16, {
        emissive: switchActivated ? '#39dba6' : '#4b43c7',
        emissiveIntensity: switchActivated ? 1.5 : 0.9,
      })
    );
    crystal.position.set(x, 0.65, z);
    crystal.castShadow = true;
    crystal.userData.cell = cell;
    objectsGroup.add(crystal);
    switchMeshes.push(crystal);
    switchCrystalMeshes.push(crystal);
    const light = new THREE.PointLight(switchActivated ? '#6bffcf' : '#867cff', 1.6, 3.5);
    light.position.set(x, 0.9, z);
    objectsGroup.add(light);
  }

  // Coins
  for (let i = 0; i < world.coins.length; i++) {
    const cell = world.coins[i];
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const coinGroup = new THREE.Group();
    const coin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.23, 0.23, 0.085, 28),
      createMaterial('#ffc44c', 0.25, 0.56, { emissive: '#ad6814', emissiveIntensity: 0.42 })
    );
    coin.rotation.x = Math.PI / 2;
    coin.castShadow = true;
    coinGroup.add(coin);
    const inset = new THREE.Mesh(
      new THREE.CircleGeometry(0.15, 24),
      createMaterial('#ffe49b', 0.32, 0.22, { emissive: '#e5ae3c', emissiveIntensity: 0.22 })
    );
    inset.position.z = 0.05;
    coinGroup.add(inset);
    coinGroup.position.set(x, 0.48, z);
    coinGroup.userData = { coinIndex: i };
    coinGroup.visible = !collected.has(i);
    coinsGroup.add(coinGroup);
    coinMeshes.push(coinGroup);
  }

  // Springs
  for (const cell of world.springs) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.4, 0.16, 10), createMaterial('#3e6574', 0.45, 0.32));
    base.position.set(x, 0.08, z);
    objectsGroup.add(base);
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.07, 8, 18), createMaterial('#79d9d3', 0.28, 0.48, { emissive: '#147d7c', emissiveIntensity: 0.65 }));
    coil.position.set(x, 0.25, z);
    coil.rotation.x = Math.PI / 2;
    objectsGroup.add(coil);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 0.12, 10), createMaterial('#a4f2d9', 0.3, 0.22, { emissive: '#38bd9c', emissiveIntensity: 0.5 }));
    cap.position.set(x, 0.43, z);
    objectsGroup.add(cap);
  }

  // Portals
  for (const cell of world.portals) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const portalGroup = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.075, 10, 28), createMaterial('#74d6ff', 0.25, 0.42, { emissive: '#147dd2', emissiveIntensity: 1.35 }));
    ring.position.y = 0.55;
    portalGroup.add(ring);
    const core = new THREE.Mesh(new THREE.CircleGeometry(0.29, 24), new THREE.MeshBasicMaterial({ color: '#548aff', transparent: true, opacity: 0.65, side: THREE.DoubleSide }));
    core.position.set(0, 0.55, 0);
    portalGroup.add(core);
    portalGroup.position.set(x, 0, z);
    portalGroup.userData = { portal: true, baseY: 0 };
    objectsGroup.add(portalGroup);
    switchMeshes.push(ring);
  }

  // Checkpoints
  for (const cell of world.checkpoints) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.43, 0.18, 8), createMaterial('#397568', 0.48, 0.22));
    base.position.set(x, 0.09, z);
    objectsGroup.add(base);
    const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.24, 0), createMaterial('#7cf2c4', 0.24, 0.16, { emissive: '#25b97d', emissiveIntensity: 1.2 }));
    marker.position.set(x, 0.52, z);
    marker.castShadow = true;
    objectsGroup.add(marker);
    switchMeshes.push(marker);
  }

  // Movers
  for (let i = 0; i < world.movers.length; i++) {
    const cell = world.movers[i];
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const moverGroup = new THREE.Group();
    const platform = new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.18, 0.7), createMaterial('#d48b52', 0.4, 0.28, { emissive: '#773514', emissiveIntensity: 0.25 }));
    platform.castShadow = true;
    platform.receiveShadow = true;
    moverGroup.add(platform);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), createMaterial('#ffd17b', 0.25, 0, { emissive: '#ff9b34', emissiveIntensity: 1.8 }));
    beacon.position.y = 0.2;
    moverGroup.add(beacon);
    moverGroup.position.set(x, 0.35, z);
    moverGroup.userData = { x, z, index: i };
    objectsGroup.add(moverGroup);
    movingMeshes.push(moverGroup);
  }

  // Pressure Plates
  for (const cell of world.plates || []) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const active = activatedPlates.has(`${cell[0]},${cell[1]}`);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.48, 0.13, 8), createMaterial('#31414c', 0.58, 0.2));
    base.position.set(x, 0.065, z);
    objectsGroup.add(base);
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(0.66, 0.09, 0.66),
      createMaterial(active ? '#70edb6' : '#d59a4d', 0.4, 0.12, {
        emissive: active ? '#1d9b64' : '#7a4212',
        emissiveIntensity: 0.7,
      })
    );
    top.position.set(x, active ? 0.12 : 0.17, z);
    top.castShadow = true;
    objectsGroup.add(top);
    plateMeshes.push({ cell, top, active });
  }

  // Rotators
  for (let i = 0; i < (world.rotators || []).length; i++) {
    const cell = world.rotators[i];
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const rotGroup = new THREE.Group();
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.48, 12), createMaterial('#74858b', 0.42, 0.46));
    hub.position.y = 0.24;
    rotGroup.add(hub);
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(1.95, 0.16, 0.2),
      createMaterial('#e18a49', 0.4, 0.22, { emissive: '#783514', emissiveIntensity: 0.22 })
    );
    beam.position.y = 0.55;
    beam.castShadow = true;
    rotGroup.add(beam);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.3), createMaterial('#ffe0a0', 0.36, 0.16));
    cap.position.set(0.96, 0.55, 0);
    rotGroup.add(cap);
    rotGroup.position.set(x, 0, z);
    rotGroup.userData = { index: i };
    objectsGroup.add(rotGroup);
    rotatorMeshes.push(rotGroup);
  }

  // Exit Door Frame & Panel
  if (world.exitDoor) {
    const { x, z } = gridToWorld(world.exitDoor[0], world.exitDoor[1]);
    exitDoorGroup = new THREE.Group();
    exitDoorGroup.position.set(x, 0, z);
    if (world.exitDoor[0] === 0 || world.exitDoor[0] === GRID_SIZE - 1) {
      exitDoorGroup.rotation.y = Math.PI / 2;
    }
    const jambOffset = EXIT_OPENING_WIDTH / 2 - 0.07;
    addBox(exitDoorGroup, [0.14, 2.85, 0.22], [-jambOffset, 1.43, 0], '#64737c', { metalness: 0.4 });
    addBox(exitDoorGroup, [0.14, 2.85, 0.22], [jambOffset, 1.43, 0], '#64737c', { metalness: 0.4 });
    addBox(exitDoorGroup, [EXIT_OPENING_WIDTH, 0.16, 0.22], [0, 2.82, 0], '#9ca9aa', { metalness: 0.35 });
    exitDoorMesh = addBox(exitDoorGroup, [1.17, 2.55, 0.16], [0, 1.3, 0], doorsOpen ? '#587c6e' : '#56636a', { metalness: 0.28 });
    exitDoorMesh.userData.kind = 'exitDoor';
    objectsGroup.add(exitDoorGroup);
  }

  // Ambient Wall Sconces & Lanterns
  buildDecorations(decorationGroup);

  return {
    floorTargets,
    coinMeshes,
    switchMeshes,
    switchCrystalMeshes,
    movingMeshes,
    physicsVisuals,
    rotatorMeshes,
    plateMeshes,
    exitDoorMesh,
    exitDoorGroup,
  };
}

/**
 * Construct room outer boundary walls with lighting sconces.
 */
function buildRoomShell(group, door) {
  const height = 8.5;
  const y = height / 2;
  const edge = HALF_GRID + 0.12;
  const thickness = 0.35;

  const makeSpan = (axis, side, from, to) => {
    if (to < from) return;
    const length = to - from + 1;
    const middle = (from + to) / 2 - HALF_GRID;
    if (axis === 'z') {
      const z = side * edge;
      addBox(group, [length, height, thickness], [middle, y, z], '#925b37', { roughness: 0.92 });
      addBox(group, [length, 0.22, thickness + 0.04], [middle, height - 0.11, z], '#d39a5c', { castShadow: false });
      addBox(group, [length, 0.12, thickness + 0.05], [middle, 0.12, z], '#263846', { castShadow: false });
    } else {
      const x = side * edge;
      addBox(group, [thickness, height, length], [x, y, middle], '#925b37', { roughness: 0.92 });
      addBox(group, [thickness + 0.04, 0.22, length], [x, height - 0.11, middle], '#d39a5c', { castShadow: false });
      addBox(group, [thickness + 0.05, 0.12, length], [x, 0.12, middle], '#263846', { castShadow: false });
    }
  };

  const spansFor = (axis, side) => {
    const doorOnSide = door && (axis === 'z'
      ? door[1] === (side < 0 ? 0 : GRID_SIZE - 1)
      : door[0] === (side < 0 ? 0 : GRID_SIZE - 1));
    if (!doorOnSide) {
      makeSpan(axis, side, 0, GRID_SIZE - 1);
      return;
    }
    const index = door[axis === 'z' ? 0 : 1];
    const openingOffset = (EXIT_OPENING_WIDTH - 1) / 2;
    makeSpan(axis, side, 0, index - 1 - openingOffset);
    makeSpan(axis, side, index + 1 + openingOffset, GRID_SIZE - 1);
    const doorX = axis === 'z' ? index - HALF_GRID : side * edge;
    const doorZ = axis === 'z' ? side * edge : index - HALF_GRID;
    const headerHeight = height - 2.9;
    if (axis === 'z') {
      addBox(group, [EXIT_OPENING_WIDTH, headerHeight, thickness], [doorX, 2.9 + headerHeight / 2, doorZ], '#925b37', { roughness: 0.92 });
    } else {
      addBox(group, [thickness, headerHeight, EXIT_OPENING_WIDTH], [doorX, 2.9 + headerHeight / 2, doorZ], '#925b37', { roughness: 0.92 });
    }
  };

  spansFor('z', -1);
  spansFor('z', 1);
  spansFor('x', -1);
  spansFor('x', 1);

  // Decorative wall sconces
  const sconces = [
    [-4.8, 5.82, '#ffca8a'], [0, 5.82, '#ffe0aa'], [4.8, 5.82, '#ffca8a'],
    [-4.8, -5.82, '#ffca8a'], [0, -5.82, '#ffe0aa'], [4.8, -5.82, '#ffca8a'],
    [5.82, -3.8, '#ffca8a'], [5.82, 3.8, '#ffca8a'], [-5.82, -3.8, '#ffca8a'], [-5.82, 3.8, '#ffca8a']
  ];
  for (const [x, z, color] of sconces) {
    const mount = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.38, 0.18), createMaterial('#39434a', 0.7, 0.2));
    mount.position.set(x, 5.45, z);
    group.add(mount);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), createMaterial(color, 0.24, 0, { emissive: color, emissiveIntensity: 1.5 }));
    lamp.position.set(x, 5.65, z);
    group.add(lamp);
    const light = new THREE.PointLight(color, 1.15, 6.5);
    light.position.set(x, 5.65, z);
    group.add(light);
  }
}

/**
 * Atmospheric room beacons and floor lantern posts.
 */
function buildDecorations(group) {
  for (const [x, z] of [[-3.55, -2.55], [2.55, -3.55], [-2.55, 3.55]]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 1.05, 8), createMaterial('#5b5960', 0.55, 0.2));
    post.position.set(x, 0.52, z);
    post.castShadow = true;
    group.add(post);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 10), createMaterial('#ffbd70', 0.2, 0, { emissive: '#ff7e2d', emissiveIntensity: 2.4 }));
    lamp.position.set(x, 1.13, z);
    group.add(lamp);
    const light = new THREE.PointLight('#ff9a56', 1.3, 4.3);
    light.position.set(x, 1.18, z);
    group.add(light);
  }
}

/**
 * Instantiate the 3D player robot cube.
 */
export function createPlayerMesh(playerHalf = 0.37) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(playerHalf * 2, playerHalf * 2, playerHalf * 2),
    createMaterial('#ff922f', 0.38, 0.04)
  );
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.105, 16, 12), createMaterial('#fff7e8', 0.25));
    eye.position.set(side * 0.155, 0.10, playerHalf + 0.025);
    group.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.047, 12, 10), createMaterial('#28333b', 0.28));
    pupil.position.set(side * 0.155, 0.095, playerHalf + 0.11);
    group.add(pupil);
  }
  return group;
}

/**
 * Instantiate the editor grid cursor ring.
 */
export function createCursorMesh() {
  const cursor = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.48, 32),
    new THREE.MeshBasicMaterial({ color: '#73f0ce', side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
  );
  cursor.rotation.x = -Math.PI / 2;
  cursor.position.y = 0.035;
  cursor.visible = false;
  return cursor;
}

