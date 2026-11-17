/**
 * Deeba's wardrobe: catalogue of looks, ownership and what is currently equipped.
 * Persisted in localStorage; coins are spent from the wallet that GameManager owns.
 */

const WARDROBE_KEY = 'deeba-wardrobe-v1';
const LEGACY_OWNED = 'the-real-exit-skins-v1';
const LEGACY_EQUIPPED = 'the-real-exit-equipped-skin-v1';

export const SLOTS = [
  { id: 'skin', label: 'Finish' },
  { id: 'hat', label: 'Headwear' },
  { id: 'face', label: 'Eyewear' },
  { id: 'neck', label: 'Neckwear' },
  { id: 'back', label: 'Back' },
];

export const OUTFITS = [
  // Finishes (body shell colours + glow)
  { id: 'pearl', slot: 'skin', name: 'Pearl', cost: 0, icon: '◐', body: '#eceff4', trim: '#1b1e27', glow: '#6fe7ff', blurb: 'The factory finish. Clean ceramic and a cool cyan glow.' },
  { id: 'coral', slot: 'skin', name: 'Signal Coral', cost: 0, icon: '◐', body: '#f37d52', trim: '#2c1510', glow: '#ffd49b', blurb: 'Warm enamel with a lab-beacon glow.' },
  { id: 'arctic', slot: 'skin', name: 'Arctic Alloy', cost: 8, icon: '◐', body: '#9fe6ee', trim: '#143240', glow: '#e9ffff', blurb: 'Frost-blue ceramic that stays cool under pressure.' },
  { id: 'violet', slot: 'skin', name: 'Night Shift', cost: 12, icon: '◐', body: '#8b74e8', trim: '#171230', glow: '#ff9fe8', blurb: 'Deep violet plating for late-shift explorers.' },
  { id: 'midnight', slot: 'skin', name: 'Midnight', cost: 16, icon: '◐', body: '#1d212b', trim: '#090a0f', glow: '#b99cff', blurb: 'Matte black with a soft ultraviolet pulse.' },
  { id: 'mint', slot: 'skin', name: 'Aurora Mint', cost: 20, icon: '◐', body: '#7de8c0', trim: '#0f3a33', glow: '#fff6a8', blurb: 'Northern-lights green with a golden core.' },
  { id: 'gold', slot: 'skin', name: 'Solid Gold', cost: 35, icon: '◐', body: '#e7b84a', trim: '#4a3210', glow: '#fff3b8', blurb: 'Polished, expensive and slightly smug.', metal: 0.85 },

  // Headwear
  { id: 'hat-none', slot: 'hat', name: 'Bare head', cost: 0, icon: '○', blurb: 'Nothing but antenna.' },
  { id: 'hat-sprout', slot: 'hat', name: 'Sprout', cost: 4, icon: '🌱', blurb: 'A tiny leaf that wobbles when you run.' },
  { id: 'hat-beanie', slot: 'hat', name: 'Beanie', cost: 6, icon: '🧢', color: '#ef6a5a', blurb: 'Soft knit with a pompom.' },
  { id: 'hat-tophat', slot: 'hat', name: 'Top Hat', cost: 14, icon: '🎩', color: '#16171d', blurb: 'For formal escapes.' },
  { id: 'hat-halo', slot: 'hat', name: 'Halo', cost: 18, icon: '😇', color: '#ffe38a', blurb: 'Floats, glows, judges lightly.' },
  { id: 'hat-crown', slot: 'hat', name: 'Crown', cost: 30, icon: '👑', color: '#ffcf4a', blurb: 'Rule the Skyway.' },

  // Eyewear
  { id: 'face-none', slot: 'face', name: 'Bare visor', cost: 0, icon: '○', blurb: 'Just the visor.' },
  { id: 'face-shades', slot: 'face', name: 'Cool Shades', cost: 7, icon: '🕶', color: '#0b0c10', blurb: 'Lasers look less scary through these.' },
  { id: 'face-goggles', slot: 'face', name: 'Flight Goggles', cost: 11, icon: '🥽', color: '#c98a3c', blurb: 'Brass rims, amber lenses.' },
  { id: 'face-heart', slot: 'face', name: 'Heart Lenses', cost: 13, icon: '💗', color: '#ff6fa6', blurb: 'Eyes full of heart.' },

  // Neckwear
  { id: 'neck-none', slot: 'neck', name: 'No accessory', cost: 0, icon: '○', blurb: '' },
  { id: 'neck-bow', slot: 'neck', name: 'Bow Tie', cost: 5, icon: '🎀', color: '#e8435a', blurb: 'Tiny and dapper.' },
  { id: 'neck-scarf', slot: 'neck', name: 'Cozy Scarf', cost: 9, icon: '🧣', color: '#ffb25a', blurb: 'Streams behind you as you sprint.' },
  { id: 'neck-cape', slot: 'neck', name: 'Hero Cape', cost: 18, icon: '🦸', color: '#d6314b', blurb: 'Flutters when you fall.' },

  // Back
  { id: 'back-none', slot: 'back', name: 'Nothing', cost: 0, icon: '○', blurb: '' },
  { id: 'back-pack', slot: 'back', name: 'Explorer Pack', cost: 8, icon: '🎒', color: '#4c9a78', blurb: 'Room for all those coins.' },
  { id: 'back-jet', slot: 'back', name: 'Glow Thrusters', cost: 22, icon: '🚀', color: '#8fa1b8', blurb: 'Puffs of light when you jump.' },
  { id: 'back-wings', slot: 'back', name: 'Light Wings', cost: 36, icon: '🪽', color: '#9be8ff', blurb: 'Translucent, shimmering, purely decorative.' },
];

export const DEFAULT_EQUIPPED = { skin: 'pearl', hat: 'hat-none', face: 'face-none', neck: 'neck-none', back: 'back-none' };

export function outfitById(id) { return OUTFITS.find((o) => o.id === id) || null; }

export class Wardrobe {
  constructor() {
    this.owned = new Set(OUTFITS.filter((o) => o.cost === 0).map((o) => o.id));
    this.equipped = { ...DEFAULT_EQUIPPED };
    this.listeners = [];
    this._load();
  }

  _load() {
    try {
      const saved = JSON.parse(localStorage.getItem(WARDROBE_KEY) || 'null');
      if (saved) {
        (saved.owned || []).forEach((id) => outfitById(id) && this.owned.add(id));
        Object.assign(this.equipped, saved.equipped || {});
      } else {
        // Carry over purchases from the old three-skin shop.
        const legacyOwned = JSON.parse(localStorage.getItem(LEGACY_OWNED) || '[]');
        legacyOwned.forEach((id) => outfitById(id) && this.owned.add(id));
        const legacy = localStorage.getItem(LEGACY_EQUIPPED);
        if (legacy && this.owned.has(legacy)) this.equipped.skin = legacy;
      }
    } catch { /* defaults */ }
    for (const slot of SLOTS) {
      const item = outfitById(this.equipped[slot.id]);
      if (!item || item.slot !== slot.id || !this.owned.has(item.id)) this.equipped[slot.id] = DEFAULT_EQUIPPED[slot.id];
    }
  }

  _save() {
    try { localStorage.setItem(WARDROBE_KEY, JSON.stringify({ owned: [...this.owned], equipped: this.equipped })); } catch { /* optional */ }
    this.listeners.forEach((fn) => fn(this));
  }

  onChange(fn) { this.listeners.push(fn); }
  isOwned(id) { return this.owned.has(id); }
  isEquipped(id) { const o = outfitById(id); return !!o && this.equipped[o.slot] === id; }

  /** Returns { ok, reason, cost }.  `spend(cost)` must deduct from the wallet and return true on success. */
  buy(id, wallet, spend) {
    const item = outfitById(id);
    if (!item) return { ok: false, reason: 'unknown' };
    if (this.owned.has(id)) return { ok: true, reason: 'owned', cost: 0 };
    if (wallet < item.cost) return { ok: false, reason: 'poor', cost: item.cost };
    if (!spend(item.cost)) return { ok: false, reason: 'failed', cost: item.cost };
    this.owned.add(id);
    this._save();
    return { ok: true, reason: 'bought', cost: item.cost };
  }

  equip(id) {
    const item = outfitById(id);
    if (!item || !this.owned.has(id)) return false;
    this.equipped[item.slot] = id;
    this._save();
    return true;
  }
}
