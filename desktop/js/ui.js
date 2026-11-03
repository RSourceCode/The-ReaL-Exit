/**
 * App Shell UI & Navigation Controller
 * Manages screen transitions, fullscreen focus, toasts, and settings panels.
 */

const $ = (id) => document.getElementById(id);

export class UIController {
  constructor(gameManager, cameraController, editor, onPageChanged) {
    this.gameManager = gameManager;
    this.cameraController = cameraController;
    this.editor = editor;
    this.onPageChanged = onPageChanged;

    this.activePage = 'home';
    this.mode = 'play';
    this.toastTimer = null;

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

    $('worldTitle').textContent = nextMode === 'play' ? this.gameManager.world.name : `Edit ${this.gameManager.world.name}`;
    $('worldDescription').textContent = nextMode === 'play'
      ? 'Press the plate, dodge the rotating bar, and cross the open door.'
      : 'Arrange walls, pressure plates, rotating bars, the exit door, and the starting tile.';
    $('worldEyebrow').textContent = nextMode === 'play'
      ? `CAMPAIGN · LEVEL ${this.gameManager.activeLevelIndex + 1} OF ${this.gameManager.campaignLevels.length}`
      : 'LEVEL EDITOR';

    $('modeCaption').textContent = nextMode === 'play'
      ? 'PLAY · WASD to move · ←/→ to turn · Space to jump'
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
        ? 'Mouse look · WASD move · Space jump · R restart.'
        : 'Drag to orbit · WASD move · Space jump · R restart.')
      : 'Drag to orbit · click the world to place · scroll to zoom.';
  }

  showPage(requested) {
    const page = ['play', 'build'].includes(requested) ? 'world' : requested;
    this.activePage = page;

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
    };
    $('breadcrumb').textContent = labels[requested] || 'Home';

    if (requested === 'play' || requested === 'build') {
      this.setMode(requested === 'build' ? 'edit' : 'play');
      document.body.classList.add('world-focus');
      document.body.classList.toggle('world-build-focus', requested === 'build');
      $('fullscreenBtn').textContent = 'Exit fullscreen';
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      }
    } else {
      document.body.classList.remove('world-focus', 'world-build-focus');
      $('fullscreenBtn').textContent = 'Enter fullscreen';
    }

    $('appMain').scrollTop = 0;
    if (this.onPageChanged) this.onPageChanged(requested);
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

    $('fullscreenBtn').addEventListener('click', async () => {
      if (document.body.classList.contains('world-focus')) {
        document.body.classList.remove('world-focus', 'world-build-focus');
        if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      } else {
        document.body.classList.add('world-focus');
        document.body.classList.toggle('world-build-focus', this.mode === 'edit');
        try {
          await document.documentElement.requestFullscreen();
        } catch {
          this.toast('Fullscreen view enabled');
        }
      }
      $('fullscreenBtn').textContent = document.body.classList.contains('world-focus') ? 'Exit fullscreen' : 'Enter fullscreen';
      this.cameraController.resize();
    });

    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) document.body.classList.remove('world-focus');
      document.body.classList.toggle('world-build-focus', this.mode === 'edit' && document.body.classList.contains('world-focus'));
      $('fullscreenBtn').textContent = document.body.classList.contains('world-focus') ? 'Exit fullscreen' : 'Enter fullscreen';
      this.cameraController.resize();
    });

    document.querySelectorAll('[data-settings-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-settings-tab]').forEach((tab) => tab.classList.toggle('active', tab === btn));
        document.querySelectorAll('[data-settings-content]').forEach((panel) => {
          panel.hidden = panel.dataset.settingsContent !== btn.dataset.settingsTab;
        });
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

    $('exportWorldBtn').addEventListener('click', () => this.gameManager.exportWorld());
    $('restoreWorldBtn').addEventListener('click', () => {
      if (confirm('Restore starter four-level campaign? This will replace your current levels.')) {
        this.gameManager.restoreStarterWorld((m) => this.toast(m));
      }
    });

    document.querySelectorAll('.tile-tool').forEach((btn) => {
      btn.addEventListener('click', () => this.editor.setTool(btn.dataset.tool));
    });
  }
}

