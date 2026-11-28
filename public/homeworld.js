// The little world of the landing page's Liveview example (public/homelive.js): its blocks, the three places
// it's made of (the overworld by Birchwood's spawn, a corner of the Nether, an End island), their light, and
// the meshes that draw them. Nothing here is a real server's: every block is placed by the code below, the
// same way each time.
//
// Textures are the game's own (/api/mc/textures/block/…, the few src/mcassets.js serves to the landing page),
// packed into one sheet the way Liveview packs its atlas: unpremultiplied pixels, nearest filtering, no
// colour conversion. A texture that doesn't load is a flat colour instead, so the world still draws.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

/* ---------------- blocks ---------------- */

const GRASS = 0x93c25e, OAK = 0x77ab2f, BIRCH = 0x80a755, WATER = 0x3f76e4;
// kind: solid (a full cube that hides what's behind it), cutout (a cube with holes: leaves, glass),
// cross (two crossed panes: plants, a torch), fluid (water, lava), pane (the portal)
export const DEFS = [{ name: 'air', kind: 'air', light: 0 }];
export const B = { air: 0 };
function def(name, tex, o = {}) {
  const t = typeof tex === 'string' ? { top: tex, bottom: tex, side: tex } : tex;
  B[name] = DEFS.length;
  DEFS.push({ name, kind: 'solid', light: 0, ...t, ...o });
}
def('grass', { top: 'grass_block_top', bottom: 'dirt', side: 'grass_side' }, { tintTop: GRASS, label: 'Grass Block' });
def('dirt', 'dirt');
def('stone', 'stone');
def('cobblestone', 'cobblestone');
def('mossy_cobblestone', 'mossy_cobblestone');
def('gravel', 'gravel');
def('sand', 'sand');
def('deepslate', 'deepslate');
def('bedrock', 'bedrock');
def('coal_ore', 'coal_ore');
def('iron_ore', 'iron_ore');
def('diamond_ore', 'diamond_ore');
def('deepslate_diamond_ore', 'deepslate_diamond_ore');
def('oak_log', { top: 'oak_log_top', bottom: 'oak_log_top', side: 'oak_log' });
def('birch_log', { top: 'birch_log_top', bottom: 'birch_log_top', side: 'birch_log' });
def('oak_leaves', 'oak_leaves', { kind: 'cutout', tint: OAK, glow: 1.2 });
def('birch_leaves', 'birch_leaves', { kind: 'cutout', tint: BIRCH, glow: 1.2 });
def('oak_planks', 'oak_planks');
def('spruce_planks', 'spruce_planks');
def('stone_bricks', 'stone_bricks');
def('glass', 'glass', { kind: 'cutout' });
def('bookshelf', { top: 'oak_planks', bottom: 'oak_planks', side: 'bookshelf' });
def('crafting_table', { top: 'crafting_table_top', bottom: 'oak_planks', side: 'crafting_table_side', front: 'crafting_table_front' });
def('furnace', { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front_on' }, { light: 13 });
def('barrel', { top: 'barrel_top', bottom: 'barrel_bottom', side: 'barrel_side' });
def('farmland', { top: 'farmland_moist', bottom: 'dirt', side: 'dirt' });
def('path', { top: 'dirt_path_top', bottom: 'dirt', side: 'dirt_path_side' });
def('hay', { top: 'hay_block_top', bottom: 'hay_block_top', side: 'hay_block_side' });
def('pumpkin', { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side' });
def('jack_o_lantern', { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side', front: 'jack_o_lantern' }, { light: 15 });
def('obsidian', 'obsidian');
def('white_wool', 'white_wool');
def('water', 'water_still', { kind: 'fluid', tint: WATER });
def('wheat', 'wheat_stage7', { kind: 'cross' });
def('poppy', 'poppy', { kind: 'cross' });
def('dandelion', 'dandelion', { kind: 'cross' });
def('cornflower', 'cornflower', { kind: 'cross' });
def('short_grass', 'short_grass', { kind: 'cross', tint: GRASS });
def('torch', 'torch', { kind: 'cross', light: 14 });
def('portal', 'nether_portal', { kind: 'pane', light: 11 });
def('netherrack', 'netherrack');
def('nether_quartz_ore', 'nether_quartz_ore');
def('nether_gold_ore', 'nether_gold_ore');
def('soul_sand', 'soul_sand');
def('nether_bricks', 'nether_bricks');
def('glowstone', 'glowstone', { light: 15 });
def('magma', 'magma', { light: 3 });
def('lava', 'lava_still', { kind: 'fluid', light: 15 });
def('crimson_stem', { top: 'crimson_stem_top', bottom: 'crimson_stem_top', side: 'crimson_stem' });
def('nether_wart_block', 'nether_wart_block');
def('crimson_nylium', { top: 'crimson_nylium', bottom: 'netherrack', side: 'crimson_nylium_side' });
def('shroomlight', 'shroomlight', { light: 15 });
def('end_stone', 'end_stone');
def('end_stone_bricks', 'end_stone_bricks');
def('purpur', 'purpur_block');
def('purpur_pillar', { top: 'purpur_pillar_top', bottom: 'purpur_pillar_top', side: 'purpur_block' });

const opaque = (id) => DEFS[id].kind === 'solid';
export const blockName = (id) => DEFS[id].label || DEFS[id].name.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/* ---------------- the texture sheet ---------------- */

// what a tile is when its texture didn't load
const FLAT = {
  grass_block_top: '#7fae55', grass_side: '#8a6a45', dirt: '#866043', stone: '#7d7d7d', cobblestone: '#7a7a7a', mossy_cobblestone: '#6f7d62',
  gravel: '#837f7e', sand: '#dbcfa3', deepslate: '#4f4f52', bedrock: '#555', coal_ore: '#6d6d6d', iron_ore: '#8a7f77', diamond_ore: '#7c9a99',
  deepslate_diamond_ore: '#53706f', oak_log: '#6b5433', oak_log_top: '#b08e5a', birch_log: '#d7d3cb', birch_log_top: '#c0ae78', oak_leaves: '#9a9a9a',
  birch_leaves: '#9a9a9a', oak_planks: '#a2824e', spruce_planks: '#72552f', stone_bricks: '#7a7a7a', glass: '#c7e3ea', bookshelf: '#8a6b3d',
  crafting_table_top: '#7b5a35', crafting_table_side: '#8a6b3d', crafting_table_front: '#8a6b3d', furnace_front_on: '#7a6a5a', furnace_side: '#6f6f6f',
  furnace_top: '#6a6a6a', barrel_top: '#8a6a40', barrel_side: '#7d5f36', barrel_bottom: '#7d5f36', farmland_moist: '#51331a', wheat_stage7: '#c9a640',
  dirt_path_top: '#94793f', dirt_path_side: '#866043', hay_block_side: '#b79a18', hay_block_top: '#b59d1e', pumpkin_side: '#c67616', pumpkin_top: '#b56c12',
  jack_o_lantern: '#d68a1e', obsidian: '#15101f', white_wool: '#e9ecec', water_still: '#bcbcbc', poppy: '#c62b23', dandelion: '#f5d43a',
  cornflower: '#4c6fd6', short_grass: '#a8a8a8', torch: '#f5c84a', nether_portal: '#7b2fd0', netherrack: '#6e3533', nether_quartz_ore: '#7d4b46',
  nether_gold_ore: '#7d5236', soul_sand: '#51402f', nether_bricks: '#2d1619', glowstone: '#ab8654', magma: '#8e4517', lava_still: '#d4631a',
  crimson_stem: '#5c2d40', crimson_stem_top: '#70333f', nether_wart_block: '#730302', crimson_nylium: '#831f1f', crimson_nylium_side: '#782c2b',
  shroomlight: '#f1924a', end_stone: '#dbde9e', end_stone_bricks: '#dae0a2', purpur_block: '#a97da9', purpur_pillar_top: '#aa7faa',
};
const ANIMATED = { water_still: 2, lava_still: 3, nether_portal: 1 }; // game ticks per frame
const TILE = 16, COLS = 16;

// Same decode Liveview uses for the game's atlas: no premultiplied alpha, no colour-space conversion,
// so a flower's transparent pixels stay transparent and a dark block keeps its real pixels.
const loadImage = async (url) => {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
  } catch {
    return null;
  }
};

// -> { texture, uv(name) -> [col, row], tick(seconds) } once every texture is in (or has failed)
export async function loadAtlas() {
  const names = new Set();
  for (const d of DEFS) for (const k of ['top', 'bottom', 'side', 'front']) if (d[k]) names.add(d[k]);
  const list = [...names];
  const files = new Set(list.map((n) => (n === 'grass_side' ? 'grass_block_side' : n)));
  files.add('grass_block_side_overlay');
  const images = new Map(await Promise.all([...files].map(async (f) => [f, await loadImage(`/api/mc/textures/block/${f}.png`)])));
  const missing = [...images.values()].filter((img) => !img).length;

  const canvas = document.createElement('canvas');
  canvas.width = COLS * TILE;
  canvas.height = Math.ceil(list.length / COLS) * TILE;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = false;
  const where = new Map(list.map((n, i) => [n, [i % COLS, Math.floor(i / COLS)]]));
  const animated = [];

  const flat = (name, x, y) => {
    g.fillStyle = FLAT[name] || '#888';
    g.fillRect(x, y, TILE, TILE);
    // a little grain, so a flat tile still reads as a block
    for (let i = 0; i < 40; i++) {
      g.fillStyle = i % 2 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)';
      g.fillRect(x + ((i * 7) % TILE), y + ((i * 11 + (i >> 2)) % TILE), 1, 1);
    }
  };
  const draw = (name, frame = 0) => {
    const [cx, cy] = where.get(name), x = cx * TILE, y = cy * TILE;
    g.clearRect(x, y, TILE, TILE);
    const img = images.get(name === 'grass_side' ? 'grass_block_side' : name);
    if (!img) return flat(name, x, y);
    const frames = Math.max(1, Math.floor(img.height / img.width));
    g.drawImage(img, 0, (frame % frames) * img.width, img.width, img.width, x, y, TILE, TILE);
    if (name === 'grass_side') {
      // the grey fringe of grass over the dirt, in the grass's colour
      const over = images.get('grass_block_side_overlay');
      if (!over) return;
      const tmp = document.createElement('canvas');
      tmp.width = tmp.height = TILE;
      const t = tmp.getContext('2d');
      t.drawImage(over, 0, 0, TILE, TILE);
      t.globalCompositeOperation = 'multiply';
      t.fillStyle = `#${GRASS.toString(16).padStart(6, '0')}`;
      t.fillRect(0, 0, TILE, TILE);
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(over, 0, 0, TILE, TILE);
      g.drawImage(tmp, x, y);
    }
  };
  for (const name of list) {
    draw(name);
    const img = images.get(name);
    if (ANIMATED[name] && img && img.height > img.width) animated.push({ name, every: ANIMATED[name] / 20, at: 0, frame: 0 });
  }

  // The canvas stays the texture, so water, lava and the portal can repaint a frame onto it.
  // flipY stays on, matching the UVs (v = 1 − canvas y): the top of a grass tile stays the top of the block.
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.premultiplyAlpha = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return {
    texture, missing, size: [canvas.width, canvas.height],
    uv: (name) => where.get(name),
    // water, lava and the portal move
    tick(dt) {
      let changed = false;
      for (const a of animated) {
        a.at += dt;
        if (a.at < a.every) continue;
        a.frame += Math.floor(a.at / a.every);
        a.at %= a.every;
        draw(a.name, a.frame);
        changed = true;
      }
      if (changed) texture.needsUpdate = true;
    },
  };
}

/* ---------------- a place: a box of blocks ---------------- */

const hash2 = (x, z, seed) => {
  let h = (x * 374761393 + z * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const hash3 = (x, y, z, seed) => hash2(x + y * 131, z - y * 71, seed);
const smooth = (t) => t * t * (3 - 2 * t);
function noise(x, z, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z), fx = smooth(x - x0), fz = smooth(z - z0);
  const a = hash2(x0, z0, seed), b = hash2(x0 + 1, z0, seed), c = hash2(x0, z0 + 1, seed), d = hash2(x0 + 1, z0 + 1, seed);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

class Place {
  constructor(sx, sy, sz) {
    this.sx = sx; this.sy = sy; this.sz = sz;
    this.blocks = new Uint8Array(sx * sy * sz);
    this.ground = new Int16Array(sx * sz).fill(-1); // the block walked on in each column, -1 where nothing is
    this.blocked = new Uint8Array(sx * sz); // where nobody walks: water, trees, walls, crops
    this.barrels = [];
  }
  inside(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz; }
  get(x, y, z) { return this.inside(x, y, z) ? this.blocks[(y * this.sz + z) * this.sx + x] : 0; }
  set(x, y, z, id) { if (this.inside(x, y, z)) this.blocks[(y * this.sz + z) * this.sx + x] = id; }
  fill(x0, y0, z0, x1, y1, z1, id) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, id);
  }
  block(x, z, on = 1) { if (x >= 0 && z >= 0 && x < this.sx && z < this.sz) this.blocked[z * this.sx + x] = on; }
  blockRect(x0, z0, x1, z1) { for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.block(x, z); }
  groundAt(x, z) { return x >= 0 && z >= 0 && x < this.sx && z < this.sz ? this.ground[z * this.sx + x] : -1; }
  // somewhere a player or a sheep can stand
  walkable(x, z) { return this.groundAt(x, z) >= 0 && !this.blocked[z * this.sx + x]; }
  // the top of the highest block in a column, for the camera
  top(x, z) {
    for (let y = this.sy - 1; y >= 0; y--) if (this.get(x, y, z)) return y + 1;
    return 0;
  }
}

/* ---------------- the overworld: Birchwood's spawn ---------------- */

function tree(w, x, z, y, kind, r) {
  const log = kind === 'birch' ? B.birch_log : B.oak_log, leaves = kind === 'birch' ? B.birch_leaves : B.oak_leaves;
  const tall = (kind === 'birch' ? 5 : 4) + Math.floor(r() * 2);
  const top = y + tall;
  for (let dy = -2; dy <= 1; dy++) {
    const wide = dy < 0 ? 2 : 1;
    for (let dz = -wide; dz <= wide; dz++) {
      for (let dx = -wide; dx <= wide; dx++) {
        const corner = Math.abs(dx) === wide && Math.abs(dz) === wide;
        if (corner && (dy === 1 || r() < 0.5)) continue;
        if (!w.get(x + dx, top + dy, z + dz)) w.set(x + dx, top + dy, z + dz, leaves);
      }
    }
  }
  for (let i = 0; i < tall; i++) w.set(x, y + i, z, log);
  w.block(x, z);
}

function overworld() {
  const N = 80, w = new Place(N, 44, N);
  const WL = 11; // the pond's surface
  const POND = [18, 59, 9.5], HILL = [61, 17, 19];
  const flat = [[40, 40, 13], [57, 47, 7]]; // the village and the big oak: level ground
  const height = (x, z) => {
    let h = 15 + (noise(x / 21, z / 21, 3) - 0.5) * 6 + (noise(x / 8, z / 8, 9) - 0.5) * 2.4;
    const dh = Math.hypot(x - HILL[0], z - HILL[1]) / HILL[2];
    if (dh < 1) h += smooth(1 - dh) * 12;
    for (const [fx, fz, fr] of flat) {
      const d = Math.hypot(x - fx, z - fz) / fr;
      if (d < 1.5) h += (14 - h) * smooth(clamp((1.5 - d) * 2, 0, 1));
    }
    h = Math.max(h, 12.4);
    const dp = Math.hypot(x - POND[0], z - POND[1]) / POND[2];
    if (dp < 1.25) h += (7.5 - h) * smooth(clamp((1.25 - dp) * 2.2, 0, 1));
    return Math.round(h);
  };
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const g = height(x, z);
      const shore = g <= WL + 1, rocky = g >= 22 || (g >= 20 && hash2(x, z, 5) < 0.45);
      for (let y = 0; y <= g; y++) {
        let id;
        if (y === 0) id = B.bedrock;
        else if (y < 4) id = hash3(x, y, z, 21) < 0.022 ? B.deepslate_diamond_ore : B.deepslate;
        else if (y < g - 3 || rocky) {
          const r = hash3(x, y, z, 22);
          id = r < 0.03 ? B.coal_ore : r < 0.05 ? B.iron_ore : r < 0.056 && y < 9 ? B.diamond_ore : rocky && r > 0.9 ? B.cobblestone : rocky && r > 0.86 ? B.gravel : B.stone;
        } else if (shore) id = y === g && g < WL - 2 && hash2(x, z, 6) < 0.35 ? B.gravel : B.sand;
        else id = y === g ? B.grass : B.dirt;
        w.set(x, y, z, id);
      }
      for (let y = g + 1; y <= WL; y++) w.set(x, y, z, B.water);
      w.ground[z * N + x] = g;
      if (g < WL) w.block(x, z);
    }
  }
  const G = 14; // the village's ground

  // the paths: a cross through the plaza, out to each door, the farm and the portal
  const path = (x0, z0, x1, z1) => {
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) if (w.get(x, w.groundAt(x, z), z) === B.grass) w.set(x, w.groundAt(x, z), z, B.path);
  };
  path(33, 40, 56, 41); path(40, 36, 41, 48); path(47, 39, 47, 40); path(36, 36, 39, 36); path(56, 42, 58, 46);

  // the oak house: cobble footing, plank walls, glass, a spruce roof; inside, what a base starts with
  const house = (x0, z0, x1, z1, wall, corner, door) => {
    w.fill(x0, G, z0, x1, G, z1, B.oak_planks);
    for (let y = G + 1; y <= G + 3; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const edgeX = x === x0 || x === x1, edgeZ = z === z0 || z === z1;
          if (!edgeX && !edgeZ) continue;
          const mid = (edgeZ && x > x0 + 1 && x < x1 - 1) || (edgeX && z > z0 + 1 && z < z1 - 1);
          w.set(x, y, z, edgeX && edgeZ ? corner : y === G + 1 ? B.cobblestone : y === G + 2 && mid ? B.glass : wall);
        }
      }
    }
    for (let k = 0; x0 - 1 + k <= x1 + 1 - k && z0 - 1 + k <= z1 + 1 - k; k++) {
      w.fill(x0 - 1 + k, G + 4 + k, z0 - 1 + k, x1 + 1 - k, G + 4 + k, z1 + 1 - k, B.spruce_planks);
      // hollow under the roof, so it's a room and not a block of wood
      if (k > 0 && x0 + k <= x1 - k && z0 + k <= z1 - k) w.fill(x0 + k, G + 3 + k, z0 + k, x1 - k, G + 3 + k, z1 - k, B.air);
    }
    w.set(door[0], G + 1, door[1], B.air);
    w.set(door[0], G + 2, door[1], B.air);
    w.blockRect(x0 - 1, z0 - 1, x1 + 1, z1 + 1);
  };
  house(44, 33, 50, 38, B.oak_planks, B.oak_log, [47, 38]);
  w.set(45, G + 1, 34, B.crafting_table); w.set(46, G + 1, 34, B.furnace); w.set(49, G + 1, 34, B.bookshelf); w.set(49, G + 2, 34, B.bookshelf);
  w.set(49, G + 1, 35, B.barrel); w.barrels.push({ x: 49, y: G + 1, z: 35, name: 'Pebble_’s barrel', kind: 'home' });
  w.set(45, G + 3, 36, B.torch);
  house(30, 34, 35, 38, B.stone_bricks, B.birch_log, [35, 36]);
  w.set(31, G + 1, 35, B.crafting_table); w.set(31, G + 1, 37, B.hay); w.set(32, G + 3, 36, B.torch);

  // the plaza: the community barrel everyone keeps taking from, and torches at its corners
  w.set(42, G + 1, 42, B.barrel); w.barrels.push({ x: 42, y: G + 1, z: 42, name: 'Community barrel', kind: 'community' });
  w.block(42, 42);
  for (const [x, z] of [[39, 39], [42, 39], [39, 42], [48, 42], [34, 39], [55, 43]]) { w.set(x, G + 1, z, B.torch); w.block(x, z); }

  // the farm: wheat either side of a channel, hay, and the pumpkins nobody picked
  w.fill(29, G, 44, 37, G, 50, B.farmland);
  for (let x = 29; x <= 37; x++) for (let z = 44; z <= 50; z++) if (z === 47) w.set(x, G, z, B.water); else w.set(x, G + 1, z, B.wheat);
  for (let x = 28; x <= 38; x++) for (const z of [43, 51]) w.set(x, G, z, B.oak_log);
  for (let z = 43; z <= 51; z++) for (const x of [28, 38]) w.set(x, G, z, B.oak_log);
  w.blockRect(29, 44, 37, 50);
  w.set(39, G + 1, 45, B.hay); w.set(39, G + 1, 46, B.hay); w.set(39, G + 2, 45, B.hay); w.block(39, 45); w.block(39, 46);
  w.set(27, G + 1, 47, B.pumpkin); w.set(27, G + 1, 45, B.jack_o_lantern); w.set(26, G + 1, 49, B.pumpkin);
  for (const [x, z] of [[27, 47], [27, 45], [26, 49]]) w.block(x, z);

  // the big oak, and the portal next to it
  for (let y = G + 1; y <= G + 10; y++) w.fill(53, y, 46, 54, y, 47, B.oak_log);
  for (let y = G + 7; y <= G + 14; y++) {
    const r = y < G + 9 ? 3.4 : y < G + 12 ? 5.3 : y < G + 14 ? 3.8 : 2.2;
    for (let z = 41; z <= 53; z++) for (let x = 48; x <= 60; x++) {
      if (Math.hypot(x - 54, z - 47) + hash3(x, y, z, 31) * 1.3 < r && !w.get(x, y, z)) w.set(x, y, z, B.oak_leaves);
    }
  }
  w.blockRect(53, 46, 54, 47);
  w.fill(58, G + 1, 49, 61, G + 5, 49, B.obsidian);
  w.fill(59, G + 2, 49, 60, G + 4, 49, B.portal);
  w.blockRect(58, 49, 61, 49);
  w.portal = { x: 59.9, z: 48.2, back: [59.9, 47.2], facing: 0 };

  // a little digging on the hill: cobble, a torch, the ore someone hasn't mined yet
  for (const [x, z] of [[55, 22], [57, 24], [60, 26]]) {
    const g = w.groundAt(x, z);
    w.set(x, g, z, B.cobblestone); w.set(x, g + 1, z, B.torch); w.block(x, z);
  }
  for (const [x, z, id] of [[58, 21, B.coal_ore], [59, 21, B.coal_ore], [62, 23, B.iron_ore], [63, 22, B.iron_ore], [56, 19, B.mossy_cobblestone]]) w.set(x, w.groundAt(x, z), z, id);

  // birches and a few oaks, then grass and flowers
  const r = (() => { let s = 12345; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); })();
  const trunks = [];
  for (let i = 0; i < 900 && trunks.length < 46; i++) {
    const x = 3 + Math.floor(r() * (N - 6)), z = 3 + Math.floor(r() * (N - 6)), g = w.groundAt(x, z);
    if (w.get(x, g, z) !== B.grass || w.blocked[z * N + x] || w.get(x, g + 1, z)) continue;
    if (Math.hypot(x - 40, z - 40) < 13 || Math.hypot(x - 56, z - 47) < 9 || (x > 24 && x < 42 && z > 40 && z < 54)) continue;
    if (trunks.some(([tx, tz]) => Math.abs(tx - x) < 4 && Math.abs(tz - z) < 4)) continue;
    trunks.push([x, z]);
    tree(w, x, z, g + 1, r() < 0.72 ? 'birch' : 'oak', r);
  }
  for (let z = 1; z < N - 1; z++) {
    for (let x = 1; x < N - 1; x++) {
      const g = w.groundAt(x, z);
      if (w.get(x, g, z) !== B.grass || w.get(x, g + 1, z)) continue;
      const v = hash2(x, z, 77);
      if (v < 0.11) w.set(x, g + 1, z, B.short_grass);
      else if (v < 0.122) w.set(x, g + 1, z, B.poppy);
      else if (v < 0.136) w.set(x, g + 1, z, B.dandelion);
      else if (v < 0.144) w.set(x, g + 1, z, B.cornflower);
    }
  }
  return Object.assign(w, {
    name: 'Overworld', sky: true, ambient: 0, fog: [58, 128], skyColor: 0x9fc3f5,
    origin: [88, 50, -378], // what the corner of the box is called in the game's coordinates
    spawn: [43.5, 40.5], centre: [42, 17, 42], orbit: [27, 13],
  });
}

/* ---------------- a corner of the Nether ---------------- */

function nether() {
  const N = 48, w = new Place(N, 30, N);
  const LAVA = 6;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const lake = Math.hypot(x - 13, z - 33) / 12;
      let g = Math.round(8 + (noise(x / 9, z / 9, 41) - 0.5) * 5 + (noise(x / 4, z / 4, 42) - 0.5) * 1.6);
      if (lake < 1.3) g = Math.round(g + (3 - g) * smooth(clamp((1.3 - lake) * 2, 0, 1)));
      if (Math.hypot(x - 28, z - 22) < 6) g = 8; // level ground round the portal
      const crimson = Math.hypot(x - 36, z - 34) < 9 && g >= LAVA;
      for (let y = 0; y <= g; y++) {
        const r = hash3(x, y, z, 43);
        w.set(x, y, z, y === 0 ? B.bedrock : y === g && crimson ? B.crimson_nylium : r < 0.03 ? B.nether_quartz_ore : r < 0.042 ? B.nether_gold_ore : y === g && g === LAVA && r > 0.6 ? B.magma : B.netherrack);
      }
      for (let y = g + 1; y <= LAVA; y++) w.set(x, y, z, B.lava);
      w.ground[z * N + x] = g;
      if (g < LAVA) w.block(x, z);
      // the roof, ragged, with glowstone hanging from it
      const c = Math.round(23 + (noise(x / 7, z / 7, 44) - 0.5) * 7);
      for (let y = c; y < w.sy; y++) w.set(x, y, z, B.netherrack);
      if (hash2(x, z, 45) < 0.035) for (let y = c - 1 - Math.floor(hash2(x, z, 46) * 3); y < c; y++) w.set(x, y, z, B.glowstone);
    }
  }
  // soul sand by the lake
  for (let z = 22; z < 30; z++) for (let x = 6; x < 15; x++) if (hash2(x, z, 47) < 0.7 && w.groundAt(x, z) >= LAVA) w.set(x, w.groundAt(x, z), z, B.soul_sand);
  // huge crimson fungi
  for (const [x, z, tall] of [[35, 32, 7], [40, 37, 5], [33, 39, 6], [41, 30, 4]]) {
    const g = w.groundAt(x, z);
    for (let dy = 0; dy <= 2; dy++) {
      const wide = dy === 0 ? 2 : 1;
      for (let dz = -wide; dz <= wide; dz++) for (let dx = -wide; dx <= wide; dx++) {
        if (dy === 0 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        w.set(x + dx, g + tall - 1 + dy, z + dz, hash3(x + dx, dy, z + dz, 48) < 0.12 ? B.shroomlight : B.nether_wart_block);
      }
    }
    for (let i = 1; i <= tall; i++) w.set(x, g + i, z, B.crimson_stem);
    w.block(x, z);
  }
  // the portal, on a nether brick landing
  w.fill(25, 8, 20, 31, 8, 24, B.nether_bricks);
  w.fill(26, 9, 21, 29, 13, 21, B.obsidian);
  w.fill(27, 10, 21, 28, 12, 21, B.portal);
  w.blockRect(26, 21, 29, 21);
  w.portal = { x: 27.9, z: 22.2, back: [27.9, 23.2], facing: Math.PI };
  return Object.assign(w, {
    name: 'Nether', sky: false, ambient: 0.62, fog: [14, 60], skyColor: 0x2a0b0b,
    origin: [-12, 58, -52], spawn: [28.5, 23.5], centre: [26, 11, 27], orbit: [15, 5],
  });
}

/* ---------------- an End island ---------------- */

function end() {
  const N = 48, w = new Place(N, 44, N);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - 24, z - 24) / 21 + (noise(x / 5, z / 5, 61) - 0.5) * 0.22;
      if (d >= 1) continue;
      const g = 15 + Math.round((noise(x / 10, z / 10, 62) - 0.5) * 2.4);
      const under = Math.round(g - 2 - (1 - d * d) * 11);
      for (let y = Math.max(1, under); y <= g; y++) w.set(x, y, z, B.end_stone);
      w.ground[z * N + x] = g;
    }
  }
  // obsidian pillars
  for (const [x, z, r, tall] of [[13, 15, 2.2, 14], [34, 12, 2.6, 19], [37, 30, 2.2, 11], [16, 35, 3.1, 23], [25, 9, 1.8, 8]]) {
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      if (Math.hypot(dx, dz) > r) continue;
      const g = w.groundAt(x + dx, z + dz);
      if (g < 0) continue;
      for (let y = g + 1; y <= 15 + tall; y++) w.set(x + dx, y, z + dz, B.obsidian);
      w.block(x + dx, z + dz);
    }
  }
  // the start of somebody's purpur build
  const g = 15;
  w.fill(22, g, 22, 27, g, 27, B.end_stone_bricks);
  for (const [x, z] of [[22, 22], [27, 22], [22, 27], [27, 27]]) { for (let y = g + 1; y <= g + 4; y++) w.set(x, y, z, B.purpur_pillar); w.block(x, z); }
  w.fill(22, g + 5, 22, 27, g + 5, 27, B.purpur);
  w.fill(23, g + 5, 23, 26, g + 5, 26, B.air);
  for (let z = 22; z <= 27; z++) for (let x = 22; x <= 27; x++) w.ground[z * N + x] = g;
  return Object.assign(w, {
    name: 'The End', sky: false, ambient: 0.78, fog: [40, 110], skyColor: 0x120e1a,
    origin: [-24, 49, -24], spawn: [24.5, 30.5], centre: [24, 20, 24], orbit: [30, 13],
  });
}

const MAKE = { overworld, nether, end };
export const DIMS = ['overworld', 'nether', 'end'];

/* ---------------- light ---------------- */

// Sky light falls straight down and spreads sideways a block at a time; block light spreads from what
// glows. Both 0–15, as in the game.
function lightUp(w) {
  const { sx, sy, sz, blocks } = w, n = sx * sy * sz;
  const sky = new Uint8Array(n), blk = new Uint8Array(n);
  const queue = new Int32Array(n * 2);
  const idx = (x, y, z) => (y * sz + z) * sx + x;
  const spread = (arr, len) => {
    for (let i = 0; i < len; i++) {
      const at = queue[i], l = arr[at] - 1;
      if (l <= 0) continue;
      const x = at % sx, z = Math.floor(at / sx) % sz, y = Math.floor(at / (sx * sz));
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
        const to = idx(nx, ny, nz);
        if (opaque(blocks[to]) || arr[to] >= l) continue;
        arr[to] = l;
        if (len < queue.length) queue[len++] = to;
      }
    }
  };
  let len = 0;
  if (w.sky) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        let l = 15;
        for (let y = sy - 1; y >= 0 && l > 0; y--) {
          const at = idx(x, y, z), kind = DEFS[blocks[at]].kind;
          if (kind === 'solid') break;
          if (kind === 'cutout' && blocks[at] !== B.glass) l -= 1;
          else if (kind === 'fluid') l -= 2;
          if (l <= 0) break;
          sky[at] = l;
          queue[len++] = at;
        }
      }
    }
    // the box is open at its sides: daylight comes in there too
    spread(sky, len);
  }
  len = 0;
  for (let at = 0; at < n; at++) {
    const l = DEFS[blocks[at]].light;
    if (l) { blk[at] = l; queue[len++] = at; }
  }
  spread(blk, len);
  w.skyLight = sky; w.blockLight = blk;
}

/* ---------------- meshes ---------------- */

// each face: the way it looks, its four corners counter-clockwise from the bottom left as seen from outside,
// how bright the game draws that side, and which of the block's textures it wears
const FACES = [
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], shade: 0.6, tex: 'side' },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], shade: 0.6, tex: 'side' },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: 1, tex: 'top' },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.5, tex: 'bottom' },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: 0.8, tex: 'side', front: true },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], shade: 0.8, tex: 'side' },
];
const UVS = [[0, 1], [1, 1], [1, 0], [0, 0]];
const AO = [0.52, 0.7, 0.86, 1];
const CHUNK = 16;

const vertexShader = `
attribute vec3 tint;
attribute vec2 light;
varying vec2 vUv;
varying vec3 vTint;
varying vec2 vLight;
varying float vDepth;
void main() {
  vUv = uv;
  vTint = tint;
  vLight = light;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
// Liveview's lightmap (public/liveview.js): sky and block light each run through the game's curve, block
// light is warm, sky light goes blue at night, then the brightness lift. Without it, dark textures
// (obsidian, the portal) crush to black and a flower's few colours flatten into one.
const fragmentShader = `
precision highp float;
uniform sampler2D atlas;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
uniform float day;
uniform float ambient;
uniform float fullbright;
uniform float alpha;
uniform float endTint;
varying vec2 vUv;
varying vec3 vTint;
varying vec2 vLight;
varying float vDepth;
float curve(float f) {
  float g = f / (4.0 - 3.0 * f);
  return g + ambient * (1.0 - g);
}
vec3 lightmap(vec2 l) {
  float sky = curve(l.x) * day;
  float blk = curve(l.y) * 1.5;
  vec3 c = vec3(blk, blk * ((blk * 0.6 + 0.4) * 0.6 + 0.4), blk * (blk * blk * 0.6 + 0.4));
  c += mix(vec3(day, day, 1.0), vec3(1.0), 0.35) * sky;
  if (endTint > 0.5) c = mix(c, vec3(0.99, 1.12, 1.0), 0.25);
  c = clamp(mix(c, vec3(0.75), 0.04), 0.0, 1.0);
  vec3 lifted = 1.0 - pow(1.0 - c, vec3(4.0));
  c = mix(c, lifted, 0.5);
  return clamp(mix(c, vec3(0.75), 0.04), 0.0, 1.0);
}
void main() {
  vec4 texel = texture2D(atlas, vUv);
  if (texel.a < (alpha >= 1.0 ? 0.5 : 0.004)) discard;
  vec3 lit = fullbright > 0.5 ? vec3(1.0) : lightmap(vLight);
  float fog = clamp((vDepth - fogNear) / (fogFar - fogNear), 0.0, 1.0);
  float a = alpha >= 1.0 ? 1.0 : alpha * max(texel.a, 0.75);
  gl_FragColor = vec4(mix(texel.rgb * vTint * lit, fogColor, fog), a);
}`;

const hex3 = (hex) => new THREE.Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);

// One set of uniforms for every place, so a change of light or fog is one write.
export function makeMaterials(atlas) {
  const uniforms = {
    atlas: { value: atlas.texture }, fogColor: { value: hex3(0x9fc3f5) }, fogNear: { value: 60 }, fogFar: { value: 130 },
    day: { value: 1 }, ambient: { value: 0 }, fullbright: { value: 0 }, alpha: { value: 1 }, endTint: { value: 0 },
  };
  const solid = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, side: THREE.DoubleSide });
  const clear = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, alpha: { value: 0.74 } }, vertexShader, fragmentShader, side: THREE.DoubleSide, transparent: true, depthWrite: false,
  });
  return { uniforms, solid, clear, hex3 };
}

// name -> a Place with .group (its chunks, each a Mesh) ready to add to a scene
export function buildPlace(name, atlas, mats) {
  const w = MAKE[name]();
  w.id = name;
  lightUp(w);
  const { sx, sy, sz } = w;
  const [aw, ah] = atlas.size;
  const group = new THREE.Group();
  w.chunks = [];
  const tintOf = (hex, k) => [((hex >> 16) & 255) / 255 * k, ((hex >> 8) & 255) / 255 * k, (hex & 255) / 255 * k];
  const lightAt = (x, y, z) => (w.inside(x, y, z)
    ? [w.skyLight[(y * sz + z) * sx + x] / 15, w.blockLight[(y * sz + z) * sx + x] / 15]
    : [w.sky ? 1 : 0, 0]);

  for (let cz = 0; cz < sz; cz += CHUNK) {
    for (let cx = 0; cx < sx; cx += CHUNK) {
      const out = { solid: { p: [], u: [], t: [], l: [], i: [] }, clear: { p: [], u: [], t: [], l: [], i: [] } };
      const quad = (buf, corners, texName, tint, shades, light, crop = 1) => {
        const [tx, ty] = atlas.uv(texName), base = buf.p.length / 3, e = 0.1; // kept off the tile's edge, so the one beside it never shows
        for (let k = 0; k < 4; k++) {
          buf.p.push(corners[k][0], corners[k][1], corners[k][2]);
          const px = tx * TILE + (UVS[k][0] ? TILE - e : e), py = ty * TILE + (UVS[k][1] ? TILE - e : (1 - crop) * TILE + e);
          buf.u.push(px / aw, 1 - py / ah);
          buf.t.push(tint[0] * shades[k], tint[1] * shades[k], tint[2] * shades[k]);
          buf.l.push(light[0], light[1]);
        }
        // split along the brighter diagonal, so the shading in a corner doesn't streak
        if (shades[0] + shades[2] >= shades[1] + shades[3]) buf.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
        else buf.i.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
      };
      for (let y = 0; y < sy; y++) {
        for (let z = cz; z < Math.min(sz, cz + CHUNK); z++) {
          for (let x = cx; x < Math.min(sx, cx + CHUNK); x++) {
            const id = w.get(x, y, z);
            if (!id) continue;
            const d = DEFS[id];
            const white = [1, 1, 1];
            if (d.kind === 'cross') {
              const t = d.tint ? tintOf(d.tint, 1) : white, l = lightAt(x, y, z), s = [1, 1, 1, 1];
              const a = 0, b = 1;
              quad(out.solid, [[x + a, y, z + a], [x + b, y, z + b], [x + b, y + 1, z + b], [x + a, y + 1, z + a]], d.side, t, s, l);
              quad(out.solid, [[x + a, y, z + b], [x + b, y, z + a], [x + b, y + 1, z + a], [x + a, y + 1, z + b]], d.side, t, s, l);
              continue;
            }
            if (d.kind === 'pane') {
              quad(out.clear, [[x, y, z + 0.5], [x + 1, y, z + 0.5], [x + 1, y + 1, z + 0.5], [x, y + 1, z + 0.5]], d.side, white, [1, 1, 1, 1], [1, 1]);
              continue;
            }
            const fluid = d.kind === 'fluid';
            const low = fluid && w.get(x, y + 1, z) !== id ? 0.875 : 1; // a fluid's surface sits a little under the block's top
            for (const f of FACES) {
              const nx = x + f.n[0], ny = y + f.n[1], nz = z + f.n[2];
              if (ny < 0) continue; // nobody sees the underside of the world
              const other = w.get(nx, ny, nz), od = DEFS[other];
              if (od.kind === 'solid') continue;
              if (other === id && (fluid || id === B.glass)) continue;
              if (other === id && d.kind === 'cutout' && f.n[0] + f.n[1] + f.n[2] < 0) continue; // between leaves, one side is enough
              const texName = f.front && d.front ? d.front : d[f.tex];
              const tintHex = d.tint ?? (f.tex === 'top' ? d.tintTop : null);
              const k = f.shade * (d.glow ?? 1); // leaves are drawn a little brighter than their texture, as the game's are
              const tint = tintHex != null ? tintOf(tintHex, k) : [k, k, k];
              const corners = f.c.map(([ox, oy, oz]) => [x + ox, y + (oy ? low : 0), z + oz]);
              const shades = fluid || d.kind === 'cutout' ? [1, 1, 1, 1] : f.c.map(([ox, oy, oz]) => {
                // how boxed in this corner is by the blocks beside the face
                const axes = [0, 1, 2].filter((a) => !f.n[a]);
                const o = [ox, oy, oz], step = (a) => { const v = [0, 0, 0]; v[a] = o[a] ? 1 : -1; return v; };
                const [a1, a2] = axes.map(step);
                const s1 = opaque(w.get(nx + a1[0], ny + a1[1], nz + a1[2])), s2 = opaque(w.get(nx + a2[0], ny + a2[1], nz + a2[2]));
                const c = opaque(w.get(nx + a1[0] + a2[0], ny + a1[1] + a2[1], nz + a1[2] + a2[2]));
                return AO[s1 && s2 ? 0 : 3 - (s1 + s2 + c)];
              });
              const l = d.light ? [lightAt(nx, ny, nz)[0], 1] : lightAt(nx, ny, nz);
              quad(fluid && id === B.water ? out.clear : out.solid, corners, texName, tint, shades, l, f.tex === 'side' ? low : 1);
            }
          }
        }
      }
      const meshOf = (buf, material) => {
        if (!buf.i.length) return null;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.p, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.u, 2));
        geo.setAttribute('tint', new THREE.Float32BufferAttribute(buf.t, 3));
        geo.setAttribute('light', new THREE.Float32BufferAttribute(buf.l, 2));
        geo.setIndex(buf.i);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, material);
        mesh.matrixAutoUpdate = true;
        return mesh;
      };
      const chunk = new THREE.Group();
      const a = meshOf(out.solid, mats.solid), b = meshOf(out.clear, mats.clear);
      if (a) chunk.add(a);
      if (b) { b.renderOrder = 2; chunk.add(b); }
      // how far it is from the middle: chunks arrive from the middle outwards the first time the world is shown
      chunk.userData.ring = Math.hypot(cx + CHUNK / 2 - sx / 2, cz + CHUNK / 2 - sz / 2) / CHUNK;
      group.add(chunk);
      w.chunks.push(chunk);
    }
  }
  w.group = group;
  return w;
}

// The first thing in the way of a ray, a block at a time: { x, y, z, id, dist } or null. Plants, fluids and
// the portal are looked through.
export function rayBlock(w, o, d, far = 80) {
  let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
  const step = [Math.sign(d.x), Math.sign(d.y), Math.sign(d.z)];
  const delta = [Math.abs(1 / d.x), Math.abs(1 / d.y), Math.abs(1 / d.z)];
  const next = [
    d.x ? ((d.x > 0 ? x + 1 - o.x : o.x - x) * delta[0]) : Infinity,
    d.y ? ((d.y > 0 ? y + 1 - o.y : o.y - y) * delta[1]) : Infinity,
    d.z ? ((d.z > 0 ? z + 1 - o.z : o.z - z) * delta[2]) : Infinity,
  ];
  let dist = 0;
  for (let i = 0; i < 400 && dist < far; i++) {
    const id = w.get(x, y, z), kind = DEFS[id].kind;
    if (kind === 'solid' || kind === 'cutout') return { x, y, z, id, dist };
    const a = next[0] < next[1] ? (next[0] < next[2] ? 0 : 2) : (next[1] < next[2] ? 1 : 2);
    dist = next[a];
    next[a] += delta[a];
    if (a === 0) x += step[0]; else if (a === 1) y += step[1]; else z += step[2];
  }
  return null;
}
