/**
 * Level geometry & scenery: the CatLab.
 *
 * The level lives inside a closed laboratory room: panelled steel walls on every side (single-sided, so the
 * camera can look in from outside like a dollhouse), a tiled floor, a ceiling with light panels, pipes, vents,
 * wall screens and hazard striping.  Obstacles are lab hardware: acid vats, water pools, floor spikes, saw
 * cutters, scanning lasers that can sweep along any axis, and electric shocks that strike from one direction.
 * The grid still exists as *data* (editor + RL environment) but nothing in the picture looks like cells.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import { RoundedBoxGeometry } from './vendor/rounded_box_geometry.js';
import {
  GRID_SIZE, HALF_GRID, EXIT_OPENING_WIDTH, WALL_TOP_PAD, PLATFORM_TOP_PAD, LIFT_DEFAULT_HEIGHT,
  gridToWorld, hasCell, laserCenter, laserSpec, shockSpec, shockPhase, cutterPosition, cutterSpec, spikeUp,
  SHOCK_CHARGE_AT, SHOCK_STRIKE_AT, liftTop,
  channelOf, channelColor, CHANNELS,
} from './constants.js';
import { createMaterial, addBox, disposeGroup, getObjectProperties, mergeCells, surfaceHeightAt } from './materials.js';
import { createDeeba } from './character.js';

export { createDeeba as createPlayerMesh };

// ── Procedural textures (created once, shared) ───────────────────────────────────────────────────
function canvasTexture(size, draw, { repeat = true, srgb = true } = {}) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hashString(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

let TEX = null;
function textures() {
  if (TEX) return TEX;
  const rnd = mulberry(7);
  TEX = {
    grass: canvasTexture(512, (g, n) => {
      g.fillStyle = '#7dbb5f'; g.fillRect(0, 0, n, n);
      for (let i = 0; i < 1400; i++) {
        const x = rnd() * n, y = rnd() * n, r = 10 + rnd() * 46;
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        const tone = rnd();
        grd.addColorStop(0, tone > 0.5 ? 'rgba(160,214,110,0.20)' : 'rgba(60,130,70,0.18)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        for (const ox of [-n, 0, n]) for (const oy of [-n, 0, n]) { g.save(); g.translate(ox, oy); g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.restore(); }
      }
      g.strokeStyle = 'rgba(40,110,50,0.25)'; g.lineWidth = 1;
      for (let i = 0; i < 900; i++) { const x = rnd() * n, y = rnd() * n; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 4, y - 3 - rnd() * 5); g.stroke(); }
    }),
    stone: canvasTexture(256, (g, n) => {
      g.fillStyle = '#d9dbe2'; g.fillRect(0, 0, n, n);
      const rows = 4;
      for (let r = 0; r < rows; r++) {
        const h = n / rows, off = (r % 2) * (n / 4);
        for (let c = -1; c < 3; c++) {
          const x = c * (n / 2) + off, w = n / 2;
          const shade = 200 + Math.floor(rnd() * 40);
          g.fillStyle = `rgb(${shade},${shade + 2},${shade + 8})`; g.fillRect(x + 2, r * h + 2, w - 4, h - 4);
          for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(80,86,100,${rnd() * 0.07})`; g.fillRect(x + rnd() * w, r * h + rnd() * h, 2 + rnd() * 5, 2 + rnd() * 3); }
        }
      }
      g.strokeStyle = 'rgba(70,76,92,0.55)'; g.lineWidth = 3;
      for (let r = 0; r <= rows; r++) { g.beginPath(); g.moveTo(0, r * (n / rows)); g.lineTo(n, r * (n / rows)); g.stroke(); }
      for (let r = 0; r < rows; r++) { const off = (r % 2) * (n / 4); for (let c = 0; c < 3; c++) { const x = (c * (n / 2) + off) % n; g.beginPath(); g.moveTo(x, r * (n / rows)); g.lineTo(x, (r + 1) * (n / rows)); g.stroke(); } }
    }),
    soft: canvasTexture(128, (g, n) => {
      const grd = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.55, 'rgba(255,255,255,0.95)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, n, n);
    }, { repeat: false }),
    curtain: canvasTexture(64, (g, n) => {
      const grd = g.createLinearGradient(0, n, 0, 0);
      grd.addColorStop(0, 'rgba(255,255,255,0.9)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, n, n);
    }, { repeat: false }),
    fence: canvasTexture(128, (g, n) => {
      const grd = g.createLinearGradient(0, n, 0, 0);
      grd.addColorStop(0, 'rgba(120,230,255,0.8)'); grd.addColorStop(0.4, 'rgba(120,230,255,0.2)'); grd.addColorStop(1, 'rgba(120,230,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, n, n);
      g.strokeStyle = 'rgba(200,250,255,0.5)'; g.lineWidth = 2;
      for (let x = 0; x <= n; x += n / 2) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, n); g.stroke(); }
    }),
    crate: canvasTexture(256, (g, n) => {
      g.fillStyle = '#e8c79a'; g.fillRect(0, 0, n, n);
      for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(120,70,30,${0.12 + rnd() * 0.12})`; g.fillRect(0, i * (n / 6), n, 3); }
      for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(110,64,28,${rnd() * 0.12})`; g.fillRect(rnd() * n, rnd() * n, 20 + rnd() * 40, 1); }
      g.strokeStyle = '#8a5a2e'; g.lineWidth = 14; g.strokeRect(7, 7, n - 14, n - 14);
      g.lineWidth = 12; g.beginPath(); g.moveTo(14, 14); g.lineTo(n - 14, n - 14); g.moveTo(n - 14, 14); g.lineTo(14, n - 14); g.stroke();
      g.fillStyle = '#5a3a1c'; for (const [x, y] of [[14, 14], [n - 14, 14], [14, n - 14], [n - 14, n - 14]]) { g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill(); }
    }),
    epoxy: canvasTexture(1024, (g, n) => {
      // one continuous poured-resin floor: soft light pools, faint wear, a dashed walkway – no tile seams at all
      const base = g.createLinearGradient(0, 0, n, n); base.addColorStop(0, '#9fb7bd'); base.addColorStop(0.5, '#b4c9ce'); base.addColorStop(1, '#8fa8af');
      g.fillStyle = base; g.fillRect(0, 0, n, n);
      for (let i = 0; i < 260; i++) {
        const x = rnd() * n, y = rnd() * n, r = 30 + rnd() * 140, grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, rnd() > 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(30,60,70,0.07)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
      }
      for (let i = 0; i < 1500; i++) { g.fillStyle = `rgba(20,40,50,${rnd() * 0.035})`; g.fillRect(rnd() * n, rnd() * n, 1 + rnd() * 3, 1 + rnd() * 3); }
      g.strokeStyle = 'rgba(255,200,60,0.55)'; g.lineWidth = 10; g.setLineDash([46, 34]); g.beginPath(); g.moveTo(n / 2, n * 0.14); g.lineTo(n / 2, n * 0.92); g.stroke(); g.setLineDash([]);
    }, { repeat: false }),
    concrete: canvasTexture(256, (g, n) => {
      g.fillStyle = '#34505a'; g.fillRect(0, 0, n, n);
      for (let i = 0; i < 160; i++) {
        const x = rnd() * n, y = rnd() * n, r = 18 + rnd() * 60, grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, rnd() > 0.5 ? 'rgba(160,210,220,0.08)' : 'rgba(5,20,28,0.12)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
        for (const ox of [-n, 0, n]) for (const oy of [-n, 0, n]) { g.save(); g.translate(ox, oy); g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.restore(); }
      }
    }),
    tile: canvasTexture(256, (g, n) => {
      g.fillStyle = '#39464f'; g.fillRect(0, 0, n, n);
      for (let i = 0; i < 700; i++) { g.fillStyle = `rgba(${rnd() > 0.5 ? '255,255,255' : '0,0,0'},${rnd() * 0.05})`; g.fillRect(rnd() * n, rnd() * n, 2 + rnd() * 14, 1 + rnd() * 3); }
      g.strokeStyle = 'rgba(10,16,20,0.9)'; g.lineWidth = 6; g.strokeRect(0, 0, n, n);
      g.strokeStyle = 'rgba(140,170,185,0.22)'; g.lineWidth = 2; g.strokeRect(6, 6, n - 12, n - 12);
      g.fillStyle = 'rgba(15,22,28,0.8)'; for (const [x, y] of [[18, 18], [n - 18, 18], [18, n - 18], [n - 18, n - 18]]) { g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill(); }
    }),
    panel: canvasTexture(256, (g, n) => {
      g.fillStyle = '#c9d3d6'; g.fillRect(0, 0, n, n);
      for (let i = 0; i < 500; i++) { g.fillStyle = `rgba(60,80,90,${rnd() * 0.05})`; g.fillRect(rnd() * n, rnd() * n, 3 + rnd() * 18, 1 + rnd() * 2); }
      g.strokeStyle = 'rgba(70,92,102,0.85)'; g.lineWidth = 4; g.strokeRect(2, 2, n - 4, n - 4);
      g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 2; g.strokeRect(10, 10, n - 20, n - 20);
      g.fillStyle = 'rgba(70,92,102,0.8)'; for (const [x, y] of [[20, 20], [n - 20, 20], [20, n - 20], [n - 20, n - 20]]) { g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill(); }
    }),
    stripes: canvasTexture(128, (g, n) => {
      g.fillStyle = '#16191c'; g.fillRect(0, 0, n, n); g.fillStyle = '#f2c230';
      for (let i = -n; i < n * 2; i += 32) { g.beginPath(); g.moveTo(i, n); g.lineTo(i + 16, n); g.lineTo(i + 16 + n, 0); g.lineTo(i + n, 0); g.fill(); }
    }),
    grate: canvasTexture(128, (g, n) => {
      g.fillStyle = '#5b6a73'; g.fillRect(0, 0, n, n); g.fillStyle = '#12191e';
      for (let x = 8; x < n; x += 16) for (let y = 8; y < n; y += 16) { g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); }
    }),
    screen: canvasTexture(256, (g, n) => {
      g.fillStyle = '#04161a'; g.fillRect(0, 0, n, n);
      g.strokeStyle = '#38e6c8'; g.lineWidth = 3; g.beginPath();
      for (let x = 0; x <= n; x += 8) { const y = n * 0.55 + Math.sin(x * 0.07) * 40 + Math.sin(x * 0.19) * 18; x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
      g.fillStyle = 'rgba(56,230,200,0.75)'; g.font = 'bold 22px monospace'; g.fillText('CATLAB', 14, 34); g.font = '14px monospace'; g.fillText('SUBJECT: DEEBA', 14, 56);
      for (let y = 0; y < n; y += 4) { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, y, n, 1); }
    }, { repeat: false }),
    arrow: canvasTexture(128, (g, n) => {
      g.fillStyle = '#2d4a47'; g.fillRect(0, 0, n, n);
      g.strokeStyle = '#7bffd0'; g.lineWidth = 10; g.lineCap = 'round'; g.lineJoin = 'round';
      for (const y of [42, 84]) { g.beginPath(); g.moveTo(34, y + 16); g.lineTo(64, y - 10); g.lineTo(94, y + 16); g.stroke(); }
    }, { repeat: false }),
  };
  return TEX;
}

function scaleBoxUV(geo, w, h, d) {
  const uv = geo.attributes.uv;
  const f = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let face = 0; face < 6; face++) for (let v = 0; v < 4; v++) { const i = face * 4 + v; uv.setXY(i, uv.getX(i) * f[face][0], uv.getY(i) * f[face][1]); }
  uv.needsUpdate = true;
  return geo;
}

// ── Lab backdrop, lighting moods ──────────────────────────────────────────────────────────────────
// Shared so the glowing strips in buildBoard follow the per-level accent colour.
const ACCENT = new THREE.Color('#47e6d1');
const PALETTES = [
  { accent: '#47e6d1', top: '#1d4651', horizon: '#3b7482', sun: '#dff8ff', hemiSky: '#bfe9f2', hemiGround: '#2c4047', sunI: 2.4 },
  { accent: '#6ab8ff', top: '#1d3858', horizon: '#3d6590', sun: '#dbe9ff', hemiSky: '#b6d2f5', hemiGround: '#26384a', sunI: 2.3 },
  { accent: '#ff7a8a', top: '#4a2434', horizon: '#7a4054', sun: '#ffe3e8', hemiSky: '#f2c4cf', hemiGround: '#47262f', sunI: 2.3 },
  { accent: '#9dff6a', top: '#25502e', horizon: '#4a8a56', sun: '#effff0', hemiSky: '#cdeccd', hemiGround: '#2c4a2e', sunI: 2.4 },
  { accent: '#ffc15a', top: '#5a4220', horizon: '#8f6b34', sun: '#fff1da', hemiSky: '#f4dcb4', hemiGround: '#4a3a24', sunI: 2.4 },
  { accent: '#c58cff', top: '#3a2a5a', horizon: '#65508f', sun: '#f1e6ff', hemiSky: '#d6c0f3', hemiGround: '#3a2c52', sunI: 2.3 },
];

export function createEnvironment(scene, lights) {
  // A dark void around the room (only ever seen when the dollhouse camera is outside the walls).
  const skyUniforms = { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() } };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(95, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyUniforms,
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying vec3 vP; void main(){ float h = clamp(vP.y*0.5+0.5,0.0,1.0); gl_FragColor = vec4(mix(horizon, top, pow(h,1.4)),1.0); }',
    }),
  );
  sky.renderOrder = -10;
  scene.add(sky);

  const fogColor = new THREE.Color();
  function setMood(index) {
    const p = PALETTES[index % PALETTES.length];
    skyUniforms.top.value.set(p.top); skyUniforms.horizon.value.set(p.horizon);
    fogColor.set(p.horizon);
    scene.fog = new THREE.Fog(fogColor.clone(), 30, 90);
    scene.background = fogColor.clone();
    ACCENT.set(p.accent);
    if (lights) {
      lights.sun.color.set(p.sun); lights.sun.intensity = p.sunI;
      lights.hemi.color.set(p.hemiSky); lights.hemi.groundColor.set(p.hemiGround);
      lights.rim.color.set(p.accent);
    }
  }
  setMood(0);
  return { setMood, update() {} };
}

// ── The board ────────────────────────────────────────────────────────────────────────────────────
export function buildBoard(groups, world, runtimeState) {
  const { boardGroup, objectsGroup, coinsGroup, decorationGroup } = groups;
  const { activatedPlates, collected, switchActivated, doorsOpen, powerupsCollected } = runtimeState;
  [boardGroup, objectsGroup, coinsGroup, decorationGroup].forEach(disposeGroup);
  const T = textures();
  const edge = GRID_SIZE - 1;
  const door = world.exitDoor;
  const isBorder = ([x, z]) => x === 0 || z === 0 || x === edge || z === edge;
  const isDoorCell = ([x, z]) => door && door[0] === x && door[1] === z;

  const out = {
    floorTargets: [], coinMeshes: [], switchMeshes: [], switchCrystalMeshes: [], movingMeshes: [], physicsVisuals: [],
    rotatorMeshes: [], plateMeshes: [], powerupMeshes: [], laserMeshes: [], barrierMeshes: [], leverMeshes: [],
    liftMeshes: [], movingLaserMeshes: [], shockMeshes: [], cutterMeshes: [], spikeMeshes: [], occluders: [], exitDoorMesh: null, exitDoorGroup: null,
  };
  const updaters = [];

  // ── The closed lab room: tiled floor, panelled walls on all four sides, ceiling, trim, pipes, screens ──
  const ROOM_H = 4.6;
  const scalePlane = (geo, rx, ry) => { const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rx, uv.getY(i) * ry); uv.needsUpdate = true; return geo; };
  const accentMat = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }); accentMat.color = ACCENT;
  // Continuous floor: a smooth resin pad inside the room, and the same lab hall floor running on past the walls
  // (so the room is plainly *in* a building, not floating).
  const floorMat = new THREE.MeshStandardMaterial({ map: T.epoxy, color: '#ffffff', roughness: 0.32, metalness: 0.15 });
  const slab = new THREE.Mesh(new THREE.PlaneGeometry(GRID_SIZE, GRID_SIZE), floorMat);
  slab.rotation.x = -Math.PI / 2; slab.position.y = 0; slab.receiveShadow = true; slab.userData.kind = 'floor';
  boardGroup.add(slab); out.floorTargets.push(slab);
  const hallMat = new THREE.MeshStandardMaterial({ map: T.concrete, color: '#ffffff', roughness: 0.55, metalness: 0.2 });
  const hallFloor = new THREE.Mesh(scalePlane(new THREE.PlaneGeometry(160, 160), 24, 24), hallMat);
  hallFloor.rotation.x = -Math.PI / 2; hallFloor.position.y = -0.03; hallFloor.receiveShadow = true; boardGroup.add(hallFloor);
  const panelMat = new THREE.MeshStandardMaterial({ map: T.panel, color: '#ffffff', roughness: 0.6, metalness: 0.3, side: THREE.FrontSide });
  const stripeMat = new THREE.MeshStandardMaterial({ map: T.stripes, color: '#ffffff', roughness: 0.7 });
  // Wall segment: `side` is where it stands (-1 / +1), `axis` which coordinate the wall is perpendicular to.
  const wallSegment = (axis, side, from, to) => {
    if (to < from) return;
    const len = to - from + 1, mid = (from + to) / 2 - HALF_GRID, c = side * (HALF_GRID - 0.5);
    const place = (mesh, inset = 0, y = 0) => {
      const cc = c - side * inset;
      if (axis === 'z') { mesh.position.set(mid, y, cc); mesh.rotation.y = side < 0 ? 0 : Math.PI; } else { mesh.position.set(cc, y, mid); mesh.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2; }
      boardGroup.add(mesh); return mesh;
    };
    place(new THREE.Mesh(scalePlane(new THREE.PlaneGeometry(len, ROOM_H), len / 2, ROOM_H / 2), panelMat), 0, ROOM_H / 2).receiveShadow = true;
    place(new THREE.Mesh(scalePlane(new THREE.PlaneGeometry(len, 0.34), len * 1.5, 1), stripeMat), 0.01, 0.17);
    place(new THREE.Mesh(new THREE.PlaneGeometry(len, 0.06), accentMat), 0.012, 3.9);
    const curb = new THREE.Mesh(new THREE.BoxGeometry(axis === 'z' ? len : 0.34, 0.22, axis === 'z' ? 0.34 : len), createMaterial('#d9e4e6', 0.4, 0.2));
    curb.position.set(axis === 'z' ? mid : c + side * 0.17, 0.11, axis === 'z' ? c + side * 0.17 : mid); curb.castShadow = curb.receiveShadow = true; boardGroup.add(curb);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, len, 10), createMaterial('#6f8590', 0.35, 0.7));
    pipe.rotation.z = Math.PI / 2; place(pipe, 0.2, 4.25);
    const pipe2 = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, len, 8), createMaterial('#c58a3c', 0.4, 0.6));
    pipe2.rotation.z = Math.PI / 2; place(pipe2, 0.16, 3.65);
    return { place, len };
  };
  const wallPieces = [];
  for (const [axis, side] of [['z', -1], ['z', 1], ['x', -1], ['x', 1]]) {
    const here = door && (axis === 'z' ? door[1] === (side < 0 ? 0 : edge) : door[0] === (side < 0 ? 0 : edge));
    if (!here) wallPieces.push(wallSegment(axis, side, 0, edge));
    else {
      const index = door[axis === 'z' ? 0 : 1], half = Math.ceil((EXIT_OPENING_WIDTH - 1) / 2);
      wallPieces.push(wallSegment(axis, side, 0, index - 1 - half), wallSegment(axis, side, index + 1 + half, edge));
      // header panel above the opening
      const wide = (half * 2 + 1) * 1.0, c = side * (HALF_GRID - 0.5), mid = index - HALF_GRID;
      const header = new THREE.Mesh(new THREE.PlaneGeometry(wide, ROOM_H - 3.3), panelMat);
      if (axis === 'z') { header.position.set(mid, 3.3 + (ROOM_H - 3.3) / 2, c); header.rotation.y = side < 0 ? 0 : Math.PI; } else { header.position.set(c, 3.3 + (ROOM_H - 3.3) / 2, mid); header.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2; }
      boardGroup.add(header);
    }
  }
  const lightPanelMat = new THREE.MeshBasicMaterial({ color: '#e9fbff', toneMapped: false });
  // corner pillars + a top frame so the chamber reads as a built room from outside
  const pillarMat = createMaterial('#e3ecee', 0.4, 0.3);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pil = new THREE.Mesh(new THREE.BoxGeometry(0.7, ROOM_H + 0.3, 0.7), pillarMat); pil.position.set(sx * (HALF_GRID + 0.15), (ROOM_H + 0.3) / 2, sz * (HALF_GRID + 0.15)); pil.castShadow = true; boardGroup.add(pil);
    const ring = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.08, 0.74), accentMat); ring.position.set(sx * (HALF_GRID + 0.15), 3.9, sz * (HALF_GRID + 0.15)); boardGroup.add(ring);
  }
  // ── The hall around the room: far walls, columns, tanks, catwalk, cable runs, big overhead pipes ──
  const HALL = 34, HALL_H = 15;
  const hallWallMat = new THREE.MeshStandardMaterial({ map: T.panel, color: '#7fa0a8', roughness: 0.7, metalness: 0.2 });
  for (const [hx, hz, ry] of [[0, -HALL, 0], [0, HALL, Math.PI], [-HALL, 0, Math.PI / 2], [HALL, 0, -Math.PI / 2]]) {
    const w = new THREE.Mesh(scalePlane(new THREE.PlaneGeometry(HALL * 2, HALL_H), 16, 4), hallWallMat); w.position.set(hx, HALL_H / 2, hz); w.rotation.y = ry; boardGroup.add(w);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(HALL * 2, 0.7), accentMat); strip.position.set(hx - Math.sin(ry) * 0.05, 8.5, hz + Math.cos(ry) * -0.05 * -1); strip.rotation.y = ry; boardGroup.add(strip);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(HALL * 1.2, 3.2), new THREE.MeshBasicMaterial({ color: '#bdf3ff', transparent: true, opacity: 0.35, toneMapped: false }));
    win.position.set(hx + Math.sin(ry) * -0.08 * 0 + (ry === Math.PI / 2 ? 0.08 : ry === -Math.PI / 2 ? -0.08 : 0), 5.5, hz + (ry === 0 ? 0.08 : ry === Math.PI ? -0.08 : 0)); win.rotation.y = ry; boardGroup.add(win);
  }
  const hallCeil = new THREE.Mesh(scalePlane(new THREE.PlaneGeometry(HALL * 2, HALL * 2), 16, 16), new THREE.MeshStandardMaterial({ map: T.panel, color: '#5c7a83', roughness: 0.9 }));
  hallCeil.rotation.x = Math.PI / 2; hallCeil.position.y = HALL_H; boardGroup.add(hallCeil);
  const colMat = createMaterial('#bcd0d4', 0.5, 0.3);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.2, r = 17 + (i % 3) * 4;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, HALL_H, 14), colMat); col.position.set(Math.cos(a) * r, HALL_H / 2, Math.sin(a) * r); col.castShadow = true; boardGroup.add(col);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 0.3, 14), accentMat); band.position.set(col.position.x, 3.2, col.position.z); boardGroup.add(band);
  }
  const tankG = new THREE.MeshPhysicalMaterial({ color: '#8ff5df', transparent: true, opacity: 0.28, roughness: 0.08, clearcoat: 1 });
  const tankL = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, toneMapped: false }); tankL.color = ACCENT;
  for (const [tx, tz] of [[-14, 11], [14, 12], [-15, -12], [16, -11], [0, 19], [-8, 18.5], [9, -19]]) {
    const tg = new THREE.Group(); tg.position.set(tx, 0, tz);
    tg.add(new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.4, 0.4, 20), colMat));
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 5, 20, 1, true), tankG); glass.position.y = 2.9; tg.add(glass);
    const liq = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 3.6, 20), tankL); liq.position.y = 2.2; tg.add(liq);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 0.4, 20), colMat); cap.position.y = 5.5; tg.add(cap);
    boardGroup.add(tg);
  }
  // catwalk along the back wall, overhead pipes, cable runs leading away from the room, lit ceiling panels
  const walkMat = createMaterial('#6f8790', 0.5, 0.5);
  const walk = new THREE.Mesh(new THREE.BoxGeometry(46, 0.25, 3), walkMat); walk.position.set(0, 3.4, 30.5); boardGroup.add(walk);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(46, 0.08, 0.08), accentMat); rail.position.set(0, 4.5, 29.1); boardGroup.add(rail);
  for (let i = -10; i <= 10; i++) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.2, 0.08), walkMat); post.position.set(i * 2.3, 3.95, 29.1); boardGroup.add(post); }
  for (const z of [-20, -8, 8, 20]) { const pp = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, HALL * 2, 12), createMaterial('#c58a3c', 0.4, 0.6)); pp.rotation.z = Math.PI / 2; pp.position.set(0, 11.5, z); boardGroup.add(pp); }
  const cableMat = createMaterial('#10171b', 0.8, 0.2);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.4, len = 22;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.12, len), cableMat); cab.position.set(Math.sin(a) * (8 + len / 2), 0.0, Math.cos(a) * (8 + len / 2)); cab.rotation.y = a; boardGroup.add(cab);
  }
  for (const [lx, lz] of [[-18, -18], [18, -18], [-18, 18], [18, 18], [0, 0], [-24, 0], [24, 0], [0, -24], [0, 24]]) {
    const lp = new THREE.Mesh(new THREE.BoxGeometry(5, 0.1, 2), lightPanelMat); lp.position.set(lx, HALL_H - 0.1, lz); boardGroup.add(lp);
  }
  // exit pad beyond the door
  if (door) {
    const dp = gridToWorld(door[0], door[1]);
    const out2 = new THREE.Mesh(new THREE.PlaneGeometry(3, 5), new THREE.MeshBasicMaterial({ map: T.arrow, color: '#7bffd0', transparent: true, opacity: 0.55, toneMapped: false }));
    out2.rotation.x = -Math.PI / 2; out2.position.set(dp.x + (door[0] === edge ? 4 : door[0] === 0 ? -4 : 0), 0.02, dp.z + (door[1] === edge ? 4 : door[1] === 0 ? -4 : 0)); boardGroup.add(out2);
  }
  // ceiling (faces down, invisible from above) with four light panels
  const ceiling = new THREE.Mesh(scalePlane(new THREE.PlaneGeometry(GRID_SIZE, GRID_SIZE), GRID_SIZE / 2, GRID_SIZE / 2), new THREE.MeshStandardMaterial({ map: T.panel, color: '#9fb0b6', roughness: 0.8 }));
  ceiling.rotation.x = Math.PI / 2; ceiling.position.y = ROOM_H; boardGroup.add(ceiling);
  for (const [lx, lz] of [[-4, -6], [4, -6], [-4, 0], [4, 0], [-4, 6], [4, 6]].map(([a, b]) => [a * (HALF_GRID / 8), b * (HALF_GRID / 6)])) {
    const lp = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.06, 1.0), lightPanelMat); lp.position.set(lx, ROOM_H - 0.04, lz); boardGroup.add(lp);
  }
  // floor guide stripes along the base of every wall
  for (const [sx, sz, w, d] of [[0, -(HALF_GRID - 0.65), GRID_SIZE - 2, 0.3], [0, HALF_GRID - 0.65, GRID_SIZE - 2, 0.3], [-(HALF_GRID - 0.65), 0, 0.3, GRID_SIZE - 2], [HALF_GRID - 0.65, 0, 0.3, GRID_SIZE - 2]]) {
    const st = new THREE.Mesh(scaleBoxUV(new THREE.BoxGeometry(w, 0.014, d), Math.max(w, d) * 1.5, 0.014, 1), stripeMat); st.position.set(sx, 0.007, sz); st.receiveShadow = true; boardGroup.add(st);
  }
  // wall screens + vents (decoration only, kept in the wall plane)
  const screenMat = new THREE.MeshBasicMaterial({ map: T.screen, color: '#ffffff', toneMapped: false });
  const grateMat = new THREE.MeshStandardMaterial({ map: T.grate, color: '#ffffff', roughness: 0.6, metalness: 0.5 });
  const frameMat = createMaterial('#1b262c', 0.4, 0.6);
  const deco = (kind, axis, side, along, y) => {
    const g = new THREE.Group();
    const w = kind === 'screen' ? 1.7 : 1.0, h = kind === 'screen' ? 1.0 : 0.7;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, h + 0.12, 0.06), frameMat); g.add(frame);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), kind === 'screen' ? screenMat : grateMat); face.position.z = 0.04; g.add(face);
    const c = side * (HALF_GRID - 0.5) - side * 0.04;
    if (axis === 'z') { g.position.set(along, y, c); g.rotation.y = side < 0 ? 0 : Math.PI; } else { g.position.set(c, y, along); g.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2; }
    boardGroup.add(g);
  };
  for (const a of [-6, -2, 2, 6]) { deco('screen', 'x', -1, a, 2.5); deco('screen', 'x', 1, a + 0.6, 2.5); }
  deco('screen', 'z', 1, 3.6, 2.5);
  for (const a of [-4, 0, 4]) { deco('vent', 'x', -1, a + 0.1, 1.3); deco('vent', 'x', 1, a + 0.2, 1.3); } deco('vent', 'z', 1, -3.8, 1.3);

  // ── Liquids: acid, water and ice are one continuous surface, not discs ──
  // A single world-space shader draws the cartoon "cracked cell" pattern, so neighbouring cells join seamlessly,
  // and a per-instance neighbour mask gives every pool a soft, wobbling shoreline.
  const LIQUID = {
    acid: { base: '#7bd92a', deep: '#3f9a12', line: '#e3ff7e', rim: '#244d0c', speed: 0.55, scale: 1.25, glow: 0.35 },
    water: { base: '#2f93f2', deep: '#1c62c4', line: '#b6e4ff', rim: '#e9f8ff', speed: 0.4, scale: 1.05, glow: 0.0 },
    ice: { base: '#bfe8f4', deep: '#8cc8dc', line: '#ffffff', rim: '#e8fbff', speed: 0.0, scale: 0.8, glow: 0.0 },
  };
  const liquidVert = `
    attribute vec4 aEdge; varying vec2 vUv; varying vec4 vEdge; varying vec2 vWorld;
    void main() { vUv = uv; vEdge = aEdge; vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0); vWorld = wp.xz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
  const liquidFrag = `
    uniform float time, speed, scale, glow; uniform vec3 base, deep, line, rim;
    varying vec2 vUv; varying vec4 vEdge; varying vec2 vWorld;
    vec2 hash2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
    float hash1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
    float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash1(i), hash1(i + vec2(1, 0)), f.x), mix(hash1(i + vec2(0, 1)), hash1(i + vec2(1, 1)), f.x), f.y); }
    void main() {
      vec2 p = vWorld * scale; vec2 ip = floor(p), fp = fract(p);
      float f1 = 8.0, f2 = 8.0;
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j)); vec2 o = hash2(ip + g);
        o = 0.5 + 0.5 * sin(time * speed + 6.2831 * o);
        float d = length(g + o - fp);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
      }
      float cell = smoothstep(0.0, 0.11, f2 - f1);                 // 0 on the cracks, 1 inside a cell
      vec3 col = mix(line, mix(deep, base, 0.55 + 0.45 * vnoise(p * 1.7 + time * speed * 0.4)), cell);
      // shoreline: distance to the nearest side that has no neighbouring liquid cell, wobbled by noise
      vec2 uv = vUv;
      float d = 1.0;
      d = min(d, mix(uv.x, 1.0, vEdge.x));
      d = min(d, mix(1.0 - uv.x, 1.0, vEdge.y));
      d = min(d, mix(uv.y, 1.0, vEdge.z));
      d = min(d, mix(1.0 - uv.y, 1.0, vEdge.w));
      d += (vnoise(vWorld * 3.1) - 0.5) * 0.16;
      float inside = smoothstep(0.0, 0.05, d);
      float rimBand = 1.0 - smoothstep(0.05, 0.2, d);
      col = mix(col, rim, rimBand * 0.85);
      col += glow * pow(cell, 2.0) * 0.25;
      if (inside < 0.02) discard;
      gl_FragColor = vec4(col, 1.0);
    }`;
  const liquidMats = [];
  const addPools = (cells, kind) => {
    if (!cells.length) return;
    const cfg = LIQUID[kind];
    const has = new Set(cells.map((c) => `${c[0]},${c[1]}`));
    const N = (x, z) => (has.has(`${x},${z}`) ? 1 : 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: liquidVert, fragmentShader: liquidFrag, transparent: false, side: THREE.DoubleSide,
      uniforms: { time: { value: 0 }, speed: { value: cfg.speed }, scale: { value: cfg.scale }, glow: { value: cfg.glow }, base: { value: new THREE.Color(cfg.base) }, deep: { value: new THREE.Color(cfg.deep) }, line: { value: new THREE.Color(cfg.line) }, rim: { value: new THREE.Color(cfg.rim) } },
    });
    const geo = new THREE.PlaneGeometry(1.0, 1.0);
    const edge = new Float32Array(cells.length * 4);
    cells.forEach((c, i) => { edge.set([N(c[0] - 1, c[1]), N(c[0] + 1, c[1]), N(c[0], c[1] - 1), N(c[0], c[1] + 1)], i * 4); });
    geo.setAttribute('aEdge', new THREE.InstancedBufferAttribute(edge, 4));
    const mesh = new THREE.InstancedMesh(geo, mat, cells.length);
    const d = new THREE.Object3D();
    cells.forEach((c, i) => { const { x, z } = gridToWorld(c[0], c[1]); d.position.set(x, kind === 'ice' ? 0.012 : 0.008, z); d.rotation.set(-Math.PI / 2, 0, 0); d.scale.set(1.002, 1.002, 1); d.updateMatrix(); mesh.setMatrixAt(i, d.matrix); });
    mesh.frustumCulled = false; mesh.renderOrder = 2; boardGroup.add(mesh);
    updaters.push((t) => { mat.uniforms.time.value = t; });
    if (kind !== 'ice') {
      const bubbles = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: kind === 'acid' ? '#e9ffb0' : '#ffffff', size: kind === 'acid' ? 0.09 : 0.06, transparent: true, opacity: 0.8, depthWrite: false }));
      const pts = new Float32Array(cells.length * 3 * 3);
      cells.forEach((c, i) => { const { x, z } = gridToWorld(c[0], c[1]); for (let k = 0; k < 3; k++) { pts[(i * 3 + k) * 3] = x + (Math.random() - 0.5) * 0.8; pts[(i * 3 + k) * 3 + 1] = 0.05; pts[(i * 3 + k) * 3 + 2] = z + (Math.random() - 0.5) * 0.8; } });
      bubbles.geometry.setAttribute('position', new THREE.BufferAttribute(pts, 3)); bubbles.frustumCulled = false; boardGroup.add(bubbles);
      updaters.push((t) => { bubbles.material.opacity = 0.3 + Math.abs(Math.sin(t * 2.1)) * 0.6; });
    }
  };
  addPools(world.hazards || [], 'acid');
  addPools(world.water || [], 'water');
  addPools(world.ice || [], 'ice');

  // ── Walls: merged runs ──
  const walls = world.walls.filter((c) => !isBorder(c) && !isDoorCell(c));
  for (const r of mergeCells(walls, (c) => { const p = getObjectProperties(world, 'wall', c); return `${p.height}|${p.color}`; })) {
    const props = getObjectProperties(world, 'wall', r.cell);
    const w = r.x1 - r.x0 + 1, d = r.z1 - r.z0 + 1, h = props.height;
    const cx = (r.x0 + r.x1) / 2 - HALF_GRID, cz = (r.z0 + r.z1) / 2 - HALF_GRID;
    const body = new THREE.Mesh(scaleBoxUV(new THREE.BoxGeometry(w, h, d), w, h, d), new THREE.MeshStandardMaterial({ map: T.panel, color: props.color, roughness: 0.6, metalness: 0.3 }));
    body.position.set(cx, h / 2, cz); body.castShadow = body.receiveShadow = true; body.userData = { kind: 'wall', cell: r.cell };
    objectsGroup.add(body); out.occluders.push(body); out.floorTargets.push(body);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.06, WALL_TOP_PAD, d + 0.06), new THREE.MeshStandardMaterial({ color: '#dfe8ea', roughness: 0.5, metalness: 0.4 }));
    cap.position.set(cx, h + WALL_TOP_PAD / 2, cz); cap.castShadow = true; objectsGroup.add(cap);
  }

  // ── Platforms / ledges ──
  for (const r of mergeCells(world.platforms || [], (c) => { const p = getObjectProperties(world, 'platform', c); return `${p.height}|${p.color}`; })) {
    const props = getObjectProperties(world, 'platform', r.cell);
    const w = r.x1 - r.x0 + 1, d = r.z1 - r.z0 + 1, h = props.height;
    const cx = (r.x0 + r.x1) / 2 - HALF_GRID, cz = (r.z0 + r.z1) / 2 - HALF_GRID;
    const body = new THREE.Mesh(scaleBoxUV(new THREE.BoxGeometry(w, h, d), w, h, d), new THREE.MeshStandardMaterial({ map: T.panel, color: '#a9b8c0', roughness: 0.6, metalness: 0.3 }));
    body.position.set(cx, h / 2, cz); body.castShadow = body.receiveShadow = true; body.userData = { kind: 'platform', cell: r.cell };
    objectsGroup.add(body); out.occluders.push(body); out.floorTargets.push(body);
    const top = new THREE.Mesh(scaleBoxUV(new THREE.BoxGeometry(w + 0.08, PLATFORM_TOP_PAD, d + 0.08), w * 1.2, PLATFORM_TOP_PAD, d * 1.2), new THREE.MeshStandardMaterial({ map: T.grate, color: props.color, roughness: 0.55, metalness: 0.45 }));
    top.position.set(cx, h + PLATFORM_TOP_PAD / 2, cz); top.castShadow = top.receiveShadow = true; top.userData = { kind: 'platform', cell: r.cell };
    objectsGroup.add(top); out.floorTargets.push(top);
  }
  for (const cell of world.stairs || []) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    for (let step = 0; step < 4; step++) { const h = 0.23 * (step + 1); addBox(objectsGroup, [0.24, h, 0.82], [x - 0.36 + step * 0.24, h / 2, z], step % 2 ? '#8fa6b3' : '#a8bfc0'); }
  }

  // ── Pushable crates ──
  for (const cell of world.blocks || []) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const props = getObjectProperties(world, 'block', cell);
    const g = new THREE.Group();
    const m = new THREE.Mesh(new RoundedBoxGeometry(props.size, props.height, props.size, 3, 0.05), new THREE.MeshStandardMaterial({ map: T.crate, color: props.color === '#b77148' ? '#ffffff' : props.color, roughness: 0.75 }));
    m.castShadow = m.receiveShadow = true; g.add(m);
    g.position.set(x, surfaceHeightAt(world, cell[0], cell[1]) + props.height / 2 + 0.02, z); g.userData = { kind: 'block', cell };
    objectsGroup.add(g); out.physicsVisuals.push({ kind: 'block', cell, mesh: g });
  }

  // ── Lasers: scanning beams that sweep along any axis (x / y / z) and extend along any other ──
  (world.lasers || []).forEach((entry, i) => {
    const spec = laserSpec(entry);
    const len = spec.beam === 'y' ? spec.half * 2 : spec.half * 2 + 1;
    const holder = new THREE.Group();
    const pivot = new THREE.Group(); holder.add(pivot);
    if (spec.beam === 'x') pivot.rotation.z = Math.PI / 2; else if (spec.beam === 'z') pivot.rotation.x = Math.PI / 2;
    const beamMat = new THREE.MeshBasicMaterial({ color: '#ff3b6b', transparent: true, opacity: 0.95, toneMapped: false });
    pivot.add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, len, 8), beamMat));
    const haloMat = new THREE.MeshBasicMaterial({ color: '#ff3b6b', transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    pivot.add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, len, 8), haloMat));
    const housing = createMaterial('#27323f', 0.35, 0.6);
    for (const sgn of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 0.3, 14), housing); cap.position.y = sgn * (len / 2 + 0.1); cap.castShadow = true; pivot.add(cap);
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), new THREE.MeshBasicMaterial({ color: '#ff8aa6' })); lens.position.y = sgn * (len / 2 - 0.02); pivot.add(lens);
    }
    objectsGroup.add(holder);
    // tracks showing the sweep range
    const railMat = new THREE.MeshBasicMaterial({ color: '#ff9db5', transparent: true, opacity: 0.4 });
    const gx = spec.cx - HALF_GRID, gz = spec.cz - HALF_GRID;
    const ends = spec.beam === 'y' ? [0] : [-len / 2, len / 2];
    for (const e of ends) {
      const ox = spec.beam === 'x' ? e : 0, oz = spec.beam === 'z' ? e : 0;
      if (spec.sweep === 'y') {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.04, spec.range * 2 + 0.1, 0.04), railMat); rail.position.set(gx + ox, spec.y, gz + oz); objectsGroup.add(rail);
      } else {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(spec.sweep === 'x' ? spec.range * 2 + 0.1 : 0.05, 0.02, spec.sweep === 'z' ? spec.range * 2 + 0.1 : 0.05), railMat);
        rail.position.set(gx + ox, 0.012, gz + oz); objectsGroup.add(rail);
      }
    }
    const item = { index: i, entry, spec, holder, beamMat, frozen: false, setFrozen(f) { this.frozen = f; } };
    out.movingLaserMeshes.push(item);
    updaters.push((t, ctx) => {
      const c = laserCenter(entry, i, ctx.sim);
      holder.visible = !ctx.channelOff?.('laser', entry);
      holder.position.set(c.px - HALF_GRID, c.beam === 'y' ? c.y + c.half : c.by, c.pz - HALF_GRID);
      beamMat.opacity = item.frozen ? 0.3 : 0.82 + Math.sin(t * 18 + i) * 0.1; beamMat.color.set(item.frozen ? '#9fe8ff' : '#ff3b6b');
      haloMat.opacity = item.frozen ? 0.05 : 0.18 + Math.sin(t * 9) * 0.05;
    });
  });

  // ── Electric shocks: big ceiling emitters that charge, then drop a branching lime bolt onto a floor pad ──
  const DIRS = { down: [0, -1, 0], up: [0, 1, 0], xp: [1, 0, 0], xn: [-1, 0, 0], zp: [0, 0, 1], zn: [0, 0, -1] };
  const SHOCK_LIME = new THREE.Color('#b6ff5a'), SHOCK_CORE = new THREE.Color('#f6ffe0'), SHOCK_WARN = new THREE.Color('#ffd23a');
  (world.shocks || []).forEach((entry, i) => {
    const s = shockSpec(entry);
    const wx = s.x - HALF_GRID, wz = s.z - HALF_GRID;
    const dv = new THREE.Vector3(...DIRS[s.dir]);
    const root = new THREE.Group(); root.position.set(wx, s.y, wz); objectsGroup.add(root);
    const aim = new THREE.Group(); aim.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dv); root.add(aim);
    // emitter: dark flared housing with two glowing lime crystals, like the lab's ceiling "tesla" heads
    const dark = createMaterial('#3a3436', 0.45, 0.55);
    const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.55, 0.42, 20), dark); hood.position.y = -0.05; hood.castShadow = true; aim.add(hood);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.08, 20), createMaterial('#7a7172', 0.4, 0.6)); collar.position.y = -0.27; aim.add(collar);
    const crystalMat = new THREE.MeshBasicMaterial({ color: '#7dff6a', toneMapped: false });
    for (const sx of [-0.22, 0.22]) { const cr = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.2), crystalMat); cr.position.set(sx, 0.27, 0); cr.rotation.set(0.4, 0.5, 0.2); aim.add(cr); }
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), new THREE.MeshBasicMaterial({ color: '#eaffc8', toneMapped: false })); tip.position.y = 0.22; aim.add(tip);
    if (s.dir === 'down') { const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, ROOM_H - s.y, 10), createMaterial('#4d4749', 0.5, 0.5)); stem.position.set(wx, s.y + (ROOM_H - s.y) / 2, wz); objectsGroup.add(stem); }
    const L = (s.dir === 'down' || s.dir === 'up') ? s.length : Math.round(s.length) + 0.5;
    // target pad where the bolt lands (dark when idle, glowing green when live)
    const pad = new THREE.Group();
    const padDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.5, 0.06, 28), createMaterial('#1b1a1c', 0.5, 0.4)); pad.add(padDisc);
    const padRingMat = new THREE.MeshBasicMaterial({ color: '#2c3a2a', toneMapped: false });
    const padRing = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.045, 8, 32), padRingMat); padRing.rotation.x = Math.PI / 2; padRing.position.y = 0.035; pad.add(padRing);
    const padGlowMat = new THREE.MeshBasicMaterial({ color: '#8dff5a', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const padGlow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 28), padGlowMat); padGlow.rotation.x = -Math.PI / 2; padGlow.position.y = 0.045; pad.add(padGlow);
    const endPos = new THREE.Vector3(wx, s.y, wz).addScaledVector(dv, L + (s.dir === 'down' || s.dir === 'up' ? 0 : 0.3));
    pad.position.set(endPos.x, s.dir === 'down' ? Math.max(0.03, endPos.y) : s.dir === 'up' ? endPos.y : 0.03, endPos.z);
    if (s.dir === 'up') pad.rotation.x = Math.PI;
    if (s.dir !== 'down' && s.dir !== 'up') pad.position.y = 0.03;
    objectsGroup.add(pad);
    // the bolt itself: three jittering polylines (core + two thick halos) plus short side arcs
    const N = 16;
    const mkLine = (color, opacity) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3)); const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, toneMapped: false, depthWrite: false })); l.frustumCulled = false; aim.add(l); return l; };
    const bolts = [mkLine('#f6ffe0', 0), mkLine('#b6ff5a', 0), mkLine('#b6ff5a', 0)];
    const arcs = Array.from({ length: 7 }, () => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3)); const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: '#d9ff9a', transparent: true, opacity: 0, toneMapped: false, depthWrite: false })); l.frustumCulled = false; aim.add(l); return l; });
    const colMat = new THREE.MeshBasicMaterial({ color: '#9dff5a', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, L, 10, 1, true), colMat); column.position.y = 0.3 + L / 2; aim.add(column);
    const item = { index: i, entry, pos: { x: wx, z: wz }, striking: false, charging: false };
    out.shockMeshes.push(item);
    const jag = (line, spread) => {
      const a = line.geometry.attributes.position;
      for (let k = 0; k < N; k++) { const f = k / (N - 1), mid = k && k < N - 1; a.setXYZ(k, mid ? (Math.random() - 0.5) * spread : 0, 0.3 + f * L, mid ? (Math.random() - 0.5) * spread : 0); }
      a.needsUpdate = true;
    };
    const arc = (line) => {
      const a = line.geometry.attributes.position, y0 = 0.3 + Math.random() * L, ang = Math.random() * 6.283, len = 0.5 + Math.random() * 1.0;
      let x = 0, z = 0, y = y0;
      for (let k = 0; k < 4; k++) { a.setXYZ(k, x, y, z); x += Math.cos(ang) * len / 3 + (Math.random() - 0.5) * 0.25; z += Math.sin(ang) * len / 3 + (Math.random() - 0.5) * 0.25; y += (Math.random() - 0.5) * 0.3; }
      a.needsUpdate = true;
    };
    updaters.push((t, ctx) => {
      const off = ctx.frozen || ctx.channelOff?.('shock', entry);
      const ph = off ? 0 : shockPhase(entry, i, ctx.sim);
      item.striking = ph >= SHOCK_STRIKE_AT; item.charging = !item.striking && ph >= SHOCK_CHARGE_AT;
      crystalMat.color.set(off ? '#4a5a48' : item.striking ? '#eaffc8' : item.charging ? '#ffd23a' : '#7dff6a');
      colMat.opacity = item.striking ? 0.4 : item.charging ? 0.05 + Math.abs(Math.sin(t * 22)) * 0.07 : 0;
      colMat.color.copy(item.charging ? SHOCK_WARN : SHOCK_LIME);
      bolts[0].material.opacity = item.striking ? 1 : 0; bolts[1].material.opacity = item.striking ? 0.7 : 0; bolts[2].material.opacity = item.striking ? 0.5 : 0;
      if (item.striking) { jag(bolts[0], 0.22); jag(bolts[1], 0.5); jag(bolts[2], 0.5); arcs.forEach((l, k) => { l.material.opacity = Math.random() > 0.35 ? 0.8 : 0; arc(l); }); } else arcs.forEach((l) => { l.material.opacity = 0; });
      padGlowMat.opacity = item.striking ? 0.95 : item.charging ? 0.2 + Math.abs(Math.sin(t * 16)) * 0.5 : 0;
      padRingMat.color.set(item.striking ? '#d6ff9a' : item.charging ? '#ffd23a' : off ? '#26332a' : '#3f6a38');
      tip.scale.setScalar(item.striking ? 1.9 : item.charging ? 1.1 + Math.sin(t * 40) * 0.3 : 0.8);
    });
  });

  // ── Cutters: spinning saw blades riding a floor groove ──
  (world.cutters || []).forEach((entry, i) => {
    const c = cutterSpec(entry);
    const holder = new THREE.Group(); holder.position.y = c.radius; objectsGroup.add(holder);
    const face = new THREE.Group(); holder.add(face);
    if (c.axis === 'x') face.rotation.x = Math.PI / 2; else face.rotation.z = Math.PI / 2;
    const spin = new THREE.Group(); face.add(spin);
    const steel = createMaterial('#b9c6cc', 0.25, 0.85);
    spin.add(new THREE.Mesh(new THREE.CylinderGeometry(c.radius, c.radius, 0.05, 28), steel));
    const toothMat = createMaterial('#e7eef0', 0.2, 0.9);
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.16, 3), toothMat);
      tooth.position.set(Math.cos(a) * (c.radius + 0.03), 0, Math.sin(a) * (c.radius + 0.03)); tooth.rotation.z = -Math.PI / 2 + 0; tooth.rotation.y = -a; spin.add(tooth);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.1, 14), createMaterial('#d4552e', 0.35, 0.5)); spin.add(hub);
    holder.traverse((n) => { if (n.isMesh) n.castShadow = true; });
    const gx = c.x - HALF_GRID, gz = c.z - HALF_GRID, len = c.range * 2 + 0.5;
    const groove = new THREE.Mesh(scaleBoxUV(new THREE.BoxGeometry(c.axis === 'x' ? len : 0.22, 0.02, c.axis === 'z' ? len : 0.22), len * 1.5, 0.02, 0.5), stripeMat);
    groove.position.set(gx, 0.012, gz); objectsGroup.add(groove);
    const item = { index: i, holder, spin, spec: c };
    out.cutterMeshes.push(item);
    updaters.push((t, ctx) => {
      const p = cutterPosition(entry, i, ctx.sim);
      holder.visible = !ctx.channelOff?.('cutter', entry);
      holder.position.set(p.px - HALF_GRID, c.radius, p.pz - HALF_GRID);
      spin.rotation.y = ctx.frozen ? spin.rotation.y : t * 14 * (i % 2 ? -1 : 1);
    });
  });

  // ── Spikes: a floor plate whose spikes pop out on a timer ──
  (world.spikes || []).forEach((entry, i) => {
    const { x, z } = gridToWorld(entry[0], entry[1]);
    const surf = surfaceHeightAt(world, entry[0], entry[1]);
    const g = new THREE.Group(); g.position.set(x, surf, z); objectsGroup.add(g);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.05, 0.92), createMaterial('#2a343b', 0.5, 0.6)); plate.position.y = 0.025; plate.receiveShadow = true; g.add(plate);
    const spikes = new THREE.Group(); g.add(spikes);
    const spikeMat = createMaterial('#cfd8dc', 0.25, 0.85);
    for (const [ox, oz] of [[0, 0], [-0.27, -0.27], [0.27, -0.27], [-0.27, 0.27], [0.27, 0.27]]) {
      const sp = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.55, 8), spikeMat); sp.position.set(ox, 0.28, oz); sp.castShadow = true; spikes.add(sp);
    }
    const warn = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: '#ff5a3a', transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    warn.rotation.x = -Math.PI / 2; warn.position.y = 0.06; g.add(warn);
    let cur = entry[2] > 0 ? 0 : 1; const item = { index: i, entry, group: g };
    out.spikeMeshes.push(item);
    updaters.push((t, ctx) => {
      const target = !ctx.frozen && !ctx.channelOff?.('spikes', entry) && spikeUp(entry, i, ctx.sim) ? 1 : 0;
      cur += (target - cur) * 0.35; spikes.scale.y = Math.max(0.02, cur); spikes.visible = cur > 0.03;
      // blink a warning just before the spikes come out
      const soon = entry[2] > 0 && !target && spikeUp(entry, i, ctx.sim + 0.45);
      warn.material.opacity = soon ? 0.25 + Math.abs(Math.sin(t * 20)) * 0.3 : 0;
    });
  });

  // ── Power-ups ──
  const puColors = { speed: '#ffb85c', jump: '#b88cff', freeze: '#65dfff', shield: '#6ff0c3' };
  (world.powerups || []).forEach((entry, i) => {
    const [gx, gz, type = 'speed'] = entry;
    const { x, z } = gridToWorld(gx, gz);
    const surf = surfaceHeightAt(world, gx, gz);
    const color = puColors[type] || puColors.speed;
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.035, 8, 28), new THREE.MeshBasicMaterial({ color, toneMapped: false })); ring.rotation.x = Math.PI / 2; ring.position.y = 0.2; g.add(ring);
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.2, 1), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2, roughness: 0.2 })); core.position.y = 0.6; core.castShadow = true; g.add(core);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.MeshBasicMaterial({ map: T.soft, color, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending })); glow.rotation.x = -Math.PI / 2; glow.position.y = 0.02; g.add(glow);
    g.position.set(x, surf, z); g.userData = { powerupIndex: i, type }; g.visible = !powerupsCollected.has(i);
    objectsGroup.add(g); out.powerupMeshes.push(g);
    updaters.push((t) => { core.rotation.y = t * 1.4 + i; core.position.y = 0.6 + Math.sin(t * 2.2 + i) * 0.08; ring.scale.setScalar(1 + Math.sin(t * 3 + i) * 0.06); });
  });

  // ── Levers ──
  for (const cell of world.levers || []) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const surf = surfaceHeightAt(world, cell[0], cell[1]);
    const lever = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.32, 0.18, 24), createMaterial('#2d4458', 0.4, 0.5)); base.position.y = 0.09; base.castShadow = true; lever.add(base);
    const pivot = new THREE.Group(); pivot.position.y = 0.18; lever.add(pivot);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.055, 0.5, 12), createMaterial('#dfeceb', 0.25, 0.6)); arm.position.y = 0.25; pivot.add(arm);
    const lch = channelOf(world, 'lever', cell), lcol = channelColor(lch);
    const grip = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 12), new THREE.MeshStandardMaterial({ color: lcol, emissive: lcol, emissiveIntensity: 0.7, roughness: 0.3 })); grip.position.y = 0.51; pivot.add(grip);
    base.material.color.set(lcol).multiplyScalar(0.45);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshBasicMaterial({ map: T.soft, color: lcol, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending })); halo.rotation.x = -Math.PI / 2; halo.position.y = 0.02; lever.add(halo);
    lever.position.set(x, surf, z); lever.userData = { pivot, cell, activated: false, halo, channel: lch, color: lcol };
    pivot.rotation.z = 0.78;
    objectsGroup.add(lever); out.leverMeshes.push(lever);
    updaters.push((t) => { halo.material.opacity = 0.25 + Math.sin(t * 3) * 0.12; });
  }

  // ── Lifts ──
  (world.lifts || []).forEach((entry, i) => {
    const [gx, gz, high = LIFT_DEFAULT_HEIGHT] = entry;
    const { x, z } = gridToWorld(gx, gz);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.04, 1.08), createMaterial('#17222c', 0.5, 0.4)); frame.position.set(x, 0.02, z); boardGroup.add(frame);
    const g = new THREE.Group();
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.8, 0.92), createMaterial('#4a5c6b', 0.55, 0.45)); pillar.position.y = -0.9; pillar.castShadow = true; g.add(pillar);
    const topMat = new THREE.MeshStandardMaterial({ map: T.arrow, color: '#ffffff', roughness: 0.4, emissive: '#2fbf90', emissiveIntensity: 0.0 });
    const pad = new THREE.Mesh(new RoundedBoxGeometry(0.98, 0.1, 0.98, 2, 0.03), [createMaterial('#7ba8ad', 0.3, 0.5), createMaterial('#7ba8ad', 0.3, 0.5), topMat, createMaterial('#7ba8ad', 0.3, 0.5), createMaterial('#7ba8ad', 0.3, 0.5), createMaterial('#7ba8ad', 0.3, 0.5)]);
    pad.position.y = -0.05; pad.castShadow = pad.receiveShadow = true; g.add(pad);
    g.position.set(x, 0.04, z); g.userData = { index: i, high, top: 0.04 };
    objectsGroup.add(g);
    out.liftMeshes.push({ mesh: g, cell: [gx, gz], index: i, high, topMat });
    const lich = channelOf(world, 'lift', entry), licol = channelColor(lich);
    topMat.emissive.set(licol);
    const band = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 1.1), new THREE.MeshBasicMaterial({ color: licol, toneMapped: false })); band.position.set(x, 0.045, z); boardGroup.add(band);
    updaters.push((t, ctx) => { const on = lich ? ctx.channelsOn?.has(lich) : ctx.powered; topMat.emissiveIntensity = on ? 0.6 + Math.sin(t * 4) * 0.2 : 0.08; });
  });

  // ── Switch crystals (legacy) ──
  for (const cell of world.switches || []) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const surf = surfaceHeightAt(world, cell[0], cell[1]);
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.35, 8), createMaterial('#3e5366', 0.48, 0.36)); ped.position.set(x, surf + 0.17, z); ped.castShadow = true; objectsGroup.add(ped);
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 0), createMaterial(switchActivated ? '#75f0ce' : '#8b91ff', 0.2, 0.16, { emissive: switchActivated ? '#39dba6' : '#4b43c7', emissiveIntensity: switchActivated ? 1.5 : 0.9 }));
    crystal.position.set(x, surf + 0.65, z); crystal.userData.cell = cell; objectsGroup.add(crystal);
    out.switchMeshes.push(crystal); out.switchCrystalMeshes.push(crystal);
    updaters.push((t) => { crystal.rotation.y = t * 0.65; crystal.position.y = surf + 0.65 + Math.sin(t * 1.8) * 0.045; });
  }

  // ── Coins ──
  (world.coins || []).forEach((cell, i) => {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const surf = surfaceHeightAt(world, cell[0], cell[1]);
    const g = new THREE.Group();
    const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.07, 32), new THREE.MeshStandardMaterial({ color: '#ffc44c', roughness: 0.22, metalness: 0.75, emissive: '#b8701a', emissiveIntensity: 0.55 }));
    coin.rotation.x = Math.PI / 2; coin.castShadow = true; g.add(coin);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.025, 8, 28), createMaterial('#ffe49b', 0.25, 0.6)); g.add(rim);
    const star = new THREE.Mesh(new THREE.CircleGeometry(0.11, 5), new THREE.MeshBasicMaterial({ color: '#fff3c4' })); star.position.z = 0.04; g.add(star);
    const star2 = star.clone(); star2.position.z = -0.04; star2.rotation.y = Math.PI; g.add(star2);
    g.position.set(x, surf + 0.6, z); g.userData = { coinIndex: i, baseY: surf + 0.6 }; g.visible = !collected.has(i);
    coinsGroup.add(g); out.coinMeshes.push(g);
    updaters.push((t) => { g.rotation.y = t * 2.1 + i; g.position.y = g.userData.baseY + Math.sin(t * 2.4 + i * 1.8) * 0.08; });
  });

  // ── Springs / portals / checkpoints / movers (legacy editor pieces) ──
  for (const cell of world.springs || []) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const spring = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.3, 12), createMaterial('#79d9d3', 0.3, 0.4, { emissive: '#147d7c', emissiveIntensity: 0.6 }));
    spring.position.set(x, 0.15, z); objectsGroup.add(spring);
  }
  for (const cell of world.portals || []) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.075, 10, 28), new THREE.MeshBasicMaterial({ color: '#74d6ff' })); ring.position.set(x, 0.55, z); objectsGroup.add(ring); out.switchMeshes.push(ring);
  }
  for (const cell of world.checkpoints || []) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.24, 0), createMaterial('#7cf2c4', 0.24, 0.16, { emissive: '#25b97d', emissiveIntensity: 1.2 })); marker.position.set(x, 0.52, z); objectsGroup.add(marker); out.switchMeshes.push(marker);
  }
  (world.movers || []).forEach((cell, i) => {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.18, 0.7), createMaterial('#d48b52', 0.4, 0.28, { emissive: '#773514', emissiveIntensity: 0.25 })));
    g.position.set(x, 0.35, z); g.userData = { x, z, index: i }; objectsGroup.add(g); out.movingMeshes.push(g);
  });

  // ── Pressure plates: translucent glass pads with a light column ──
  for (const cell of world.plates || []) {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const surf = surfaceHeightAt(world, cell[0], cell[1]);
    const hold = hasCell(world.continuousPlates || [], cell[0], cell[1]);
    const g = new THREE.Group(); g.position.set(x, surf, z);
    const baseRing = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.5, 0.07, 36), createMaterial('#2c4153', 0.35, 0.5)); baseRing.position.y = 0.035; g.add(baseRing);
    const pch = channelColor(channelOf(world, 'plate', cell));
    const topMat = new THREE.MeshPhysicalMaterial({ color: '#ffb25a', emissive: '#ff8a1f', emissiveIntensity: 0.9, transparent: true, opacity: 0.62, roughness: 0.08, metalness: 0, clearcoat: 1 });
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.39, 0.1, 36), topMat); top.position.y = 0.11; g.add(top);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.018, 8, 40), new THREE.MeshBasicMaterial({ color: hold ? '#9fd8ff' : '#ffe0a8', toneMapped: false })); ring.rotation.x = Math.PI / 2; ring.position.y = 0.16; g.add(ring);
    const beamMat = new THREE.MeshBasicMaterial({ map: T.curtain, color: '#ffb25a', transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 1.4, 24, 1, true), beamMat); column.position.y = 0.8; g.add(column);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({ map: T.soft, color: '#ffb25a', transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending })); glow.rotation.x = -Math.PI / 2; glow.position.y = 0.01; g.add(glow);
    objectsGroup.add(g);
    const plate = {
      cell, surface: surf, group: g, top: g, active: false,
      setActive(active) {
        this.active = active;
        const c = pch;
        topMat.color.set(c); topMat.emissive.set(c); topMat.emissiveIntensity = active ? 1.6 : 0.6; beamMat.color.set(c); glow.material.color.set(c);
        ring.material.color.set(active ? '#ffffff' : c);
        top.position.y = active ? 0.07 : 0.11;
      },
    };
    plate.setActive(activatedPlates.has(`${cell[0]},${cell[1]}`));
    out.plateMeshes.push(plate);
    updaters.push((t) => { ring.scale.setScalar(1 + Math.sin(t * 3 + cell[0]) * 0.03); beamMat.opacity = (plate.active ? 0.12 : 0.3) + Math.sin(t * 2.4 + cell[1]) * 0.07; glow.material.opacity = 0.25 + Math.sin(t * 2.4) * 0.1; });
  }

  // ── Rotators ──
  (world.rotators || []).forEach((cell, i) => {
    const { x, z } = gridToWorld(cell[0], cell[1]);
    const g = new THREE.Group();
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.5, 14), createMaterial('#7f8e95', 0.4, 0.5)); hub.position.y = 0.25; hub.castShadow = true; g.add(hub);
    const beam = new THREE.Mesh(new RoundedBoxGeometry(2.05, 0.2, 0.26, 3, 0.09), new THREE.MeshStandardMaterial({ color: '#f07855', emissive: '#cf3b27', emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.3 })); beam.position.y = 0.55; beam.castShadow = true; g.add(beam);
    for (const s of [-1, 1]) { const cap = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), createMaterial('#ffe0a0', 0.3, 0.2)); cap.position.set(s * 1.0, 0.55, 0); g.add(cap); }
    const warn = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8), new THREE.MeshBasicMaterial({ map: T.soft, color: '#ff7a55', transparent: true, opacity: 0.16, depthWrite: false })); warn.rotation.x = -Math.PI / 2; warn.position.set(x, 0.012, z); objectsGroup.add(warn);
    g.position.set(x, 0, z); g.userData = { index: i }; objectsGroup.add(g); out.rotatorMeshes.push(g);
    updaters.push((t) => { beam.material.emissiveIntensity = 0.4 + (Math.sin(t * 3.1 + i) + 1) * 0.2; });
  });

  // ── Exit gate ──
  if (door) {
    const { x, z } = gridToWorld(door[0], door[1]);
    const grp = new THREE.Group(); grp.position.set(x, 0, z);
    if (door[0] === 0 || door[0] === edge) grp.rotation.y = Math.PI / 2;
    const stone = createMaterial('#b8c0cc', 0.8, 0.1);
    const half = EXIT_OPENING_WIDTH / 2;
    for (const s of [-1, 1]) { const pillar = new THREE.Mesh(new RoundedBoxGeometry(0.38, 3.2, 0.5, 3, 0.06), stone); pillar.position.set(s * (half + 0.12), 1.6, 0); pillar.castShadow = true; grp.add(pillar); }
    const lintel = new THREE.Mesh(new RoundedBoxGeometry(EXIT_OPENING_WIDTH + 1.0, 0.4, 0.5, 3, 0.06), stone); lintel.position.set(0, 3.3, 0); lintel.castShadow = true; grp.add(lintel);
    const sign = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.04, 8, 24), new THREE.MeshBasicMaterial({ color: '#7fffd0', toneMapped: false })); sign.position.set(0, 3.3, 0.27); grp.add(sign);
    const panelMat = new THREE.MeshStandardMaterial({ color: doorsOpen ? '#77bd91' : '#56636a', roughness: 0.3, metalness: 0.2, transparent: true, opacity: 0.86, emissive: '#27d6a8', emissiveIntensity: 0.15 });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(EXIT_OPENING_WIDTH * 0.8, 2.6, 0.16), panelMat); panel.position.set(0, 1.3, 0); panel.castShadow = true; grp.add(panel);
    const exitGlow = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 4.5), new THREE.MeshBasicMaterial({ map: T.soft, color: '#7fffd0', transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending })); exitGlow.rotation.x = -Math.PI / 2; exitGlow.position.set(0, 0.02, 0.8); grp.add(exitGlow);
    objectsGroup.add(grp);
    out.exitDoorMesh = panel; out.exitDoorGroup = grp; panel.userData.kind = 'exitDoor';
    updaters.push((t, ctx) => { panelMat.emissiveIntensity = ctx.doorsOpen ? 0.6 + Math.sin(t * 3) * 0.2 : 0.1; exitGlow.material.opacity = ctx.doorsOpen ? 0.35 + Math.sin(t * 3) * 0.1 : 0.12; sign.scale.setScalar(1 + Math.sin(t * 3) * 0.1); });
  }

  // ── Lab props: a few consoles and canisters standing against the walls, kept clear of play cells ──
  const rng = mulberry(hashString(world.name || 'level'));
  const propMat = createMaterial('#3b4a53', 0.5, 0.5), tankGlass = new THREE.MeshPhysicalMaterial({ color: '#7cf0d8', transparent: true, opacity: 0.35, roughness: 0.1, metalness: 0, clearcoat: 1 });
  const tankLiquid = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.55, toneMapped: false }); tankLiquid.color = ACCENT;
  for (const [px, pz] of [[-(HALF_GRID - 0.9), -(HALF_GRID - 0.9)], [HALF_GRID - 0.9, -(HALF_GRID - 0.9)], [-(HALF_GRID - 0.9), HALF_GRID - 0.9]]) {
    if (door && Math.hypot(px - gridToWorld(door[0], door[1]).x, pz - gridToWorld(door[0], door[1]).z) < 2.6) continue;
    const tank = new THREE.Group(); tank.position.set(px, 0, pz);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.16, 16), propMat); base.position.y = 0.08; tank.add(base);
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 1.2, 16, 1, true), tankGlass); glass.position.y = 0.76; tank.add(glass);
    const liquid = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.9, 16), tankLiquid); liquid.position.y = 0.62; tank.add(liquid);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.1, 16), propMat); lid.position.y = 1.4; tank.add(lid);
    tank.rotation.y = rng() * 6; decorationGroup.add(tank);
  }

  // ── Colour-coded wiring: beacons on controlled pieces + glowing cables from each plate / lever to its targets ──
  {
    const TARGETS = [['lasers', 'laser'], ['shocks', 'shock'], ['cutters', 'cutter'], ['spikes', 'spikes'], ['lifts', 'lift']];
    const SOURCES = [['plates', 'plate'], ['levers', 'lever']];
    const cableMats = new Map();
    for (let ch = 1; ch < CHANNELS.length; ch++) {
      const targets = [], sources = [];
      for (const [list, kind] of TARGETS) for (const e of world[list] || []) if (channelOf(world, kind, e) === ch) targets.push({ kind, e });
      for (const [list, kind] of SOURCES) for (const e of world[list] || []) if (channelOf(world, kind, e) === ch) sources.push({ kind, e });
      if (!targets.length) continue;
      const col = channelColor(ch);
      const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
      cableMats.set(ch, mat);
      for (const { e } of targets) {
        const { x, z } = gridToWorld(e[0], e[1]);
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 24), new THREE.MeshBasicMaterial({ color: col, toneMapped: false }));
        disc.position.set(x + 0.36, 0.04, z + 0.36); objectsGroup.add(disc);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.025, 8, 28), new THREE.MeshBasicMaterial({ color: col, toneMapped: false }));
        ring.rotation.x = Math.PI / 2; ring.position.set(x + 0.36, 0.06, z + 0.36); objectsGroup.add(ring);
      }
      const seg = (ax, az, bx, bz) => {
        const len = Math.hypot(bx - ax, bz - az); if (len < 0.01) return;
        const m = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(bx - ax) || 0.07, 0.012, Math.abs(bz - az) || 0.07), mat);
        m.position.set((ax + bx) / 2, 0.02, (az + bz) / 2); boardGroup.add(m);
      };
      for (const s of sources) for (const tg of targets) {
        const a = gridToWorld(s.e[0], s.e[1]), b = gridToWorld(tg.e[0], tg.e[1]);
        seg(a.x, a.z, b.x, a.z); seg(b.x, a.z, b.x, b.z);
      }
    }
    updaters.push((t, ctx) => {
      for (const [ch, mat] of cableMats) mat.opacity = ctx.channelsOn?.has(ch) ? 0.95 : 0.35 + Math.sin(t * 2 + ch) * 0.08;
    });
  }

  out.tick = (t, ctx) => {
    ctx.channelOff = (kind, entry) => !!ctx.channelsOn?.size && ctx.channelsOn.has(channelOf(world, kind, entry));
    for (const fn of updaters) fn(t, ctx);
  };
  return out;
}

export function createCursorMesh() {
  const cursor = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 32), new THREE.MeshBasicMaterial({ color: '#73f0ce', side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
  ring.rotation.x = -Math.PI / 2; cursor.add(ring);
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.98), new THREE.MeshBasicMaterial({ color: '#73f0ce', transparent: true, opacity: 0.16, depthTest: false }));
  fill.rotation.x = -Math.PI / 2; cursor.add(fill);
  cursor.visible = false; cursor.renderOrder = 20;
  return cursor;
}
