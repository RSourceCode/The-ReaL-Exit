/**
 * App Shell UI & Navigation Controller
 * Manages screen transitions, fullscreen focus, toasts, and settings panels.
 */

import { expandLevel, worldDims, LIST_FIELDS, MIN_GRID, MAX_GRID } from './constants.js';

const $ = (id) => document.getElementById(id);
const PAGE_TITLES = { home: 'Home', levels: 'Levels', ai: 'AI Lab', settings: 'Settings', build: 'Level Builder', play: 'Play', shop: 'Wardrobe', achievements: 'Awards' };
const PAGE_ALIAS = { worlds: 'levels' };

export class UIController {
  constructor(gameManager, cameraController, editor, onPageChanged, playerMesh = null, audio = null, wardrobe = null) {
    this.gameManager = gameManager;
    this.cameraController = cameraController;
    this.editor = editor;
    this.onPageChanged = onPageChanged;
    this.playerMesh = playerMesh;
    this.audio = audio;
    this.wardrobe = wardrobe;
    this.wardrobeUI = null;

    this.activePage = 'home';
    this.requestedPage = 'home';
    this.mode = 'play';
    this.levelsMode = 'play';          // what a click on a level card does: play it or build it
    document.body.dataset.page = 'home';
    this.gameManager.onLevelsChanged = () => { if (this.activePage === 'levels') this.renderLevels(); this.syncSizeInputs(); };
    this.toastTimer = null;
    this.isPaused = false;
    this.pauseStartedAt = 0;
    if ($('soundToggle')) $('soundToggle').textContent = this.audio?.enabled === false ? 'Sound off' : 'Sound on';

    this._bindEvents();
  }

  toast(message) {
    const node = $('toast');
    if (!node) return;
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => node.classList.remove('show'), 1900);
  }

  setMode(nextMode) {
    this.mode = nextMode;
    document.body.classList.toggle('world-build-focus', nextMode === 'edit' && document.body.classList.contains('world-focus'));

    document.querySelectorAll('#playBtn,#editBtn').forEach((btn) => btn.classList.remove('active'));
    $(nextMode === 'play' ? 'playBtn' : 'editBtn').classList.add('active');

    $('modePill').textContent = nextMode === 'play' ? 'PLAY MODE' : 'BUILD MODE';
    $('modePill').classList.toggle('active', nextMode === 'play');
    $('pauseBtn').hidden = nextMode !== 'play';

    $('worldTitle').textContent = nextMode === 'play' ? this.gameManager.world.name : `Edit ${this.gameManager.world.name}`;
    $('worldDescription').textContent = nextMode === 'play'
      ? (this.gameManager.world.hint || 'Press the plates, grab coins and reach the exit gate.')
      : 'Place walls, ledges, crates, plates, lifts, scanning lasers, levers, coins and the exit. Plates, coins and boosts can sit on top of ledges.';
    $('worldEyebrow').textContent = nextMode === 'play'
      ? `CAMPAIGN · LEVEL ${this.gameManager.activeLevelIndex + 1} OF ${this.gameManager.campaignLevels.length}`
      : 'LEVEL EDITOR';

    $('modeCaption').textContent = nextMode === 'play'
      ? 'PLAY · WASD move · Space jump · E use · ←/→ rotate camera'
      : 'BUILD · Click a tile to place the selected object';

    $('objectivesSection').style.display = nextMode === 'play' ? 'block' : 'none';
    this.syncSizeInputs();
    $('campaignEditorSection').style.display = nextMode === 'edit' ? 'block' : 'none';
    $('buildToolsSection').style.display = nextMode === 'edit' ? 'block' : 'none';
    $('objectInspector').style.display = nextMode === 'edit' ? 'block' : 'none';

    if (nextMode === 'edit') {
      this.editor.refreshInspector(this.gameManager.world);
      this.toast('Build mode: click a tile to place the selected object');
    }

    this.gameManager.refreshLevelNavigation();
    $('controlHelp').textContent = nextMode === 'play'
      ? (this.cameraController.view === 'first'
        ? 'Mouse look · WASD move · Space jump · E use · R restart.'
        : 'Drag to orbit · WASD move (camera-relative) · Space jump (hold = higher) · E use · R restart.')
      : 'Drag to orbit · click the world to place · scroll to zoom.';
  }

  showPage(requested) {
    requested = PAGE_ALIAS[requested] || requested;
    const page = ['play', 'build'].includes(requested) ? 'world' : requested;
    this.activePage = page; this.requestedPage = requested;
    document.body.dataset.page = requested;
    console.info(`[ui] page selected: ${requested}`);

    document.querySelectorAll('.app-page').forEach((node) => {
      node.classList.toggle('active', node.id === `${page}-page`);
    });
    $('breadcrumb').textContent = PAGE_TITLES[requested] || 'Home';

    if (requested === 'play' || requested === 'build') {
      this.setMode(requested === 'build' ? 'edit' : 'play');
      document.body.classList.add('world-focus');
      document.body.classList.toggle('world-build-focus', requested === 'build');
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      }
    } else {
      document.body.classList.remove('world-focus', 'world-build-focus');
    }
    this._syncFullscreenLabel();

    $('appMain').scrollTop = 0;
    if (requested !== 'play') this.setPaused(false);
    if (requested === 'shop') this.refreshShop();
    if (requested === 'levels') this.renderLevels();
    if (this.onPageChanged) this.onPageChanged(requested);
  }

  // ── Level select ───────────────────────────────────────────────────────────────────────────
  /** Draw a level as a tiny top-down map (walls, liquids, ice, plates, hazards, coins, start and gate). */
  drawThumb(canvas, level) {
    const { w, d } = worldDims(level);
    const cell = Math.max(4, Math.min(12, Math.floor(230 / Math.max(w, d))));
    canvas.width = w * cell; canvas.height = d * cell;
    const g = canvas.getContext('2d');
    let L = level;
    try { L = expandLevel(level); } catch { /* fall back to the raw level */ }
    const X = (x) => x * cell, Y = (z) => (d - 1 - z) * cell;       // z = 0 is the near wall, drawn at the bottom
    g.fillStyle = '#10222b'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#16303b';
    for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) if ((x + z) % 2) g.fillRect(X(x), Y(z), cell, cell);
    const fill = (cells, color, inset = 0, round = false) => {
      g.fillStyle = color;
      for (const c of cells || []) {
        if (round) { g.beginPath(); g.arc(X(c[0]) + cell / 2, Y(c[1]) + cell / 2, Math.max(1.5, cell * 0.34), 0, 6.283); g.fill(); }
        else g.fillRect(X(c[0]) + inset, Y(c[1]) + inset, cell - inset * 2, cell - inset * 2);
      }
    };
    fill(L.ice, '#bfe8f4'); fill(L.water, '#2f93f2'); fill(L.hazards, '#7bd92a');
    fill(L.platforms, '#6a8fb8', 0.5); fill(L.lifts, '#3fd0b8', 1);
    fill(L.walls, '#92a9b2'); fill(L.blocks, '#b77148', 1.2);
    fill(L.spikes, '#ff6b6b', 1.4); fill(L.plates, '#ffb347', 0, true); fill(L.levers, '#c8a0ff', 0, true);
    fill(L.rotators, '#e8eef2', 0, true); fill(L.coins, '#ffd36a', 0, true);
    for (const s of L.shocks || []) fill([s], '#d6ff7a', 0, true);
    for (const s of L.cutters || []) fill([s], '#ffd27a', 0, true);
    g.strokeStyle = '#ff4d78'; g.lineWidth = Math.max(1, cell * 0.2);
    for (const l of L.lasers || []) { g.beginPath(); g.arc(X(l[0]) + cell / 2, Y(l[1]) + cell / 2, cell * 0.4, 0, 6.283); g.stroke(); }
    const door = level.exitDoor;
    if (door) { g.fillStyle = '#55ff9a'; g.fillRect(X(door[0]) - cell * 0.4, Y(door[1]) - cell * 0.4, cell * 1.8, cell * 1.8); g.fillStyle = '#10222b'; }
    const s = level.start;
    if (s) { g.fillStyle = '#7fe7ff'; g.beginPath(); g.arc(X(s[0]) + cell / 2, Y(s[1]) + cell / 2, Math.max(2, cell * 0.45), 0, 6.283); g.fill(); }
  }

  renderLevels() {
    const host = $('levelGrid'); if (!host) return;
    const gm = this.gameManager;
    host.innerHTML = '';
    const building = this.levelsMode === 'build';
    $('newLevelBtn').hidden = !building;
    $('levelsHint').textContent = building ? 'Pick a level to edit, or start a new one.' : 'Pick a level to play.';
    document.querySelectorAll('[data-levels-mode]').forEach((b) => b.classList.toggle('active', b.dataset.levelsMode === this.levelsMode));
    host.classList.toggle('building', building);
    gm.campaignLevels.forEach((level, index) => {
      const { w, d } = worldDims(level);
      const record = gm.levelRecord(level);
      const stars = record ? '★'.repeat(record.stars) + '☆'.repeat(3 - record.stars) : '☆☆☆';
      const card = document.createElement('article');
      card.className = `level-card${index === gm.activeLevelIndex ? ' active' : ''}${record ? ' done' : ''}`;
      card.tabIndex = 0; card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `${building ? 'Edit' : 'Play'} level ${index + 1}: ${level.name}`);
      const thumb = document.createElement('div'); thumb.className = 'thumb';
      const canvas = document.createElement('canvas'); thumb.append(canvas);
      const num = document.createElement('span'); num.className = 'num'; num.textContent = String(index + 1).padStart(2, '0'); thumb.append(num);
      if (level.standalone) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'standalone'; thumb.append(tag); }
      const meta = document.createElement('div'); meta.className = 'meta';
      const h = document.createElement('h3'); h.textContent = level.name;
      const sub = document.createElement('div'); sub.className = 'sub';
      sub.innerHTML = `<span>${w} × ${d}</span><span class="stars" title="Best rating">${stars}</span>${record?.time ? `<span>${record.time.toFixed(1)}s</span>` : ''}`;
      meta.append(h, sub);
      card.append(thumb, meta);
      if (building) {
        const actions = document.createElement('div'); actions.className = 'card-actions';
        for (const [act, label, title] of [['up', '↑', 'Move earlier'], ['down', '↓', 'Move later'], ['dup', '⧉', 'Duplicate'], ['del', '✕', 'Delete']]) {
          const b = document.createElement('button'); b.type = 'button'; b.dataset.act = act; b.textContent = label; b.title = title; b.setAttribute('aria-label', `${title}: ${level.name}`); actions.append(b);
        }
        card.append(actions);
      }
      const open = () => { gm.loadCampaignLevel(index); this.showPage(building ? 'build' : 'play'); };
      card.addEventListener('click', (e) => {
        const act = e.target.closest?.('[data-act]')?.dataset.act;
        if (!act) { open(); return; }
        e.stopPropagation();
        if (act === 'dup') { gm.duplicateLevel(index); this.renderLevels(); this.toast('Level duplicated'); }
        else if (act === 'del') { if (confirm(`Delete “${level.name}”?`) && gm.deleteLevel(index)) { this.renderLevels(); this.toast('Level deleted'); } }
        else if (gm.moveLevel(index, act === 'up' ? -1 : 1)) this.renderLevels();
      });
      card.addEventListener('keydown', (e) => { if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } });
      host.append(card);
      this.drawThumb(canvas, level);
    });
  }

  // ── World size (editor) ──────────────────────────────────────────────────────────────────
  syncSizeInputs() {
    const w = $('worldW'), d = $('worldD'); if (!w || !d) return;
    const dims = worldDims(this.gameManager.world);
    if (document.activeElement !== w) w.value = dims.w;
    if (document.activeElement !== d) d.value = dims.d;
  }

  applyWorldSize(width, depth) {
    const gm = this.gameManager, world = gm.world;
    const nw = Math.max(MIN_GRID, Math.min(MAX_GRID, Math.round(width) || 0)), nd = Math.max(MIN_GRID, Math.min(MAX_GRID, Math.round(depth) || 0));
    const { w, d } = worldDims(world);
    if (nw === w && nd === d) { this.syncSizeInputs(); return; }
    if (nw < w || nd < d) {
      const outside = LIST_FIELDS.filter((k) => k !== 'walls').reduce((n, k) => n + (world[k] || []).filter((c) => c[0] > nw - 2 || c[1] > nd - 2).length, 0);
      if (outside && !confirm(`Shrinking to ${nw} × ${nd} removes ${outside} piece${outside === 1 ? '' : 's'} outside the new walls. Continue?`)) { this.syncSizeInputs(); return; }
    }
    if (this.editor.resizeWorld(world, nw, nd)) {
      this.editor.onWorldChanged?.();
      gm.updateUI(); this.syncSizeInputs();
      this.toast(`Room is now ${nw} × ${nd}`);
    }
  }

  _syncFullscreenLabel() {
    const btn = $('fullscreenBtn');
    if (btn) btn.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  }

  _bindEvents() {
    $('playBtn').addEventListener('click', () => this.showPage('play'));
    $('editBtn').addEventListener('click', () => this.showPage('build'));
    $('homePlayBtn').addEventListener('click', () => this.showPage('play'));
    document.querySelectorAll('[data-go]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.go;
        if (target === 'levels') { this.levelsMode = 'play'; }
        if (target === 'build' && btn.closest('#home-page')) { this.levelsMode = 'build'; this.showPage('levels'); return; }
        this.showPage(target);
      });
    });
    document.querySelectorAll('[data-levels-mode]').forEach((btn) => btn.addEventListener('click', () => { this.levelsMode = btn.dataset.levelsMode; this.renderLevels(); }));
    $('newLevelBtn')?.addEventListener('click', () => { this.gameManager.addCampaignLevel(); this.showPage('build'); this.toast(`${this.gameManager.world.name} created`); });
    // world size controls
    const sizeFrom = () => this.applyWorldSize(Number($('worldW').value), Number($('worldD').value));
    $('worldW')?.addEventListener('change', sizeFrom); $('worldD')?.addEventListener('change', sizeFrom);
    document.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
      const dims = worldDims(this.gameManager.world), delta = Number(b.dataset.d);
      this.applyWorldSize(dims.w + (b.dataset.size === 'w' ? delta : 0), dims.d + (b.dataset.size === 'd' ? delta : 0));
    }));
    document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { const [pw, pd] = b.dataset.preset.split('x').map(Number); this.applyWorldSize(pw, pd); }));

    // Fullscreen is just a window state. The in-game HUD ("world-focus") stays on while a run / the editor is open, so
    // leaving fullscreen never drops back to the old black game card; the Menu button returns to the menus.
    $('fullscreenBtn').addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch { this.toast('Fullscreen is not available here'); }
      this._syncFullscreenLabel();
      this.cameraController.resize();
    });
    $('menuBtn')?.addEventListener('click', () => this.showPage(this.requestedPage === 'build' ? 'levels' : 'home'));

    $('pauseBtn')?.addEventListener('click', () => this.setPaused(!this.isPaused));
    $('soundToggle')?.addEventListener('click', () => {
      if (!this.audio) return;
      this.audio.unlock();
      this.audio.enabled = !this.audio.enabled;
      $('soundToggle').textContent = this.audio.enabled ? 'Sound on' : 'Sound off';
      if (this.audio.enabled) this.audio.play('tap');
    });
    for (const [id, key] of [['volMaster', 'master'], ['volMusic', 'music'], ['volSfx', 'sfx']]) {
      const slider = $(id);
      if (!slider || !this.audio) continue;
      slider.value = Math.round(this.audio.settings[key] * 100);
      const label = $(`${id}Label`); if (label) label.textContent = `${slider.value}%`;
      slider.addEventListener('input', () => {
        this.audio.unlock();
        this.audio.setVolumes({ [key]: Number(slider.value) / 100 });
        if (label) label.textContent = `${slider.value}%`;
      });
      slider.addEventListener('change', () => this.audio.play(key === 'sfx' ? 'coin' : 'tap'));
    }
    $('resumeBtn')?.addEventListener('click', () => this.setPaused(false));
    document.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && this.activePage === 'world' && this.mode === 'play') {
        event.preventDefault(); this.setPaused(!this.isPaused);
      }
    });
    document.querySelectorAll('[data-world]').forEach((button) => button.addEventListener('click', () => this.purchaseWorld(button)));

    document.addEventListener('fullscreenchange', () => {
      this._syncFullscreenLabel();
      this.cameraController.resize();
      setTimeout(() => this.cameraController.resize(), 120);
    });

    document.querySelectorAll('[data-settings-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-settings-tab]').forEach((tab) => tab.classList.toggle('active', tab === btn));
        document.querySelectorAll('[data-settings-content]').forEach((panel) => {
          panel.hidden = panel.dataset.settingsContent !== btn.dataset.settingsTab;
        });
      if (btn.dataset.settingsTab === 'diagnostics') this.refreshDiagnostics();
      });
    });

    $('standaloneLevel')?.addEventListener('change', (e) => {
      this.gameManager.world.standalone = e.target.checked;
      this.gameManager.saveWorld(false);
      this.toast(this.gameManager.world.standalone ? 'Standalone completion message enabled' : 'Level linked to campaign');
    });

    $('rotatorSpeed')?.addEventListener('input', (e) => {
      this.gameManager.world.rotatorSpeed = Number(e.target.value);
      this.gameManager.saveWorld(false);
    });

    $('saveBtn').addEventListener('click', () => this.gameManager.saveWorld(true, (m) => this.toast(m)));
    $('addLevelBtn')?.addEventListener('click', () => {
      this.gameManager.addCampaignLevel();
      this.toast(`${this.gameManager.world.name} added`);
    });
    $('generateChallengeBtn')?.addEventListener('click', () => {
      const level = this.gameManager.generateChallengeLevel();
      this.showPage('build');
      this.toast(`${level.name} generated · test it, then save or export`);
    });

    $('exportWorldBtn')?.addEventListener('click', () => this.gameManager.exportWorld());
    $('importWorldBtn')?.addEventListener('click', () => $('importWorldFile').click());
    $('importWorldFile')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const count = this.gameManager.importWorldData(JSON.parse(await file.text()));
        this.toast(`Imported ${count} level${count === 1 ? '' : 's'} · ready to edit`);
        this.levelsMode = 'build'; this.showPage('build');
      } catch (error) {
        this.toast(error.message || 'Could not import this level file');
      } finally { event.target.value = ''; }
    });
    $('restoreWorldBtn').addEventListener('click', () => {
      if (confirm('Restore the nine-level starter campaign? This will replace your current levels.')) {
        this.gameManager.restoreStarterWorld((m) => this.toast(m));
      }
    });

    $('refreshLogsBtn')?.addEventListener('click', () => this.refreshDiagnostics());
    $('clearLogsBtn')?.addEventListener('click', () => {
      window.gameDiagnostics?.clear();
      this.refreshDiagnostics();
    });
    $('copyLogsBtn')?.addEventListener('click', async () => {
      const logs = window.gameDiagnostics?.getLogs() || 'Diagnostics are not initialized.';
      try {
        await navigator.clipboard.writeText(logs);
        this.toast('Application logs copied');
      } catch (error) {
        console.error('[diagnostics] clipboard copy failed', error);
        const field = $('diagnosticLog');
        field?.focus(); field?.select();
        this.toast('Copy unavailable · select the log text and copy it');
      }
    });

    document.querySelectorAll('.tile-tool').forEach((btn) => {
      btn.addEventListener('click', () => this.editor.setTool(btn.dataset.tool));
    });
  }

  refreshDiagnostics() {
    const field = $('diagnosticLog');
    if (!field) return;
    field.value = window.gameDiagnostics?.getLogs() || 'Diagnostics are not initialized yet.';
    field.scrollTop = field.scrollHeight;
  }

  setPaused(paused) {
    if (paused && !this.isPaused) this.pauseStartedAt = Date.now();
    if (!paused && this.isPaused && this.pauseStartedAt) {
      const pausedFor = Date.now() - this.pauseStartedAt;
      this.gameManager.levelStartedAt += pausedFor;
      this.gameManager.startedAt += pausedFor;
      if (this.gameManager.activePowerup) this.gameManager.powerupUntil += pausedFor;
      this.gameManager.onPauseDuration?.(pausedFor);
      this.pauseStartedAt = 0;
    }
    this.isPaused = paused;
    const overlay = $('pauseOverlay');
    if (overlay) overlay.hidden = !paused;
    const button = $('pauseBtn');
    if (button) button.textContent = paused ? '▶ Resume' : 'Ⅱ Pause';
    if (paused) document.exitPointerLock?.();
  }

  refreshShop() {
    this.wardrobeUI?.render();
    let worldOwned = false;
    try { worldOwned = localStorage.getItem('the-real-exit-quantum-annex-v1') === 'unlocked'; } catch { /* locked for this session */ }
    document.querySelectorAll('[data-world="quantum-annex"]').forEach((button) => {
      button.textContent = worldOwned ? 'Unlocked · find it in Levels' : `Unlock · ${Number(button.dataset.cost)} coins`;
      button.disabled = worldOwned;
    });
  }

  purchaseWorld(button) {
    const cost = Number(button.dataset.cost);
    if (!this.gameManager.spendCoins(cost)) { this.audio?.play('error'); this.toast(`You need ${cost} coins to unlock this chamber`); return; }
    try { localStorage.setItem('the-real-exit-quantum-annex-v1', 'unlocked'); } catch { /* chamber remains available for this session */ }
    this.audio?.play('buy');
    const level = this.gameManager.generateChallengeLevel();
    level.name = 'Quantum Annex';
    level.standalone = true;
    this.gameManager.saveWorld(false);
    this.gameManager.updateUI();
    this.refreshShop();
    this.toast('Quantum Annex unlocked · find it in Levels');
  }
}
