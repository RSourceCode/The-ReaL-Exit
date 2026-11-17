/**
 * Wardrobe / shop page: browse looks, try them on a turntable Deeba, buy with coins and equip.
 */

import * as THREE from '../../node_modules/three/build/three.module.js';
import { createDeeba } from './character.js';
import { OUTFITS, SLOTS, outfitById } from './outfits.js';

const $ = (id) => document.getElementById(id);

export class WardrobeUI {
  constructor(wardrobe, gameManager, audio, toast) {
    this.wardrobe = wardrobe;
    this.game = gameManager;
    this.audio = audio;
    this.toast = toast;
    this.activeSlot = 'skin';
    this.trying = {};          // slot -> outfit id being previewed (not equipped)
    this.stage = null;
    wardrobe.onChange(() => this.render());
    this._initStage();
    this.render();
  }

  _initStage() {
    const host = $('wardrobeStage');
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 30);
    camera.position.set(0, 0.35, 4.3); camera.lookAt(0, 0.05, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x7a86a8, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(2, 3, 3); scene.add(key);
    const back = new THREE.DirectionalLight(0x7fe7ff, 2); back.position.set(-3, 2, -2); scene.add(back);
    const deeba = createDeeba(this.wardrobe.equipped);
    scene.add(deeba);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.85, 0.05, 48), new THREE.MeshStandardMaterial({ color: '#171b26', roughness: 0.3, metalness: 0.6, emissive: '#2fd0ff', emissiveIntensity: 0.15 }));
    disc.position.y = -0.55; scene.add(disc);
    this.stage = { renderer, scene, camera, deeba, host };
    let last = performance.now();
    const loop = (now) => {
      requestAnimationFrame(loop);
      const page = $('shop-page');
      if (!page?.classList.contains('active')) { last = now; return; }
      const r = host.getBoundingClientRect();
      if (r.width < 10) return;
      if (renderer.domElement.width !== Math.floor(r.width * renderer.getPixelRatio())) { renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      deeba.userData.update(dt, { speed01: 0, grounded: true, yaw: now * 0.0006 + 0.5, won: false });
      renderer.render(scene, camera);
    };
    requestAnimationFrame(loop);
  }

  _previewSet() {
    const eq = { ...this.wardrobe.equipped, ...this.trying };
    this.stage?.deeba.userData.setOutfit(eq);
  }

  _swatch(item) {
    if (item.slot === 'skin') return `<div class="swatch" style="background:radial-gradient(circle at 30% 25%, ${item.glow}, ${item.body} 55%, ${item.trim})"></div>`;
    return `<div class="swatch emoji">${item.icon || '✦'}</div>`;
  }

  render() {
    const tabs = $('wardrobeTabs'), grid = $('shopGrid');
    if (!tabs || !grid) return;
    if ($('shopWallet')) $('shopWallet').textContent = this.game.wallet;
    tabs.innerHTML = '';
    for (const slot of SLOTS) {
      const b = document.createElement('button');
      b.className = `chip${slot.id === this.activeSlot ? ' active' : ''}`; b.textContent = slot.label;
      b.addEventListener('click', () => { this.activeSlot = slot.id; this.audio.play('tick'); this.render(); });
      tabs.append(b);
    }
    grid.innerHTML = '';
    for (const item of OUTFITS.filter((o) => o.slot === this.activeSlot)) {
      const owned = this.wardrobe.isOwned(item.id), equipped = this.wardrobe.isEquipped(item.id), trying = this.trying[item.slot] === item.id;
      const card = document.createElement('article');
      card.className = `outfit-card${equipped ? ' equipped' : ''}${trying ? ' trying' : ''}${owned ? '' : ' locked'}`;
      const affordable = this.game.wallet >= item.cost;
      card.innerHTML = `${this._swatch(item)}<div class="info"><h3>${item.name}</h3><p>${item.blurb || ''}</p></div>`;
      const btn = document.createElement('button');
      btn.className = `tool ${equipped ? '' : owned ? 'primary' : affordable ? 'primary' : 'secondary'}`;
      btn.textContent = equipped ? 'Equipped' : owned ? 'Equip' : `◉ ${item.cost}`;
      btn.disabled = equipped || (!owned && !affordable);
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.activate(item); });
      card.append(btn);
      card.addEventListener('mouseenter', () => this.audio.play('hover'));
      card.addEventListener('click', () => { this.trying[item.slot] = item.id; this.audio.play('tick'); this._previewSet(); this.render(); });
      grid.append(card);
    }
    this._previewSet();
    const owned = OUTFITS.filter((o) => this.wardrobe.isOwned(o.id)).length;
    if ($('wardrobeCount')) $('wardrobeCount').textContent = `${owned} / ${OUTFITS.length} collected`;
  }

  activate(item) {
    if (!this.wardrobe.isOwned(item.id)) {
      const res = this.wardrobe.buy(item.id, this.game.wallet, (cost) => this.game.spendCoins(cost));
      if (!res.ok) { this.audio.play('error'); this.toast(`You need ${item.cost} coins for ${item.name}`); return; }
      this.audio.play('buy'); this.toast(`${item.name} unlocked`);
    }
    this.wardrobe.equip(item.id);
    delete this.trying[item.slot];
    this.audio.play('equip');
    this.render();
  }
}

export { outfitById };
