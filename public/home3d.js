// The landing page's 3D: a player with armor and held items (the profile example).
//
// The players are the dashboard's own model (public/player3d.js) in the game's real textures: default
// skins, armor, trims and items, served at /api/mc/ even outside a server (src/mcassets.js, serveHomeAsset).
// Loaded on demand by public/home.js.
import { buildModel, mountPlayer as mountModel } from '/player3d.js';

export function rng(seed) {
  let s = 0;
  for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

/* ================= what they wear and hold ================= */

// Items as the server mod reports them (src/gear.js), so public/player3d.js draws them just as on a
// player's page: { id, asset?, model?, texture?, glint?, trim? }. kind and name are for the caption.
const MATERIALS = [ // [item prefix, armor asset, name]
  ['leather', 'leather', 'Leather'], ['chainmail', 'chainmail', 'Chainmail'], ['iron', 'iron', 'Iron'],
  ['golden', 'gold', 'Golden'], ['diamond', 'diamond', 'Diamond'], ['netherite', 'netherite', 'Netherite'],
];
const PIECES = { head: 'helmet', chest: 'chestplate', legs: 'leggings', feet: 'boots' };
const LEATHER_NAMES = { helmet: 'Cap', chestplate: 'Tunic', leggings: 'Pants', boots: 'Boots' };
const TOOLS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];
// armor trims: the smithing template's pattern, colored by the ingredient's palette
export const TRIM_PATTERNS = ['coast', 'dune', 'eye', 'host', 'raiser', 'rib', 'sentry', 'shaper', 'silence', 'snout', 'spire', 'tide', 'vex', 'ward', 'wayfinder', 'wild', 'bolt', 'flow'];
export const TRIM_PALETTES = ['amethyst', 'copper', 'diamond', 'emerald', 'gold', 'iron', 'lapis', 'netherite', 'quartz', 'redstone', 'resin'];
// off hand: [id, name, how it's drawn (player3d.js: texture path or special model)]
const OFFHAND = [
  ['totem_of_undying', 'Totem of Undying'], ['shield', 'Shield', { special: 'shield' }], ['shield', 'Shield', { special: 'shield' }],
  ['golden_apple', 'Golden Apple'], ['azalea_leaves', 'Azalea Leaves', { texture: 'block/azalea_leaves' }],
  ['flowering_azalea_leaves', 'Flowering Azalea Leaves', { texture: 'block/flowering_azalea_leaves' }],
  ['bucket', 'Bucket'], ['water_bucket', 'Water Bucket'], ['lava_bucket', 'Lava Bucket'], ['shears', 'Shears'],
  ['ender_pearl', 'Ender Pearl'], ['bread', 'Bread'], null,
];
// What each kind of item can be enchanted with, as [name, level] in the order the game lists them.
// An enchanted item rolls a few of these; groups in [] exclude each other (only one is picked).
const ENCHANTS = {
  helmet: [[['Protection', 4], ['Blast Protection', 4], ['Projectile Protection', 4]], ['Respiration', 3], ['Aqua Affinity', 1], ['Unbreaking', 3], ['Mending', 1]],
  chestplate: [[['Protection', 4], ['Blast Protection', 4], ['Fire Protection', 4]], ['Thorns', 3], ['Unbreaking', 3], ['Mending', 1]],
  leggings: [[['Protection', 4], ['Blast Protection', 4]], ['Swift Sneak', 3], ['Unbreaking', 3], ['Mending', 1]],
  boots: [[['Protection', 4], ['Fire Protection', 4]], ['Feather Falling', 4], [['Depth Strider', 3], ['Frost Walker', 2]], ['Soul Speed', 3], ['Unbreaking', 3], ['Mending', 1]],
  sword: [['Sharpness', 5], ['Looting', 3], ['Fire Aspect', 2], ['Sweeping Edge', 3], ['Knockback', 2], ['Unbreaking', 3], ['Mending', 1]],
  axe: [['Sharpness', 5], ['Efficiency', 5], ['Unbreaking', 3], ['Mending', 1]],
  pickaxe: [['Efficiency', 5], [['Fortune', 3], ['Silk Touch', 1]], ['Unbreaking', 3], ['Mending', 1]],
  spear: [['Sharpness', 5], ['Lunge', 3], ['Knockback', 2], ['Unbreaking', 3], ['Mending', 1]],
  mace: [[['Density', 5], ['Breach', 4]], ['Wind Burst', 3], ['Fire Aspect', 2], ['Unbreaking', 3], ['Mending', 1]],
  shield: [['Unbreaking', 3], ['Mending', 1]],
};
function rollEnchants(r, kind) {
  const pool = ENCHANTS[kind];
  if (!pool) return [];
  const out = pool.map((e) => (Array.isArray(e[0]) ? pick(r, e) : e)).filter(() => r() < 0.7);
  return out.length ? out : [pool.map((e) => (Array.isArray(e[0]) ? e[0] : e))[0]];
}
// the game's name colors by rarity: common white, uncommon yellow, rare aqua, epic magenta.
// Enchanting a common or uncommon item makes it rare.
const RARITY = { totem_of_undying: 'uncommon', golden_apple: 'rare', enchanted_golden_apple: 'epic', mace: 'epic' };

const title = (s) => s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

// A random outfit, the same for the same seed: { armor: { head, chest, legs, feet }, mainhand, offhand }
export function rollGear(seed) {
  const r = rng(seed);
  // mostly late-game sets: diamond and netherite, some iron, the odd golden or chainmail piece
  const material = () => MATERIALS[pick(r, [1, 2, 2, 3, 4, 4, 4, 4, 5, 5, 5, 5])];
  const armor = {};
  // one trim for the whole set, as players tend to do; not every piece gets it
  const trim = r() < 0.6 ? { pattern: pick(r, TRIM_PATTERNS), palette: pick(r, TRIM_PALETTES) } : null;
  for (const [slot, kind] of Object.entries(PIECES)) {
    if (r() >= 0.95) continue;
    const [prefix, asset, label] = material();
    const piece = { id: `${prefix}_${kind}`, asset, kind, glint: r() < 0.7, name: `${label} ${prefix === 'leather' ? LEATHER_NAMES[kind] : title(kind)}` };
    // a trim the same color as its armor would vanish, so the game uses a darker shade there
    if (trim && r() < 0.85) piece.trim = { pattern: trim.pattern, palette: trim.palette === asset ? `${asset}_darker` : trim.palette };
    if (asset === 'leather') piece.dye = pick(r, [0xa06540, 0x3c44aa, 0xb02e26, 0x5e7c16, 0xf9801d, 0x1d1d21]);
    armor[slot] = piece;
  }
  const kind = pick(r, ['sword', 'sword', 'sword', 'spear', 'spear', 'mace', 'axe', 'pickaxe']);
  let mainhand;
  if (kind === 'mace') mainhand = { id: 'mace', kind, glint: r() < 0.6, name: 'Mace' };
  else {
    const tier = pick(r, [2, 3, 4, 4, 4, 5, 5, 5].map((i) => TOOLS[i]));
    mainhand = { id: `${tier}_${kind}`, kind, glint: r() < 0.5, name: `${title(tier)} ${title(kind)}` };
  }
  const off = pick(r, OFFHAND);
  let offhand = off && { id: off[0], kind: off[0], glint: false, name: off[1], ...off[2] };
  if (off?.[0] === 'golden_apple' && r() < 0.3) offhand = { id: 'enchanted_golden_apple', model: 'golden_apple', kind: 'golden_apple', glint: true, name: 'Enchanted Golden Apple' };
  if (off?.[0] === 'shield' && r() < 0.3) offhand.glint = true;
  for (const item of [...Object.values(armor), mainhand, offhand]) {
    if (!item) continue;
    if (item.glint && item.id !== 'enchanted_golden_apple') item.enchants = rollEnchants(r, item.kind);
    const base = RARITY[item.id] ?? 'common';
    item.rarity = item.enchants?.length && (base === 'common' || base === 'uncommon') ? 'rare' : base;
  }
  return { armor, mainhand, offhand };
}

// mountPlayer(container) -> { show(spec), dispose() }: the player page's own model (public/player3d.js),
// swapped for another player's on show(). spec is player3d's: { name, skin, armor, mainhand, offhand }.
// Builds a model and throws it away: its skin and textures are then in player3d.js's image cache, so the
// real one is built without waiting on the network.
export function warm(spec) {
  const made = [];
  return buildModel(spec, (x) => (made.push(x), x))
    .then(() => made.forEach((x) => x.dispose?.()), () => {});
}

export function mountPlayer(container) {
  let current = null, token = 0;
  return {
    async show(spec) {
      const mine = ++token;
      const next = await mountModel(container, spec);
      if (mine !== token) { next.dispose(); return; }
      current?.dispose(); // the new one is already drawn on top, so there's no gap
      current = next;
    },
    pick: (x, y) => current?.pick(x, y) ?? null,
    dispose() { token++; current?.dispose(); current = null; },
  };
}
