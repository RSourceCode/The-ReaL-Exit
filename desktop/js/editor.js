/**
 * Level Editor Tool Controller
 * Manages tile selection, object placement, erase operations, and inspector property editing.
 */

import { GRID_SIZE, gridToWorld, hasCell, propertyKey } from './constants.js';
import { getObjectProperties } from './materials.js';

const $ = (id) => document.getElementById(id);

export class LevelEditor {
  constructor() {
    this.selectedTool = 'select';
    this.selectedCell = null;
    this.onWorldChanged = null;
    this.toast = (msg) => console.log(msg);
  }

  setTool(tool) {
    this.selectedTool = tool;
    document.querySelectorAll('.tile-tool').forEach((btn) => {
      btn.classList.toggle('selected', btn.dataset.tool === tool);
    });
    const editHint = $('editHint');
    if (editHint) {
      editHint.textContent = `${tool[0].toUpperCase()}${tool.slice(1)} selected · click a tile in the 3D world.`;
    }
  }

  updateCursorAt(event, raycaster, pointer, camera, floorTargets, cursorMesh, isEditMode, domElement) {
    const rect = domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const hits = raycaster.intersectObjects(floorTargets, false);
    if (hits.length) {
      const cell = hits[0].object.userData;
      this.selectedCell = { gx: cell.gx, gz: cell.gz };
      if (cursorMesh) {
        const p = gridToWorld(cell.gx, cell.gz);
        cursorMesh.position.set(p.x, 0.035, p.z);
        cursorMesh.visible = isEditMode;
      }
    }
  }

  objectTypeAt(world, cell) {
    if (world.exitDoor?.[0] === cell.gx && world.exitDoor?.[1] === cell.gz) return 'door';
    const types = [['walls', 'wall'], ['plates', 'plate'], ['rotators', 'rotator']];
    for (const [list, type] of types) {
      if (hasCell(world[list], cell.gx, cell.gz)) return type;
    }
    return 'floor';
  }

  refreshInspector(world) {
    if (!this.selectedCell) {
      $('inspectorType').textContent = 'No object selected';
      ['objectX', 'objectZ', 'objectHeight', 'objectSize', 'objectColor', 'objectCollision', 'applyObjectProperties'].forEach((id) => {
        $(id).disabled = true;
      });
      return;
    }

    const type = this.objectTypeAt(world, this.selectedCell);
    $('inspectorType').textContent = `${type.toUpperCase()} · tile ${this.selectedCell.gx + 1}, ${this.selectedCell.gz + 1}`;
    $('objectX').value = this.selectedCell.gx + 1;
    $('objectZ').value = this.selectedCell.gz + 1;

    const props = getObjectProperties(world, type, [this.selectedCell.gx, this.selectedCell.gz]);
    $('objectHeight').value = props.height;
    $('objectSize').value = props.size;
    $('objectColor').value = props.color;
    $('objectCollision').checked = props.collision !== false;

    const placeable = type !== 'floor';
    const configurable = ['wall', 'block', 'platform'].includes(type);
    ['objectX', 'objectZ', 'applyObjectProperties'].forEach((id) => { $(id).disabled = !placeable; });
    ['objectHeight', 'objectSize', 'objectColor', 'objectCollision'].forEach((id) => { $(id).disabled = !configurable; });
  }

  _toggleCellIn(world, listName, cell) {
    const list = world[listName];
    const i = list.findIndex(([x, z]) => x === cell.gx && z === cell.gz);
    if (i >= 0) list.splice(i, 1);
    else list.push([cell.gx, cell.gz]);
  }

  editCell(cell, world) {
    if (this.selectedTool !== 'start' && cell.gx === world.start[0] && cell.gz === world.start[1]) {
      this.toast('Use the Start tool to move the starting point');
      return;
    }
    this.selectedCell = { gx: cell.gx, gz: cell.gz };

    if (this.selectedTool === 'select') {
      $('selectionInfo').textContent = `Selected tile: ${cell.gx + 1}, ${cell.gz + 1} · ${this.objectTypeAt(world, cell)}`;
      this.refreshInspector(world);
      return;
    }

    const tools = { wall: 'walls', plate: 'plates', rotator: 'rotators' };

    if (this.selectedTool === 'start') {
      world.walls = world.walls.filter(([x, z]) => x !== cell.gx || z !== cell.gz);
      world.plates = world.plates.filter(([x, z]) => x !== cell.gx || z !== cell.gz);
      world.rotators = world.rotators.filter(([x, z]) => x !== cell.gx || z !== cell.gz);
      if (world.exitDoor?.[0] === cell.gx && world.exitDoor?.[1] === cell.gz) world.exitDoor = null;
      world.start = [cell.gx, cell.gz];
    } else if (this.selectedTool === 'door') {
      const oldDoor = world.exitDoor;
      if (oldDoor && (oldDoor[0] !== cell.gx || oldDoor[1] !== cell.gz) && (oldDoor[0] === 0 || oldDoor[0] === GRID_SIZE - 1 || oldDoor[1] === 0 || oldDoor[1] === GRID_SIZE - 1)) {
        world.walls.push([...oldDoor]);
      }
      world.exitDoor = [cell.gx, cell.gz];
      world.goal = [...world.exitDoor];
      world.walls = world.walls.filter(([x, z]) => x !== cell.gx || z !== cell.gz);
      world.plates = world.plates.filter(([x, z]) => x !== cell.gx || z !== cell.gz);
      world.rotators = world.rotators.filter(([x, z]) => x !== cell.gx || z !== cell.gz);
    } else if (this.selectedTool === 'erase') {
      for (const name of Object.values(tools)) {
        world[name] = world[name].filter(([x, z]) => x !== cell.gx || z !== cell.gz);
      }
      world.painted = (world.painted || []).filter(([x, z]) => x !== cell.gx || z !== cell.gz);
      if (world.exitDoor?.[0] === cell.gx && world.exitDoor?.[1] === cell.gz) {
        world.exitDoor = null;
        world.goal = null;
      }
      for (const key of Object.keys(world.objectProperties || {})) {
        if (key.endsWith(`:${cell.gx}:${cell.gz}`)) delete world.objectProperties[key];
      }
    } else {
      const name = tools[this.selectedTool];
      if (name) {
        if (world.exitDoor?.[0] === cell.gx && world.exitDoor?.[1] === cell.gz) {
          this.toast('Move the exit door first');
          return;
        }
        for (const other of Object.values(tools)) {
          if (other !== name) world[other] = world[other].filter(([x, z]) => x !== cell.gx || z !== cell.gz);
        }
        this._toggleCellIn(world, name, cell);
      }
    }

    $('selectionInfo').textContent = `Selected tile: ${cell.gx + 1}, ${cell.gz + 1} · ${this.selectedTool}`;
    this.refreshInspector(world);
    if (this.onWorldChanged) this.onWorldChanged();
    this.toast(`${this.selectedTool[0].toUpperCase()}${this.selectedTool.slice(1)} placed`);
  }

  applyObjectProperties(world) {
    if (!this.selectedCell) return;
    const type = this.objectTypeAt(world, this.selectedCell);
    if (type === 'floor') {
      this.toast('Select a placed object first');
      return;
    }

    const oldCell = [this.selectedCell.gx, this.selectedCell.gz];
    const nextCell = [Number($('objectX').value) - 1, Number($('objectZ').value) - 1];

    if (nextCell.some((val) => !Number.isInteger(val) || val < 0 || val >= GRID_SIZE)) {
      this.toast(`Tile coordinates must be between 1 and ${GRID_SIZE}`);
      return;
    }
    if (nextCell[0] === world.start[0] && nextCell[1] === world.start[1]) {
      this.toast('The starting tile is protected');
      return;
    }

    const typeToList = { wall: 'walls', plate: 'plates', rotator: 'rotators' };
    const ownList = typeToList[type];
    const occupiedLists = type === 'door' ? ['plates', 'rotators'] : Object.values(typeToList);

    if (occupiedLists.some((name) => world[name].some(([x, z]) => x === nextCell[0] && z === nextCell[1] && (name !== ownList || x !== oldCell[0] || z !== oldCell[1])))) {
      this.toast('That tile already contains another object');
      return;
    }

    if (type === 'door') {
      const oldDoor = [...world.exitDoor];
      if ((oldDoor[0] !== nextCell[0] || oldDoor[1] !== nextCell[1]) && (oldDoor[0] === 0 || oldDoor[0] === GRID_SIZE - 1 || oldDoor[1] === 0 || oldDoor[1] === GRID_SIZE - 1)) {
        world.walls.push(oldDoor);
      }
      world.exitDoor = nextCell;
      world.goal = [...nextCell];
      world.walls = world.walls.filter(([x, z]) => x !== nextCell[0] || z !== nextCell[1]);
      world.plates = world.plates.filter(([x, z]) => x !== nextCell[0] || z !== nextCell[1]);
      world.rotators = world.rotators.filter(([x, z]) => x !== nextCell[0] || z !== nextCell[1]);
    } else {
      const list = world[ownList];
      const entry = list.find(([x, z]) => x === oldCell[0] && z === oldCell[1]);
      if (entry) {
        entry[0] = nextCell[0];
        entry[1] = nextCell[1];
      }
    }

    const configurable = ['wall'].includes(type);
    const oldKey = propertyKey(type, oldCell);
    const key = propertyKey(type, nextCell);
    if (configurable && world.objectProperties?.[oldKey]) delete world.objectProperties[oldKey];

    this.selectedCell = { gx: nextCell[0], gz: nextCell[1] };
    if (configurable) {
      world.objectProperties ||= {};
      world.objectProperties[key] = {
        height: Number($('objectHeight').value),
        size: Number($('objectSize').value),
        color: $('objectColor').value,
        collision: $('objectCollision').checked,
      };
    }

    $('selectionInfo').textContent = `Selected tile: ${nextCell[0] + 1}, ${nextCell[1] + 1} · ${type}`;
    this.refreshInspector(world);
    if (this.onWorldChanged) this.onWorldChanged();
    this.toast(`${type[0].toUpperCase()}${type.slice(1)} updated`);
  }

  updateObjectCount(world) {
    $('objectCount').textContent = world.walls.length + (world.plates?.length || 0) + (world.rotators?.length || 0) + Number(!!world.exitDoor);
    $('rotatorCount').textContent = world.rotators?.length || 0;
  }
}

