/**
 * Level editor controller.
 *
 *  • Tools place pieces on the 13×13 data grid (the 3D room stays continuous).
 *  • Clicking a piece with the Select tool (or just placing it) *selects* it.  Only then does the inspector
 *    appear, showing exactly the settings that piece has (lasers: sweep axis / beam axis / range / length /
 *    height / speed, shocks: direction / length / period / height, cutters, spikes, ledges, …).
 *  • A selected piece also shows drag handles in the 3D room: pull them to resize walls, ledges, acid, ice,
 *    water and crates in X, Y and Z, or to stretch a laser's sweep and length, a shock's reach, a cutter's rail.
 *
 * Data model additions (shared with backend/levels.py): `objectProperties["wall:x:z"] = {w, d, height, …}`
 * where w / d are footprint cells, plus the list formats documented in backend/levels.py.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import {
  GRID_SIZE, HALF_GRID, LIFT_DEFAULT_HEIGHT, CHANNELS, SHOCK_DIRS, gridToWorld, hasCell, propertyKey, laserSpec, shockSpec, cutterSpec,
} from './constants.js';
import { getObjectProperties, surfaceHeightAt } from './materials.js';

const $ = (id) => document.getElementById(id);

/** tool name -> data list.  The tool name doubles as the piece "type". */
const TOOLS = {
  wall: 'walls', block: 'blocks', platform: 'platforms', mover: 'movers', hazard: 'hazards', water: 'water', ice: 'ice',
  spikes: 'spikes', cutter: 'cutters', laser: 'lasers', shock: 'shocks', coin: 'coins', switch: 'switches', plate: 'plates',
  rotator: 'rotators', powerup: 'powerups', lever: 'levers', lift: 'lifts',
};
const TYPE_OF = Object.fromEntries(Object.entries(TOOLS).map(([k, v]) => [v, k]));
const LABEL = { hazard: 'Acid', water: 'Water', spikes: 'Spikes', cutter: 'Cutter', laser: 'Laser', shock: 'Shock', lift: 'Lift', platform: 'Ledge' };
// Pieces that may sit on top of a ledge (or be combined with one).
const STACKABLE = ['plates', 'coins', 'powerups', 'levers', 'switches', 'blocks'];
// Moving hazards live *in the air above* other pieces, so they never evict (or get evicted by) anything.
const OVERLAY = ['lasers', 'shocks', 'cutters'];
// Pieces that can be stretched over several cells with objectProperties {w, d}.
const BOX_TYPES = ['wall', 'platform', 'hazard', 'ice', 'water'];
const snap = (v, step) => Math.round(v / step) * step;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const same = (c, x, z) => c[0] === x && c[1] === z;

const DEFAULTS = {
  laser: (x, z) => [x, z, 'z', 1, 5, 'x', 0.5, 1],
  shock: (x, z) => [x, z, 'down', 3, 3, 3],
  cutter: (x, z) => [x, z, 'x', 3, 0.5, 1],
  spikes: (x, z) => [x, z, 0],
  lift: (x, z) => [x, z, LIFT_DEFAULT_HEIGHT],
};

export class LevelEditor {
  constructor() {
    this.selectedTool = 'select';
    this.selectedCell = null;       // the cell under the cursor
    this.selection = null;          // { type, list, x, z } of the selected piece
    this.onWorldChanged = null;
    this.toast = (msg) => console.log(msg);
    this.handlesGroup = new THREE.Group();
    this.handlesGroup.renderOrder = 40;
    this.handleMeshes = [];
    this.drag = null;
    this._world = null;
  }

  // ── Tools ───────────────────────────────────────────────────────────────────────────────────
  setTool(tool) {
    this.selectedTool = tool;
    document.querySelectorAll('.tile-tool').forEach((btn) => btn.classList.toggle('selected', btn.dataset.tool === tool));
    const editHint = $('editHint');
    if (editHint) {
      editHint.textContent = tool === 'select'
        ? 'Click a piece to select it, then configure it or drag its handles to resize.'
        : `${tool[0].toUpperCase()}${tool.slice(1)} · click a tile to place it (click again to remove). Place it, then it is selected for editing.`;
    }
    // tool-specific options are only visible while their tool is active
    $('optPowerup') && ($('optPowerup').hidden = tool !== 'powerup');
    $('optPlate') && ($('optPlate').hidden = tool !== 'plate');
  }

  updateCursorAt(event, raycaster, pointer, camera, floorTargets, cursorMesh, isEditMode, domElement, world = null) {
    const rect = domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const hit = raycaster.intersectObjects(floorTargets, false)[0];
    if (hit) {
      // Nudge the hit point into the surface so side faces resolve to the cell that was actually clicked.
      const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : { x: 0, z: 0 };
      const gx = Math.round(hit.point.x - n.x * 0.02 + HALF_GRID), gz = Math.round(hit.point.z - n.z * 0.02 + HALF_GRID);
      if (gx < 0 || gz < 0 || gx >= GRID_SIZE || gz >= GRID_SIZE) return;
      this.selectedCell = { gx, gz };
      if (cursorMesh) {
        const p = gridToWorld(gx, gz);
        const y = world ? surfaceHeightAt(world, gx, gz) : 0;
        cursorMesh.position.set(p.x, y + 0.04, p.z);
        cursorMesh.visible = isEditMode && !this.drag;
      }
    }
  }

  // ── Looking pieces up ───────────────────────────────────────────────────────────────────────
  /** Every piece anchored on `cell`, as [{type, list}], the highest-priority first. */
  piecesAt(world, cell) {
    const out = [];
    if (world.exitDoor?.[0] === cell.gx && world.exitDoor?.[1] === cell.gz) out.push({ type: 'door', list: null });
    if (same(world.start, cell.gx, cell.gz)) out.push({ type: 'start', list: null });
    for (const [type, list] of Object.entries(TOOLS)) if (hasCell(world[list] || [], cell.gx, cell.gz)) out.push({ type, list });
    return out;
  }

  objectTypeAt(world, cell) { return this.piecesAt(world, cell)[0]?.type || 'floor'; }

  entry(world, sel = this.selection) { return sel?.list ? (world[sel.list] || []).find((e) => same(e, sel.x, sel.z)) : null; }

  select(world, cell) {
    const pieces = this.piecesAt(world, cell);
    if (!pieces.length) { this.clearSelection(); return; }
    // clicking the same tile again cycles through pieces that share it
    let pick = pieces[0];
    if (this.selection && this.selection.x === cell.gx && this.selection.z === cell.gz) {
      const i = pieces.findIndex((p) => p.type === this.selection.type);
      pick = pieces[(i + 1) % pieces.length];
    }
    this.selection = { type: pick.type, list: pick.list, x: cell.gx, z: cell.gz };
    this.refreshInspector(world);
  }

  clearSelection() {
    this.selection = null;
    this.refreshInspector(this._world);
  }

  // ── Placing / erasing ───────────────────────────────────────────────────────────────────────
  editCell(cell, world) {
    this._world = world;
    if (this.selectedTool !== 'start' && same(world.start, cell.gx, cell.gz) && this.selectedTool !== 'select') {
      this.toast('Use the Start tool to move the starting point');
      return;
    }
    if (this.selectedTool === 'select') { this.select(world, cell); return; }

    const all = Object.values(TOOLS);
    world.continuousPlates ||= [];
    const strip = (names) => { for (const n of names) world[n] = (world[n] || []).filter((c) => !same(c, cell.gx, cell.gz)); };

    if (this.selectedTool === 'start') {
      strip(all.filter((n) => !OVERLAY.includes(n)));
      if (world.exitDoor && same(world.exitDoor, cell.gx, cell.gz)) world.exitDoor = null;
      world.start = [cell.gx, cell.gz];
    } else if (this.selectedTool === 'door') {
      const old = world.exitDoor;
      if (old && !same(old, cell.gx, cell.gz) && (old[0] === 0 || old[0] === GRID_SIZE - 1 || old[1] === 0 || old[1] === GRID_SIZE - 1)) world.walls.push([...old]);
      world.exitDoor = [cell.gx, cell.gz];
      world.goal = [...world.exitDoor];
      world.walls = world.walls.filter((c) => !same(c, cell.gx, cell.gz));
      strip(all);
    } else if (this.selectedTool === 'erase') {
      strip(all);
      world.painted = (world.painted || []).filter((c) => !same(c, cell.gx, cell.gz));
      if (world.exitDoor && same(world.exitDoor, cell.gx, cell.gz)) { world.exitDoor = null; world.goal = null; }
      for (const key of Object.keys(world.objectProperties || {})) if (key.endsWith(`:${cell.gx}:${cell.gz}`)) delete world.objectProperties[key];
      this.selection = null;
    } else {
      const tool = this.selectedTool;
      const name = TOOLS[tool];
      if (!name) return;
      if (world.exitDoor && same(world.exitDoor, cell.gx, cell.gz)) { this.toast('Move the exit door first'); return; }
      const list = (world[name] ||= []);
      const i = list.findIndex((c) => same(c, cell.gx, cell.gz));
      if (i >= 0) {
        list.splice(i, 1);
        if (world.objectProperties) delete world.objectProperties[propertyKey(tool, [cell.gx, cell.gz])];
        this.selection = null;
      } else {
        const SURF = ['platforms', 'walls'];
        const stack = (a, b) => (STACKABLE.includes(a) && SURF.includes(b)) || (SURF.includes(a) && STACKABLE.includes(b));
        for (const other of all) {
          if (other === name || OVERLAY.includes(other) || OVERLAY.includes(name) || stack(name, other)) continue;
          world[other] = (world[other] || []).filter((c) => !same(c, cell.gx, cell.gz));
        }
        if (tool === 'powerup') list.push([cell.gx, cell.gz, $('powerupType')?.value || 'speed']);
        else if (DEFAULTS[tool]) list.push(DEFAULTS[tool](cell.gx, cell.gz));
        else list.push([cell.gx, cell.gz]);
        if (tool === 'plate') {
          world.continuousPlates = world.continuousPlates.filter((c) => !same(c, cell.gx, cell.gz));
          if ($('plateMode')?.value === 'hold') world.continuousPlates.push([cell.gx, cell.gz]);
        }
        this.selection = { type: tool, list: name, x: cell.gx, z: cell.gz };
      }
    }
    world.continuousPlates = world.continuousPlates.filter(([x, z]) => hasCell(world.plates || [], x, z));
    $('selectionInfo') && ($('selectionInfo').textContent = `Tile ${cell.gx + 1}, ${cell.gz + 1}`);
    this.refreshInspector(world);
    this.onWorldChanged?.();
  }

  // ── Inspector (visible only while a piece is selected) ─────────────────────────────────────
  _props(world, sel = this.selection) { return getObjectProperties(world, sel.type, [sel.x, sel.z]); }

  _setProps(world, patch, sel = this.selection) {
    world.objectProperties ||= {};
    const key = propertyKey(sel.type, [sel.x, sel.z]);
    const next = { ...(world.objectProperties[key] || {}), ...patch };
    if (!(next.w > 1)) delete next.w;
    if (!(next.d > 1)) delete next.d;
    world.objectProperties[key] = next;
  }

  _move(world, nx, nz) {
    const sel = this.selection;
    if (!sel?.list) return false;
    if (nx < 0 || nz < 0 || nx >= GRID_SIZE || nz >= GRID_SIZE || same(world.start, nx, nz)) { this.toast('That tile is not available'); return false; }
    if ((world[sel.list] || []).some((c) => same(c, nx, nz))) { this.toast('That tile already holds one'); return false; }
    const e = this.entry(world);
    const oldKey = propertyKey(sel.type, [sel.x, sel.z]);
    e[0] = nx; e[1] = nz;
    if (world.objectProperties?.[oldKey]) { world.objectProperties[propertyKey(sel.type, [nx, nz])] = world.objectProperties[oldKey]; delete world.objectProperties[oldKey]; }
    if (sel.type === 'plate') world.continuousPlates = (world.continuousPlates || []).map((c) => (same(c, sel.x, sel.z) ? [nx, nz] : c));
    sel.x = nx; sel.z = nz;
    return true;
  }

  /** Fields for the selected piece: [{label, kind, get, set, ...}] */
  _fields(world) {
    const sel = this.selection;
    const e = this.entry(world);
    const f = [];
    const num = (label, get, set, min, max, step) => f.push({ label, kind: 'number', get, set, min, max, step });
    const sel2 = (label, get, set, options) => f.push({ label, kind: 'select', get, set, options });
    const bool = (label, get, set) => f.push({ label, kind: 'bool', get, set });
    if (sel.type !== 'start' && sel.type !== 'door') {
      num('Tile X', () => sel.x + 1, (v) => this._move(world, Math.round(v) - 1, sel.z), 1, GRID_SIZE, 1);
      num('Tile Z', () => sel.z + 1, (v) => this._move(world, sel.x, Math.round(v) - 1), 1, GRID_SIZE, 1);
    }
    const t = sel.type;
    if (BOX_TYPES.includes(t)) {
      num('Width (cells, X)', () => this._props(world).w || 1, (v) => this._setProps(world, { w: clamp(Math.round(v), 1, GRID_SIZE) }), 1, GRID_SIZE, 1);
      num('Depth (cells, Z)', () => this._props(world).d || 1, (v) => this._setProps(world, { d: clamp(Math.round(v), 1, GRID_SIZE) }), 1, GRID_SIZE, 1);
    }
    if (t === 'wall' || t === 'platform') {
      num('Height (Y)', () => this._props(world).height, (v) => this._setProps(world, { height: clamp(snap(v, 0.25), 0.25, 4) }), 0.25, 4, 0.25);
      f.push({ label: 'Colour', kind: 'color', get: () => this._props(world).color, set: (v) => this._setProps(world, { color: v }) });
      bool('Solid (collides)', () => this._props(world).collision !== false, (v) => this._setProps(world, { collision: v }));
    }
    if (t === 'block') {
      num('Size (X / Z)', () => this._props(world).size, (v) => this._setProps(world, { size: clamp(snap(v, 0.05), 0.4, 1.4) }), 0.4, 1.4, 0.05);
      num('Height (Y)', () => this._props(world).height, (v) => this._setProps(world, { height: clamp(snap(v, 0.05), 0.4, 1.6) }), 0.4, 1.6, 0.05);
    }
    if (t === 'laser' && e) {
      const axes = [['x', 'X'], ['y', 'Y (up/down)'], ['z', 'Z']];
      sel2('Sweeps along', () => laserSpec(e).sweep, (v) => { e[2] = v; if (laserSpec(e).beam === v) e[5] = v === 'x' ? 'z' : 'x'; }, axes);
      sel2('Beam extends along', () => laserSpec(e).beam, (v) => { e[5] = v; if (laserSpec(e).sweep === v) e[2] = v === 'x' ? 'z' : 'x'; }, axes);
      num('Sweep range', () => e[3], (v) => { e[3] = clamp(snap(v, 0.25), 0, 5); }, 0, 5, 0.25);
      num('Beam half-length', () => e[4], (v) => { e[4] = clamp(snap(v, 0.5), 0.5, 6); }, 0.5, 6, 0.5);
      num('Height (Y)', () => e[6] ?? 0.5, (v) => { e[6] = clamp(snap(v, 0.05), 0, 4); }, 0, 4, 0.05);
      num('Speed ×', () => e[7] ?? 1, (v) => { e[7] = clamp(snap(v, 0.05), 0.2, 3); }, 0.2, 3, 0.05);
    }
    if (t === 'shock' && e) {
      const labels = { down: 'Down', up: 'Up', xp: '+X', xn: '−X', zp: '+Z', zn: '−Z' };
      sel2('Strikes towards', () => shockSpec(e).dir, (v) => { e[2] = v; if (v === 'down') e[5] = Math.max(e[5] ?? 3, 2); }, SHOCK_DIRS.map((d) => [d, labels[d]]));
      num('Reach (length)', () => e[3], (v) => { e[3] = clamp(snap(v, 0.5), 0.5, 8); }, 0.5, 8, 0.5);
      num('Cycle period (s)', () => e[4], (v) => { e[4] = clamp(snap(v, 0.25), 1, 10); }, 1, 10, 0.25);
      num('Emitter height (Y)', () => shockSpec(e).y, (v) => { e[5] = clamp(snap(v, 0.25), 0, 4.2); }, 0, 4.2, 0.25);
    }
    if (t === 'cutter' && e) {
      sel2('Rail direction', () => cutterSpec(e).axis, (v) => { e[2] = v; }, [['x', 'X'], ['z', 'Z']]);
      num('Rail range (cells)', () => e[3], (v) => { e[3] = clamp(snap(v, 0.5), 0, 5); }, 0, 5, 0.5);
      num('Blade radius', () => e[4], (v) => { e[4] = clamp(snap(v, 0.05), 0.25, 1.2); }, 0.25, 1.2, 0.05);
      num('Speed ×', () => e[5] ?? 1, (v) => { e[5] = clamp(snap(v, 0.05), 0.2, 3); }, 0.2, 3, 0.05);
    }
    if (t === 'spikes' && e) num('Cycle (s, 0 = always out)', () => e[2] ?? 0, (v) => { e[2] = clamp(snap(v, 0.25), 0, 10); }, 0, 10, 0.25);
    if (t === 'lift' && e) num('Top height (Y)', () => e[2], (v) => { e[2] = clamp(snap(v, 0.25), 0.5, 3.5); }, 0.5, 3.5, 0.25);
    if (t === 'powerup' && e) sel2('Power-up', () => e[2] || 'speed', (v) => { e[2] = v; }, [['speed', 'Speed boost'], ['jump', 'High jump'], ['freeze', 'Time freeze'], ['shield', 'Shield']]);
    if (t === 'plate') bool('Hold (must stay pressed)', () => hasCell(world.continuousPlates || [], sel.x, sel.z), (v) => {
      world.continuousPlates = (world.continuousPlates || []).filter((c) => !same(c, sel.x, sel.z));
      if (v) world.continuousPlates.push([sel.x, sel.z]);
    });
    const chOpts = CHANNELS.map((c) => [String(c.id), c.name]);
    const setCh = (v) => this._setProps(world, { channel: Number(v) });
    if (t === 'plate') sel2('Wire colour · opens / switches off…', () => String(this._props(world).channel || 0), setCh, chOpts);
    if (t === 'lever') sel2('Wire colour · powers / switches off…', () => String(this._props(world).channel || 0), setCh, chOpts);
    if (['laser', 'shock', 'cutter', 'spikes'].includes(t)) sel2('Switched off by (wire colour)', () => String(this._props(world).channel || 0), setCh, [['0', 'Never (always active)'], ...chOpts.slice(1)]);
    if (t === 'lift') sel2('Powered by (wire colour)', () => String(this._props(world).channel || 0), setCh, [['0', 'Green · default lever'], ...chOpts.slice(1)]);
    return f;
  }

  refreshInspector(world) {
    this._world = world || this._world;
    const section = $('objectInspector');
    if (!section) return;
    const sel = this.selection;
    if (!sel || !world || (sel.list && !this.entry(world))) {
      this.selection = null;
      section.hidden = true;
      this.updateHandles(world);
      return;
    }
    section.hidden = false;
    const title = LABEL[sel.type] || (sel.type[0].toUpperCase() + sel.type.slice(1));
    $('inspectorType').textContent = `${title.toUpperCase()} · tile ${sel.x + 1}, ${sel.z + 1}`;
    const host = $('inspectorFields');
    host.innerHTML = '';
    const fields = (sel.type === 'door' || sel.type === 'start') ? [] : this._fields(world);
    if (!fields.length) host.innerHTML = '<div class="progress-note">Nothing to configure. Use the Start / Door tools to move it.</div>';
    for (const field of fields) {
      const row = document.createElement('label');
      row.className = 'progress-note inspector-row';
      row.append(field.label);
      let input;
      if (field.kind === 'select') {
        input = document.createElement('select'); input.className = 'setting-select';
        for (const [v, l] of field.options) { const o = document.createElement('option'); o.value = v; o.textContent = l; input.append(o); }
        input.value = field.get();
      } else if (field.kind === 'bool') {
        input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!field.get();
      } else if (field.kind === 'color') {
        input = document.createElement('input'); input.type = 'color'; input.value = field.get();
      } else {
        input = document.createElement('input'); input.type = 'number'; input.min = field.min; input.max = field.max; input.step = field.step; input.value = Number(field.get());
      }
      input.addEventListener('change', () => {
        const value = field.kind === 'bool' ? input.checked : field.kind === 'number' ? Number(input.value) : input.value;
        field.set(value);
        this.refreshInspector(world);
        this.onWorldChanged?.();
      });
      row.append(input);
      host.append(row);
    }
    this.updateHandles(world);
  }

  /** Kept for older call sites: edits now apply as soon as a field changes. */
  applyObjectProperties() {}

  // ── Drag handles ────────────────────────────────────────────────────────────────────────────
  /** Handle specs for the selected piece. `pos` is in world units; `axis` the drag axis (unit vector index). */
  _handleSpecs(world) {
    const sel = this.selection;
    if (!sel || !sel.list) return [];
    const e = this.entry(world);
    if (!e) return [];
    const t = sel.type;
    const W = (gx, gz) => ({ x: gx - HALF_GRID, z: gz - HALF_GRID });
    const out = [];
    const add = (id, axis, sign, pos, color, start, apply) => out.push({ id, axis, sign, pos, color, start, apply });
    const X = '#ff6b6b', Y = '#7dff8a', Z = '#6bb5ff';

    if (BOX_TYPES.includes(t)) {
      const p = this._props(world);
      const w = p.w || 1, d = p.d || 1;
      const y1 = (t === 'wall' || t === 'platform') ? p.height : 0.06;
      const x0 = sel.x - 0.5, z0 = sel.z - 0.5;
      const midX = x0 + w / 2, midZ = z0 + d / 2, midY = Math.max(0.2, y1 / 2);
      const resize = (axisKey, sign) => (value, travelled) => {
        const size = clamp(Math.round(value + travelled), 1, GRID_SIZE);
        const patch = axisKey === 'w' ? { w: size } : { d: size };
        if (sign < 0) {
          const grow = size - value; // cells added on the low side
          const nx = axisKey === 'w' ? sel.x - grow : sel.x, nz = axisKey === 'd' ? sel.z - grow : sel.z;
          if (nx < 0 || nz < 0) return;
          this._setProps(world, patch);
          if (grow) this._move(world, nx, nz);
        } else this._setProps(world, patch);
      };
      const ww = W(midX, midZ);
      add('+x', 0, 1, [W(x0 + w, 0).x, midY, ww.z], X, w, resize('w', 1));
      add('-x', 0, -1, [W(x0, 0).x, midY, ww.z], X, w, resize('w', -1));
      add('+z', 2, 1, [ww.x, midY, W(0, z0 + d).z], Z, d, resize('d', 1));
      add('-z', 2, -1, [ww.x, midY, W(0, z0).z], Z, d, resize('d', -1));
      if (t === 'wall' || t === 'platform') add('+y', 1, 1, [ww.x, y1 + 0.25, ww.z], Y, y1, (v, tr) => this._setProps(world, { height: clamp(snap(v + tr, 0.25), 0.25, 4) }));
    } else if (t === 'block') {
      const p = this._props(world);
      const c = W(sel.x, sel.z);
      add('+x', 0, 1, [c.x + p.size / 2, p.height / 2, c.z], X, p.size, (v, tr) => this._setProps(world, { size: clamp(snap(v + tr * 2, 0.05), 0.4, 1.4) }));
      add('+z', 2, 1, [c.x, p.height / 2, c.z + p.size / 2], Z, p.size, (v, tr) => this._setProps(world, { size: clamp(snap(v + tr * 2, 0.05), 0.4, 1.4) }));
      add('+y', 1, 1, [c.x, p.height + 0.25, c.z], Y, p.height, (v, tr) => this._setProps(world, { height: clamp(snap(v + tr, 0.05), 0.4, 1.6) }));
    } else if (t === 'laser') {
      const s = laserSpec(e);
      const c = W(s.cx, s.cz);
      const axisIndex = { x: 0, y: 1, z: 2 };
      const colour = { x: X, y: Y, z: Z };
      const base = [c.x, s.beam === 'y' ? s.y : s.y, c.z];
      const swp = [...base]; swp[axisIndex[s.sweep]] += s.sweep === 'y' ? s.range : s.range;
      if (s.sweep === 'y') swp[1] = s.y + s.range;
      add('range', axisIndex[s.sweep], 1, swp, colour[s.sweep], s.range, (v, tr) => { e[3] = clamp(snap(v + tr, 0.25), 0, 5); });
      const bm = [...base];
      if (s.beam === 'y') { bm[1] = s.y + 2 * s.half; add('half', 1, 1, bm, Y, s.half, (v, tr) => { e[4] = clamp(snap(v + tr / 2, 0.5), 0.5, 6); }); } else {
        bm[axisIndex[s.beam]] += s.half + 0.5; add('half', axisIndex[s.beam], 1, bm, colour[s.beam], s.half, (v, tr) => { e[4] = clamp(Math.round(v + tr), 1, 6); });
      }
      if (s.sweep !== 'y' && s.beam !== 'y') add('y', 1, 1, [c.x, s.y + 0.5, c.z], Y, s.y, (v, tr) => { e[6] = clamp(snap(v + tr, 0.05), 0, 4); });
    } else if (t === 'shock') {
      const s = shockSpec(e);
      const c = W(s.x, s.z);
      const dv = { down: [0, -1, 0], up: [0, 1, 0], xp: [1, 0, 0], xn: [-1, 0, 0], zp: [0, 0, 1], zn: [0, 0, -1] }[s.dir];
      const ai = dv.findIndex((v) => v !== 0), sg = dv[ai];
      const L = (s.dir === 'down' || s.dir === 'up') ? s.length : Math.round(s.length) + 0.5;
      const pos = [c.x + dv[0] * L, s.y + dv[1] * L, c.z + dv[2] * L];
      add('reach', ai, sg, pos, ai === 1 ? Y : ai === 0 ? X : Z, s.length, (v, tr) => { e[3] = clamp(snap(v + tr, 0.5), 0.5, 8); });
      if (ai !== 1) add('y', 1, 1, [c.x, s.y + 0.5, c.z], Y, s.y, (v, tr) => { e[5] = clamp(snap(v + tr, 0.25), 0, 4.2); });
      else add('y', 1, 1, [c.x + 0.45, s.y, c.z], Y, s.y, (v, tr) => { e[5] = clamp(snap(v + tr, 0.25), 0, 4.2); });
    } else if (t === 'cutter') {
      const s = cutterSpec(e);
      const c = W(s.x, s.z);
      const ai = s.axis === 'x' ? 0 : 2;
      const pos = [c.x, s.radius, c.z]; pos[ai] += s.range;
      add('range', ai, 1, pos, ai === 0 ? X : Z, s.range, (v, tr) => { e[3] = clamp(snap(v + tr, 0.5), 0, 5); });
      add('radius', 1, 1, [c.x, s.radius * 2 + 0.25, c.z], Y, s.radius, (v, tr) => { e[4] = clamp(snap(v + tr / 2, 0.05), 0.25, 1.2); });
    } else if (t === 'lift') {
      const c = W(sel.x, sel.z);
      add('top', 1, 1, [c.x, e[2] + 0.3, c.z], Y, e[2], (v, tr) => { e[2] = clamp(snap(v + tr, 0.25), 0.5, 3.5); });
    }
    return out;
  }

  updateHandles(world) {
    const g = this.handlesGroup;
    for (const m of [...g.children]) { g.remove(m); m.geometry?.dispose(); m.material?.dispose(); }
    this.handleMeshes = [];
    if (!world || !this.selection) return;
    this._world = world;
    this._specs = this._handleSpecs(world);
    for (const spec of this._specs) {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.17, 0), new THREE.MeshBasicMaterial({ color: spec.color, depthTest: false, transparent: true, opacity: 0.95, toneMapped: false }));
      m.position.set(...spec.pos); m.renderOrder = 40; m.userData.handle = spec;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.25, 20), new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true, opacity: 0.8, side: THREE.DoubleSide, toneMapped: false }));
      ring.renderOrder = 41; m.add(ring);
      m.userData.ring = ring;
      g.add(m); this.handleMeshes.push(m);
    }
  }

  /** Billboard the rings and gently pulse the handles (called every frame in edit mode). */
  tickHandles(camera, t) {
    this.handlesGroup.visible = !!this.selection;
    for (const m of this.handleMeshes) {
      m.userData.ring.quaternion.copy(camera.quaternion);
      const s = (this.drag?.spec === m.userData.handle ? 1.35 : 1) * (1 + Math.sin(t * 4) * 0.06) * (camera.position.distanceTo(m.position) / 9);
      m.scale.setScalar(Math.max(0.6, s));
    }
  }

  pickHandle(raycaster, pointer, camera, domElement, event) {
    if (!this.handleMeshes.length) return null;
    const rect = domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(this.handleMeshes, false)[0];
    return hit ? hit.object.userData.handle : null;
  }

  beginDrag(spec, raycaster) {
    const origin = new THREE.Vector3(...spec.pos);
    const dir = new THREE.Vector3(spec.axis === 0 ? 1 : 0, spec.axis === 1 ? 1 : 0, spec.axis === 2 ? 1 : 0).multiplyScalar(spec.sign || 1);
    this.drag = { spec, origin, dir, startValue: spec.start, last: null, grab: this._axisParam(raycaster.ray, origin, dir) };
    this._snapshot = JSON.stringify(this._world);
    this.drag.selStart = { ...this.selection };
  }

  /** Parameter t along the axis line (origin + t·dir) closest to the camera ray. */
  _axisParam(ray, origin, dir) {
    const w0 = origin.clone().sub(ray.origin);
    const b = dir.dot(ray.direction);
    const d = dir.dot(w0), e = ray.direction.dot(w0);
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-4) return 0;
    return (b * e - d) / denom;
  }

  dragMove(raycaster) {
    const d = this.drag;
    if (!d) return;
    const travelled = this._axisParam(raycaster.ray, d.origin, d.dir) - d.grab; // along `dir`, i.e. already sign-corrected
    const key = Math.round(travelled * 8);
    if (key === d.last) return;
    d.last = key;
    // restore the pre-drag state, then apply the new size so repeated moves never accumulate rounding errors
    const world = this._world;
    const fresh = JSON.parse(this._snapshot);
    for (const k of Object.keys(world)) delete world[k];
    Object.assign(world, fresh);
    this.selection = { ...d.selStart };
    const spec = this._handleSpecs(world).find((s) => s.id === d.spec.id);
    if (!spec) return;
    spec.apply(spec.start, travelled);
    this.refreshInspector(world);
    this.onWorldChanged?.();
  }

  endDrag() {
    if (!this.drag) return;
    this.drag = null;
    this.refreshInspector(this._world);
  }

  updateObjectCount(world) {
    const lists = ['blocks', 'platforms', 'movers', 'hazards', 'water', 'ice', 'spikes', 'cutters', 'coins', 'switches', 'plates', 'rotators', 'lasers', 'shocks', 'powerups', 'levers', 'lifts'];
    $('objectCount').textContent = world.walls.length + lists.reduce((sum, key) => sum + (world[key]?.length || 0), 0);
    $('rotatorCount').textContent = world.rotators?.length || 0;
  }
}
