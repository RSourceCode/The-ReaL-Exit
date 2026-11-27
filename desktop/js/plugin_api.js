/**
 * Plugin API for The-ReaL-Exit  (window.TheRealExit)
 *
 *   api.plugins.register({ id, title, icon, description, mount(container, api), onShow(api), onHide(api) })
 *   api.levels   list / get / current / add / addValidated / load / play / remove / removeGenerated / exportJSON
 *                + backend helpers: schema / validate / features
 *   api.game     state() · stats(levelRef) · allStats() · on(event, fn) -> off
 *                events: levelLoaded, attemptStart, death, levelComplete, coin, plate, door, pageChanged
 *   api.bot      simulate(levels, opts) · collect(levels, opts)          (Python backend, headless bot play)
 *   api.dataset  stats / records / add / label / remove / export / download
 *   api.ext(plugin).call(route, body)                                    (plugin routes in backend/plugins)
 *   api.ui       toast / showPage / openPlugin / home
 *
 * Nothing in the game's own files needs to know about plugins: this module wraps the live GameManager / UIController.
 */

import { migrateLevel, boundaryWalls, worldDims, HALF_X, HALF_Z, GRID_SIZE } from './constants.js';
import { RLClient } from './rl_client.js';

export const API_VERSION = '1.0.0';
const $ = (id) => document.getElementById(id);
const clone = (v) => JSON.parse(JSON.stringify(v));

export function installPluginAPI({ gameManager: gm, ui, getPlayer = () => null }) {
  const backend = new RLClient();
  const post = (path, body = {}) => backend._request(path, 'POST', body);
  const listeners = new Map();
  const emit = (event, payload = {}) => (listeners.get(event) || []).slice().forEach((fn) => { try { fn(payload); } catch (e) { console.error(`[plugin] '${event}' listener failed`, e); } });
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => listeners.set(event, listeners.get(event).filter((f) => f !== fn));
  };

  // ── Level references: index (number) | id | name | undefined = the level being played ──────────
  const indexOf = (ref) => {
    if (ref === undefined || ref === null) return gm.activeLevelIndex;
    if (typeof ref === 'number') return ref;
    const i = gm.campaignLevels.findIndex((l) => l.id === ref || l.name === ref);
    return i;
  };
  const levelOf = (ref) => gm.campaignLevels[indexOf(ref)] || null;
  const levelKey = (level) => level.id || level.name;

  // ── Human play statistics (attempts, deaths, clear times per level) ────────────────────────────
  const stats = new Map();
  let attempt = null;
  const statFor = (level) => {
    const key = levelKey(level);
    if (!stats.has(key)) stats.set(key, { levelId: level.id, name: level.name, attempts: 0, deaths: 0, clears: 0, restarts: 0, bestTime: null, totalClearTime: 0, deathCauses: {}, history: [] });
    return stats.get(key);
  };
  const closeAttempt = (outcome, extra = {}) => {
    if (!attempt || attempt.closed) return;
    attempt.closed = true;
    const s = statFor(attempt.level);
    const seconds = (Date.now() - attempt.startedAt) / 1000;
    if (outcome === 'death') { s.deaths++; s.deathCauses[extra.cause] = (s.deathCauses[extra.cause] || 0) + 1; }
    else if (outcome === 'clear') { s.clears++; s.totalClearTime += seconds; s.bestTime = s.bestTime === null ? seconds : Math.min(s.bestTime, seconds); }
    else s.restarts++;
    s.history.push({ outcome, seconds: +seconds.toFixed(2), coins: gm.collected.size, ...extra });
    if (s.history.length > 50) s.history.shift();
  };
  const startAttempt = () => {
    closeAttempt('restart');
    attempt = { level: gm.world, startedAt: Date.now(), closed: false };
    statFor(gm.world).attempts++;
    emit('attemptStart', { levelId: gm.world.id, levelName: gm.world.name, attempt: statFor(gm.world).attempts });
  };

  const wrap = (name, fn) => { const orig = gm[name].bind(gm); gm[name] = (...args) => fn(orig, ...args); };
  wrap('loadCampaignLevel', (orig, i) => { orig(i); startAttempt(); emit('levelLoaded', { levelId: gm.world.id, levelName: gm.world.name, index: gm.activeLevelIndex }); });
  wrap('resetRun', (orig, ...a) => { orig(...a); startAttempt(); });
  wrap('kill', (orig, cause, toast) => {
    const before = gm.dying; orig(cause, toast);
    if (!before && gm.dying) { closeAttempt('death', { cause }); emit('death', { levelId: gm.world.id, levelName: gm.world.name, cause, deaths: statFor(gm.world).deaths }); }
  });
  wrap('winRun', (orig, toast) => {
    const seconds = (Date.now() - gm.levelStartedAt) / 1000, before = gm.won;
    orig(toast);
    if (!before && gm.won) {
      const s = statFor(gm.world);
      closeAttempt('clear');
      emit('levelComplete', { levelId: gm.world.id, levelName: gm.world.name, timeSeconds: +seconds.toFixed(2), stars: gm.rateRun(seconds), coins: gm.collected.size, coinsTotal: (gm.world.coins || []).length, attempts: s.attempts, deaths: s.deaths });
    }
  });
  wrap('updateGameplay', (orig, ...a) => {
    const coins = gm.collected.size, plates = gm.activatedPlates.size, door = gm.doorsOpen;
    const r = orig(...a);
    if (gm.collected.size > coins) emit('coin', { collected: gm.collected.size, total: (gm.world.coins || []).length });
    if (gm.activatedPlates.size !== plates) emit('plate', { pressed: gm.activatedPlates.size });
    if (gm.doorsOpen !== door) emit('door', { open: gm.doorsOpen });
    return r;
  });
  // Generated levels are not part of the saved campaign unless added with { persist: true }.
  wrap('saveWorld', (orig, ...a) => {
    const all = gm.campaignLevels;
    gm.campaignLevels = all.filter((l) => !l.ephemeral);
    try { return orig(...a); } finally { gm.campaignLevels = all; }
  });

  // ── Levels ────────────────────────────────────────────────────────────────────────────────────
  const levels = {
    list: () => gm.campaignLevels.map((l, index) => ({ index, id: l.id, name: l.name, width: worldDims(l).w, depth: worldDims(l).d, standalone: !!l.standalone, generated: !!l.ephemeral, record: gm.levelRecord(l) })),
    get: (ref) => { const l = levelOf(ref); return l ? clone(l) : null; },
    current: () => clone(gm.world),
    /** Add a level to the game (synchronous, client-side normalisation). Returns { index, id, name }. */
    add(level, { name, activate = true, play = false, standalone = true, persist = false, addBoundary = true } = {}) {
      if (!level || typeof level !== 'object') throw new Error('add(level): level must be an object');
      const lv = clone(level);
      const { w, d } = worldDims(lv);
      lv.width = w; lv.depth = d;
      lv.exitDoor ||= [w >> 1, d - 1];
      lv.start ||= [w >> 1, 2];
      if (!Array.isArray(lv.start) || lv.start.length !== 2) throw new Error('add(level): start must be [x, z]');
      migrateLevel(lv);
      if (addBoundary) {
        const have = new Set(lv.walls.map((c) => `${c[0]},${c[1]}`)), door = `${lv.exitDoor[0]},${lv.exitDoor[1]}`;
        lv.walls = lv.walls.filter((c) => `${c[0]},${c[1]}` !== door);
        for (const c of boundaryWalls(lv.exitDoor, lv.width, lv.depth)) if (!have.has(`${c[0]},${c[1]}`)) lv.walls.push(c);
      }
      lv.goal = [...lv.exitDoor];
      lv.id ||= `gen-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const taken = new Set(gm.campaignLevels.map((l) => l.name)), base = name || lv.name || 'Generated level';
      let unique = base, n = 2;
      while (taken.has(unique)) unique = `${base} #${n++}`;   // best times / coin rewards are keyed by name
      lv.name = unique; lv.standalone = standalone; lv.ephemeral = !persist;
      gm.campaignLevels.push(lv);
      const index = gm.campaignLevels.length - 1;
      if (persist) gm.saveWorld(false);
      if (activate || play) gm.loadCampaignLevel(index); else gm.refreshLevelNavigation();
      if (play) ui.showPage('play');
      return { index, id: lv.id, name: lv.name };
    },
    /** Validate on the Python backend first (throws with the list of errors), then add the normalised level. */
    async addValidated(level, opts = {}) {
      const res = await post('/api/levels/validate', { level, solve: !!opts.solve });
      if (!res.valid) throw new Error(`Invalid level: ${res.errors.join('; ')}`);
      if (opts.solve && !res.solvable) throw new Error('Level was not solved within the search budget');
      return { ...levels.add(res.level, opts), validation: res };
    },
    load(ref) { const i = indexOf(ref); if (!gm.campaignLevels[i]) throw new Error(`No such level: ${ref}`); gm.loadCampaignLevel(i); return i; },
    play(ref) { const i = levels.load(ref); ui.showPage('play'); return i; },
    remove(ref) {
      const i = indexOf(ref);
      if (!gm.campaignLevels[i] || gm.campaignLevels.length <= 1) return false;
      if (i === gm.activeLevelIndex) return gm.deleteLevel(i);
      gm.campaignLevels.splice(i, 1);
      if (i < gm.activeLevelIndex) gm.activeLevelIndex--;
      gm.saveWorld(false); gm.refreshLevelNavigation();
      return true;
    },
    removeGenerated() { let n = 0; for (let i = gm.campaignLevels.length - 1; i >= 0; i--) if (gm.campaignLevels[i].ephemeral && levels.remove(i)) n++; return n; },
    exportJSON: (ref) => JSON.stringify(levelOf(ref), null, 2),
    schema: () => backend._request('/api/levels/schema'),
    validate: (level, opts = {}) => post('/api/levels/validate', { level, ...opts }),
    features: (levelOrList) => post('/api/levels/features', Array.isArray(levelOrList) ? { levels: levelOrList } : { level: levelOrList }).then((r) => (Array.isArray(levelOrList) ? r.features : r.features[0])),
  };

  // ── Live game data ────────────────────────────────────────────────────────────────────────────
  const game = {
    on,
    state() {
      const w = gm.world, p = getPlayer(), coins = (w.coins || []).length, plates = (w.plates || []).length;
      const cell = p ? { x: p.x + HALF_X, z: p.z + HALF_Z } : null;
      let progress = gm.won ? 1 : 0;
      if (cell && !gm.won && w.start && w.exitDoor) {
        const total = Math.hypot(w.exitDoor[0] - w.start[0], w.exitDoor[1] - w.start[1]) || 1;
        progress = Math.max(0, Math.min(1, 1 - Math.hypot(w.exitDoor[0] - cell.x, w.exitDoor[1] - cell.z) / total));   // straight-line progress to the gate
      }
      const s = statFor(w);
      return {
        levelId: w.id, levelName: w.name, levelIndex: gm.activeLevelIndex, standalone: !!w.standalone,
        running: ui.activePage === 'world' && ui.mode === 'play' && !gm.won && !gm.dying,
        elapsedSeconds: +((Date.now() - gm.levelStartedAt) / 1000).toFixed(2), timeLimit: gm.timeLimit(),
        attempts: s.attempts, deaths: s.deaths, runDeaths: gm.runDeaths, moves: gm.moves,
        coins: { collected: gm.collected.size, total: coins }, plates: { pressed: gm.activatedPlates.size, total: plates },
        doorsOpen: gm.doorsOpen, leverOn: gm.leverActivated, powerup: gm.activePowerup, won: gm.won, dying: gm.dying, progress: +progress.toFixed(3),
        player: p ? { cellX: +cell.x.toFixed(2), cellZ: +cell.z.toFixed(2), height: +(p.jumpY || 0).toFixed(2), grounded: !!p.grounded, speed: +Math.hypot(p.vx || 0, p.vz || 0).toFixed(2) } : null,
      };
    },
    stats: (ref) => { const l = levelOf(ref); return l ? clone(statFor(l)) : null; },
    allStats: () => clone([...stats.values()]),
  };

  // ── Python backend: bot play (ETL) and dataset ──────────────────────────────────────────────────
  const asBody = (levels_, opts) => ({ ...(Array.isArray(levels_) ? { levels: levels_ } : { level: levels_ }), ...opts });
  const bot = {
    /** opts: { policy: 'auto'|'agent'|'solver'|'random', runs, maxAttempts, seed, explore, includeDetails } */
    simulate: (lv, opts = {}) => post('/api/levels/simulate', asBody(lv, opts)),
    /** One-call ETL: validate + features + bot play + store. opts add { label: 'Easy' | [labels], store: true } */
    collect: (lv, opts = {}) => post('/api/dataset/collect', asBody(lv, opts)),
  };
  const dataset = {
    stats: () => backend._request('/api/dataset/stats'),
    records: (opts = {}) => post('/api/dataset/records', opts),
    add: (records) => post('/api/dataset/add', { records }),
    label: (updates) => post('/api/dataset/label', { updates }),
    remove: (ids) => post('/api/dataset/delete', Array.isArray(ids) ? { ids } : { all: true }),
    export: (format = 'csv', label) => post('/api/dataset/export', { format, label }),
    async download(format = 'csv', label) {
      const out = await dataset.export(format, label);
      const url = URL.createObjectURL(new Blob([out.content], { type: format === 'csv' ? 'text/csv' : 'application/x-ndjson' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `the-real-exit-levels.${format}` });
      a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      return out.count;
    },
  };

  // ── UI / plugin pages ─────────────────────────────────────────────────────────────────────────
  const pages = new Map();
  let activePlugin = null;
  const origShowPage = ui.showPage.bind(ui);
  ui.showPage = (requested) => {
    const previous = activePlugin;
    origShowPage(requested);
    const entry = pages.get(requested);
    if (previous && previous !== requested) { try { pages.get(previous)?.plugin.onHide?.(api); } catch (e) { console.error(e); } }
    activePlugin = entry ? requested : null;
    if (entry) {
      $('breadcrumb').textContent = entry.plugin.title;
      try { entry.plugin.onShow?.(api); } catch (e) { console.error(`[plugin:${entry.plugin.id}] onShow failed`, e); }
    }
    emit('pageChanged', { page: requested });
  };
  const uiApi = { toast: (m) => ui.toast(m), showPage: (p) => ui.showPage(p), home: () => ui.showPage('home'), openPlugin: (id) => ui.showPage(`plugin-${id}`) };

  const plugins = {
    list: () => [...pages.values()].map((e) => e.plugin.id),
    register(plugin) {
      if (!plugin || !/^[a-z0-9-]+$/.test(plugin.id || '')) throw new Error("plugin.id is required (lowercase letters, digits and '-')");
      const key = `plugin-${plugin.id}`;
      if (pages.has(key)) throw new Error(`Plugin '${plugin.id}' is already registered`);
      plugin = { title: plugin.id, icon: '✚', description: '', ...plugin };
      const section = document.createElement('section');
      section.className = 'app-page plugin-page'; section.id = `${key}-page`;
      section.innerHTML = '<div class="page-heading"><div><div class="eyebrow">PLUGIN</div><h1></h1><p></p></div></div><div class="plugin-body"></div>';
      section.querySelector('h1').textContent = plugin.title;
      section.querySelector('p').textContent = plugin.description;
      document.querySelector('main.ui-content').append(section);
      const button = document.createElement('button');
      button.className = 'dock-btn'; button.dataset.plugin = plugin.id;
      button.innerHTML = '<i></i><span></span>';
      button.querySelector('i').textContent = plugin.icon; button.querySelector('span').textContent = plugin.title;
      button.addEventListener('click', () => ui.showPage(key));
      document.querySelector('#home-page .dock')?.append(button);
      pages.set(key, { plugin, section });
      try { plugin.mount?.(section.querySelector('.plugin-body'), api); }
      catch (e) { console.error(`[plugin:${plugin.id}] mount failed`, e); section.querySelector('.plugin-body').textContent = `Plugin failed to start: ${e.message}`; }
      return { page: key, container: section.querySelector('.plugin-body') };
    },
  };

  /** Load plugin modules: each entry is () => import('../plugins/x/index.js'); a module exports default (api) => {...} or register(api). */
  async function loadPlugins(loaders = []) {
    for (const load of loaders) {
      try { const mod = await load(); await (mod.default || mod.register)(api); }
      catch (e) { console.error('[plugin] failed to load', e); ui.toast(`A plugin failed to load: ${e.message}`); }
    }
  }

  const api = Object.freeze({ version: API_VERSION, plugins, levels, game, bot, dataset, ui: uiApi, ext: (plugin) => ({ call: (route, body = {}) => post(`/api/ext/${plugin}/${route}`, body) }), loadPlugins, GRID_SIZE });
  window.TheRealExit = api;
  return api;
}
