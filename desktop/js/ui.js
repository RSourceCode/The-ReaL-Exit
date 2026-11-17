/**
 * App Shell UI & Navigation Controller
 * Manages screen transitions, fullscreen focus, toasts, and settings panels.
 */

const $ = (id) => document.getElementById(id);

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
    this.mode = 'play';
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
    const page = ['play', 'build'].includes(requested) ? 'world' : requested;
    this.activePage = page;
    console.info(`[ui] page selected: ${requested}`);

    document.querySelectorAll('.app-page').forEach((node) => {
      node.classList.toggle('active', node.id === `${page}-page`);
    });
    document.querySelectorAll('.nav-btn[data-page]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.page === requested);
    });

    const labels = {
      ai: 'AI Lab',
      worlds: 'My Worlds',
      settings: 'Settings',
      build: 'World Editor',
      play: 'Play',
      home: 'Home',
      shop: 'Wardrobe',
      achievements: 'Achievements',
    };
    $('breadcrumb').textContent = labels[requested] || 'Home';

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
    if (this.onPageChanged) this.onPageChanged(requested);
  }

  _syncFullscreenLabel() {
    const btn = $('fullscreenBtn');
    if (btn) btn.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  }

  _bindEvents() {
    $('playBtn').addEventListener('click', () => this.showPage('play'));
    $('editBtn').addEventListener('click', () => this.showPage('build'));
    $('homePlayBtn').addEventListener('click', () => this.showPage('play'));
    $('recentPlayBtn').addEventListener('click', () => this.showPage('play'));
    $('homeBuildBtn').addEventListener('click', () => this.showPage('build'));
    $('libraryPlayBtn').addEventListener('click', () => this.showPage('play'));
    $('libraryBuildBtn').addEventListener('click', () => this.showPage('build'));

    document.querySelectorAll('.nav-btn[data-page]').forEach((btn) => {
      btn.addEventListener('click', () => this.showPage(btn.dataset.page));
    });
    document.querySelectorAll('[data-go]').forEach((btn) => {
      btn.addEventListener('click', () => this.showPage(btn.dataset.go));
    });

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
    $('menuBtn')?.addEventListener('click', () => this.showPage('home'));

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
    $('addLevelBtn').addEventListener('click', () => {
      this.gameManager.addCampaignLevel();
      this.toast(`${this.gameManager.world.name} added`);
    });
    $('generateChallengeBtn')?.addEventListener('click', () => {
      const level = this.gameManager.generateChallengeLevel();
      this.showPage('build');
      this.toast(`${level.name} generated · test it, then save or export`);
    });

    $('exportWorldBtn').addEventListener('click', () => this.gameManager.exportWorld());
    $('importWorldBtn')?.addEventListener('click', () => $('importWorldFile').click());
    $('importWorldFile')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const count = this.gameManager.importWorldData(JSON.parse(await file.text()));
        this.toast(`Imported ${count} level${count === 1 ? '' : 's'} · ready to edit`);
        this.showPage('build');
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
      button.textContent = worldOwned ? 'Unlocked · open My Worlds' : `Unlock · ${Number(button.dataset.cost)} coins`;
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
    this.toast('Quantum Annex unlocked · open My Worlds to play it');
  }
}
