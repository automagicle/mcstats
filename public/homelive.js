// The landing page's Liveview example: the World tab of the real thing (public/liveview.js), pointed at a
// made-up world instead of a server. It looks and works the way Liveview does: click to fly, drag to look,
// click a player for their inventory, follow them, chat, run /tp, switch dimension, turn on controls.
//
// Nothing here talks to a server. The world is public/homeworld.js; the players are the landing page's own
// (public/home.js), so whoever is online at the top of the page is who walks around here, what's said in
// the chat log shows in the world's chat, and a death in the log is a death here too. home.js loads this
// when the section comes near and calls mount(ctx); what it gets back is how it tells the world what happened.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';
import { buildModel } from '/player3d.js';
import { B, DIMS, blockName, buildPlace, loadAtlas, makeMaterials, rayBlock } from '/homeworld.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const any = (list) => list[Math.floor(Math.random() * list.length)];
const turnTo = (from, to, t) => from + (((to - from + Math.PI * 3) % TAU) - Math.PI) * t;
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const DIM_NAME = { overworld: 'Overworld', nether: 'Nether', end: 'The End' };

// Where each player spends their time: a place, a spot in it, how far they stray, and what they're doing there.
const HOMES = {
  Pebble_: { dim: 'overworld', at: [43, 41], r: 8, does: ['opened the Community barrel', 'placed a Torch', 'traded with a Villager'] },
  kestrel: { dim: 'overworld', at: [33, 54], r: 6, does: ['harvested Wheat', 'used a Firework Rocket', 'broke a Pumpkin'] },
  minty: { dim: 'nether', at: [29, 26], r: 8, does: ['mined Nether Quartz Ore', 'mined Nether Gold Ore', 'placed Cobblestone'] },
  Saltwater: { dim: 'overworld', at: [30, 62], r: 5, does: ['caught a Cod', 'caught a Salmon', 'cast a Fishing Rod'] },
  oakleaf: { dim: 'nether', at: [21, 26], r: 6, does: ['filled a Bucket with lava', 'mined Netherrack', 'placed Cobblestone'] },
  nightowl_: { dim: 'end', at: [24, 31], r: 11, does: ['placed a Purpur Block', 'mined End Stone', 'threw an Ender Pearl'] },
  Brickhouse: { dim: 'overworld', at: [38, 37], r: 5, does: ['opened a Crafting Table', 'placed Stone Bricks', 'broke a Stone Brick'] },
  dandelion: { dim: 'overworld', at: [57, 25], r: 6, does: ['mined Coal Ore', 'mined Iron Ore', 'mined Stone', 'placed a Torch'] },
  Quartzy: { dim: 'overworld', at: [56, 44], r: 5, does: ['broke Oak Leaves', 'picked up an Oak Sapling', 'lit the portal'] },
};
// what else is in their pockets: [item, at least, at most]
const POCKETS = [['bread', 9, 40], ['arrow', 16, 64], ['cooked_beef', 6, 32], ['diamond', 1, 9], ['iron_ingot', 5, 40], ['coal', 8, 48],
  ['emerald', 2, 20], ['gold_ingot', 2, 16], ['stick', 4, 30], ['wheat', 6, 30], ['redstone', 8, 40], ['ender_pearl', 1, 8],
  ['golden_carrot', 4, 24], ['cod', 1, 6], ['book', 1, 5], ['compass', 1, 1], ['map', 1, 1], ['bow', 1, 1], ['fishing_rod', 1, 1],
  ['flint_and_steel', 1, 1], ['water_bucket', 1, 1], ['golden_apple', 2, 9], ['blaze_rod', 1, 6], ['ender_eye', 1, 4],
  ['firework_rocket', 12, 64], ['experience_bottle', 4, 32], ['gunpowder', 6, 40], ['netherite_scrap', 1, 3], ['shulker_shell', 1, 4]];
const BARRELS = {
  community: [['bread', 32], ['iron_ingot', 17], null, ['coal', 40], ['arrow', 64], ['arrow', 23], null, ['cooked_beef', 12], ['book', 3],
    null, ['wheat', 41], ['wheat_seeds', 20], ['stick', 12], null, null, ['diamond', 2], null, ['apple', 6],
    ['stone_pickaxe', 1], null, null, ['iron_axe', 1], null, ['cod', 4], null, null, ['emerald', 1]],
  home: [['diamond', 14], ['emerald', 37], ['gold_ingot', 22], ['iron_ingot', 64], ['iron_ingot', 48], ['redstone', 64], ['coal', 64], null, ['ender_pearl', 11],
    ['golden_apple', 5], ['enchanted_golden_apple', 1], null, ['totem_of_undying', 1], ['book', 9], null, ['blaze_rod', 12], ['ender_eye', 7], null,
    ['diamond_pickaxe', 1], ['bow', 1], ['arrow', 64], ['arrow', 64], null, ['golden_carrot', 64], ['cooked_beef', 40], null, ['map', 1]],
};

export async function mount(ctx) {
  const $ = (id) => document.getElementById(`ld-${id}`);
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') e.textContent = v;
      else if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    e.append(...kids.flat().filter((x) => x != null && x !== false));
    return e;
  };
  const root = document.getElementById('lv-demo'), stage = $('stage'), canvas = $('view');
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch {
    $('fail').hidden = false;
    $('terrain').textContent = '';
    stage.classList.add('ld-off');
    return null;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc3f5);
  scene.fog = new THREE.Fog(0x9fc3f5, 60, 130);
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 420);
  camera.rotation.order = 'YXZ';
  // the players are lit like the ones on a player's page, dimmed with the world
  const ambient = new THREE.AmbientLight(0xffffff, 1.9), sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
  sunLight.position.set(-0.6, 1, 0.9);
  scene.add(ambient, sunLight);
  const actorRoot = new THREE.Group();
  scene.add(actorRoot);

  const [atlas] = await Promise.all([loadAtlas(), document.fonts?.load('40px "Jersey 10"').catch(() => {})]);
  const mats = makeMaterials(atlas);
  const U = mats.uniforms;

  /* ---------------- state ---------------- */

  const DEFAULTS = { speed: 11, sens: 100, fov: 70, sky: true, clouds: true };
  const settings = { ...DEFAULTS };
  const places = {};
  let place = null;
  let time = 1500; // the game's clock: 0 is sunrise, 6000 noon, 12000 sunset, 18000 midnight
  let fullbright = false, controlsOn = false, flying = false;
  const cam = { x: 0, y: 30, z: 0, yaw: 0, pitch: -0.3, mode: 'tour', angle: 0.7, follow: null, view: 'back' };
  const keys = new Set();
  const actors = new Map();
  const mobs = [];
  let speedShown = 0;

  /* ---------------- the sky ---------------- */

  const skyRoot = new THREE.Group();
  scene.add(skyRoot);
  const texLoader = new THREE.TextureLoader();
  const pixel = (url) => {
    const t = texLoader.load(url, undefined, undefined, () => {});
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const celestial = (url, size) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: pixel(url), transparent: true, blending: THREE.AdditiveBlending, fog: false, depthWrite: false }));
    m.renderOrder = -2;
    skyRoot.add(m);
    return m;
  };
  const sun = celestial('/api/mc/textures/environment/celestial/sun.png', 60);
  const moon = celestial('/api/mc/textures/environment/celestial/moon/full_moon.png', 44);
  const stars = (() => {
    const n = 700, pos = new Float32Array(n * 3);
    let s = 7;
    const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < n; i++) {
      const u = r() * 2 - 1, a = r() * TAU, k = Math.sqrt(1 - u * u);
      pos.set([Math.cos(a) * k * 300, u * 300, Math.sin(a) * k * 300], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    p.renderOrder = -3;
    skyRoot.add(p);
    return p;
  })();
  const clouds = (() => {
    const t = pixel('/api/mc/textures/environment/clouds.png');
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(0.5, 0.5);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(768, 768),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = 52;
    m.renderOrder = 1;
    scene.add(m);
    return m;
  })();
  const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  const DAY = rgb(0x9fc3f5), NIGHT = rgb(0x070a16), DUSK = rgb(0xe89a5c);
  let daylight = 1;
  function paintSky() {
    const a = (time / 24000) * TAU, up = Math.sin(a);
    daylight = place.sky ? clamp(up * 3 + 0.6, 0, 1) : 0;
    let color = rgb(place.skyColor);
    if (place.sky) {
      color = mix3(NIGHT, DAY, daylight);
      const low = clamp(1 - Math.abs(up) * 3.2, 0, 1); // the sun on the horizon
      color = mix3(color, DUSK, low * 0.45);
    }
    scene.background.setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace);
    scene.fog.color.copy(scene.background);
    U.fogColor.value.set(color[0], color[1], color[2]);
    U.day.value = place.sky ? 0.27 + 0.73 * daylight : 0;
    U.ambient.value = place.ambient;
    U.fullbright.value = fullbright ? 1 : 0;
    const lit = fullbright ? 1 : Math.max(place.sky ? 0.3 + 0.7 * daylight : 0, place.ambient + 0.25);
    ambient.intensity = 1.9 * lit;
    sunLight.intensity = 1.5 * lit * (place.sky ? daylight : 0.4);
    const show = place.sky && settings.sky;
    sun.visible = moon.visible = stars.visible = show;
    if (show) {
      const dir = new THREE.Vector3(Math.cos(a), Math.sin(a), 0.22).normalize();
      sun.position.copy(dir).multiplyScalar(280);
      moon.position.copy(dir).multiplyScalar(-280);
      sun.lookAt(0, 0, 0);
      moon.lookAt(0, 0, 0);
      stars.material.opacity = clamp(1 - daylight * 2.2, 0, 1) * 0.9;
      stars.rotation.z = a;
    }
    clouds.visible = place.sky && settings.clouds;
    const c = 0.35 + 0.65 * daylight;
    clouds.material.color.setRGB(c, c, c * 1.02);
  }

  /* ---------------- places ---------------- */

  function placeOf(name) {
    if (places[name]) return places[name];
    const w = buildPlace(name, atlas, mats);
    w.group.visible = false;
    scene.add(w.group);
    w.reveal = reduced() ? 99 : 0;
    places[name] = w;
    return w;
  }
  const local = (w, x, y, z) => [x - w.origin[0], y - w.origin[1], z - w.origin[2]];
  function setPlace(name, { keepCamera = false } = {}) {
    if (place?.id === name && !keepCamera) return;
    if (place) place.group.visible = false;
    place = placeOf(name);
    place.group.visible = true;
    scene.fog.near = U.fogNear.value = place.fog[0];
    scene.fog.far = U.fogFar.value = place.fog[1];
    for (const b of $('dims').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.dim === name));
    for (const a of actors.values()) a.group.visible = a.dim === name;
    for (const m of mobs) m.group.visible = m.dim === name;
    if (!keepCamera) {
      stopFollow(true);
      cam.mode = reduced() ? 'free' : 'tour';
      const [cx, cy, cz] = place.centre, [r, up] = place.orbit;
      Object.assign(cam, { x: cx + Math.cos(cam.angle) * r, y: cy + up, z: cz + Math.sin(cam.angle) * r });
      lookAt(cx, cy, cz, 1);
    }
    paintSky();
    renderSide();
  }
  function lookAt(x, y, z, t) {
    const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
    cam.yaw = turnTo(cam.yaw, Math.atan2(-dx, -dz), t);
    cam.pitch = lerp(cam.pitch, Math.atan2(dy, Math.hypot(dx, dz)), t);
  }

  /* ---------------- players and animals ---------------- */

  const keepers = [];
  const keep = (x) => (keepers.push(x), x);
  function tag(text) {
    const c = document.createElement('canvas'), g = c.getContext('2d'), font = '40px "Jersey 10", sans-serif';
    g.font = font;
    c.width = Math.ceil(g.measureText(text).width) + 18;
    c.height = 44;
    g.font = font;
    g.fillStyle = 'rgba(0, 0, 0, 0.36)';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#fff';
    g.textBaseline = 'middle';
    g.fillText(text, 9, 23);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, fog: false, depthWrite: false }));
    s.scale.set((c.width / c.height) * 0.34, 0.34, 1);
    s.position.y = 2.28;
    s.renderOrder = 3;
    return s;
  }
  const standAt = (w, x, z) => w.groundAt(Math.floor(x), Math.floor(z)) + 1;
  // somewhere to stand within r of a spot
  function spotNear(w, [hx, hz], r) {
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * r;
      const x = Math.floor(hx + Math.cos(a) * d), z = Math.floor(hz + Math.sin(a) * d);
      if (w.walkable(x, z)) return [x + 0.5, z + 0.5];
    }
    return null;
  }
  function addActor(p, fresh) {
    if (actors.has(p.name)) return;
    const home = HOMES[p.name] ?? { dim: 'overworld', at: [43, 41], r: 9, does: ['placed a Torch'] };
    const w = placeOf(home.dim);
    // whoever just joined shows up at the spawn and walks off to what they were doing
    const [x, z] = (fresh ? spotNear(w, w.spawn, 2) : spotNear(w, home.at, home.r)) ?? w.spawn;
    const a = {
      name: p.name, p, dim: home.dim, home, x, z, y: standAt(w, x, z), yaw: Math.random() * TAU, state: 'idle', wait: fresh ? 0.6 : Math.random() * 4,
      speed: 3.4 + Math.random() * 1.2, phase: Math.random() * 6, work: 0, look: 0, dead: 0, trip: null,
      group: new THREE.Group(), model: null, health: 14 + Math.floor(Math.random() * 7), food: 12 + Math.floor(Math.random() * 9), mode: 'survival', inv: null,
    };
    a.group.add(tag(p.name));
    a.group.visible = place?.id === a.dim;
    actorRoot.add(a.group);
    actors.set(p.name, a);
    buildModel(ctx.specOf(p), keep).then((m) => {
      if (!actors.has(p.name)) return;
      m.root.scale.setScalar(1.8 / 32); // the model is 32 pixels tall; a player is 1.8 blocks
      a.group.add(m.root);
      a.model = m;
    }, () => {});
    renderSide();
  }
  function removeActor(name) {
    const a = actors.get(name);
    if (!a) return;
    actors.delete(name);
    actorRoot.remove(a.group);
    if (cam.follow === name) { stopFollow(); toast(`${name} left the game.`); }
    if (screen?.actor === a) closeScreen();
    renderSide();
  }
  function killActor(name) {
    const a = actors.get(name);
    if (!a || a.dead) return;
    a.dead = 0.001;
    a.health = 0;
  }
  function mob(kind, dim, at) {
    const g = new THREE.Group(), legs = [];
    const mat = (c) => keep(new THREE.MeshLambertMaterial({ color: c }));
    const box = (bw, bh, bd, x, y, z, m) => { const b = new THREE.Mesh(keep(new THREE.BoxGeometry(bw, bh, bd)), m); b.position.set(x, y, z); g.add(b); return b; };
    if (kind === 'sheep') {
      const wool = mat(0xe6e6e0), skin = mat(0xc9ad8f);
      box(0.72, 0.62, 1.06, 0, 0.82, 0, wool);
      box(0.42, 0.42, 0.44, 0, 1.06, 0.66, wool);
      box(0.36, 0.3, 0.1, 0, 1, 0.9, skin);
      for (const [x, z] of [[-0.22, 0.36], [0.22, 0.36], [-0.22, -0.36], [0.22, -0.36]]) legs.push(box(0.2, 0.52, 0.2, x, 0.26, z, skin));
    } else {
      const pink = mat(0xeea19d), nose = mat(0xd98480);
      box(0.62, 0.5, 1, 0, 0.62, 0, pink);
      box(0.5, 0.5, 0.48, 0, 0.78, 0.66, pink);
      box(0.24, 0.18, 0.08, 0, 0.72, 0.93, nose);
      for (const [x, z] of [[-0.19, 0.34], [0.19, 0.34], [-0.19, -0.34], [0.19, -0.34]]) legs.push(box(0.22, 0.38, 0.22, x, 0.19, z, pink));
    }
    const w = placeOf(dim);
    const [x, z] = spotNear(w, at, 3) ?? at;
    const m = { kind, dim, home: { at, r: 7 }, x, z, y: standAt(w, x, z), yaw: Math.random() * TAU, state: 'idle', wait: Math.random() * 6, speed: 0.9 + Math.random() * 0.5, phase: 0, group: g, legs };
    g.visible = false;
    actorRoot.add(g);
    mobs.push(m);
  }

  // while a place's chunks are still coming up out of the ground, whoever stands on one comes up with it
  const lift = (w, x, z) => (w.reveal < 99 ? w.chunks[Math.floor(z / 16) * Math.ceil(w.sx / 16) + Math.floor(x / 16)]?.position.y ?? 0 : 0);

  // One step of walking about: wait a while, pick somewhere near home, go there a block at a time.
  function wander(a, dt) {
    const w = places[a.dim];
    if (!w) return;
    if (a.state === 'idle') {
      a.wait -= dt;
      if (a.wait > 0) return;
      const to = a.trip && w.portal ? [w.portal.x, w.portal.z] : spotNear(w, a.home.at, a.home.r);
      if (!to) { a.wait = 1; return; }
      a.target = to;
      a.state = 'walk';
      return;
    }
    const dx = a.target[0] - a.x, dz = a.target[1] - a.z, dist = Math.hypot(dx, dz);
    if (dist < 0.25) return arrive(a);
    const step = Math.min(dist, a.speed * dt), nx = a.x + (dx / dist) * step, nz = a.z + (dz / dist) * step;
    const cx = Math.floor(nx), cz = Math.floor(nz), here = w.groundAt(Math.floor(a.x), Math.floor(a.z));
    const atPortal = a.trip && Math.hypot(nx - w.portal.x, nz - w.portal.z) < 1.6;
    if (!atPortal && (!w.walkable(cx, cz) || Math.abs(w.groundAt(cx, cz) - here) > 1)) {
      // something in the way: think about it, then head somewhere else
      a.state = 'idle';
      a.wait = 0.4 + Math.random();
      if (a.trip && ++a.tries > 6) a.trip = null;
      return;
    }
    a.x = nx; a.z = nz;
    a.yaw = turnTo(a.yaw, Math.atan2(dx, dz), Math.min(1, dt * 9));
    a.phase += step * 2.6;
  }
  function arrive(a) {
    a.state = 'idle';
    if (a.trip) return throughPortal(a);
    a.wait = 1.5 + Math.random() * 5;
    if (a.home.does && Math.random() < 0.45) {
      a.work = 1.6;
      addFeed(`${a.name} ${any(a.home.does)}`);
    }
  }
  function throughPortal(a) {
    const to = a.trip, w = placeOf(to);
    a.trip = null;
    a.dim = to;
    [a.x, a.z] = w.portal.back;
    a.y = standAt(w, a.x, a.z);
    a.yaw = w.portal.facing;
    a.wait = 0.8;
    a.home = to === HOMES[a.name]?.dim ? HOMES[a.name] : { dim: to, at: w.spawn, r: 7, does: null };
    a.group.visible = place.id === to;
    addFeed(`${a.name} went through the portal to the ${DIM_NAME[to]}`);
    if (cam.follow === a.name) setPlace(to, { keepCamera: true });
    renderSide();
  }
  function animate(a, dt, t) {
    const w = places[a.dim];
    if (!w) return;
    if (a.dead) {
      // the game's death: tip over, a moment on the ground, then back at the spawn
      a.dead += dt;
      a.group.rotation.z = Math.min(1, a.dead / 0.35) * (Math.PI / 2);
      if (a.dead > 1.1) a.group.visible = false;
      if (a.dead > 3) {
        a.dead = 0;
        a.health = 20; a.food = 20;
        [a.x, a.z] = spotNear(w, w.spawn, 2) ?? w.spawn;
        a.y = standAt(w, a.x, a.z);
        a.state = 'idle'; a.wait = 1;
        a.group.rotation.z = 0;
        a.group.visible = place.id === a.dim;
      }
    } else wander(a, dt);
    const gy = standAt(w, a.x, a.z);
    a.y += (gy - a.y) * Math.min(1, dt * (gy > a.y ? 16 : 10));
    a.group.position.set(a.x, a.y + lift(w, a.x, a.z), a.z);
    a.group.rotation.y = a.yaw;
    const parts = a.model?.parts;
    if (parts) {
      const walking = a.state === 'walk' && !a.dead, swing = walking ? Math.sin(a.phase) * 0.85 : 0;
      const ease = Math.min(1, dt * 12);
      parts.rightLeg.rotation.x = lerp(parts.rightLeg.rotation.x, swing, ease);
      parts.leftLeg.rotation.x = lerp(parts.leftLeg.rotation.x, -swing, ease);
      parts.leftArm.rotation.x = lerp(parts.leftArm.rotation.x, swing * 0.8, ease);
      a.work = Math.max(0, a.work - dt);
      // swinging at a block
      const arm = a.work > 0 ? -1.3 + Math.sin(t * 16) * 0.55 : -swing * 0.8;
      parts.rightArm.rotation.x = lerp(parts.rightArm.rotation.x, arm, ease);
      // looking about while standing; at the camera when it comes close
      const near = Math.hypot(cam.x - a.x, cam.z - a.z) < 7 && cam.follow !== a.name;
      let yaw = walking ? 0 : Math.sin(t * 0.7 + a.phase) * 0.5, pitch = a.work > 0 ? 0.35 : 0;
      if (near && !walking) {
        const rel = ((Math.atan2(cam.x - a.x, cam.z - a.z) - a.yaw + Math.PI * 3) % TAU) - Math.PI;
        if (Math.abs(rel) < 1.3) { yaw = rel; pitch = clamp(-Math.atan2(cam.y - a.y - 1.6, Math.hypot(cam.x - a.x, cam.z - a.z)), -0.7, 0.7); }
      }
      parts.head.rotation.y = lerp(parts.head.rotation.y, yaw, Math.min(1, dt * 5));
      parts.head.rotation.x = lerp(parts.head.rotation.x, pitch, Math.min(1, dt * 5));
    }
  }
  function animateMob(m, dt) {
    wander(m, dt);
    const w = places[m.dim], gy = standAt(w, m.x, m.z);
    m.y += (gy - m.y) * Math.min(1, dt * 12);
    m.group.position.set(m.x, m.y + lift(w, m.x, m.z), m.z);
    m.group.rotation.y = m.yaw;
    const swing = m.state === 'walk' ? Math.sin(m.phase * 2.4) * 0.55 : 0;
    m.legs.forEach((leg, i) => { leg.rotation.x = lerp(leg.rotation.x, i % 3 ? -swing : swing, Math.min(1, dt * 12)); });
  }

  /* ---------------- the camera ---------------- */

  const eye = (a) => [a.x, a.y + 1.62, a.z];
  function startFollow(name, view = 'back') {
    const a = actors.get(name);
    if (!a) return;
    if (a.dim !== place.id) setPlace(a.dim, { keepCamera: true });
    cam.mode = 'follow'; cam.follow = name; cam.view = view;
    $('follow').hidden = false;
    $('follow-name').textContent = name;
    for (const b of $('follow').querySelectorAll('[data-follow]')) b.setAttribute('aria-pressed', String(b.dataset.follow === view));
  }
  function stopFollow(quiet) {
    if (cam.mode === 'follow') cam.mode = 'free';
    cam.follow = null;
    $('follow').hidden = true;
    if (!quiet) cam.pitch = clamp(cam.pitch, -1.5, 1.5);
  }
  function flyTo(a) {
    if (a.dim !== place.id) setPlace(a.dim, { keepCamera: true });
    stopFollow(true);
    cam.mode = 'free';
    Object.assign(cam, { x: a.x - Math.sin(a.yaw + 0.6) * -4.5, y: a.y + 3, z: a.z - Math.cos(a.yaw + 0.6) * -4.5 });
    lookAt(a.x, a.y + 1.2, a.z, 1);
  }
  const free = () => { if (cam.mode === 'tour') cam.mode = 'free'; };
  function moveCamera(dt) {
    if (cam.mode === 'tour') {
      cam.angle += dt * 0.055;
      const [cx, cy, cz] = place.centre, [r, up] = place.orbit;
      const k = 1 - Math.exp(-dt * 2.5);
      cam.x = lerp(cam.x, cx + Math.cos(cam.angle) * r, k);
      cam.y = lerp(cam.y, cy + up + Math.sin(cam.angle * 1.7) * 1.5, k);
      cam.z = lerp(cam.z, cz + Math.sin(cam.angle) * r, k);
      lookAt(cx, cy - 1, cz, k);
    } else if (cam.mode === 'follow') {
      const a = actors.get(cam.follow);
      if (!a) stopFollow();
      else {
        const [ex, ey, ez] = eye(a), fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
        const k = 1 - Math.exp(-dt * (cam.view === 'first' ? 14 : 6));
        const [tx, ty, tz, yaw, pitch] = cam.view === 'first' ? [ex + fx * 0.2, ey, ez + fz * 0.2, a.yaw + Math.PI, 0]
          : cam.view === 'back' ? [ex - fx * 4, ey + 1.3, ez - fz * 4, a.yaw + Math.PI, -0.28]
            : [ex + fx * 4, ey + 0.6, ez + fz * 4, a.yaw, -0.12];
        cam.x = lerp(cam.x, tx, k); cam.y = lerp(cam.y, ty, k); cam.z = lerp(cam.z, tz, k);
        cam.yaw = turnTo(cam.yaw, yaw, k);
        cam.pitch = lerp(cam.pitch, pitch, k);
        // what they see doesn't include themselves
        if (a.model) a.model.root.visible = !(cam.view === 'first' && Math.hypot(cam.x - tx, cam.z - tz) < 1);
      }
    }
    // flying: the keys move along where the camera faces, level; Space and Shift are up and down
    const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0), s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const v = (keys.has('Space') ? 1 : 0) - (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0);
    if (f || s || v) {
      if (cam.mode !== 'free') { stopFollow(true); cam.mode = 'free'; }
      const speed = settings.speed * (keys.has('ControlLeft') || keys.has('ControlRight') ? 3 : 1) * dt, n = Math.hypot(f, s) || 1;
      cam.x += ((-Math.sin(cam.yaw) * f + Math.cos(cam.yaw) * s) / n) * speed;
      cam.z += ((-Math.cos(cam.yaw) * f - Math.sin(cam.yaw) * s) / n) * speed;
      cam.y += v * speed;
    }
    // the example's world is small: the camera stays near it
    const pad = place.id === 'nether' ? -1.5 : 26;
    cam.x = clamp(cam.x, -pad, place.sx + pad);
    cam.z = clamp(cam.z, -pad, place.sz + pad);
    cam.y = clamp(cam.y, 2.5, place.id === 'nether' ? 21 : place.sy + 22);
    camera.position.set(cam.x, cam.y, cam.z);
    camera.rotation.set(cam.pitch, cam.yaw, 0);
  }

  /* ---------------- what the pointer is on ---------------- */

  const caster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    if (flying) ndc.set(0, 0);
    else ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    caster.setFromCamera(ndc, camera);
    const o = caster.ray.origin, d = caster.ray.direction;
    const block = rayBlock(place, o, d);
    let best = null;
    for (const a of actors.values()) {
      if (a.dim !== place.id || a.dead || (cam.follow === a.name && cam.view === 'first')) continue;
      // a box round the player
      let t0 = 0, t1 = block ? block.dist : 80;
      for (const [oo, dd, lo, hi] of [[o.x, d.x, a.x - 0.4, a.x + 0.4], [o.y, d.y, a.y, a.y + 1.95], [o.z, d.z, a.z - 0.4, a.z + 0.4]]) {
        if (Math.abs(dd) < 1e-9) { if (oo < lo || oo > hi) { t0 = Infinity; break; } continue; }
        const a1 = (lo - oo) / dd, a2 = (hi - oo) / dd;
        t0 = Math.max(t0, Math.min(a1, a2)); t1 = Math.min(t1, Math.max(a1, a2));
      }
      if (t0 <= t1 && (!best || t0 < best.dist)) best = { actor: a, dist: t0 };
    }
    return best ?? (block ? { block } : null);
  }

  /* ---------------- toasts, chat, the activity list ---------------- */

  let toastTimer = 0;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
  }
  const chatBox = $('chat'), chatForm = $('chat-form'), chatInput = $('chat-input');
  // a line of the game's chat: pieces of { t, c? }
  function line(...pieces) {
    const row = h('div', { class: 'ld-line' }, ...pieces.map((p) => (typeof p === 'string' ? p : h('span', { style: `color:${p.c}`, text: p.t }))));
    chatBox.append(row);
    while (chatBox.children.length > 40) chatBox.firstChild.remove();
    setTimeout(() => row.classList.add('gone'), 9000);
    chatBox.scrollTop = chatBox.scrollHeight;
  }
  const YELLOW = '#ffff55', RED = '#ff5555', GREEN = '#55ff55', GREY = '#aaaaaa', AQUA = '#55ffff';
  function openChat(text = '') {
    chatForm.hidden = false;
    chatBox.classList.add('open');
    chatInput.value = text;
    chatInput.focus();
    chatBox.scrollTop = chatBox.scrollHeight;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  }
  function closeChat(refocus = true) {
    chatForm.hidden = true;
    chatBox.classList.remove('open');
    if (refocus) canvas.focus({ preventScroll: true });
  }
  const feed = [];
  function addFeed(text) {
    feed.unshift({ at: ctx.clock(), text });
    feed.length = Math.min(feed.length, 7);
    $('feed').replaceChildren(...feed.map((f) => h('div', { class: 'lv-feed-row' }, h('time', { text: f.at }), h('div', { class: 'log-msg', text: f.text }))));
  }

  /* ---------------- commands ---------------- */

  const findActor = (name) => [...actors.values()].find((a) => a.name.toLowerCase() === String(name || '').toLowerCase());
  const TIMES = { day: 1000, noon: 6000, night: 13000, midnight: 18000 };
  function command(text) {
    const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
    const needControls = () => { line({ t: 'That needs controls on. /tp and /spectate work without them.', c: YELLOW }); };
    const unknown = () => { line({ t: 'Unknown or incomplete command. Try /help.', c: RED }); };
    switch ((cmd || '').toLowerCase()) {
      case 'help':
        line({ t: '/tp <player>, /tp <x> <y> <z>, /spectate <player>: move your camera', c: GREY });
        line({ t: '/time set <day|noon|night|midnight>, /gamemode <mode> <player>, /kill <player>: need controls on', c: GREY });
        return;
      case 'tp':
      case 'teleport': {
        const a = findActor(args[0]);
        if (a) { flyTo(a); return line(`Teleported your camera to ${a.name}`); }
        const n = args.slice(0, 3).map(Number);
        if (n.length === 3 && n.every(Number.isFinite)) {
          stopFollow(true);
          cam.mode = 'free';
          [cam.x, cam.y, cam.z] = local(place, n[0], n[1], n[2]);
          return line(`Teleported your camera to ${n.join(', ')}`);
        }
        return line({ t: args.length ? 'No player was found' : 'Who to? /tp <player>, or /tp <x> <y> <z>', c: RED });
      }
      case 'spectate': {
        if (!args.length) { stopFollow(); return line('No longer spectating'); }
        const a = findActor(args[0]);
        if (!a) return line({ t: 'No player was found', c: RED });
        startFollow(a.name, 'first');
        return line(`Now spectating ${a.name}`);
      }
      case 'time': {
        if (!controlsOn) return needControls();
        const to = TIMES[args[1]] ?? Number(args[1]);
        if (args[0] !== 'set' || !Number.isFinite(to)) return unknown();
        time = ((to % 24000) + 24000) % 24000;
        syncTime();
        addFeed(`You ran /time set ${args[1]}`);
        return line(`Set the time to ${Math.round(time)}`);
      }
      case 'gamemode': {
        if (!controlsOn) return needControls();
        const a = findActor(args[1]);
        if (!['survival', 'creative', 'adventure', 'spectator'].includes(args[0]) || !a) return unknown();
        a.mode = args[0];
        renderSide();
        addFeed(`You ran /gamemode ${args[0]} ${a.name}`);
        return line(`Set ${a.name}’s game mode to ${cap(args[0])} Mode`);
      }
      case 'kill': {
        if (!controlsOn) return needControls();
        const a = findActor(args[0]);
        if (!a) return line({ t: 'No player was found', c: RED });
        addFeed(`You ran /kill ${a.name}`);
        return ctx.kill(a.name);
      }
      default:
        return controlsOn ? unknown() : needControls();
    }
  }
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    closeChat();
    if (!text) return;
    if (text.startsWith('/')) { line({ t: text, c: GREY }); command(text); } else ctx.say(text);
  });
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeChat(); } });

  /* ---------------- inventories: the game's screens ---------------- */

  const seeded = (seed) => {
    let s = 0;
    for (const c of seed) s = (Math.imul(s, 31) + c.charCodeAt(0)) >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  };
  const item = (id, n = 1, more = {}) => ({ id, n, enchants: [], ...more });
  function invOf(a) {
    if (a.inv) return a.inv;
    const gear = ctx.gearOf(a.p), r = seeded(a.name);
    const armor = ['head', 'chest', 'legs', 'feet'].map((slot) => (gear.armor[slot] ? item(gear.armor[slot].id, 1, { glint: gear.armor[slot].glint, enchants: gear.armor[slot].enchants ?? (gear.armor[slot].glint ? ['Protection IV', 'Unbreaking III'] : []) }) : null));
    const hot = Array(9).fill(null), main = Array(27).fill(null);
    gear.carry.forEach((it, i) => { hot[i] = { ...it, n: 1 }; });
    const pockets = [...POCKETS].sort(() => r() - 0.5).slice(0, 9 + Math.floor(r() * 6)).map(([id, lo, hi]) => item(id, lo + Math.floor(r() * (hi - lo + 1))));
    let k = gear.carry.length;
    for (const it of pockets.splice(0, 3 + Math.floor(r() * 3))) hot[k++] = it;
    for (const it of pockets) { let at; do at = Math.floor(r() * 27); while (main[at]); main[at] = it; }
    const off = gear.offhand && !gear.offhand.special ? [item(gear.offhand.id, gear.offhand.n ?? 1)] : [null];
    return (a.inv = { armor, off, main, hot, craft: Array(5).fill(null) });
  }
  const barrelStore = new Map();
  const barrelOf = (b) => {
    if (!barrelStore.has(b)) barrelStore.set(b, BARRELS[b.kind].map((x) => (x ? item(x[0], x[1]) : null)));
    return barrelStore.get(b);
  };
  const emptyInv = { main: Array(27).fill(null), hot: Array(9).fill(null) };

  let screen = null, held = null;
  const heldEl = h('div', { class: 'mc-held', hidden: true });
  document.body.append(heldEl);
  const itemNode = (it) => {
    const img = h('img', { class: 'ld-item', alt: '', draggable: 'false', src: `/api/mc/textures/item/${it.id}.png` });
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    return [img,
      it.glint ? h('span', { class: 'ld-glint', style: `-webkit-mask-image:url(/api/mc/textures/item/${it.id}.png);mask-image:url(/api/mc/textures/item/${it.id}.png)` }) : null,
      it.n > 1 ? h('span', { class: 'ld-count', text: String(it.n) }) : null];
  };
  function slot(store, i, gx, gy, { only = false } = {}) {
    const it = store[i];
    const el = h('div', { class: `ld-slot${held && held.store === store && held.i === i ? ' held-from' : ''}`, style: `left:${(gx - 1) * 2}px;top:${(gy - 1) * 2}px` }, it ? itemNode(it) : null);
    if (it && !held) ctx.itemTip(el, it);
    el.addEventListener('click', () => {
      if (!controlsOn) return;
      if (!held) {
        if (!store[i]) return;
        held = { store, i, item: store[i] };
        heldEl.replaceChildren(...itemNode(held.item));
        heldEl.hidden = false;
      } else {
        // put it down here; what was here goes back to where the held stack came from
        if (only && !(held.store === store && held.i === i)) return;
        held.store[held.i] = store[i];
        store[i] = held.item;
        held = null;
        heldEl.hidden = true;
        if (screen?.actor) addFeed(`You moved items in ${screen.actor.name}’s inventory`);
        else addFeed(`You moved items in the ${screen.barrel.name}`);
      }
      ctx.hideTip();
      paintScreen();
    });
    return el;
  }
  addEventListener('pointermove', (e) => { if (held) heldEl.style.transform = `translate(${e.clientX - 16}px, ${e.clientY - 16}px)`; }, { passive: true });
  function doll(a) {
    const c = h('canvas', { class: 'ld-doll', width: '16', height: '32' }), g = c.getContext('2d');
    const spec = ctx.specOf(a.p), img = new Image();
    img.onload = () => {
      const arm = spec.skin.slim ? 3 : 4;
      for (const [sx, sy, sw, sh, dx, dy] of [[8, 8, 8, 8, 4, 0], [20, 20, 8, 12, 4, 8], [44, 20, arm, 12, 4 - arm, 8], [36, 52, arm, 12, 12, 8],
        [4, 20, 4, 12, 4, 20], [20, 52, 4, 12, 8, 20], [40, 8, 8, 8, 4, 0], [20, 36, 8, 12, 4, 8], [4, 36, 4, 12, 4, 20], [4, 52, 4, 12, 8, 20]]) g.drawImage(img, sx, sy, sw, sh, dx, dy, sw, sh);
    };
    img.src = `/api/mc/textures/${spec.skin.path}.png`;
    return c;
  }
  function paintScreen() {
    if (!screen) return;
    const bar = h('div', { class: 'screen-bar' },
      h('span', { class: `screen-mode${controlsOn ? ' on' : ''}`, text: controlsOn ? 'Editing: click a stack, then where it goes' : 'Looking only' }),
      controlsOn ? null : h('button', { type: 'button', class: 'btn', text: 'Turn on controls', onclick: () => setControls(true) }),
      h('span', { class: 'screen-who', text: screen.actor ? `${screen.actor.name}’s inventory` : screen.barrel.name }));
    const gui = h('div', { class: `mc-screen ld-gui${controlsOn ? ' editing' : ''}` });
    const label = (text, gx, gy) => gui.append(h('span', { class: 'ld-label', style: `left:${gx * 2}px;top:${gy * 2}px`, text }));
    const grid = (store, gx, gy, rows, from = 0) => {
      for (let r = 0; r < rows; r++) for (let c = 0; c < 9; c++) gui.append(slot(store, from + r * 9 + c, gx + c * 18, gy + r * 18));
    };
    if (screen.actor) {
      const inv = invOf(screen.actor);
      gui.style.height = '332px';
      inv.armor.forEach((_, i) => gui.append(slot(inv.armor, i, 8, 8 + i * 18, { only: true })));
      gui.append(h('div', { class: 'ld-dollbox' }, doll(screen.actor)), slot(inv.off, 0, 77, 62, { only: true }));
      label('Crafting', 97, 8);
      for (let i = 0; i < 4; i++) gui.append(slot(inv.craft, i, 98 + (i % 2) * 18, 18 + Math.floor(i / 2) * 18));
      gui.append(h('span', { class: 'ld-arrow', 'aria-hidden': 'true' }), slot(inv.craft, 4, 154, 28, { only: true }));
      grid(inv.main, 8, 84, 3);
      grid(inv.hot, 8, 142, 1);
    } else {
      gui.style.height = '336px';
      label('Barrel', 8, 6);
      grid(barrelOf(screen.barrel), 8, 18, 3);
      label('Inventory', 8, 74);
      grid(emptyInv.main, 8, 86, 3);
      grid(emptyInv.hot, 8, 144, 1);
    }
    const close = h('button', { type: 'button', class: 'lv-screen-close', 'aria-label': 'Close', title: 'Close (Esc)', text: '×', onclick: closeScreen });
    gui.append(close);
    $('screen-host').replaceChildren(bar, gui);
  }
  function openScreen(what) {
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    closePops();
    toggleSide(false);
    screen = what;
    $('screen').hidden = false;
    paintScreen();
    $('screen-host').querySelector('.lv-screen-close').focus({ preventScroll: true });
    addFeed(what.actor ? `You opened ${what.actor.name}’s inventory` : `You opened the ${what.barrel.name}`);
  }
  function closeScreen() {
    if (!screen) return;
    screen = null; held = null;
    heldEl.hidden = true;
    ctx.hideTip();
    $('screen').hidden = true;
    canvas.focus({ preventScroll: true });
  }
  $('screen').addEventListener('pointerdown', (e) => { if (e.target === $('screen')) closeScreen(); });
  const nearest = () => [...actors.values()].filter((a) => a.dim === place.id && !a.dead)
    .sort((a, b) => Math.hypot(a.x - cam.x, a.z - cam.z) - Math.hypot(b.x - cam.x, b.z - cam.z))[0];

  /* ---------------- the players menu, and the list under the world ---------------- */

  const where = (a) => { const w = places[a.dim]; return `${Math.floor(a.x + w.origin[0])} ${Math.floor(a.y + w.origin[1])} ${Math.floor(a.z + w.origin[2])}`; };
  const about = (a) => `${(a.health / 2).toFixed(1)} ♥, ${cap(a.mode)}, ${DIM_NAME[a.dim]}, ${where(a)}`;
  const sorted = () => [...actors.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  const btn = (text, fn, cls) => h('button', { type: 'button', class: `btn${cls ? ` ${cls}` : ''}`, text, onclick: (e) => fn(e.currentTarget) });
  // a button that asks for a second click
  function confirmed(b, text) {
    if (b.classList.contains('armed')) return true;
    const was = b.textContent;
    b.classList.add('armed');
    b.textContent = text;
    setTimeout(() => { b.classList.remove('armed'); b.textContent = was; }, 2500);
    return false;
  }
  function toggleSide(open = $('side').hidden) {
    $('side').hidden = !open;
    if (open) { closePops(); renderSide(true); }
  }
  let sideSig = '';
  function renderSide(force) {
    $('s-online').textContent = String(actors.size);
    $('online-sub').textContent = actors.size ? `${actors.size} on the server` : '';
    renderPlayers();
    if ($('side').hidden) return;
    const sig = `${controlsOn}|${sorted().map((a) => `${a.name}:${a.mode}`).join(',')}`;
    if (sig === sideSig && !force) {
      for (const row of $('side-list').querySelectorAll('[data-name]')) { const a = actors.get(row.dataset.name); if (a) row.querySelector('small').textContent = about(a); }
      return;
    }
    sideSig = sig;
    const rows = sorted();
    if (!rows.length) return $('side-list').replaceChildren(h('div', { class: 'empty', text: 'Nobody is online.' }));
    $('side-list').replaceChildren(...rows.map((a) => h('div', { class: 'lv-who-row', 'data-name': a.name },
      h('div', { class: 'lv-who-head' }, ctx.head(a.p, 32, 'lv-face'), h('div', {}, h('span', { class: 'lv-name', text: a.name }), h('small', { text: about(a) }))),
      h('div', { class: 'lv-acts' },
        btn('Go to', () => { flyTo(a); toggleSide(false); canvas.focus({ preventScroll: true }); }, 'btn-primary'),
        btn('Follow', () => { startFollow(a.name, 'first'); toggleSide(false); canvas.focus({ preventScroll: true }); toast(`Seeing what ${a.name} sees. V switches the view; move or press Esc to stop.`); }),
        btn('Follow behind', () => { startFollow(a.name, 'back'); toggleSide(false); canvas.focus({ preventScroll: true }); }),
        btn('Inventory', () => openScreen({ actor: a }))),
      controlsOn ? h('div', { class: 'lv-acts lv-acts-control' },
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Game mode' }, ...['survival', 'creative', 'adventure', 'spectator'].map((mode) =>
          h('button', { type: 'button', 'aria-pressed': String(a.mode === mode), text: cap(mode), onclick: () => command(`/gamemode ${mode} ${a.name}`) }))),
        btn('Bring here', () => { a.x = clamp(cam.x, 1, place.sx - 2); a.z = clamp(cam.z, 1, place.sz - 2); a.dim = place.id; a.state = 'idle'; a.wait = 2; a.group.visible = true; addFeed(`You brought ${a.name} to your camera`); toggleSide(false); }),
        btn('Heal', () => { a.health = 20; addFeed(`You healed ${a.name}`); renderSide(); }),
        btn('Feed', () => { a.food = 20; addFeed(`You fed ${a.name}`); }),
        btn('Kill', (b) => { if (confirmed(b, 'Click again to kill')) { toggleSide(false); command(`/kill ${a.name}`); } }, 'lv-danger')) : null)));
  }
  function renderPlayers() {
    const host = $('players'), rows = sorted();
    if (!rows.length) return host.replaceChildren(h('div', { class: 'empty', text: 'Nobody is online.' }));
    const have = new Map([...host.querySelectorAll('[data-name]')].map((r) => [r.dataset.name, r]));
    if (have.size !== rows.length || rows.some((a) => !have.has(a.name))) {
      host.replaceChildren(...rows.map((a) => h('div', { class: 'ld-prow', 'data-name': a.name },
        ctx.head(a.p, 24, 'lv-face'), h('span', { class: 'lv-name', text: a.name }), h('small', { text: about(a) }),
        h('button', { type: 'button', class: 'btn', text: 'Follow', onclick: () => { startFollow(a.name, 'back'); stage.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); } }))));
      return;
    }
    for (const a of rows) have.get(a.name).querySelector('small').textContent = about(a);
  }

  /* ---------------- the bar over the world, and what floats on it ---------------- */

  function setControls(on) {
    controlsOn = on;
    $('control').setAttribute('aria-pressed', String(on));
    $('control-label').textContent = on ? 'Controls on' : 'Watching only';
    root.classList.toggle('lv-controls-on', on);
    toast(on ? 'Controls are on: commands run and items move. On a real server that changes the game.' : 'Watching only: nothing you do changes the world.');
    if (!on && held) { held = null; heldEl.hidden = true; }
    paintScreen();
    renderSide(true);
  }
  $('control').addEventListener('click', () => setControls(!controlsOn));
  $('fullbright').addEventListener('click', () => {
    fullbright = !fullbright;
    $('fullbright').setAttribute('aria-pressed', String(fullbright));
    paintSky();
  });
  $('dims').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-dim]');
    if (b && DIMS.includes(b.dataset.dim)) setPlace(b.dataset.dim);
  });
  const pops = [['settings-btn', 'settings'], ['keys-btn', 'keys']];
  function closePops() {
    for (const [b, p] of pops) { $(p).hidden = true; $(b).setAttribute('aria-expanded', 'false'); }
  }
  for (const [b, p] of pops) {
    $(b).addEventListener('click', () => {
      const open = $(p).hidden;
      closePops();
      $(p).hidden = !open;
      $(b).setAttribute('aria-expanded', String(open));
    });
  }
  $('keys-close').addEventListener('click', closePops);
  $('menu-btn').addEventListener('click', () => toggleSide());
  $('side-close').addEventListener('click', () => { toggleSide(false); canvas.focus({ preventScroll: true }); });
  $('chat-btn').addEventListener('click', () => (chatForm.hidden ? openChat() : closeChat()));
  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen?.())?.catch?.(() => {});
  $('full-btn').addEventListener('click', fullscreen);
  $('follow').addEventListener('click', (e) => {
    const b = e.target.closest('[data-follow]');
    if (b && cam.follow) startFollow(cam.follow, b.dataset.follow);
  });
  $('follow-stop').addEventListener('click', () => stopFollow());

  // settings
  const clockOf = (t) => { const m = Math.floor((((t + 6000) % 24000) / 1000) * 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  function syncSettings() {
    $('set-speed').value = settings.speed; $('set-speed-out').textContent = `${settings.speed} blocks a second`;
    $('set-sens').value = settings.sens; $('set-sens-out').textContent = `${settings.sens}%`;
    $('set-fov').value = settings.fov; $('set-fov-out').textContent = `${settings.fov}°`;
    $('set-sky').checked = settings.sky; $('set-clouds').checked = settings.clouds;
    camera.fov = settings.fov;
    camera.updateProjectionMatrix();
    paintSky();
  }
  function syncTime() {
    $('set-time').value = Math.round(time / 250) * 250;
    $('set-time-out').textContent = clockOf(time);
  }
  $('settings').addEventListener('input', (e) => {
    if (e.target.id === 'ld-set-time') { time = Number(e.target.value); $('set-time-out').textContent = clockOf(time); paintSky(); return; }
    settings.speed = Number($('set-speed').value); settings.sens = Number($('set-sens').value); settings.fov = Number($('set-fov').value);
    settings.sky = $('set-sky').checked; settings.clouds = $('set-clouds').checked;
    syncSettings();
  });
  $('settings-reset').addEventListener('click', () => { Object.assign(settings, DEFAULTS); syncSettings(); });

  /* ---------------- mouse and keys ---------------- */

  let drag = null;
  const look = (dx, dy) => {
    const k = 0.0024 * (settings.sens / 100);
    cam.yaw -= dx * k;
    cam.pitch = clamp(cam.pitch - dy * k, -1.55, 1.55);
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || flying) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, touch: e.pointerType === 'touch' };
    canvas.setPointerCapture?.(e.pointerId);
    canvas.focus({ preventScroll: true });
    closePops();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.moved < 5) return;
    if (cam.mode !== 'free') { stopFollow(true); cam.mode = 'free'; }
    look(dx * 1.4, drag.touch ? 0 : dy * 1.4); // a finger moving up and down scrolls the page
    stage.classList.add('looking');
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const clicked = drag.moved < 5 && e.type === 'pointerup', touch = drag.touch;
    drag = null;
    stage.classList.remove('looking');
    if (!clicked) return;
    const hit = pick(e.clientX, e.clientY);
    if (hit?.actor) return openScreen({ actor: hit.actor });
    if (touch) return toast('Drag sideways to look around. Players opens the list: follow someone or see their inventory.');
    free();
    canvas.requestPointerLock?.()?.catch?.(() => {});
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const hit = pick(e.clientX, e.clientY);
    if (!hit?.block) return;
    const b = place.barrels.find((x) => x.x === hit.block.x && x.y === hit.block.y && x.z === hit.block.z);
    if (b) openScreen({ barrel: b });
    else toast(`${blockName(hit.block.id)}: only barrels open here. There’s one in the plaza.`);
  });
  document.addEventListener('pointerlockchange', () => {
    flying = document.pointerLockElement === canvas;
    stage.classList.toggle('flying', flying);
    if (!flying) keys.clear();
  });
  document.addEventListener('mousemove', (e) => { if (flying) look(e.movementX, e.movementY); });
  canvas.addEventListener('mousedown', (e) => {
    if (!flying) return;
    const hit = pick();
    if (e.button === 0 && hit?.actor) openScreen({ actor: hit.actor });
    if (e.button === 2 && hit?.block) {
      const b = place.barrels.find((x) => x.x === hit.block.x && x.y === hit.block.y && x.z === hit.block.z);
      if (b) openScreen({ barrel: b });
    }
  });
  canvas.addEventListener('wheel', (e) => {
    if (!flying) return; // the page scrolls as usual until you're flying
    e.preventDefault();
    settings.speed = clamp(Math.round(settings.speed * (e.deltaY < 0 ? 1.2 : 1 / 1.2)) + (e.deltaY < 0 ? 1 : -1), 2, 40);
    speedShown = performance.now();
    syncSettings();
  }, { passive: false });
  const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight']);
  canvas.addEventListener('keydown', (e) => {
    if (e.metaKey || e.altKey) return;
    if (MOVE.has(e.code)) { keys.add(e.code); e.preventDefault(); return; }
    const k = e.key.toLowerCase();
    if (k === 't' || k === 'enter') { e.preventDefault(); openChat(); }
    else if (k === '/') { e.preventDefault(); openChat('/'); }
    else if (k === 'm') toggleSide();
    else if (k === 'f') fullscreen();
    else if (k === 'e') { const a = actors.get(cam.follow) ?? nearest(); if (a) openScreen({ actor: a }); }
    else if (k === 'v' && cam.follow) startFollow(cam.follow, { first: 'back', back: 'front', front: 'first' }[cam.view]);
  });
  canvas.addEventListener('keyup', (e) => keys.delete(e.code));
  canvas.addEventListener('blur', () => keys.clear());
  // Esc closes whatever is open, innermost first
  stage.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (screen) closeScreen();
    else if (!$('side').hidden) { toggleSide(false); canvas.focus({ preventScroll: true }); }
    else if (!$('settings').hidden || !$('keys').hidden) closePops();
    else if (cam.follow) stopFollow();
    else return;
    e.stopPropagation();
  });

  /* ---------------- frames ---------------- */

  function resize() {
    const w = stage.clientWidth, hh = stage.clientHeight;
    if (!w || !hh) return;
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);

  let last = 0, raf = 0, seen = false, shown = false, slow = 0;
  function frame(now) {
    raf = shown && !document.hidden ? requestAnimationFrame(frame) : 0;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016), t = now / 1000;
    last = now;
    time = (time + dt * 20) % 24000;
    atlas.tick(dt);
    paintSky();
    // chunks come up out of the ground from the middle outwards, the first time a place is seen
    if (place.reveal < 99) {
      place.reveal += dt;
      let done = true;
      for (const c of place.chunks) {
        const k = clamp((place.reveal - c.userData.ring * 0.22) / 0.7, 0, 1), e = 1 - (1 - k) ** 3;
        c.position.y = (e - 1) * 22;
        c.visible = k > 0;
        if (k < 1) done = false;
      }
      if (done) place.reveal = 99;
    }
    for (const a of actors.values()) animate(a, dt, t);
    for (const m of mobs) animateMob(m, dt);
    moveCamera(dt);
    skyRoot.position.copy(camera.position);
    clouds.position.x = camera.position.x;
    clouds.position.z = camera.position.z;
    clouds.material.map.offset.x = (t * 0.0006 + camera.position.x / 1536) % 1;
    clouds.material.map.offset.y = (-camera.position.z / 1536) % 1;
    renderer.render(scene, camera);
    // the text over the world, a few times a second
    if (now - slow > 200) {
      slow = now;
      const [ox, oy, oz] = place.origin;
      $('hud-pos').textContent = `${(cam.x + ox).toFixed(1)}  ${(cam.y + oy).toFixed(1)}  ${(cam.z + oz).toFixed(1)}`;
      $('hud-more').textContent = DIM_NAME[place.id] + (now - speedShown < 2000 ? `, flying at ${settings.speed} blocks a second` : '');
      if ($('settings').hidden === false && document.activeElement?.id !== 'ld-set-time') syncTime();
    }
  }
  const wake = () => { if (!raf && shown && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  new IntersectionObserver(([e]) => {
    shown = e.isIntersecting;
    if (shown && !seen) { seen = true; place.reveal = reduced() ? 99 : 0; }
    wake();
  }, { rootMargin: '80px' }).observe(stage);
  document.addEventListener('visibilitychange', wake);

  // now and then: someone takes the portal, the numbers under the world move
  setInterval(() => {
    if (document.hidden || !shown) return;
    const able = [...actors.values()].filter((a) => !a.dead && !a.trip && a.dim !== 'end' && cam.follow !== a.name);
    const a = any(able);
    if (a && Math.random() < 0.5) { a.trip = a.dim === 'overworld' ? 'nether' : 'overworld'; a.tries = 0; a.state = 'idle'; a.wait = 0; placeOf(a.trip); }
  }, 40000);
  let mspt = 9.6;
  setInterval(() => {
    if (document.hidden || !shown) return;
    mspt = clamp(mspt + (Math.random() - 0.5) * 1.6, 6.5, 14);
    $('s-mspt').textContent = mspt.toFixed(1);
    $('s-mobs').textContent = String(mobs.length + 11 + Math.round(Math.sin(performance.now() / 9000) * 3));
    for (const a of actors.values()) if (!a.dead && a.health < 20 && Math.random() < 0.3) a.health += 1;
    renderSide();
  }, 1000);

  /* ---------------- go ---------------- */

  for (const [kind, at] of [['sheep', [22, 31]], ['sheep', [25, 34]], ['sheep', [20, 36]], ['pig', [61, 60]], ['pig', [64, 57]], ['sheep', [66, 44]]]) mob(kind, 'overworld', at);
  for (const p of ctx.players) if (ctx.online.has(p.name)) addActor(p, false);
  setPlace('overworld');
  for (const m of mobs) m.group.visible = m.dim === place.id;
  resize();
  syncSettings();
  syncTime();
  // with a finger there's no flying: say what does work
  if (matchMedia('(pointer: coarse)').matches) $('help').textContent = 'Drag sideways to look around. Tap a player for their inventory.';
  $('terrain').textContent = atlas.missing ? 'Some of the game’s textures didn’t load' : 'Birchwood SMP, an example';
  $('s-mspt').textContent = mspt.toFixed(1);
  $('s-mobs').textContent = String(mobs.length + 11);
  stage.classList.add('ld-ready');
  wake();

  // for looking at the example from the browser's console
  window.homeLiveDebug = { actors, mobs, cam, places, camera, pick };

  // What the page tells the world: a line of its chat log (chat, join, leave, death, advancement).
  return {
    event(m) {
      if (m.kind === 'chat') {
        line(m.you ? { t: '[Web] ', c: AQUA } : '', `<${m.you ? 'You' : m.name}> ${m.text}`);
        addFeed(`${m.you ? 'You' : m.name}: ${m.text}`);
        return;
      }
      if (m.kind === 'join') { const p = ctx.players.find((x) => x.name === m.name); if (p) addActor(p, true); }
      if (m.kind === 'leave') removeActor(m.name);
      if (m.kind === 'death') killActor(m.name);
      if (m.kind === 'join' || m.kind === 'leave') line({ t: `${m.name} ${m.text}`, c: YELLOW });
      else if (m.kind === 'advancement') {
        const br = /^(.*?)(\[.+\])(.*)$/.exec(m.text);
        line(`${m.name} ${br ? br[1] : m.text}`, br ? { t: br[2], c: /challenge/.test(m.text) ? '#aa00aa' : GREEN } : '', br ? br[3] : '');
      } else line(`${m.name} ${m.text}`);
      addFeed(`${m.name} ${m.text}`);
    },
  };
}
