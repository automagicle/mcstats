// Liveview: the admins' live view of the Minecraft world, in the Liveview tab (#/live).
//
// app.js imports this the first time the tab is opened (like player3d.js) and calls show() and hide() as
// the page changes. The markup it paints into is the #view-live section of index.html; every id there
// starts with "lv-".
//
// What the server mod sends arrives through the dashboard's relay (src/liveview.js): one WebSocket,
// /api/liveview/ws, whose binary messages are batches of frames, each either a JSON message or a terrain
// section. Nothing here talks to the Minecraft server directly.
//
// Two tiers, kept apart on purpose:
//   watching   needs the server's viewer key, entered once per account (the gate card asks for it);
//   controls   running commands and moving items. Needs the control key, entered once per account, and
//              is off every time the page opens until it's switched on with the button at the top.
// Watching never changes the world.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

// ---------- shared state (the 3D engine below reads these) ----------
const players = new Map();
const entities = new Map();
const slots = new Map();
const actions = [];
const seenActions = new Set();
const root = document.getElementById('view-live');
const $ = (id) => document.getElementById('lv-' + id);
const app = $('app');
const statusEl = $('status'), statusPill = $('status-pill'), terrainEl = $('terrain');
const throttleEl = $('throttle'), stage = $('stage'), canvas = $('view'), banner = $('banner');
const hudPos = $('hud-pos'), hudMore = $('hud-more');
let socket = null;
let selected = null;
let inventoryUuid = null;
let inventoryUnavailable = false;
let currentView = 'map';
let view = { cameraChunkRadius: 8, playerChunkRadius: 2, entityRadiusBlocks: 64 };
// The Liveview tab is the page being shown (set by show() and hide()).
let active = false;
const mapVisible = () => active && currentView === 'map' && !app.hidden;
// Set once the lighting and particle code further down has initialized (avoids let/const temporal-dead-zone reads).
let lightingReady = false;
let particlesReady = false;
// Read-only handle for checking the renderer from the browser console.
const debugState = {};
window.liveviewDebug = debugState;

// ---------- scene ----------
// Atlas texels and hex colours are used as stored; nothing is converted to or from linear.
THREE.ColorManagement.enabled = false;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 400);
camera.rotation.order = 'YXZ';
camera.position.set(0, 80, 0);
const terrainRoot = new THREE.Group();
const actorRoot = new THREE.Group();
scene.add(terrainRoot, actorRoot);
const SKY = { 'minecraft:overworld': 0x9fc3f5, 'minecraft:the_nether': 0x2a0b0b, 'minecraft:the_end': 0x120e1a };
const fog = { color: new THREE.Color(0x9fc3f5), near: 80, far: 140 };
scene.fog = new THREE.Fog(fog.color, fog.near, fog.far);
let cameraDim = 'minecraft:overworld';
let cameraPlaced = false;

// ---------- atlas ----------
const atlas = { ready: false, url: null, meta: null, size: 0, texture: null, cells: null, cellTranslucent: null, cellCount: 0, canvas: null, anims: [], keys: [] };
const uniforms = {
  atlas: { value: null }, cells: { value: null }, atlasSize: { value: 1 }, cellCount: { value: 1 },
  fogColor: { value: fog.color }, fogNear: { value: fog.near }, fogFar: { value: fog.far },
  fullbright: { value: 0 }, skyBright: { value: 1 }, ambient: { value: 0 }, endTint: { value: 0 }
};
const vertexShader = `
attribute vec2 origin;
attribute vec3 tint;
attribute vec2 light;
uniform float atlasSize;
varying vec2 vPx;
varying vec2 vOrigin;
varying vec3 vTint;
varying vec2 vLight;
varying float vDepth;
void main() {
  vPx = uv * atlasSize;
  vOrigin = origin * atlasSize;
  vTint = tint;
  vLight = light;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const fragmentShader = `
precision highp float;
uniform sampler2D atlas;
uniform sampler2D cells;
uniform float atlasSize;
uniform float cellCount;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
uniform float alphaCut;
uniform float fullbright;
uniform float skyBright;
uniform float ambient;
uniform float endTint;
varying vec2 vPx;
varying vec2 vOrigin;
varying vec3 vTint;
varying vec2 vLight;
varying float vDepth;
// Vanilla LightTexture: brightness curve f / (4 - 3f) lifted by the dimension's ambient light, warm block light with
// a 1.5 flicker factor, sky light scaled by the time of day and tinted toward blue at night, then the gamma lift at
// the default brightness setting (0.5).
float curve(float level) {
  float f = level / 15.0;
  float g = f / (4.0 - 3.0 * f);
  return g + ambient * (1.0 - g);
}
vec3 lightmap(vec2 l) {
  float sky = curve(l.x) * skyBright;
  float blk = curve(l.y) * 1.5;
  vec3 c = vec3(blk, blk * ((blk * 0.6 + 0.4) * 0.6 + 0.4), blk * (blk * blk * 0.6 + 0.4));
  c += mix(vec3(skyBright, skyBright, 1.0), vec3(1.0), 0.35) * sky;
  if (endTint > 0.5) c = mix(c, vec3(0.99, 1.12, 1.0), 0.25);
  c = clamp(mix(c, vec3(0.75), 0.04), 0.0, 1.0);
  vec3 lifted = 1.0 - pow(1.0 - c, vec3(4.0));
  c = mix(c, lifted, 0.5);
  return clamp(mix(c, vec3(0.75), 0.04), 0.0, 1.0);
}
void main() {
  // Greedy quads carry UVs that run past their tile; wrap them inside the rect that owns the quad's first corner.
  vec2 probe = vOrigin + sign(vPx - vOrigin) * 0.5;
  vec4 rect = texture2D(cells, (floor(probe / 16.0) + 0.5) / cellCount);
  vec2 px = rect.z > 0.0 ? rect.xy + mod(vPx - rect.xy, rect.zw) : vPx;
  vec4 c = texture2D(atlas, px / atlasSize);
  if (c.a < alphaCut) discard;
  float f = smoothstep(fogNear, fogFar, vDepth);
  vec3 lit = fullbright > 0.5 ? vec3(1.0) : lightmap(vLight);
  gl_FragColor = vec4(mix(c.rgb * vTint * lit, fogColor, f), c.a);
}`;
const opaqueMaterial = new THREE.ShaderMaterial({ uniforms: { ...uniforms, alphaCut: { value: 0.5 } }, vertexShader, fragmentShader });
const translucentMaterial = new THREE.ShaderMaterial({ uniforms: { ...uniforms, alphaCut: { value: 0.004 } }, vertexShader, fragmentShader, transparent: true, depthWrite: false });

async function loadAtlas(msg) {
  // The image can be byte-identical across restarts while the meta (models, babies) changed, so compare both.
  if (atlas.url === msg.url && atlas.metaUrl === msg.meta) return;
  terrainEl.textContent = 'Loading the game’s textures';
  const [metaRes, pngRes] = await Promise.all([
    fetch(msg.meta, { credentials: 'same-origin' }),
    fetch(msg.url, { credentials: 'same-origin' })
  ]);
  if (!metaRes.ok || !pngRes.ok) throw new Error('atlas HTTP ' + metaRes.status + '/' + pngRes.status);
  const meta = await metaRes.json();
  const bitmap = await createImageBitmap(await pngRes.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
  const size = meta.size;
  const pixels = document.createElement('canvas');
  pixels.width = size; pixels.height = size;
  const ctx2d = pixels.getContext('2d', { willReadFrequently: true });
  ctx2d.drawImage(bitmap, 0, 0);
  const texture = new THREE.Texture(bitmap);
  texture.flipY = false;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.premultiplyAlpha = false;
  texture.needsUpdate = true;
  const cellCount = size / 16;
  const cellData = new Float32Array(cellCount * cellCount * 4);
  const cellTranslucent = new Uint8Array(cellCount * cellCount);
  const translucent = new Set(meta.translucent || []);
  for (const [key, r] of Object.entries(meta.textures)) {
    const cw = Math.ceil(r.w / 16), ch = Math.ceil(r.h / 16);
    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        const index = (r.v / 16 + cy) * cellCount + (r.u / 16 + cx);
        cellData.set([r.u, r.v, r.w, r.h], index * 4);
        cellTranslucent[index] = translucent.has(key) ? 1 : 0;
      }
    }
  }
  const cells = new THREE.DataTexture(cellData, cellCount, cellCount, THREE.RGBAFormat, THREE.FloatType);
  cells.magFilter = THREE.NearestFilter;
  cells.minFilter = THREE.NearestFilter;
  cells.flipY = false;
  cells.needsUpdate = true;
  const anims = [];
  for (const a of meta.animations || []) {
    const r = meta.textures[a.texture];
    if (!r || !Array.isArray(a.frames) || a.frames.length === 0) continue;
    const frames = [];
    for (let i = 0; i < a.frameCount; i++) frames.push(ctx2d.getImageData(r.u, r.v + i * a.frameHeight, r.w, a.frameHeight));
    anims.push({ x: r.u, y: r.v, frametime: Math.max(1, a.frametime || 1), order: a.frames, frames, shown: 0 });
  }
  if (atlas.texture) atlas.texture.dispose();
  if (atlas.cells) atlas.cells.dispose();
  Object.assign(atlas, { ready: true, url: msg.url, metaUrl: msg.meta, meta, size, texture, cells, cellTranslucent, cellCount, canvas: pixels, anims });
  for (const material of [opaqueMaterial, translucentMaterial]) {
    material.uniforms.atlas.value = texture;
    material.uniforms.cells.value = cells;
    material.uniforms.atlasSize.value = size;
    material.uniforms.cellCount.value = cellCount;
  }
  entityTextures.clear();
  onAtlasReady();
}

function animateAtlas(now) {
  if (!atlas.ready || atlas.anims.length === 0) return;
  const props = renderer.properties.get(atlas.texture);
  const glTex = props && props.__webglTexture;
  if (!glTex) return;
  const gl = renderer.getContext();
  const tick = Math.floor(now / 50);
  let bound = false;
  for (const a of atlas.anims) {
    const frame = a.order[Math.floor(tick / a.frametime) % a.order.length];
    if (frame === a.shown || !a.frames[frame]) continue;
    if (!bound) {
      renderer.state.bindTexture(gl.TEXTURE_2D, glTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      bound = true;
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, a.x, a.y, gl.RGBA, gl.UNSIGNED_BYTE, a.frames[frame]);
    a.shown = frame;
  }
}

function atlasRect(key) {
  return atlas.ready ? atlas.meta.textures[key] : null;
}

function cropAtlas(r, w, h) {
  const c = document.createElement('canvas');
  c.width = w || r.w; c.height = h || r.h;
  c.getContext('2d').drawImage(atlas.canvas, r.u, r.v, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

// ---------- sections ----------
const sections = new Map();
let sectionChain = Promise.resolve();
let vertexTotal = 0;
const sectionKey = (cx, sy, cz) => cx + ',' + sy + ',' + cz;

function queueSection(work) {
  sectionChain = sectionChain.then(work).catch((error) => console.warn('liveview section', error));
}

// Highest up-facing surface per block column, from the section meshes' top faces: where rain stops and splashes
// (vanilla uses the MOTION_BLOCKING heightmap, which also counts leaves and water). Rebuilt per chunk on demand.
const columnSections = new Map();
const columnTops = new Map();
function noteColumn(cx, cz, key, add) {
  const ck = cx + ',' + cz;
  let set = columnSections.get(ck);
  if (add) { if (!set) columnSections.set(ck, set = new Set()); set.add(key); }
  else if (set) { set.delete(key); if (!set.size) columnSections.delete(ck); }
  columnTops.delete(ck);
}
function surfaceAt(x, z) {
  const bx = Math.floor(x), bz = Math.floor(z);
  const cx = Math.floor(bx / 16), cz = Math.floor(bz / 16);
  const ck = cx + ',' + cz;
  let tops = columnTops.get(ck);
  if (!tops) {
    tops = new Float32Array(256).fill(-Infinity);
    for (const key of columnSections.get(ck) || []) {
      const entry = sections.get(key);
      if (!entry || !entry.tops) continue;
      const t = entry.tops, base = entry.sy * 16;
      for (let i = 0; i < t.length; i += 5) {
        const y = base + t[i + 4];
        for (let lx = Math.max(0, Math.floor(t[i])); lx < Math.min(16, Math.ceil(t[i + 2])); lx++) {
          for (let lz = Math.max(0, Math.floor(t[i + 1])); lz < Math.min(16, Math.ceil(t[i + 3])); lz++) {
            if (y > tops[lz * 16 + lx]) tops[lz * 16 + lx] = y;
          }
        }
      }
    }
    columnTops.set(ck, tops);
  }
  return tops[(bz - cz * 16) * 16 + (bx - cx * 16)];
}

function dropSection(key) {
  const entry = sections.get(key);
  if (!entry) return;
  if (entry.cx !== undefined) noteColumn(entry.cx, entry.cz, key, false);
  for (const mesh of entry.meshes) { terrainRoot.remove(mesh); mesh.geometry.dispose(); }
  vertexTotal -= entry.vertices;
  sections.delete(key);
  if (particlesReady) sectionEmitters.delete(key);
  dropChests(key);
}

function clearSections() {
  for (const key of [...sections.keys()]) dropSection(key);
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const textDecoder = new TextDecoder();
// One index pattern (0 1 2, 0 2 3 per quad) shared by every section; subarrays of it are never written.
let quadIndex = new Uint32Array(0);
function quadIndices(quads) {
  if (quadIndex.length < quads * 6) {
    const size = Math.max(quads, 16384);
    quadIndex = new Uint32Array(size * 6);
    for (let q = 0; q < size; q++) {
      const v = q * 4, i = q * 6;
      quadIndex[i] = v; quadIndex[i + 1] = v + 1; quadIndex[i + 2] = v + 2;
      quadIndex[i + 3] = v; quadIndex[i + 4] = v + 2; quadIndex[i + 5] = v + 3;
    }
  }
  return quadIndex.subarray(0, quads * 6);
}

// Starts decompression as soon as a frame arrives, so frames inflate in parallel; only building the mesh is serial.
function startInflate(buffer) {
  const head = new DataView(buffer);
  if (head.byteLength < 16) return Promise.resolve(null);
  const flags = head.getUint8(1);
  const body = new Uint8Array(buffer, 16 + head.getUint16(14));
  return (flags & 1) ? inflate(body) : Promise.resolve(body.slice());
}

async function handleFrame(buffer, inflated) {
  const head = new DataView(buffer);
  if (head.byteLength < 16 || head.getUint8(0) !== 1) return;
  const flags = head.getUint8(1);
  const cx = head.getInt32(2), cz = head.getInt32(6), sy = head.getInt32(10);
  const dimLength = head.getUint16(14);
  const dimension = textDecoder.decode(new Uint8Array(buffer, 16, dimLength));
  if (dimension !== cameraDim || !atlas.ready) return;
  const raw = await (inflated || startInflate(buffer));
  if (!raw || dimension !== cameraDim) return;
  const data = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const count = data.getUint32(0);
  const key = sectionKey(cx, sy, cz);
  dropSection(key);
  // Flag 2: each vertex also carries sky and block light (10 floats); older frames are 8 floats and fully lit.
  const stride = (flags & 2) ? 10 : 8;
  const emitAt = 4 + count * stride * 4;
  readEmitters(key, cx, sy, cz, data, emitAt);
  readSpecials(key, cx, sy, cz, data, emitAt + 4 + (data.byteLength >= emitAt + 4 ? data.getUint32(emitAt) * 4 : 0));
  if (count === 0) { sections.set(key, { meshes: [], vertices: 0 }); return; }
  // Flag 4: vertex floats are little-endian and can be viewed in place (raw starts at offset 0, so +4 is aligned).
  let f;
  if ((flags & 4) && (raw.byteOffset + 4) % 4 === 0) {
    f = new Float32Array(raw.buffer, raw.byteOffset + 4, count * stride);
  } else {
    f = new Float32Array(count * stride);
    for (let i = 0; i < f.length; i++) f[i] = data.getFloat32(4 + i * 4, (flags & 4) !== 0);
  }
  const quads = count / 4;
  const side = new Uint8Array(quads);
  const used = [0, 0];
  const qs = stride * 4;
  // Up-facing quads as [minX, minZ, maxX, maxZ, y] in section coordinates, for surfaceAt.
  const tops = [];
  for (let q = 0; q < quads; q++) {
    const o = q * qs, s1 = o + stride, s2 = o + stride * 2;
    const ax = f[s1] - f[o], ay = f[s1 + 1] - f[o + 1], az = f[s1 + 2] - f[o + 2];
    const bx = f[s2] - f[o], by = f[s2 + 1] - f[o + 1], bz = f[s2 + 2] - f[o + 2];
    const ny = az * bx - ax * bz, len = Math.hypot(ay * bz - az * by, ny, ax * by - ay * bx) || 1;
    if (ny / len <= 0.5) continue;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y = -Infinity;
    for (let v = 0; v < 4; v++) {
      const b = o + v * stride;
      x0 = Math.min(x0, f[b]); x1 = Math.max(x1, f[b]); z0 = Math.min(z0, f[b + 2]); z1 = Math.max(z1, f[b + 2]); y = Math.max(y, f[b + 1]);
    }
    if (x1 - x0 > 0.01 && z1 - z0 > 0.01) tops.push(x0, z0, x1, z1, y);
  }
  for (let q = 0; q < quads; q++) {
    const o = q * qs;
    const ou = f[o + 3], ov = f[o + 4];
    const cell = cellAt(ou + Math.sign(f[o + 2 * stride + 3] - ou) * 0.5 / atlas.size, ov + Math.sign(f[o + 2 * stride + 4] - ov) * 0.5 / atlas.size);
    side[q] = atlas.cellTranslucent[cell] ? 1 : 0;
    used[side[q]]++;
  }
  const parts = used.map((n) => ({ n: 0, pos: new Float32Array(n * 12), uv: new Float32Array(n * 8), tint: new Float32Array(n * 12), light: new Float32Array(n * 8), origin: new Float32Array(n * 8) }));
  for (let q = 0; q < quads; q++) {
    const o = q * qs;
    const part = parts[side[q]];
    const k = part.n++;
    // Flag 8: the server already baked vanilla face shading (and each element's shade flag) into the color.
    const shade = (flags & 8) ? 1 : shadeOf(f, stride, o);
    const ou = f[o + 3], ov = f[o + 4];
    for (let v = 0; v < 4; v++) {
      const b = o + v * stride, w = k * 4 + v;
      part.pos[w * 3] = f[b]; part.pos[w * 3 + 1] = f[b + 1]; part.pos[w * 3 + 2] = f[b + 2];
      part.uv[w * 2] = f[b + 3]; part.uv[w * 2 + 1] = f[b + 4];
      part.tint[w * 3] = f[b + 5] * shade; part.tint[w * 3 + 1] = f[b + 6] * shade; part.tint[w * 3 + 2] = f[b + 7] * shade;
      part.light[w * 2] = stride === 10 ? f[b + 8] : 15; part.light[w * 2 + 1] = stride === 10 ? f[b + 9] : 0;
      part.origin[w * 2] = ou; part.origin[w * 2 + 1] = ov;
    }
  }
  const meshes = [];
  parts.forEach((part, index) => {
    if (part.n === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(part.pos, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(part.uv, 2));
    geometry.setAttribute('tint', new THREE.BufferAttribute(part.tint, 3));
    geometry.setAttribute('origin', new THREE.BufferAttribute(part.origin, 2));
    geometry.setAttribute('light', new THREE.BufferAttribute(part.light, 2));
    geometry.setIndex(new THREE.BufferAttribute(quadIndices(part.n), 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(8, 8, 8), 14);
    const mesh = new THREE.Mesh(geometry, index === 0 ? opaqueMaterial : translucentMaterial);
    mesh.position.set(cx * 16, sy * 16, cz * 16);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (index === 1) mesh.renderOrder = 1;
    terrainRoot.add(mesh);
    meshes.push(mesh);
  });
  sections.set(key, { meshes, vertices: count, tops: new Float32Array(tops), cx, sy, cz });
  noteColumn(cx, cz, key, true);
  vertexTotal += count;
}


function cellAt(u, v) {
  const n = atlas.cellCount;
  const cx = Math.min(n - 1, Math.max(0, Math.floor(u * atlas.size / 16)));
  const cy = Math.min(n - 1, Math.max(0, Math.floor(v * atlas.size / 16)));
  return cy * n + cx;
}

// Minecraft-style fixed face light: top 1.0, bottom 0.5, north/south 0.8, east/west 0.6.
function shadeOf(q, stride, o = 0) {
  const s1 = o + stride, s2 = o + stride * 2;
  const ax = q[s1] - q[o], ay = q[s1 + 1] - q[o + 1], az = q[s1 + 2] - q[o + 2];
  const bx = q[s2] - q[o], by = q[s2 + 1] - q[o + 1], bz = q[s2 + 2] - q[o + 2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  const x = Math.abs(nx / len), y = ny / len, z = Math.abs(nz / len);
  if (y > 0.5) return 1.0;
  if (y < -0.5) return 0.5;
  return x > z ? 0.6 : 0.8;
}

function handleWindow(msg) {
  if (msg.dimension !== cameraDim) return;
  for (const s of msg.remove || []) dropSection(sectionKey(s.cx, s.sy, s.cz));
}

// ---------- actors ----------
const skinTextures = new Map();
const entityTextures = new Map();
const actorMeshes = new Map();
const textureLoader = new THREE.TextureLoader();

function pixelTexture(source) {
  const texture = source instanceof THREE.Texture ? source : new THREE.CanvasTexture(source);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function skinTexture(player) {
  const slim = player.skinModel === 'slim';
  if (player.skin) {
    if (!skinTextures.has(player.skin)) {
      const texture = textureLoader.load(player.skin, (t) => { pixelTexture(t); });
      skinTextures.set(player.skin, pixelTexture(texture));
    }
    return skinTextures.get(player.skin);
  }
  const key = atlas.ready ? atlas.meta.playerSkins[slim ? 'slim' : 'wide'] : null;
  const rect = key ? atlasRect(key) : null;
  if (!rect) return null;
  if (!skinTextures.has(key)) skinTextures.set(key, pixelTexture(cropAtlas(rect, 64, 64)));
  return skinTextures.get(key);
}

// Box UV layout used by Minecraft skins: [side d][front w][side d][back w] under [top w][bottom w].
function boxGeometry(w, h, d, u, v, texW, texH, grow = 0) {
  const x0 = -w / 2 - grow, x1 = w / 2 + grow, y0 = -h / 2 - grow, y1 = h / 2 + grow, z0 = -d / 2 - grow, z1 = d / 2 + grow;
  const faces = [
    [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1], u + d, v + d, w, h],
    [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0], u + 2 * d + w, v + d, w, h],
    [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0], u, v + d, d, h],
    [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1], u + d + w, v + d, d, h],
    [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], u + d, v, w, d],
    [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0], u + d + w, v, w, d]
  ];
  const pos = [], uv = [], index = [];
  faces.forEach((f, i) => {
    const [tl, tr, br, bl, fu, fv, fw, fh] = f;
    pos.push(...tl, ...tr, ...br, ...bl);
    const u0 = fu / texW, u1 = (fu + fw) / texW, v0 = fv / texH, v1 = (fv + fh) / texH;
    uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    const b = i * 4;
    index.push(b, b + 3, b + 2, b, b + 2, b + 1);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

const PLAYER_PARTS = [
  // name, w, h, d, u, v, pivot [x, y, z] at the joint, offset of box centre from pivot, overlay [u, v]
  ['head', 8, 8, 8, 0, 0, [0, 24, 0], [0, 4, 0], [32, 0]],
  ['body', 8, 12, 4, 16, 16, [0, 24, 0], [0, -6, 0], [16, 32]],
  ['rightArm', 4, 12, 4, 40, 16, [-6, 22, 0], [0, -4, 0], [40, 32]],
  ['leftArm', 4, 12, 4, 32, 48, [6, 22, 0], [0, -4, 0], [48, 48]],
  ['rightLeg', 4, 12, 4, 0, 16, [-2, 12, 0], [0, -6, 0], [0, 32]],
  ['leftLeg', 4, 12, 4, 16, 48, [2, 12, 0], [0, -6, 0], [0, 48]]
];

function buildPlayer(player) {
  const slim = player.skinModel === 'slim';
  const texture = skinTexture(player);
  if (models.data && texture) {
    const built = modelActor(models.data.player[slim ? 'slim' : 'wide'], texture, 0.9375);
    if (built) {
      const root = new THREE.Group();
      root.add(built.turn);
      const label = nameSprite(player.name || player.uuid.slice(0, 8));
      label.position.set(0, 2.19, 0);
      root.add(label);
      const look = player.look || {};
      const extras = dress(root, built, look, {
        armor: models.data.player[slim ? 'slimArmor' : 'wideArmor'], scale: 0.9375, baby: false, type: 'minecraft:player'
      });
      if (look.cape && models.data.player.cape) {
        const capeTex = capeTexture(look.cape);
        const cape = capeTex ? modelActor(models.data.player.cape, capeTex, 0.9375) : null;
        if (cape) {
          if (cape.parts.cape) cape.parts.cape.base[0] += 0.1;
          root.add(cape.turn);
          extras.push({ turn: cape.turn, material: cape.material, model: { parts: cape.parts, walk: 0, zombie: false } });
        }
      }
      root.userData = { kind: 'player', uuid: player.uuid, skin: player.skin || '', skinModel: player.skinModel || '', hasTexture: true, hasModel: true,
        model: { parts: built.parts, walk: 0, zombie: false }, turn: built.turn, extras, last: null,
        materials: [built.material, ...extras.map((e) => e.material)], lookKey: lookKey(look), label, fonted: !!files.font };
      return root;
    }
  }
  const base = new THREE.MeshBasicMaterial({ map: texture, color: texture ? 0xffffff : 0x8899aa, alphaTest: 0.5 });
  const overlay = new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide, visible: !!texture });
  const root = new THREE.Group();
  const model = new THREE.Group();
  model.scale.setScalar(0.9375 / 16);
  root.add(model);
  const joints = {};
  for (const [name, w0, h, d, u, v, pivot, offset, over] of PLAYER_PARTS) {
    const arm = name.endsWith('Arm');
    const w = arm && slim ? 3 : w0;
    const joint = new THREE.Group();
    const px = arm ? Math.sign(pivot[0]) * (slim ? 5.5 : 6) : pivot[0];
    joint.position.set(px, pivot[1], pivot[2]);
    const inner = new THREE.Mesh(boxGeometry(w, h, d, u, v, 64, 64), base);
    inner.position.set(offset[0], offset[1], offset[2]);
    const outer = new THREE.Mesh(boxGeometry(w, h, d, over[0], over[1], 64, 64, name === 'head' ? 0.5 : 0.25), overlay);
    outer.position.copy(inner.position);
    joint.add(inner, outer);
    model.add(joint);
    joints[name] = joint;
  }
  const label = nameSprite(player.name || player.uuid.slice(0, 8));
  label.position.set(0, 2.25, 0);
  root.add(label);
  root.userData = { kind: 'player', uuid: player.uuid, joints, skin: player.skin || '', skinModel: player.skinModel || '', hasTexture: !!texture, walk: 0, last: null };
  return root;
}

function entityTexture(type) {
  if (!atlas.ready) return null;
  if (entityTextures.has(type)) return entityTextures.get(type);
  const key = atlas.meta.entities ? atlas.meta.entities[type] : null;
  const rect = key ? atlasRect(key) : null;
  const value = rect ? { texture: pixelTexture(cropAtlas(rect)), w: rect.w, h: rect.h } : null;
  entityTextures.set(type, value);
  return value;
}

function babyEntityTexture(type) {
  if (!atlas.ready || !atlas.meta.babyEntities) return null;
  const cacheKey = 'baby:' + type;
  if (entityTextures.has(cacheKey)) return entityTextures.get(cacheKey);
  const key = atlas.meta.babyEntities[type];
  const rect = key ? atlasRect(key) : null;
  const value = rect ? { texture: pixelTexture(cropAtlas(rect)), w: rect.w, h: rect.h } : null;
  entityTextures.set(cacheKey, value);
  return value;
}

// Overlay layers carry their own texture next to the body's: <body>_wool (sheep), <body>_overlay (stray, bogged),
// <body>_outer_layer (drowned). Slime's outer gel reuses the body texture.
function overlayTexture(type, layerKey) {
  const body = atlas.ready && atlas.meta.entities ? atlas.meta.entities[type] : null;
  if (!body) return null;
  const suffixes = layerKey.endsWith('#wool') ? ['_wool'] : ['_overlay', '_outer_layer'];
  for (const suffix of suffixes) {
    const cacheKey = 'overlay:' + body + suffix;
    if (entityTextures.has(cacheKey)) { const hit = entityTextures.get(cacheKey); if (hit) return hit; continue; }
    const rect = atlasRect(body + suffix);
    const value = rect ? { texture: pixelTexture(cropAtlas(rect)), w: rect.w, h: rect.h } : null;
    entityTextures.set(cacheKey, value);
    if (value) return value;
  }
  return null;
}

// Dropped items and XP orbs are flat sprites in vanilla (ItemEntityRenderer draws the item, ExperienceOrbRenderer a
// 16x16 cell of the orb sheet). Both always face the camera here.
function spriteActor(rect, size, cell) {
  const c = cropAtlas(rect);
  const texture = pixelTexture(c);
  texture.flipY = true;
  texture.needsUpdate = true;
  if (cell) {
    texture.repeat.set(cell[2], cell[3]);
    texture.offset.set(cell[0], cell[1]);
  }
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, alphaTest: 0.1 }));
  sprite.scale.set(size, size, 1);
  sprite.position.y = size / 2 + 0.05;
  return sprite;
}

// ---------- looks: variants, armor, held items, capes, light ----------
function lookKey(look) {
  if (!look) return '';
  return JSON.stringify([look.texture, look.model, look.variant, look.wool, look.armor, look.dye, look.main, look.off, look.cape, look.foil, look.mainTint, look.offTint]);
}

function atlasTexture(key) {
  const cacheKey = 'tex:' + key;
  if (entityTextures.has(cacheKey)) return entityTextures.get(cacheKey);
  const rect = atlasRect(key);
  const value = rect ? { texture: pixelTexture(cropAtlas(rect)), w: rect.w, h: rect.h } : null;
  entityTextures.set(cacheKey, value);
  return value;
}

// Data-driven variants name their texture exactly; enum variants (fox, rabbit, parrot, llama, axolotl, horse,
// mooshroom) follow the jar's file naming next to the default texture: <type>_<v>, <v>, or <v>_<type>.
function variantTexture(type, look) {
  if (!look || !atlas.ready) return null;
  if (look.texture) {
    const hit = atlasTexture(look.texture);
    if (hit) return hit;
  }
  if (look.variant && atlas.meta.entities && atlas.meta.entities[type]) {
    const def = atlas.meta.entities[type];
    const dir = def.slice(0, def.lastIndexOf('/') + 1);
    const name = type.slice(type.indexOf(':') + 1);
    const names = look.variant === 'gray' ? ['gray', 'grey'] : look.variant === 'evil' ? ['caerbannog'] : [look.variant];
    for (const v of names) {
      for (const candidate of [dir + name + '_' + v, dir + v, dir + v + '_' + name]) {
        const hit = atlasTexture(candidate);
        if (hit) return hit;
      }
    }
  }
  return null;
}

const capeTextures = new Map();
function capeTexture(path) {
  if (!capeTextures.has(path)) capeTextures.set(path, pixelTexture(textureLoader.load(path, (t) => { pixelTexture(t); })));
  return capeTextures.get(path);
}

function tint(material, rgb) {
  material.userData.tint = rgb;
  material.color.setHex(rgb);
}

// Armor: equipment/<asset>.json lists texture layers per body kind; head, chest and feet use "humanoid", legs use
// "humanoid_leggings". Dyeable layers (leather) take the item's dye or the asset's undyed color. Held items are the
// item's icon, held in the hand at the end of right_arm / left_arm.
function dress(root, built, look, opts) {
  const extras = [];
  const equipment = atlas.ready && atlas.meta.equipment;
  if (look && Array.isArray(look.armor) && Array.isArray(opts.armor) && equipment) {
    for (let i = 0; i < 4; i++) {
      const asset = look.armor[i], layerKey = opts.armor[i];
      if (!asset || !layerKey || !equipment[asset]) continue;
      const kinds = i === 2 ? ['humanoid_leggings'] : opts.baby ? ['humanoid_baby', 'humanoid'] : ['humanoid'];
      const layers = kinds.map((k) => equipment[asset][k]).find(Boolean);
      if (!layers) continue;
      for (const [textureKey, undyed] of layers) {
        const tex = atlasTexture(textureKey);
        const piece = tex ? modelActor(layerKey, tex.texture, opts.scale) : null;
        if (!piece) continue;
        if (undyed !== null && undyed !== undefined) {
          const dye = look.dye && look.dye[i] >= 0 ? look.dye[i] : undyed >= 0 ? undyed : 0xA06540;
          tint(piece.material, dye);
        }
        if ((look.foil || 0) & (1 << i)) addArmorGlint(piece);
        root.add(piece.turn);
        extras.push({ turn: piece.turn, material: piece.material, model: { parts: piece.parts, walk: 0, zombie: !!opts.zombie } });
      }
    }
  }
  holdItems(built, look, extras);
  return extras;
}

// The lightmap from the terrain shader, on the CPU: mobs and players take the light where they stand.
function lightTint(light) {
  if (fullbright || typeof light !== 'number') return [1, 1, 1];
  const u = opaqueMaterial.uniforms;
  const skyB = u.skyBright.value, amb = u.ambient.value;
  const curve = (l) => { const f = l / 15, g = f / (4 - 3 * f); return g + amb * (1 - g); };
  const sky = curve(light >> 4) * skyB, blk = curve(light & 15) * 1.5;
  let c = [blk, blk * ((blk * 0.6 + 0.4) * 0.6 + 0.4), blk * (blk * blk * 0.6 + 0.4)];
  const skyColor = [skyB * 0.65 + 0.35, skyB * 0.65 + 0.35, 1];
  c = c.map((v, i) => v + skyColor[i] * sky);
  if (u.endTint.value > 0.5) c = c.map((v, i) => v * 0.75 + [0.99, 1.12, 1][i] * 0.25);
  c = c.map((v) => Math.min(1, Math.max(0, v * 0.96 + 0.03)));
  c = c.map((v) => v * 0.5 + (1 - Math.pow(1 - v, 4)) * 0.5);
  return c.map((v) => Math.min(1, Math.max(0, v * 0.96 + 0.03)));
}

function lightActor(root, light) {
  const materials = root.userData.materials;
  if (!materials) return;
  const t = lightTint(light);
  for (const m of materials) {
    if (!m) continue;
    const base = m.userData.tint === undefined ? 0xffffff : m.userData.tint;
    m.color.setRGB(((base >> 16) & 255) / 255 * t[0], ((base >> 8) & 255) / 255 * t[1], (base & 255) / 255 * t[2]);
  }
}

// Projectiles are not living entities, so they skip LivingEntityRenderer's flip and lift and use their own
// renderer's transform (26.2 client jar, javap): ArrowRenderer and LlamaSpitRenderer rotate Y by yRot - 90 then Z by
// xRot; ThrownTridentRenderer uses xRot + 90; WitherSkullRenderer scales (-1, -1, 1) and turns the skull's head part;
// ShulkerBulletRenderer spins by age and scales (-0.5, -0.5, 0.5) under a 1.5x translucent shell.
const PROJECTILES = {
  'minecraft:arrow': 'arrow', 'minecraft:spectral_arrow': 'arrow', 'minecraft:trident': 'trident', 'minecraft:wither_skull': 'skull',
  'minecraft:shulker_bullet': 'bullet', 'minecraft:llama_spit': 'spit', 'minecraft:wind_charge': 'plain', 'minecraft:breeze_wind_charge': 'plain'
};
// Projectiles that vanilla draws as a flat camera-facing texture: [size in blocks, height of its centre].
const BILLBOARDS = { 'minecraft:dragon_fireball': [2, 0.5], 'minecraft:fishing_bobber': [0.5, 0.25] };
const unflipped = (s) => ({ y: 0, sx: s / 16, sy: s / 16, sz: s / 16 });
function buildProjectile(entity, kind) {
  const map = models.data && models.data.entities[entity.type];
  if (!map) return null;
  const look = entity.look || {};
  let tex = entityTexture(entity.type);
  if (entity.type === 'minecraft:arrow' && look.mainTint >= 0) tex = atlasTexture('minecraft:entity/projectiles/arrow_tipped') || tex;
  if (entity.type === 'minecraft:wither_skull' && ((look.foil || 0) & 128)) tex = atlasTexture('minecraft:entity/wither/wither_invulnerable') || tex;
  if (!tex) return null;
  const place = kind === 'skull' ? { y: 0, sx: -1 / 16, sy: -1 / 16, sz: 1 / 16 }
    : kind === 'bullet' ? { y: 0, sx: -0.5 / 16, sy: -0.5 / 16, sz: 0.5 / 16 } : unflipped(1);
  const built = modelActor(map.main, tex.texture, 1, place);
  if (!built) return null;
  const root = new THREE.Group();
  root.add(built.turn);
  const materials = [built.material];
  if (kind === 'bullet') {
    const shell = modelActor(map.main, tex.texture, 1, { y: 0, sx: -0.75 / 16, sy: -0.75 / 16, sz: 0.75 / 16 });
    if (shell) {
      Object.assign(shell.material, { transparent: true, opacity: 0.15, depthWrite: false, alphaTest: 0 });
      built.turn.add(shell.turn);
      materials.push(shell.material);
    }
  }
  root.userData = { kind: 'entity', id: entity.id, type: entity.type, baby: false, hasTexture: true, hasModel: true, projectile: kind,
    turn: built.turn, parts: built.parts, materials, lookKey: lookKey(look) };
  return root;
}

function buildEntity(entity) {
  const look0 = entity.look || {};
  if (entity.type === 'minecraft:lightning_bolt') return buildLightning(entity);
  const projectileKind = PROJECTILES[entity.type];
  if (projectileKind && atlas.ready) {
    const root = buildProjectile(entity, projectileKind);
    if (root) return root;
  }
  if (BILLBOARDS[entity.type] && atlas.ready) {
    const key = atlas.meta.entities && atlas.meta.entities[entity.type];
    const rect = key ? atlasRect(key) : null;
    if (rect) {
      const [size, centre] = BILLBOARDS[entity.type];
      const sprite = spriteActor(rect, size);
      sprite.position.y = centre;
      const root = new THREE.Group();
      root.add(sprite);
      root.userData = { kind: 'entity', id: entity.id, type: entity.type, baby: false, hasTexture: true, hasModel: true, still: true,
        materials: [sprite.material], lookKey: lookKey(look0) };
      return root;
    }
  }
  if (entity.type === 'minecraft:item' && entity.item && atlas.ready && files.items) {
    // ItemEntityRenderer: the ground display transform, spinning and bobbing.
    const obj = buildItem(entity.item, 'ground', { color: typeof look0.mainTint === 'number' ? look0.mainTint : -1, foil: !!((look0.foil || 0) & 16) });
    if (obj) {
      const root = new THREE.Group();
      const spin = new THREE.Group();
      spin.add(obj);
      root.add(spin);
      root.userData = { kind: 'entity', id: entity.id, type: entity.type, item: entity.item, baby: false, hasTexture: true, hasModel: true,
        bob: Math.random() * 6, spin, materials: obj.userData.materials, lookKey: lookKey(look0) };
      return root;
    }
  }
  if (entity.type !== 'minecraft:item' && entity.item && atlas.ready && !(models.data && models.data.entities[entity.type])) {
    // ThrownItemRenderer: the item, facing the camera (splash and lingering potions take their potion color).
    const icon = itemIconCanvas(entity.item, typeof look0.mainTint === 'number' ? look0.mainTint : -1);
    if (icon) {
      const texture = pixelTexture(icon);
      texture.flipY = true; texture.needsUpdate = true;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, alphaTest: 0.1 }));
      const size = entity.type === 'minecraft:fireball' || entity.type === 'minecraft:dragon_fireball' ? 1.5 : 0.5;
      sprite.scale.set(size, size, 1);
      sprite.position.y = Math.max(0.12, (entity.height || 0.25) / 2);
      const root = new THREE.Group();
      root.add(sprite);
      root.userData = { kind: 'entity', id: entity.id, type: entity.type, item: entity.item, baby: false, hasTexture: true, hasModel: true, lookKey: lookKey(look0), still: true,
        materials: [sprite.material] };
      return root;
    }
  }
  if (entity.type === 'minecraft:area_effect_cloud') {
    const root = new THREE.Group();
    root.userData = { kind: 'entity', id: entity.id, type: entity.type, baby: false, hasTexture: true, hasModel: true, lookKey: lookKey(look0), still: true, cloud: true };
    return root;
  }
  if (entity.type === 'minecraft:item' && entity.item && atlas.ready) {
    const rect = itemIcon(entity.item);
    if (rect) {
      const root = new THREE.Group();
      const sprite = spriteActor({ u: rect.u, v: rect.v, w: Math.min(16, rect.w), h: Math.min(16, rect.h) }, 0.35);
      root.add(sprite);
      root.userData = { kind: 'entity', id: entity.id, type: entity.type, item: entity.item, baby: !!entity.baby, hasTexture: true, hasModel: true, bob: Math.random() * 6,
        materials: [sprite.material] };
      return root;
    }
  }
  if (entity.type === 'minecraft:experience_orb' && atlas.ready) {
    const key = atlas.meta.entities && atlas.meta.entities['minecraft:experience_orb'];
    const rect = key ? atlasRect(key) : null;
    if (rect) {
      const root = new THREE.Group();
      const sprite = spriteActor(rect, 0.25, [0, 0.75, 0.25, 0.25]);
      root.add(sprite);
      // ExperienceOrbRenderer lifts the orb's block light, so orbs glow a little in the dark.
      root.userData = { kind: 'entity', id: entity.id, type: entity.type, baby: false, hasTexture: true, hasModel: true, bob: Math.random() * 6,
        materials: [sprite.material], glow: 8 };
      return root;
    }
  }
  const map = models.data && models.data.entities[entity.type];
  if (map) {
    const look = entity.look || {};
    // Variant geometry (cold/warm pig, cow, chicken) and the variant's exact texture, as the server read them.
    const climate = look.model && look.model !== 'normal' && map.variants ? look.model : null;
    let mainLayer = climate && map.variants[climate] ? map.variants[climate] : map.main;
    let babyLayer = climate && map.variants[climate + '_baby'] ? map.variants[climate + '_baby'] : map.baby;
    const variantTex = variantTexture(entity.type, look);
    const babyTex = entity.baby ? (variantTex || babyEntityTexture(entity.type)) : null;
    const useBabyLayer = entity.baby && babyLayer && babyTex;
    const tex = useBabyLayer ? babyTex : (variantTex || entityTexture(entity.type));
    const scale = entity.baby && !useBabyLayer ? 0.5 : 1;
    const built = tex ? modelActor(useBabyLayer ? babyLayer : mainLayer, tex.texture, scale) : null;
    if (built) {
      const root = new THREE.Group();
      root.add(built.turn);
      const zombie = ZOMBIE_ARMS.has(entity.type);
      const extras = [];
      if (!useBabyLayer) {
        for (const layerKey of map.overlays || []) {
          const wool = layerKey.endsWith('#wool');
          if (wool && look.wool === -2) continue;
          const tex2 = overlayTexture(entity.type, layerKey) || tex;
          const extra = modelActor(layerKey, tex2.texture, scale);
          if (!extra) continue;
          if (wool && look.wool >= 0) tint(extra.material, look.wool);
          root.add(extra.turn);
          extras.push({ turn: extra.turn, material: extra.material, model: { parts: extra.parts, walk: 0, zombie } });
        }
      }
      extras.push(...dress(root, built, look, { armor: map.armor, scale, baby: !!entity.baby, type: entity.type, zombie }));
      root.userData = { kind: 'entity', id: entity.id, type: entity.type, baby: !!entity.baby, hasTexture: true, hasModel: true,
        model: { parts: built.parts, walk: 0, zombie }, turn: built.turn, extras, last: null,
        materials: [built.material, ...extras.map((e) => e.material)], lookKey: lookKey(look) };
      return root;
    }
  }
  const width = Number.isFinite(entity.width) && entity.width > 0 ? entity.width : 0.6;
  const height = Number.isFinite(entity.height) && entity.height > 0 ? entity.height : 1.0;
  const tex = entityTexture(entity.type);
  let g;
  if (tex) {
    // Fallback model: the 8x8x8 box-UV head region of the real texture stretched over the hitbox.
    g = boxGeometry(8, 8, 8, 0, 0, tex.w, tex.h);
    g.scale(width / 8, height / 8, width / 8);
  } else {
    g = new THREE.BoxGeometry(width, height, width);
  }
  const material = tex
    ? new THREE.MeshBasicMaterial({ map: tex.texture, alphaTest: 0.1 })
    : new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL((Math.abs(hash(entity.type || '')) % 360) / 360, 0.4, 0.45) });
  if (!tex) tint(material, material.color.getHex());
  const mesh = new THREE.Mesh(g, material);
  mesh.position.y = height / 2;
  const root = new THREE.Group();
  root.add(mesh);
  root.userData = { kind: 'entity', id: entity.id, type: entity.type, baby: !!entity.baby, hasTexture: !!tex, hasModel: false, materials: [material] };
  return root;
}


// ---------- vanilla entity models ----------
// The server reads Minecraft's own model definitions (LayerDefinitions.createRoots) out of the client jar and ships
// them as data. These functions rebuild ModelPart.Cube and PartPose exactly: same vertex order, same box UVs, parts
// posed with translate, then rotation Z*Y*X, then scale, in 1/16 block units, under the renderer's scale(-1, -1, 1)
// and translate(0, -1.501, 0).
const models = { url: null, data: null, geometry: new Map() };

async function loadModels(url) {
  if (!url || models.url === url) return;
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('models HTTP ' + response.status);
  models.data = await response.json();
  models.url = url;
  models.geometry.clear();
  for (const [key, root] of actorMeshes) { actorRoot.remove(root); disposeActor(root); actorMeshes.delete(key); }
}

// Faces as ModelPart.Cube builds them. Vertex indices: 0 (x0,y0,z0) 1 (x1,y0,z0) 2 (x1,y1,z0) 3 (x0,y1,z0)
// 4 (x0,y0,z1) 5 (x1,y0,z1) 6 (x1,y1,z1) 7 (x0,y1,z1). UV corners name the u/v stops below. Bit = visibleFaces mask.
const CUBE_FACES = [
  { bit: 1, v: [5, 4, 0, 1], uv: ['m', 'r', 'n', 's'] },   // down
  { bit: 2, v: [2, 3, 7, 6], uv: ['n', 's', 'o', 'r'] },   // up
  { bit: 16, v: [0, 4, 7, 3], uv: ['l', 's', 'm', 't'] },  // west
  { bit: 4, v: [1, 0, 3, 2], uv: ['m', 's', 'n', 't'] },   // north
  { bit: 32, v: [5, 1, 2, 6], uv: ['n', 's', 'p', 't'] },  // east
  { bit: 8, v: [4, 5, 6, 7], uv: ['p', 's', 'q', 't'] }    // south
];

// Outward normals per face in model space (ModelPart.Polygon: a mirrored cube negates x), for the entity lighting.
const CUBE_NORMALS = { 1: [0, -1, 0], 2: [0, 1, 0], 16: [-1, 0, 0], 4: [0, 0, -1], 32: [1, 0, 0], 8: [0, 0, 1] };
function cubeGeometry(cubes, tw, th) {
  const pos = [], uv = [], index = [], normal = [];
  for (const c of cubes) {
    const [ox, oy, oz, dx, dy, dz, tu0, tv0, gx, gy, gz, mirror, su, sv, mask] = c;
    const w = tw * (su || 1), h = th * (sv || 1);
    let x0 = ox - gx, x1 = ox + dx + gx;
    const y0 = oy - gy, y1 = oy + dy + gy, z0 = oz - gz, z1 = oz + dz + gz;
    if (mirror) { const t = x0; x0 = x1; x1 = t; }
    const corners = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const u = Math.trunc(tu0), v = Math.trunc(tv0);
    const stops = { l: u, m: u + dz, n: u + dz + dx, o: u + dz + dx + dx, p: u + dz + dx + dz, q: u + dz + dx + dz + dx, r: v, s: v + dz, t: v + dz + dy };
    for (const face of CUBE_FACES) {
      if (!(mask & face.bit)) continue;
      const u1 = stops[face.uv[0]], v1 = stops[face.uv[1]], u2 = stops[face.uv[2]], v2 = stops[face.uv[3]];
      // Polygon remaps its four vertices to (u2,v1) (u1,v1) (u1,v2) (u2,v2), and reverses them when mirrored.
      let quad = face.v.map((i, k) => ({ p: corners[i], t: [[u2, v1], [u1, v1], [u1, v2], [u2, v2]][k] }));
      if (mirror) quad = quad.reverse();
      const b = pos.length / 3;
      const n = CUBE_NORMALS[face.bit];
      for (const q of quad) { pos.push(q.p[0], q.p[1], q.p[2]); uv.push(q.t[0] / w, q.t[1] / h); normal.push(mirror ? -n[0] : n[0], n[1], n[2]); }
      index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setIndex(index);
  geometry.userData.shared = true;
  return geometry;
}

// Vanilla entity lighting (Lighting.setupLevel): two fixed world-space lights, each 0.6 diffuse over 0.4 ambient and
// clamped to 1, so a mob's top is bright and its sides fall off the way they do in game. The light level where the
// mob stands (lightActor) multiplies on top through the material color.
const ENTITY_LIGHT_0 = new THREE.Vector3(0.2, 1, -0.7).normalize();
const ENTITY_LIGHT_1 = new THREE.Vector3(-0.2, 1, 0.7).normalize();
function shadeEntity(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.entityLight0 = { value: ENTITY_LIGHT_0 };
    shader.uniforms.entityLight1 = { value: ENTITY_LIGHT_1 };
    shader.vertexShader = 'varying vec3 vEntityN;\n' + shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vEntityN = mat3(modelMatrix) * normal;');
    shader.fragmentShader = 'uniform vec3 entityLight0;\nuniform vec3 entityLight1;\nvarying vec3 vEntityN;\n' + shader.fragmentShader.replace('#include <opaque_fragment>',
      `float entityN = length(vEntityN);
  if (entityN > 0.001) {
    vec3 n = vEntityN / entityN;
    outgoingLight *= min(1.0, (max(0.0, dot(entityLight0, n)) + max(0.0, dot(entityLight1, n))) * 0.6 + 0.4);
  }
  #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => 'liveview-entity-light';
  return material;
}

function buildParts(layerKey, part, path, material, parts, tw, th) {
  const node = new THREE.Group();
  const [x, y, z, xr, yr, zr, xs, ys, zs] = part.pose;
  node.position.set(x, y, z);
  node.rotation.order = 'ZYX';
  node.rotation.set(xr, yr, zr);
  node.scale.set(xs || 1, ys || 1, zs || 1);
  if (part.cubes.length) {
    const key = layerKey + '/' + path;
    let geometry = models.geometry.get(key);
    if (!geometry) { geometry = cubeGeometry(part.cubes, tw, th); models.geometry.set(key, geometry); }
    node.add(new THREE.Mesh(geometry, material));
  }
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name && !parts[name]) parts[name] = { node, base: [xr, yr, zr], pos: [x, y, z] };
  for (const [childName, child] of Object.entries(part.children)) {
    node.add(buildParts(layerKey, child, path + '/' + childName, material, parts, tw, th));
  }
  return node;
}

// place: the renderer's transform under the model. Living entities (the default) use LivingEntityRenderer's
// scale(-1, -1, 1) and translate(0, -1.501, 0); projectiles pass their own renderer's.
function modelActor(layerKey, texture, scale, place) {
  const layer = models.data && models.data.layers[layerKey];
  if (!layer || !texture) return null;
  const material = shadeEntity(new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.1, side: THREE.DoubleSide }));
  const parts = {};
  const model = buildParts(layerKey, layer.root, '', material, parts, layer.tw, layer.th);
  const holder = new THREE.Group();
  const at = place || { y: 1.501 * scale, sx: -scale / 16, sy: -scale / 16, sz: scale / 16 };
  holder.position.y = at.y;
  holder.scale.set(at.sx, at.sy, at.sz);
  holder.add(model);
  const turn = new THREE.Group();
  turn.add(holder);
  return { turn, parts, material };
}

// Limb names used by vanilla's biped and quadruped models; setupAnim is Java code, so the swing is rebuilt from these.
const ZOMBIE_ARMS = new Set(['minecraft:zombie', 'minecraft:husk', 'minecraft:drowned', 'minecraft:zombie_villager', 'minecraft:giant', 'minecraft:zombified_piglin']);
function disposeActor(root) {
  if (root.userData && root.userData.shadow) dropShadow(root);
  root.traverse((node) => {
    if (node.geometry && !node.geometry.userData.shared && !node.userData.glint) node.geometry.dispose();
    if (node.material && !node.material.userData.shared) {
      if (node.material.map && node.isSprite) node.material.map.dispose();
      node.material.dispose();
    }
  });
}

function poseProjectile(root, s, dt) {
  const ud = root.userData, turn = ud.turn;
  switch (ud.projectile) {
    case 'arrow': case 'spit':
      turn.rotation.set(0, (s.yaw - 90) * DEG, s.pitch * DEG, 'YZX');
      turn.position.y = ud.projectile === 'spit' ? 0.15 : 0;
      break;
    case 'trident':
      turn.rotation.set(0, (s.yaw - 90) * DEG, (s.pitch + 90) * DEG, 'YZX');
      break;
    case 'skull': {
      // SkullModel.setupAnim: head yRot and xRot from the entity's rotation.
      const head = ud.parts.head;
      if (head) head.node.rotation.set(s.pitch * DEG, s.yaw * DEG, 0);
      break;
    }
    case 'bullet': {
      const age = ud.age = (ud.age || 0) + dt * 20;
      turn.position.y = 0.15;
      turn.rotation.set(Math.cos(age * 0.1) * Math.PI, Math.sin(age * 0.1) * Math.PI, Math.sin(age * 0.15) * 2 * Math.PI, 'YXZ');
      break;
    }
    default: break;
  }
}

// Trails the client spawns for flying projectiles each tick (AbstractArrow, SpectralArrow, AbstractHurtingProjectile,
// ShulkerBullet, EyeOfEnder, FireworkRocketEntity). Velocity comes from the played-back motion.
const TRAILS = {
  'minecraft:wither_skull': 'smoke', 'minecraft:fireball': 'smoke', 'minecraft:small_fireball': 'smoke', 'minecraft:dragon_fireball': 'breath',
  'minecraft:shulker_bullet': 'end_rod', 'minecraft:eye_of_ender': 'portal', 'minecraft:firework_rocket': 'firework',
  'minecraft:spectral_arrow': 'spectral', 'minecraft:arrow': 'arrow'
};
function projectileTrail(root, entity, s, dt) {
  const ud = root.userData;
  const kind = TRAILS[entity.type];
  const prev = ud.trailAt;
  ud.trailAt = { x: s.x, y: s.y, z: s.z };
  if (!kind || !prev || !mapVisible() || dt <= 0) return;
  const ticks = dt * 20;
  const vx = (s.x - prev.x) / ticks, vy = (s.y - prev.y) / ticks, vz = (s.z - prev.z) / ticks;
  const flying = vx * vx + vy * vy + vz * vz > 0.0004;
  ud.trail = (ud.trail || 0) + ticks;
  const look = entity.look || {};
  const h = Number.isFinite(entity.height) ? entity.height : 0.5, w = Number.isFinite(entity.width) ? entity.width : 0.5;
  while (ud.trail >= 1) {
    ud.trail -= 1;
    ud.trailTicks = (ud.trailTicks || 0) + 1;
    const x = s.x, y = s.y + h / 2, z = s.z;
    if (kind === 'arrow') {
      if (flying && ((look.foil || 0) & 64)) {
        for (let i = 0; i < 4; i++) spawnParticle('minecraft:crit', x + vx * i / 4, y + vy * i / 4, z + vz * i / 4, -vx, -vy + 0.2, -vz);
      }
      if (look.mainTint >= 0 && (flying || ud.trailTicks % 5 === 0)) {
        for (let i = 0; i < (flying ? 2 : 1); i++) {
          spawnParticle('minecraft:entity_effect', x + (Math.random() - 0.5) * w, s.y + Math.random() * h, z + (Math.random() - 0.5) * w, 0, 0, 0, { color: look.mainTint });
        }
      }
    } else if (!flying) {
      continue;
    } else if (kind === 'spectral') {
      spawnParticle('minecraft:instant_effect', x + (Math.random() - 0.5) * w, s.y + Math.random() * h, z + (Math.random() - 0.5) * w, 0, 0, 0);
    } else if (kind === 'smoke') {
      spawnParticle('minecraft:smoke', x, y, z, 0, 0, 0);
    } else if (kind === 'breath') {
      spawnParticle('minecraft:dragon_breath', x, y, z, 0, 0, 0);
    } else if (kind === 'end_rod') {
      spawnParticle('minecraft:end_rod', x - vx, y - vy + 0.15, z - vz, 0, 0, 0);
    } else if (kind === 'portal') {
      for (let i = 0; i < 4; i++) spawnParticle('minecraft:portal', x - vx * i / 4 + rand(-0.3, 0.3), y - vy * i / 4 - 0.5 + rand(-0.3, 0.3), z - vz * i / 4 + rand(-0.3, 0.3), vx, vy, vz);
    } else if (kind === 'firework') {
      spawnParticle('minecraft:firework', x, s.y, z, gauss() * 0.05, -vy * 0.5, gauss() * 0.05);
    }
  }
}

function syncActors(dt) {
  const seen = new Set();
  glintUniforms.time.value = performance.now() / 1000;
  for (const player of players.values()) {
    if (player.dimension !== cameraDim || !Number.isFinite(player.x)) continue;
    const key = 'p:' + player.uuid;
    seen.add(key);
    let root = actorMeshes.get(key);
    const stale = root && (root.userData.skin !== (player.skin || '') || root.userData.skinModel !== (player.skinModel || '')
      || (!root.userData.hasTexture && atlas.ready));
    if (stale) { actorRoot.remove(root); disposeActor(root); root = null; }
    if (root && !root.userData.hasModel && models.data) { actorRoot.remove(root); disposeActor(root); root = null; }
    if (root && root.userData.lookKey !== undefined && root.userData.lookKey !== lookKey(player.look)) { actorRoot.remove(root); disposeActor(root); root = null; }
    if (!root) { root = buildPlayer(player); actorMeshes.set(key, root); actorRoot.add(root); }
    const look = player.look || {};
    const motion = look.motion || {};
    const s = ease(root, key, player, dt);
    root.position.set(s.x, s.y, s.z);
    updateShadow(root, 'minecraft:player', 0.6, false, s.x, s.y, s.z, look.light);
    // In their own view you do not see their body, name tag or shadow, as in game.
    root.visible = !(following === player.uuid && followMode === 'first');
    if (!root.visible && root.userData.shadow) root.userData.shadow.visible = false;
    const pose = motion.pose || 'standing';
    const crouch = pose === 'crouching';
    if (root.userData.model) {
      const st = {
        limbPos: s.limbPos, limbAmt: pose === 'swimming' || pose === 'fall_flying' ? 0 : s.limbAmt, age: s.age,
        headYaw: 0, pitch: s.pitch * DEG, pose, crouch, riding: !!motion.riding,
        attack: swingProgress(root.userData, motion, dt), swingOff: !!root.userData.swingOff,
        main: look.main, off: look.off, using: typeof motion.using === 'number' ? motion.using : -1, useOff: !!motion.useOff
      };
      const turn = root.userData.turn;
      turn.rotation.set(0, (180 - s.yaw) * DEG, 0);
      turn.position.set(0, 0, 0);
      // PlayerRenderer.setupRotations: swimming and elytra flight tip the body forward; sleeping lies it down.
      if (pose === 'swimming' || pose === 'fall_flying') {
        turn.rotation.set((-90 - s.pitch) * DEG * -1, (180 - s.yaw) * DEG, 0, 'YXZ');
        turn.position.set(0, pose === 'swimming' ? 0.3 : 0.9, 0);
      } else if (pose === 'sleeping') {
        turn.rotation.set(0, (180 - s.yaw) * DEG, Math.PI / 2, 'YXZ');
        turn.position.set(0, 0.2, 0);
      }
      animateHumanoid(root.userData.model, st);
      for (const extra of root.userData.extras || []) {
        if (!extra.turn) continue;
        animateHumanoid(extra.model, st);
        extra.turn.rotation.copy(turn.rotation);
        extra.turn.position.copy(turn.position);
      }
      lightActor(root, look.light);
      hurtTint(root, motion.hurt);
      const label = root.userData.label;
      if (label) {
        label.position.y = crouch ? 1.89 : pose === 'sleeping' || pose === 'swimming' ? 0.9 : 2.19;
        // Sneaking players' tags do not show through walls.
        if (label.userData.nameTag) label.userData.nameTag.through.visible = !crouch;
      }
      continue;
    }
    root.userData.walk += Math.min(s.limbAmt, 1) * dt * 8;
    const swing = Math.sin(root.userData.walk) * s.limbAmt * 0.9;
    const j = root.userData.joints;
    j.rightArm.rotation.x = swing; j.leftArm.rotation.x = -swing;
    j.rightLeg.rotation.x = -swing; j.leftLeg.rotation.x = swing;
    j.head.rotation.x = s.pitch * DEG;
    root.rotation.y = -s.yaw * DEG;
  }
  for (const entity of entities.values()) {
    if (entity.dimension !== cameraDim || !Number.isFinite(entity.x)) continue;
    const key = 'e:' + entity.id;
    seen.add(key);
    let root = actorMeshes.get(key);
    const wantsModel = !!(models.data && models.data.entities[entity.type]) || (entity.type === 'minecraft:item' && !!entity.item);
    if (root && ((!root.userData.hasTexture && atlas.ready && entityTexture(entity.type)) || (wantsModel && !root.userData.hasModel) || root.userData.baby !== !!entity.baby
      || (root.userData.lookKey !== undefined && root.userData.lookKey !== lookKey(entity.look)))) {
      actorRoot.remove(root); disposeActor(root); root = null;
    }
    if (!root) { root = buildEntity(entity); actorMeshes.set(key, root); actorRoot.add(root); }
    const s = ease(root, key, entity, dt);
    root.position.set(s.x, s.y, s.z);
    updateShadow(root, entity.type, entity.width, !!entity.baby, s.x, s.y, s.z, entity.look && entity.look.light);
    const light = entity.look && entity.look.light;
    if (root.userData.projectile) {
      poseProjectile(root, s, dt);
      projectileTrail(root, entity, s, dt);
      lightActor(root, light);
      continue;
    }
    if (root.userData.cloud) { if (mapVisible()) cloudParticles(entity, dt); continue; }
    if (root.userData.still) {
      if (root.userData.bolt) {
        weather.flash = 1;
        const now = performance.now();
        if (now - root.userData.boltAt > 100) { root.userData.boltAt = now; jitterLightning(root); }
        continue;
      }
      projectileTrail(root, entity, s, dt);
      lightActor(root, light);
      continue;
    }
    if (root.userData.bob !== undefined) {
      root.userData.bob += dt * 2;
      root.position.y += Math.sin(root.userData.bob) * 0.1 + 0.1 + (root.userData.spin ? 0.25 : 0.05);
      if (root.userData.spin) root.userData.spin.rotation.y = root.userData.bob / 2;
      const glow = root.userData.glow || 0;
      if (root.userData.materials) lightActor(root, typeof light === 'number' && glow ? (light & 0xF0) | Math.max(light & 15, glow) : light);
      continue;
    }
    if (root.userData.model) {
      const body = s.yaw;
      const head = s.headYaw;
      let net = ((head - body) % 360 + 540) % 360 - 180;
      net = Math.max(-75, Math.min(75, net));
      const pitch = s.pitch * DEG;
      const motion = (entity.look && entity.look.motion) || {};
      const attack = swingProgress(root.userData, motion, dt);
      animateModel(root.userData.model, s.limbPos, s.limbAmt, net * DEG, pitch);
      if (attack > 0 && root.userData.model.parts.right_arm) root.userData.model.parts.right_arm.node.rotation.x -= Math.sin(attack * Math.PI) * 1.2;
      root.userData.turn.rotation.y = (180 - body) * DEG;
      for (const extra of root.userData.extras || []) {
        if (!extra.turn) continue;
        animateModel(extra.model, s.limbPos, s.limbAmt, net * DEG, pitch);
        extra.turn.rotation.y = root.userData.turn.rotation.y;
      }
      lightActor(root, entity.look && entity.look.light);
      hurtTint(root, motion.hurt);
    } else {
      root.rotation.y = -s.yaw * DEG;
      lightActor(root, light);
    }
  }
  for (const [key, root] of actorMeshes) {
    if (!seen.has(key)) { actorRoot.remove(root); disposeActor(root); actorMeshes.delete(key); }
  }
  forgetTracks(seen);
}

// ---------- game files: item models, the default font, GUI textures, glint ----------
// The server resolves assets/*/items/*.json into item nodes and models (see ItemModels.java); this draws them the way
// the item renderer does: baked quads for block items, extruded sprites for builtin/generated items in hands and on
// the ground, flat sprites in slots, and the block-entity model for special renderers.
const DEG = Math.PI / 180;
const files = { items: null, images: new Map(), fontJson: null, font: null, ready: false };
const glintTexture = { item: null, armor: null };

function loadImage(url) {
  return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
}

async function loadFiles(meta) {
  const f = (meta && meta.files) || {};
  const jobs = [];
  if (f.items) jobs.push(fetch(f.items, { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : null).then((j) => { files.items = j; }));
  if (f.font_json) jobs.push(fetch(f.font_json, { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : null).then((j) => { files.fontJson = j; }));
  for (const [name, url] of Object.entries(f)) {
    if (typeof url === 'string' && url.endsWith('.png')) jobs.push(loadImage(url).then((img) => files.images.set(name, img)));
  }
  await Promise.allSettled(jobs);
  buildFont();
  const cross = files.images.get('crosshair');
  if (cross) {
    const el = stage.querySelector('.lv-cross');
    el.style.setProperty('--cross-img', 'url(' + cross.src + ')');
    el.classList.add('sprite');
  }
  for (const [key, name] of [['item', 'glint'], ['armor', 'glint_armor']]) {
    const img = files.images.get(name);
    if (!img) continue;
    const t = new THREE.Texture(img);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
    t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
    glintTexture[key] = t;
  }
  glintUniforms.tex.value = glintTexture.item;
  files.ready = true;
  iconCache.clear();
  textCache.clear();
  // Rebuild actors so held items and name tags use the game's models and font.
  for (const [key, root] of actorMeshes) { actorRoot.remove(root); disposeActor(root); actorMeshes.delete(key); }
  playerSig = '';
  schedulePaint();
}

// ---------- the default font (assets/minecraft/font/include/default.json bitmap providers) ----------
function buildFont() {
  const providers = (files.fontJson && files.fontJson.providers) || [];
  const names = { ascii: 'font_ascii', accented: 'font_accented', nonlatin_european: 'font_nonlatin' };
  const glyphs = new Map();
  for (const p of providers) {
    if (p.type !== 'bitmap' || !Array.isArray(p.chars) || !p.file) continue;
    const base = p.file.replace(/^minecraft:/, '').replace(/^font\//, '').replace(/\.png$/, '');
    const img = files.images.get(names[base]);
    if (!img) continue;
    const rows = p.chars.length, cols = [...p.chars[0]].length;
    const cw = img.width / cols, ch = img.height / rows;
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, img.width, img.height).data;
    const height = p.height || 8, ascent = p.ascent === undefined ? 7 : p.ascent;
    const scale = height / ch;
    p.chars.forEach((row, r) => {
      [...row].forEach((chr, col) => {
        if (chr === '\u0000' || glyphs.has(chr)) return;
        let w = 0;
        for (let x = cw - 1; x >= 0 && !w; x--) {
          for (let y = 0; y < ch; y++) {
            if (data[((r * ch + y) * img.width + col * cw + x) * 4 + 3] > 0) { w = x + 1; break; }
          }
        }
        glyphs.set(chr, { img: c, sx: col * cw, sy: r * ch, sw: cw, sh: ch, dw: cw * scale, dh: height, top: 7 - ascent, adv: Math.floor(0.5 + w * scale) + 1 });
      });
    });
  }
  glyphs.set(' ', { img: null, adv: 4 });
  files.font = glyphs.size > 1 ? glyphs : null;
}

const NAMED_COLORS = { 0: 0x000000, 1: 0x0000AA, 2: 0x00AA00, 3: 0x00AAAA, 4: 0xAA0000, 5: 0xAA00AA, 6: 0xFFAA00, 7: 0xAAAAAA, 8: 0x555555, 9: 0x5555FF, a: 0x55FF55, b: 0x55FFFF, c: 0xFF5555, d: 0xFF55FF, e: 0xFFFF55, f: 0xFFFFFF };
function glyphAdvance(chr, bold) {
  const g = files.font && files.font.get(chr);
  return (g ? g.adv : 6) + (bold && chr !== ' ' ? 1 : 0);
}
function measureText(segs) {
  let w = 0;
  for (const [text, , flags] of segs) for (const chr of String(text)) w += glyphAdvance(chr, flags & 1);
  return w;
}
// Draws segments [[text, rgb or -1, flags]] at font pixel scale `s`; returns the advance in font pixels.
function drawText(ctx, segs, x, y, s, { shadow = true, color = 0xFFFFFF, alpha = 1 } = {}) {
  let pen = x;
  const tmp = drawText.tmp || (drawText.tmp = document.createElement('canvas'));
  for (const [text, segColor, flags = 0] of segs) {
    const rgb = segColor >= 0 ? segColor : color;
    const chars = [...String(text)];
    let w = 0;
    for (const chr of chars) w += glyphAdvance(chr, flags & 1);
    if (!w) continue;
    tmp.width = (w + 3) * s; tmp.height = 12 * s;
    const t = tmp.getContext('2d');
    t.imageSmoothingEnabled = false;
    let px = 0;
    for (let chr of chars) {
      if (flags & 16) chr = String.fromCharCode(33 + Math.floor(Math.random() * 90));
      const g = files.font && files.font.get(chr);
      const italic = flags & 2;
      const drawGlyph = (dx) => {
        if (g && g.img) {
          if (italic) t.setTransform(1, 0, -0.25, 1, 2 * s, 0);
          t.drawImage(g.img, g.sx, g.sy, g.sw, g.sh, (px + dx) * s, (g.top + 1) * s, g.dw * s, g.dh * s);
          t.setTransform(1, 0, 0, 1, 0, 0);
        } else if (chr !== ' ') {
          t.fillStyle = '#fff'; t.font = (8 * s) + 'px sans-serif'; t.textBaseline = 'top';
          t.fillText(chr, (px + dx) * s, 1 * s);
        }
      };
      drawGlyph(0);
      if (flags & 1) drawGlyph(1);
      px += glyphAdvance(chr, flags & 1);
    }
    t.fillStyle = '#fff';
    if (flags & 4) t.fillRect(0, 10 * s, w * s, s);
    if (flags & 8) t.fillRect(0, 4.5 * s, w * s, s);
    t.globalCompositeOperation = 'source-in';
    const paint = (c) => { t.fillStyle = 'rgb(' + (c >> 16 & 255) + ',' + (c >> 8 & 255) + ',' + (c & 255) + ')'; t.fillRect(0, 0, tmp.width, tmp.height); };
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    if (shadow) { paint((rgb & 0xFCFCFC) >> 2); ctx.drawImage(tmp, (pen + 1) * s, y * s); }
    paint(rgb);
    ctx.drawImage(tmp, pen * s, (y - 1) * s);
    ctx.restore();
    t.globalCompositeOperation = 'source-over';
    pen += w;
  }
  return pen - x;
}
const textCache = new Map();
// One line in a canvas at scale s. bg is a CSS color for the vanilla text background (name tags, chat).
function textCanvas(segs, s = 2, { shadow = true, bg = null, pad = 1, color = 0xFFFFFF } = {}) {
  const key = JSON.stringify(segs) + s + shadow + bg + pad + color;
  if (textCache.has(key)) return textCache.get(key);
  const w = measureText(segs);
  const c = document.createElement('canvas');
  c.width = (w + pad * 2 + 1) * s; c.height = (9 + pad * 2) * s;
  const ctx = c.getContext('2d');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
  drawText(ctx, segs, pad, pad + 1, s, { shadow, color });
  if (textCache.size > 600) textCache.delete(textCache.keys().next().value);
  textCache.set(key, c);
  return c;
}
const plain = (text, color = -1, flags = 0) => [[String(text), color, flags]];

// ---------- item models ----------
const ITEM_SHADE = [0.5, 1, 0.8, 0.8, 0.6, 0.6];
const itemEntry = (id) => files.items && files.items.items[id];
const itemModelData = (id) => files.items && id ? files.items.models[id] : null;

function tintFor(tints, index, color) {
  if (index < 0 || !tints || !tints[index]) return 0xFFFFFF;
  const [kind, value] = tints[index];
  if ((kind === 'dye' || kind === 'potion') && color >= 0) return color;
  return value >= 0 ? value : 0xFFFFFF;
}

function transformGroups(t) {
  const outer = new THREE.Group(), mid = new THREE.Group(), inner = new THREE.Group();
  outer.position.set(t[0], t[1], t[2]);
  outer.quaternion.set(t[3], t[4], t[5], t[6]).normalize();
  mid.scale.set(t[7] || 1e-4, t[8] || 1e-4, t[9] || 1e-4);
  inner.quaternion.set(t[10], t[11], t[12], t[13]).normalize();
  outer.add(mid); mid.add(inner);
  return { outer, inner };
}

function quadGeometry(quads, tints, color) {
  const pos = new Float32Array(quads.length * 12), uv = new Float32Array(quads.length * 8), col = new Float32Array(quads.length * 12);
  const index = [];
  quads.forEach((q, i) => {
    pos.set(q.slice(0, 12), i * 12);
    uv.set(q.slice(12, 20), i * 8);
    const c = tintFor(tints, q[20], color);
    const shade = q[22] && q[21] >= 0 ? ITEM_SHADE[q[21]] : 1;
    for (let v = 0; v < 4; v++) {
      col[i * 12 + v * 3] = (c >> 16 & 255) / 255 * shade;
      col[i * 12 + v * 3 + 1] = (c >> 8 & 255) / 255 * shade;
      col[i * 12 + v * 3 + 2] = (c & 255) / 255 * shade;
    }
    const b = i * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(index);
  return g;
}

const pixelCache = new Map();
function layerPixels(key) {
  if (pixelCache.has(key)) return pixelCache.get(key);
  const r = atlasRect(key);
  let out = null;
  if (r) {
    const h = Math.min(r.h, r.w);
    out = { r, w: r.w, h, data: atlas.canvas.getContext('2d', { willReadFrequently: true }).getImageData(r.u, r.v, r.w, h).data };
  }
  pixelCache.set(key, out);
  return out;
}

// builtin/generated: flat in the GUI; in hands and on the ground ItemModelGenerator extrudes each layer one pixel
// thick, with an edge face wherever an opaque pixel meets a transparent one.
function generatedGeometry(layers, tints, color, extrude) {
  const quads = [];
  const S = atlas.size;
  layers.forEach((key, layerIndex) => {
    const px = layerPixels(key);
    if (!px) return;
    const { r, w, h, data } = px;
    const u0 = r.u / S, v0 = r.v / S, u1 = (r.u + w) / S, v1 = (r.v + h) / S;
    const z0 = extrude ? 7.5 / 16 : 0.5 + layerIndex * 0.001, z1 = extrude ? 8.5 / 16 : 0.5 + layerIndex * 0.001;
    // south (front) and north (back)
    quads.push([0, 1, z1, 0, 0, z1, 1, 0, z1, 1, 1, z1, u0, v0, u0, v1, u1, v1, u1, v0, layerIndex, extrude ? 3 : -1, 1]);
    quads.push([1, 1, z0, 1, 0, z0, 0, 0, z0, 0, 1, z0, u1, v0, u1, v1, u0, v1, u0, v0, layerIndex, extrude ? 2 : -1, 1]);
    if (!extrude) return;
    const a = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] > 0;
    const pw = 1 / w, ph = 1 / h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!a(x, y)) continue;
        const X0 = x * pw, X1 = (x + 1) * pw, Y1 = 1 - y * ph, Y0 = 1 - (y + 1) * ph;
        const tu0 = (r.u + x + 0.1) / S, tu1 = (r.u + x + 0.9) / S, tv0 = (r.v + y + 0.1) / S, tv1 = (r.v + y + 0.9) / S;
        const uvs = [tu0, tv0, tu0, tv1, tu1, tv1, tu1, tv0];
        if (!a(x - 1, y)) quads.push([X0, Y1, z0, X0, Y0, z0, X0, Y0, z1, X0, Y1, z1, ...uvs, layerIndex, 4, 1]);
        if (!a(x + 1, y)) quads.push([X1, Y1, z1, X1, Y0, z1, X1, Y0, z0, X1, Y1, z0, ...uvs, layerIndex, 5, 1]);
        if (!a(x, y - 1)) quads.push([X0, Y1, z0, X0, Y1, z1, X1, Y1, z1, X1, Y1, z0, ...uvs, layerIndex, 1, 1]);
        if (!a(x, y + 1)) quads.push([X0, Y0, z1, X0, Y0, z0, X1, Y0, z0, X1, Y0, z1, ...uvs, layerIndex, 0, 1]);
      }
    }
  });
  const layerTints = layers.map((_, i) => [ 'c', tintFor(tints, i, color) ]);
  return quads.length ? quadGeometry(quads, layerTints, -1) : null;
}

function itemMaterial(gui) {
  const m = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, alphaTest: 0.1, side: THREE.DoubleSide });
  m.userData.item = true;
  if (gui) m.depthTest = true;
  return m;
}

function buildNode(node, parent, opts, display, info) {
  if (!node) return false;
  let target = parent;
  if (node.t) { const g = transformGroups(node.t); parent.add(g.outer); target = g.inner; }
  if (node.c) {
    let any = false;
    for (const child of node.c) any = buildNode(child, target, opts, display, info) || any;
    return any;
  }
  const model = itemModelData(node.m);
  if (model && !info.model) info.model = model;
  const s = node.s;
  if (s && s.layer && models.data && models.data.layers[s.layer]) {
    let built = false;
    for (const [layerKey, texKey] of [[s.layer, s.tex], [s.layer2, s.tex2]]) {
      const layer = layerKey && models.data.layers[layerKey];
      const tex = texKey && atlasTexture(texKey);
      if (!layer || !tex) continue;
      const material = new THREE.MeshBasicMaterial({ map: tex.texture, alphaTest: 0.1, side: THREE.DoubleSide });
      const holder = new THREE.Group();
      holder.scale.setScalar(1 / 16);
      holder.add(buildParts(layerKey, layer.root, '', material, {}, layer.tw, layer.th));
      target.add(holder);
      info.materials.push(material);
      holder.traverse((n) => { if (n.isMesh) info.meshes.push(n); });
      built = true;
    }
    if (built) return true;
  }
  if (!model) return false;
  let geometry = null;
  if (model.q && model.q.length) geometry = quadGeometry(model.q, node.tints, opts.color);
  else if (model.g) geometry = generatedGeometry(model.l || [], node.tints, opts.color, display !== 'gui');
  else if (model.p) geometry = generatedGeometry([model.p], null, -1, display !== 'gui');
  if (!geometry) return false;
  const material = itemMaterial(display === 'gui');
  const mesh = new THREE.Mesh(geometry, material);
  target.add(mesh);
  info.materials.push(material);
  info.meshes.push(mesh);
  if (model.g) info.generated = true;
  return true;
}

// The item as ItemRenderer draws it for one display context, centered like vanilla (display transform, then
// translate -0.5). opts: { color: stack tint or -1, foil }.
function buildItem(id, display, opts = {}) {
  const entry = itemEntry(id);
  if (!entry || !atlas.ready) return null;
  const node = display === 'gui' ? entry.gui : (entry.hand || entry.gui);
  const inner = new THREE.Group();
  const info = { model: null, materials: [], meshes: [], generated: false };
  if (!buildNode(node, inner, { color: opts.color === undefined ? -1 : opts.color }, display, info)) return null;
  const d = info.model && info.model.d;
  const outer = new THREE.Group();
  let key = display, mirror = false;
  if (display === 'thirdperson_lefthand' && d && !d[display]) { key = 'thirdperson_righthand'; mirror = true; }
  const t = d && d[key];
  if (t) {
    outer.position.set((mirror ? -t[3] : t[3]) / 16, t[4] / 16, t[5] / 16);
    outer.rotation.set(t[0] * DEG, (mirror ? -t[1] : t[1]) * DEG, (mirror ? -t[2] : t[2]) * DEG, 'XYZ');
    outer.scale.set(t[6], t[7], t[8]);
  }
  inner.position.set(-0.5, -0.5, -0.5);
  outer.add(inner);
  if (opts.foil) addGlint(info.meshes, false);
  outer.userData.materials = info.materials;
  return outer;
}

// The enchantment glint: the game's glint texture scrolled across the surface and added on top. It samples the
// mesh's own texture and draws nothing where that is transparent, so it follows the item's shape (a sword, not its
// square) and wraps around armor and block items. Each mesh gets its own material for its texture; the glint
// texture and the clock are shared uniforms.
const glintUniforms = { tex: { value: null }, time: { value: 0 } };
const glintVertex = `
uniform float scale;
varying vec2 vGlint; varying vec2 vUv;
void main() {
  vUv = uv;
  vGlint = vec2(position.x + position.z * 0.7, position.y + position.z * 0.3) * scale;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const glintFragment = `
precision highp float;
uniform sampler2D tex; uniform sampler2D map; uniform float time; uniform float strength;
varying vec2 vGlint; varying vec2 vUv;
void main() {
  if (texture2D(map, vUv).a < 0.1) discard;
  float a = 0.1745;
  vec2 r = mat2(cos(a), -sin(a), sin(a), cos(a)) * vGlint;
  vec3 c = texture2D(tex, r + vec2(time * 0.125, 0.0)).rgb + texture2D(tex, vec2(r.x * 0.8, r.y * 1.2) - vec2(time * 0.09, 0.0)).rgb;
  gl_FragColor = vec4(c * strength, 1.0);
}`;
function glintMaterialFor(map, scale, strength = 0.5) {
  const m = new THREE.ShaderMaterial({
    uniforms: { tex: glintUniforms.tex, time: glintUniforms.time, map: { value: map }, scale: { value: scale }, strength: { value: strength } },
    vertexShader: glintVertex, fragmentShader: glintFragment,
    transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide
  });
  return m;
}
function addGlint(meshes, scale = 0.5) {
  if (!glintUniforms.tex.value) return;
  for (const mesh of meshes) {
    const map = mesh.material && mesh.material.map;
    if (!map) continue;
    const g = new THREE.Mesh(mesh.geometry, glintMaterialFor(map, scale));
    g.userData.glint = true;
    g.renderOrder = 5;
    mesh.add(g);
  }
}

function disposeItem(obj) {
  obj.traverse((n) => {
    if (n.geometry && !n.geometry.userData.shared && !n.userData.glint) n.geometry.dispose();
    if (n.material && !n.material.userData.shared) n.material.dispose();
  });
}

// ---------- slot icons: the GUI context rendered once per item and tint, then reused ----------
const ICON_PX = 64;
const iconCache = new Map();
let iconGL = null;
const iconScene = new THREE.Scene();
const iconCam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -10, 10);
function itemIconCanvas(id, color = -1) {
  if (!id || id === 'minecraft:air' || !atlas.ready) return null;
  const key = id + '|' + color;
  if (iconCache.has(key)) return iconCache.get(key);
  let out = null;
  const obj = files.items ? buildItem(id, 'gui', { color }) : null;
  if (obj) {
    try {
      if (!iconGL) {
        iconGL = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true });
        iconGL.setPixelRatio(1);
        iconGL.setSize(ICON_PX, ICON_PX, false);
        iconGL.outputColorSpace = THREE.LinearSRGBColorSpace;
        iconGL.setClearColor(0x000000, 0);
      }
      iconScene.add(obj);
      iconGL.clear();
      iconGL.render(iconScene, iconCam);
      iconScene.remove(obj);
      out = document.createElement('canvas');
      out.width = out.height = ICON_PX;
      out.getContext('2d').drawImage(iconGL.domElement, 0, 0);
    } catch (error) {
      out = null;
    }
    disposeItem(obj);
  }
  if (!out) {
    const rect = itemIcon(id);
    if (rect) {
      out = document.createElement('canvas');
      out.width = out.height = ICON_PX;
      const g = out.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(atlas.canvas, rect.u, rect.v, Math.min(rect.w, 16), Math.min(rect.h, 16), 0, 0, ICON_PX, ICON_PX);
    }
  }
  iconCache.set(key, out);
  return out;
}
const iconUrls = new WeakMap();
function iconUrl(canvasEl) {
  if (!iconUrls.has(canvasEl)) iconUrls.set(canvasEl, canvasEl.toDataURL());
  return iconUrls.get(canvasEl);
}

// ---------- slots, tooltips and container screens, at the game's own layout ----------
const GUI = 2;
function mcSlot(slot, x, y, { selected = false } = {}) {
  const el = document.createElement('div');
  el.className = 'mc-slot' + (selected ? ' sel' : '');
  el.style.left = (x * GUI) + 'px'; el.style.top = (y * GUI) + 'px';
  el.style.width = el.style.height = (16 * GUI) + 'px';
  if (!slot || !slot.count || slot.item === 'minecraft:air') return el;
  const icon = itemIconCanvas(slot.item, typeof slot.color === 'number' ? slot.color : -1);
  if (icon) {
    const c = document.createElement('canvas');
    c.width = c.height = ICON_PX;
    c.getContext('2d').drawImage(icon, 0, 0);
    el.append(c);
    if (slot.foil && files.images.get('glint')) {
      const g = document.createElement('div');
      g.className = 'glint';
      const url = 'url(' + iconUrl(icon) + ')';
      g.style.webkitMaskImage = url; g.style.maskImage = url;
      g.style.backgroundImage = 'url(' + files.images.get('glint').src + ')';
      g.style.backgroundSize = (64 * GUI) + 'px';
      el.append(g);
    }
  } else {
    el.append(textCanvas(plain(prettyId(slot.item).slice(0, 3)), 1));
  }
  if (slot.maxDamage > 0 && slot.damage > 0) {
    // ItemStack.getBarWidth / getBarColor: 13 px, hue from red (0) to green (1/3).
    const f = Math.max(0, (slot.maxDamage - slot.damage) / slot.maxDamage);
    const bar = document.createElement('div');
    bar.className = 'dura';
    bar.style.left = (2 * GUI) + 'px'; bar.style.top = (13 * GUI) + 'px'; bar.style.width = (13 * GUI) + 'px'; bar.style.height = (2 * GUI) + 'px';
    const fill = document.createElement('i');
    fill.style.width = (Math.round(13 * f) * GUI) + 'px';
    fill.style.background = 'hsl(' + Math.round(f * 120) + ', 100%, 50%)';
    bar.append(fill);
    el.append(bar);
  }
  if (slot.count > 1) {
    const n = textCanvas(plain(String(slot.count)), GUI, { pad: 0 });
    n.style.cssText = 'position:absolute;inset:auto;right:' + (-1 * GUI) + 'px;bottom:' + (-2 * GUI) + 'px;width:' + (n.width) + 'px;height:' + n.height + 'px';
    el.append(n);
  }
  el.addEventListener('mouseenter', (e) => showTooltip(slot, e));
  el.addEventListener('mousemove', moveTooltip);
  el.addEventListener('mouseleave', hideTooltip);
  return el;
}

const tipEl = document.createElement('div');
tipEl.className = 'mc-tip';
tipEl.hidden = true;
document.body.append(tipEl);
function tooltipLines(slot) {
  if (Array.isArray(slot.tooltip) && slot.tooltip.length) return slot.tooltip;
  return [plain(slot.customName || prettyId(slot.item))];
}
// Vanilla tooltip: 0xF0100010 fill, a 1 px 0x505000FF -> 0x5028007F gradient frame, 10 px lines with 2 px after the
// name. Shulker boxes and bundles add a preview grid of what is inside.
function tooltipCanvas(slot) {
  const lines = tooltipLines(slot);
  let w = 0;
  for (const line of lines) w = Math.max(w, measureText(line));
  const contents = Array.isArray(slot.contents) ? slot.contents : [];
  const filled = contents.filter((c) => c && c.count > 0);
  const gridCols = 9, gridRows = filled.length ? Math.max(1, Math.ceil(Math.max(contents.length, filled.length) / 9)) : 0;
  const gridW = gridRows ? gridCols * 18 : 0;
  w = Math.max(w, gridW);
  const h = lines.length * 10 + (lines.length > 1 ? 2 : 0) - 2 + (gridRows ? gridRows * 18 + 4 : 0);
  const s = GUI;
  const c = document.createElement('canvas');
  c.width = (w + 8) * s; c.height = (h + 8) * s;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = 'rgba(16,0,16,0.94)';
  g.fillRect(1 * s, 0, (w + 6) * s, (h + 8) * s);
  g.fillRect(0, 1 * s, (w + 8) * s, (h + 6) * s);
  const grad = g.createLinearGradient(0, 2 * s, 0, (h + 6) * s);
  grad.addColorStop(0, 'rgba(80,0,255,0.31)'); grad.addColorStop(1, 'rgba(40,0,127,0.31)');
  g.fillStyle = grad;
  g.fillRect(1 * s, 1 * s, (w + 6) * s, s); g.fillRect(1 * s, (h + 6) * s, (w + 6) * s, s);
  g.fillRect(1 * s, 1 * s, s, (h + 6) * s); g.fillRect((w + 6) * s, 1 * s, s, (h + 6) * s);
  let y = 4;
  lines.forEach((line, i) => {
    drawText(g, line, 4, y + 1, s, { color: i === 0 ? 0xFFFFFF : 0xAAAAAA });
    y += 10 + (i === 0 && lines.length > 1 ? 2 : 0);
  });
  if (gridRows) {
    y += 2;
    const total = Math.max(contents.length, gridRows * 9);
    for (let i = 0; i < total; i++) {
      const sx = 4 + (i % 9) * 18, sy = y + Math.floor(i / 9) * 18;
      g.fillStyle = '#373737'; g.fillRect(sx * s, sy * s, 18 * s, 18 * s);
      g.fillStyle = '#ffffff'; g.fillRect((sx + 1) * s, (sy + 1) * s, 17 * s, 17 * s);
      g.fillStyle = '#8b8b8b'; g.fillRect((sx + 1) * s, (sy + 1) * s, 16 * s, 16 * s);
      const item = contents[i];
      if (!item || !item.count) continue;
      const icon = itemIconCanvas(item.item, typeof item.color === 'number' ? item.color : -1);
      if (icon) g.drawImage(icon, (sx + 1) * s, (sy + 1) * s, 16 * s, 16 * s);
      if (item.count > 1) {
        const n = String(item.count);
        drawText(g, plain(n), sx + 18 - measureText(plain(n)), sy + 10, s);
      }
    }
  }
  return c;
}
let tipFor = null;
function showTooltip(slot, event) {
  tipFor = slot;
  tipEl.replaceChildren(tooltipCanvas(slot));
  const host = document.fullscreenElement || document.body;
  if (tipEl.parentNode !== host) host.append(tipEl);
  tipEl.hidden = false;
  moveTooltip(event);
}
function moveTooltip(event) {
  if (tipEl.hidden || !tipEl.firstChild) return;
  const c = tipEl.firstChild;
  let x = event.clientX + 12 * 1, y = event.clientY - 12 * 1;
  if (x + c.width > window.innerWidth - 4) x = event.clientX - c.width - 12;
  if (y + c.height > window.innerHeight - 4) y = window.innerHeight - c.height - 4;
  tipEl.style.left = Math.max(4, x) + 'px';
  tipEl.style.top = Math.max(4, y) + 'px';
}
function hideTooltip() { tipFor = null; tipEl.hidden = true; }

function screenBase(imgName, w, parts) {
  const el = document.createElement('div');
  el.className = 'mc-screen';
  const img = files.images.get(imgName);
  let height = 0;
  for (const [sy, sh] of parts) height += sh;
  el.style.width = (w * GUI) + 'px'; el.style.height = (height * GUI) + 'px';
  if (img) {
    const c = document.createElement('canvas');
    c.width = w; c.height = height;
    const g = c.getContext('2d');
    let y = 0;
    for (const [sy, sh] of parts) { g.drawImage(img, 0, sy, w, sh, 0, y, w, sh); y += sh; }
    c.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;image-rendering:pixelated';
    el.append(c);
  } else {
    el.style.background = '#c6c6c6'; el.style.borderRadius = '6px';
  }
  return el;
}
function screenLabel(el, segs, x, y) {
  const c = textCanvas(segs, GUI, { shadow: false, pad: 0, color: 0x404040 });
  c.className = 'label';
  c.style.left = (x * GUI) + 'px'; c.style.top = ((y - 1) * GUI) + 'px';
  el.append(c);
}

// InventoryScreen: armor at (8, 8 + 18i), off hand (77, 62), main rows at (8 + 18c, 84 + 18r), hotbar at y 142.
function inventoryScreen(p, slotMap) {
  const el = screenBase('inventory', 176, [[0, 166]]);
  [39, 38, 37, 36].forEach((index, i) => el.append(mcSlot(slotMap.get(index), 8, 8 + i * 18)));
  el.append(mcSlot(slotMap.get(40), 77, 62));
  for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) el.append(mcSlot(slotMap.get(9 + r * 9 + c), 8 + c * 18, 84 + r * 18));
  for (let c = 0; c < 9; c++) el.append(mcSlot(slotMap.get(c), 8 + c * 18, 142, { selected: p && c === p.selectedSlot }));
  screenLabel(el, plain('Crafting'), 97, 8);
  const doll = dollCanvas(p);
  if (doll) { doll.className = 'doll'; doll.style.left = (26 * GUI) + 'px'; doll.style.top = (8 * GUI) + 'px'; doll.style.width = (49 * GUI) + 'px'; doll.style.height = (70 * GUI) + 'px'; el.append(doll); }
  return el;
}
// ContainerScreen for generic_54: the top rows, then the texture's bottom edge.
function chestScreen(titleSegs, rows, slotList, base = 0) {
  const el = screenBase('generic_54', 176, [[0, 17 + rows * 18], [215, 7]]);
  screenLabel(el, titleSegs, 8, 6);
  const map = new Map(slotList.map((s) => [s.slot, s]));
  for (let i = 0; i < rows * 9; i++) el.append(mcSlot(map.get(base + i), 8 + (i % 9) * 18, 18 + Math.floor(i / 9) * 18));
  return el;
}
// The vanilla container screens with the player's inventory underneath (ChestMenu, ShulkerBoxMenu, DispenserMenu,
// HopperMenu): main rows at invY, the hotbar 58 below. Slots are clickable for admins (see slotClick).
function containerScreen(view) {
  const map = new Map((view.slots || []).map((s) => [s.slot, s]));
  const title = Array.isArray(view.title) && view.title.length ? view.title : plain(prettyId(view.block));
  let el, invY;
  if (view.kind === 'shulker') {
    el = screenBase('shulker_box', 176, [[0, 166]]);
    for (let i = 0; i < 27; i++) el.append(editSlot('c', i, map.get(i), 8 + (i % 9) * 18, 18 + Math.floor(i / 9) * 18));
    invY = 84;
  } else if (view.kind === 'dispenser') {
    el = screenBase('dispenser', 176, [[0, 166]]);
    for (let i = 0; i < 9; i++) el.append(editSlot('c', i, map.get(i), 62 + (i % 3) * 18, 17 + Math.floor(i / 3) * 18));
    invY = 84;
  } else if (view.kind === 'hopper') {
    el = screenBase('hopper', 176, [[0, 133]]);
    for (let i = 0; i < 5; i++) el.append(editSlot('c', i, map.get(i), 44 + i * 18, 20));
    invY = 51;
  } else {
    const rows = Math.max(1, Math.min(6, view.rows || Math.ceil((view.slots || []).length / 9) || 3));
    el = screenBase('generic_54', 176, [[0, 17 + rows * 18], [126, 96]]);
    for (let i = 0; i < rows * 9; i++) el.append(editSlot('c', i, map.get(i), 8 + (i % 9) * 18, 18 + Math.floor(i / 9) * 18));
    invY = 31 + rows * 18;
  }
  screenLabel(el, title, 8, 6);
  const p = screen && screen.player ? players.get(screen.player) : null;
  screenLabel(el, plain(p ? (p.name || 'Inventory') : 'No player picked'), 8, invY - 11);
  const inv = p && inventoryUuid === p.uuid && !inventoryUnavailable ? slots : new Map();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) el.append(editSlot('p', 9 + r * 9 + c, inv.get(9 + r * 9 + c), 8 + c * 18, invY + r * 18));
  for (let c = 0; c < 9; c++) el.append(editSlot('p', c, inv.get(c), 8 + c * 18, invY + 58));
  return el;
}
function editSlot(side, index, slot, x, y) {
  const picked = screen && screen.pick && screen.pick.side === side && screen.pick.slot === index;
  const el = mcSlot(slot, x, y, { selected: picked });
  el.addEventListener('mousedown', (event) => { event.preventDefault(); slotClick(side, index, slot, event); });
  el.addEventListener('contextmenu', (event) => event.preventDefault());
  return el;
}
// Like the game's clicks, but each move is one message the server does at once: click a stack to pick it (right-click
// picks half), then click where it goes (right-click puts one, and keeps the pick for more); shift-click sends it to
// the other side. Clicking the picked slot again lets go.
function slotClick(side, index, slot, event) {
  if (!screen || !screen.view) return;
  const has = slot && slot.count > 0 && slot.item !== 'minecraft:air';
  const right = event.button === 2;
  if (side === 'p' && !screen.player) { toast('Pick a player above the chest to use their inventory.', true); return; }
  if (event.shiftKey) {
    screen.pick = null;
    if (!has) return;
    if (side === 'c' && !screen.player) { toast('Pick a player above the chest to shift-click items to them.', true); return; }
    sendMove(side, index, side === 'c' ? 'p' : 'c', -1, 0);
    paintScreen();
    return;
  }
  const pick = screen.pick;
  if (!pick) {
    if (has) { screen.pick = { side, slot: index, amount: right ? 2 : 0 }; paintScreen(); }
    return;
  }
  if (pick.side === side && pick.slot === index) { screen.pick = null; paintScreen(); return; }
  sendMove(pick.side, pick.slot, side, index, right ? 1 : pick.amount);
  if (!right) screen.pick = null;
  paintScreen();
}
let moveSeq = 0;
async function sendMove(from, fromSlot, to, toSlot, amount) {
  if (!screen || !screen.at || !socket || socket.readyState !== WebSocket.OPEN) return;
  const at = screen.at, dimension = (screen.view && screen.view.dimension) || cameraDim, player = screen.player || '';
  if (!controlsOn) { toast('Moving items changes the world: turn on controls first.', true); return; }
  socket.send(JSON.stringify({ type: 'container_move', id: ++moveSeq, dimension, x: at[0], y: at[1], z: at[2], player, from, fromSlot, to, toSlot, amount }));
}
function onContainerResult(msg) {
  if (msg.ok) return;
  if (msg.locked) { noteLocked(); return; }
  toast(msg.message || 'Could not move that item.', true);
}
// Above the screen: whose inventory sits underneath, and how the clicks work.
function containerBar() {
  const bar = document.createElement('div');
  bar.className = 'screen-bar';
  const label = document.createElement('label');
  label.textContent = 'Inventory below ';
  const select = document.createElement('select');
  select.append(new Option('No player', ''));
  for (const p of sortedPlayers()) select.append(new Option((p.name || p.uuid.slice(0, 8)) + (p.dimension !== cameraDim ? ' (' + dimName(p.dimension) + ')' : ''), p.uuid));
  select.value = screen.player || '';
  select.addEventListener('change', () => {
    screen.player = select.value || null;
    screen.pick = null;
    if (screen.player) subscribe(screen.player);
    paintScreen();
  });
  label.append(select);
  const hint = document.createElement('span');
  hint.textContent = controlsOn ? 'Click to pick up, click to put down. Right-click: half, or one. Shift-click: move across.'
    : 'Looking only. Moving items needs controls on.';
  bar.append(label, hint);
  return bar;
}

// The paper-doll player in the inventory screen, drawn with the same model as the world view.
const dollCache = new Map();
function dollCanvas(p) {
  if (!p || !models.data || !atlas.ready) return null;
  const key = p.uuid + '|' + (p.skin || '') + '|' + lookKey(p.look);
  if (dollCache.has(key)) {
    const cached = dollCache.get(key);
    const copy = document.createElement('canvas');
    copy.width = cached.width; copy.height = cached.height;
    copy.getContext('2d').drawImage(cached, 0, 0);
    return copy;
  }
  const root = buildPlayer({ ...p, name: '' });
  if (!root || !root.userData.turn) return null;
  if (root.userData.label) root.remove(root.userData.label);
  for (const child of [...root.children]) if (child.isSprite) root.remove(child);
  root.userData.turn.rotation.y = Math.PI - 0.35;
  for (const extra of root.userData.extras || []) if (extra.turn) extra.turn.rotation.y = root.userData.turn.rotation.y;
  if (!iconGL) itemIconCanvas('minecraft:stone');
  if (!iconGL) return null;
  const cam = new THREE.OrthographicCamera(-0.7, 0.7, 2.0, 0, -10, 10);
  const scene = new THREE.Scene();
  scene.add(root);
  iconGL.setSize(98, 140, false);
  iconGL.clear();
  iconGL.render(scene, cam);
  const c = document.createElement('canvas');
  c.width = 98; c.height = 140;
  c.getContext('2d').drawImage(iconGL.domElement, 0, 0);
  iconGL.setSize(ICON_PX, ICON_PX, false);
  scene.remove(root);
  disposeActor(root);
  if (dollCache.size > 32) dollCache.delete(dollCache.keys().next().value);
  dollCache.set(key, c);
  return dollCanvas(p);
}

// ---------- name tags: the game's font, 0.025 blocks per font pixel, the 25% black background ----------
function nameSprite(text) {
  const group = new THREE.Group();
  const segs = plain(text);
  const s = 4;
  const c = files.font ? textCanvas(segs, s, { shadow: false, bg: 'rgba(0,0,0,0.25)', pad: 1 }) : null;
  let canvasEl = c;
  if (!canvasEl) {
    canvasEl = document.createElement('canvas');
    const g = canvasEl.getContext('2d');
    g.font = '32px sans-serif';
    canvasEl.width = Math.ceil(g.measureText(text).width) + 8; canvasEl.height = 40;
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 0, canvasEl.width, 40);
    g.font = '32px sans-serif'; g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(text, 4, 22);
  }
  const texture = new THREE.CanvasTexture(canvasEl);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter; texture.generateMipmaps = false;
  const fontPx = canvasEl.height / (c ? s : 4);
  const w = canvasEl.width / canvasEl.height * fontPx * 0.025, h = fontPx * 0.025;
  // Vanilla draws the tag twice: faintly through walls, then normally where it is not hidden.
  const through = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, opacity: 0.35 }));
  const solid = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: true, transparent: true }));
  through.renderOrder = 3; solid.renderOrder = 4;
  through.scale.set(w, h, 1); solid.scale.set(w, h, 1);
  group.add(through, solid);
  group.userData.nameTag = { through };
  return group;
}

// ---------- held items: ItemInHandLayer ----------
// After the arm's own pose: rotate X -90, Y 180, then translate (+-1/16, 0.125, -0.625) blocks, then the item's
// thirdperson display transform. Arm nodes here are in model pixels, so the hand group scales back to blocks.
function holdItems(built, look, extras) {
  if (!look) return;
  const hands = [[look.main, 'right_arm', 16, look.mainTint, 'thirdperson_righthand', 1], [look.off, 'left_arm', 32, look.offTint, 'thirdperson_lefthand', -1]];
  for (const [item, side, bit, tintValue, display, sign] of hands) {
    const arm = built.parts[side];
    if (!arm || !item || item === 'minecraft:air') continue;
    const obj = buildItem(item, display, { color: typeof tintValue === 'number' ? tintValue : -1, foil: !!((look.foil || 0) & bit) });
    if (obj) {
      const hand = new THREE.Group();
      hand.scale.setScalar(16);
      hand.rotation.set(-Math.PI / 2, Math.PI, 0, 'XYZ');
      const at = new THREE.Group();
      at.position.set(sign / 16, 0.125, -0.625);
      at.add(obj);
      hand.add(at);
      arm.node.add(hand);
      for (const m of obj.userData.materials || []) extras.push({ material: m });
      continue;
    }
    const iconKey = itemIconKey(item);
    const tex = iconKey ? atlasTexture(iconKey) : null;
    if (!tex) continue;
    const material = new THREE.MeshBasicMaterial({ map: tex.texture, alphaTest: 0.1, side: THREE.DoubleSide });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), material);
    plane.position.set(side === 'right_arm' ? -1 : 1, 10, -4.5);
    plane.rotation.set(0, Math.PI / 2, Math.PI);
    arm.node.add(plane);
    extras.push({ material });
  }
}

function addArmorGlint(piece) {
  if (!glintTexture.armor && !glintUniforms.tex.value) return;
  const meshes = [];
  piece.turn.traverse((n) => { if (n.isMesh && !n.userData.glint) meshes.push(n); });
  addGlint(meshes, 0.0625);
}

// ---------- smoothing and animation ----------
// Players and mobs arrive a few times a second at uneven intervals. Each one keeps a short track of timed samples, and
// the view plays it back a little behind real time (the delay follows how far apart samples really arrive), moving
// along a Hermite curve through the samples: the path bends through turns instead of cutting corners, and the speed
// carries across samples instead of stopping and starting at each one. When samples stop, it coasts on the last
// velocity for a moment, then holds. A jump of more than 8 blocks is a teleport and snaps.
// The walk cycle follows the played-back speed the way WalkAnimationState does (target min(1, distance * 4) per tick,
// lerp 0.4).
const tracks = new Map();
const TRACK_KEEP = 12, SNAP_DISTANCE = 8, COAST_MS = 200;
function unwrapAngle(prev, next) {
  if (!Number.isFinite(prev)) return next;
  return prev + (((next - prev) % 360 + 540) % 360 - 180);
}
// Called whenever a player or entity sample lands (full snapshot or delta) with the merged object.
function recordSample(key, obj) {
  if (!obj || !Number.isFinite(obj.x) || !Number.isFinite(obj.y) || !Number.isFinite(obj.z)) return;
  const t = performance.now();
  let tr = tracks.get(key);
  if (!tr) { tr = { samples: [], gap: 100, jitter: 20, limbPos: 0, limbAmt: 0, age: Math.random() * 100, seen: t }; tracks.set(key, tr); }
  tr.seen = t;
  const list = tr.samples;
  const last = list[list.length - 1];
  const yaw = Number(obj.yaw) || 0;
  const head = Number.isFinite(obj.headYaw) ? obj.headYaw : yaw;
  const pitch = Number(obj.pitch) || 0;
  if (last && last.x === obj.x && last.y === obj.y && last.z === obj.z && last.rawYaw === yaw && last.rawHead === head && last.pitch === pitch) return;
  const sample = { t, x: obj.x, y: obj.y, z: obj.z, rawYaw: yaw, rawHead: head, pitch,
    yaw: unwrapAngle(last && last.yaw, yaw), head: unwrapAngle(last && last.head, head) };
  const jumped = last && (Math.hypot(sample.x - last.x, sample.y - last.y, sample.z - last.z) > SNAP_DISTANCE || obj.dimension !== tr.dim);
  tr.dim = obj.dimension;
  if (jumped) { list.length = 0; tr.snap = true; tr.clockReset = true; }
  if (last && !jumped) {
    // A sample after a pause starts from where the actor stood, not mid-flight from the old one.
    const gap = Math.min(1000, t - last.t);
    if (gap > 600) { list.length = 0; list.push({ ...last, t: t - tr.gap }); tr.clockReset = true; }
    else { const g = Math.max(16, gap); tr.jitter += (Math.abs(g - tr.gap) - tr.jitter) * 0.2; tr.gap += (g - tr.gap) * 0.2; }
  }
  list.push(sample);
  if (list.length > TRACK_KEEP) list.splice(0, list.length - TRACK_KEEP);
}
function forgetTracks(seen) {
  const now = performance.now();
  for (const [key, tr] of tracks) if (!seen.has(key) && now - tr.seen > 3000) tracks.delete(key);
}
// Cubic Hermite through p1 (at t1) and p2 (at t2), with tangents from the neighbours (Catmull-Rom on uneven times).
function hermite(p0, p1, p2, p3, t0, t1, t2, t3, t) {
  const h = t2 - t1 || 1;
  const u = Math.max(0, Math.min(1, (t - t1) / h));
  const m1 = (p2 - p0) / ((t2 - t0) || 1) * h;
  const m2 = (p3 - p1) / ((t3 - t1) || 1) * h;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2;
}
const TRACK_FIELDS = ['x', 'y', 'z', 'yaw', 'head', 'pitch'];
function playTrack(tr, now) {
  const list = tr.samples;
  const out = {};
  if (!list.length) return null;
  // Play back one sample gap plus twice the usual spread in gaps behind, so the next sample is almost always here. The playback clock runs
  // steadily and only speeds up or slows down by up to 10% to follow that target, so it never jumps or runs backwards.
  const target = now - Math.max(60, Math.min(600, tr.gap + tr.jitter * 2.5 + 30));
  if (!Number.isFinite(tr.clock) || Math.abs(target - tr.clock) > 1000 || tr.clockReset) { tr.clock = target; tr.clockReset = false; }
  else {
    const step = Math.max(0, now - tr.clockAt);
    tr.clock += step * (1 + Math.max(-0.1, Math.min(0.1, (target - tr.clock) / 400)));
  }
  tr.clockAt = now;
  const t = tr.clock;
  const n = list.length;
  if (n === 1 || t <= list[0].t) { for (const f of TRACK_FIELDS) out[f] = list[0][f]; return out; }
  const last = list[n - 1];
  if (t >= last.t) {
    // Ran out of samples: coast on the last segment's velocity briefly (position only), then hold.
    const prev = list[n - 2];
    const span = (last.t - prev.t) || 1;
    // Eases out to at most COAST_MS / 2 of travel, so it never runs on and never swings back.
    const ahead = COAST_MS * 0.5 * (1 - Math.exp(-(t - last.t) / (COAST_MS * 0.5)));
    for (const f of TRACK_FIELDS) out[f] = last[f];
    for (const f of ['x', 'y', 'z']) out[f] = last[f] + (last[f] - prev[f]) / span * ahead * 0.5;
    return out;
  }
  let i = 0;
  while (i < n - 2 && list[i + 1].t <= t) i++;
  const a = list[Math.max(0, i - 1)], b = list[i], c = list[i + 1], d = list[Math.min(n - 1, i + 2)];
  for (const f of TRACK_FIELDS) out[f] = hermite(a[f], b[f], c[f], d[f], a.t, b.t, c.t, d.t, t);
  // Vertical: never dip below both ends of a segment (a curve overshooting into the ground on landings).
  out.y = Math.max(out.y, Math.min(b.y, c.y) - 0.05);
  return out;
}
function ease(root, key, obj, dt) {
  let tr = tracks.get(key);
  if (!tr) { recordSample(key, obj); tr = tracks.get(key); }
  const p = tr && playTrack(tr, performance.now());
  const s = root.userData.smooth || (root.userData.smooth = tr || {});
  if (tr && s !== tr) root.userData.smooth = tr;
  const st = tr || s;
  const x = p ? p.x : obj.x, y = p ? p.y : obj.y, z = p ? p.z : obj.z;
  const fresh = !Number.isFinite(st.x) || st.snap;
  const px = fresh ? x : st.x, pz = fresh ? z : st.z;
  st.snap = false;
  st.x = x; st.y = y; st.z = z;
  st.yaw = p ? p.yaw : Number(obj.yaw) || 0;
  st.headYaw = p ? p.head : st.yaw;
  st.pitch = p ? p.pitch : Number(obj.pitch) || 0;
  const ticks = dt * 20;
  const perTick = ticks > 0 && !fresh ? Math.hypot(x - px, z - pz) / ticks : 0;
  const target = Math.min(1, perTick * 4);
  st.limbAmt += (target - st.limbAmt) * Math.min(1, 0.4 * ticks);
  st.limbPos += st.limbAmt * ticks;
  st.age += ticks;
  return st;
}

function animateModel(data, limbPos, limbAmt, headYaw, pitch) {
  const p = data.parts;
  const a = limbPos * 0.6662;
  const set = (name, x) => { const part = p[name]; if (part) part.node.rotation.x = part.base[0] + x; };
  set('right_leg', Math.cos(a) * 1.4 * limbAmt);
  set('left_leg', Math.cos(a + Math.PI) * 1.4 * limbAmt);
  set('right_hind_leg', Math.cos(a) * 1.4 * limbAmt);
  set('left_hind_leg', Math.cos(a + Math.PI) * 1.4 * limbAmt);
  set('right_front_leg', Math.cos(a + Math.PI) * 1.4 * limbAmt);
  set('left_front_leg', Math.cos(a) * 1.4 * limbAmt);
  const armDown = data.zombie ? -Math.PI / 2 : 0;
  if (p.right_arm) p.right_arm.node.rotation.x = p.right_arm.base[0] + armDown + Math.cos(a + Math.PI) * limbAmt * (data.zombie ? 0.1 : 1);
  if (p.left_arm) p.left_arm.node.rotation.x = p.left_arm.base[0] + armDown + Math.cos(a) * limbAmt * (data.zombie ? 0.1 : 1);
  if (p.head) {
    p.head.node.rotation.y = p.head.base[1] + headYaw;
    p.head.node.rotation.x = p.head.base[0] + pitch;
  }
}

const BOW_ITEMS = new Set(['minecraft:bow', 'minecraft:crossbow']);
const SPEAR_ITEMS = new Set(['minecraft:trident']);
// HumanoidModel.setupAnim for players: walk, idle arm bob, held-item and use poses, the attack swing, crouching
// (body tilt and the part offsets vanilla uses), riding.
function animateHumanoid(data, st) {
  const p = data.parts;
  const reset = (name) => {
    const part = p[name];
    if (!part) return null;
    part.node.rotation.set(part.base[0], part.base[1], part.base[2]);
    if (part.pos) part.node.position.set(part.pos[0], part.pos[1], part.pos[2]);
    return part.node;
  };
  const head = reset('head'), body = reset('body'), ra = reset('right_arm'), la = reset('left_arm'), rl = reset('right_leg'), ll = reset('left_leg');
  const a = st.limbPos * 0.6662, amt = st.limbAmt;
  if (head) { head.rotation.y = st.headYaw; head.rotation.x = st.pose === 'fall_flying' ? -Math.PI / 4 : st.pitch; }
  if (ra) { ra.rotation.x = Math.cos(a + Math.PI) * 2 * amt * 0.5; }
  if (la) { la.rotation.x = Math.cos(a) * 2 * amt * 0.5; }
  if (rl) { rl.rotation.x = Math.cos(a) * 1.4 * amt; }
  if (ll) { ll.rotation.x = Math.cos(a + Math.PI) * 1.4 * amt; }
  if (st.riding) {
    if (ra) ra.rotation.x += -Math.PI / 5;
    if (la) la.rotation.x += -Math.PI / 5;
    if (rl) { rl.rotation.x = -1.4137167; rl.rotation.y = Math.PI / 10; rl.rotation.z = 0.07853982; }
    if (ll) { ll.rotation.x = -1.4137167; ll.rotation.y = -Math.PI / 10; ll.rotation.z = -0.07853982; }
  }
  const headX = head ? head.rotation.x : 0, headY = head ? head.rotation.y : 0;
  const armPose = (arm, item, using, sign) => {
    if (!arm) return;
    if (!item || item === 'minecraft:air') return;
    if (using && BOW_ITEMS.has(item)) {
      if (ra) { ra.rotation.y = -0.1 + headY; ra.rotation.x = -Math.PI / 2 + headX; }
      if (la) { la.rotation.y = 0.1 + headY + 0.4; la.rotation.x = -Math.PI / 2 + headX; }
      return;
    }
    if (using && item === 'minecraft:shield') { arm.rotation.x = arm.rotation.x * 0.5 - 0.9424779; arm.rotation.y = sign * -Math.PI / 6; return; }
    if (using && SPEAR_ITEMS.has(item)) { arm.rotation.x = arm.rotation.x * 0.5 - Math.PI; arm.rotation.y = 0; return; }
    if (using) { arm.rotation.x = arm.rotation.x * 0.5 - Math.PI / 4; arm.rotation.y = sign * -Math.PI / 12; return; }
    arm.rotation.x = arm.rotation.x * 0.5 - Math.PI / 10;
  };
  armPose(ra, st.main, st.using >= 0 && !st.useOff, 1);
  armPose(la, st.off, st.using >= 0 && st.useOff, -1);
  // setupAttackAnimation
  const f = st.attack;
  if (f > 0 && body && ra && la) {
    const left = st.swingOff;
    const arm = left ? la : ra;
    body.rotation.y = Math.sin(Math.sqrt(f) * Math.PI * 2) * 0.2 * (left ? -1 : 1);
    ra.position.z = Math.sin(body.rotation.y) * 5; ra.position.x = -Math.cos(body.rotation.y) * 5;
    la.position.z = -Math.sin(body.rotation.y) * 5; la.position.x = Math.cos(body.rotation.y) * 5;
    ra.rotation.y += body.rotation.y; la.rotation.y += body.rotation.y; la.rotation.x += body.rotation.y;
    let g = 1 - f; g = g * g * g * g;
    const h = Math.sin((1 - g) * Math.PI);
    const k = Math.sin(f * Math.PI) * -(headX - 0.7) * 0.75;
    arm.rotation.x -= h * 1.2 + k;
    arm.rotation.y += body.rotation.y * 2;
    arm.rotation.z += Math.sin(f * Math.PI) * -0.4;
  }
  if (st.crouch) {
    if (body) { body.rotation.x = 0.5; body.position.y = 3.2; }
    if (ra) { ra.rotation.x += 0.4; ra.position.y = 5.2; }
    if (la) { la.rotation.x += 0.4; la.position.y = 5.2; }
    if (rl) { rl.position.z = 4; rl.position.y = 12.2; }
    if (ll) { ll.position.z = 4; ll.position.y = 12.2; }
    if (head) head.position.y = 4.2;
  }
  // AnimationUtils.bobArms
  if (ra) { ra.rotation.z += Math.cos(st.age * 0.09) * 0.05 + 0.05; ra.rotation.x += Math.sin(st.age * 0.067) * 0.05; }
  if (la) { la.rotation.z -= Math.cos(st.age * 0.09) * 0.05 + 0.05; la.rotation.x -= Math.sin(st.age * 0.067) * 0.05; }
}

// Swings come in sampled every other tick; play them out locally at 20 ticks a second over vanilla's 6 ticks.
function swingProgress(ud, motion, dt) {
  const swing = motion && typeof motion.swing === 'number' ? motion.swing : -1;
  if (swing >= 0 && (ud.lastSwing === undefined || ud.lastSwing < 0 || swing < ud.lastSwing)) {
    ud.swingT = swing;
    ud.swingOff = !!motion.swingOff;
  }
  ud.lastSwing = swing;
  if (ud.swingT === undefined || ud.swingT < 0) return 0;
  ud.swingT += dt * 20;
  if (ud.swingT >= 6) { ud.swingT = -1; return 0; }
  return ud.swingT / 6;
}

function hurtTint(root, hurt) {
  const materials = root.userData.materials;
  if (!materials || !hurt) return;
  for (const m of materials) if (m && m.color) m.color.multiply(new THREE.Color(1, 0.55, 0.55));
}

// ---------- entity shadows: EntityRenderDispatcher.renderShadow ----------
// The game's misc/shadow.png on the ground under each mob, fading out and shrinking as the entity rises (vanilla
// projects it onto the blocks up to about 6 blocks below; here it sits on the first surface below, found by a ray into
// the terrain meshes a few times a second).
const shadowRoot = new THREE.Group();
scene.add(shadowRoot);
let shadowTex = null;
function shadowTexture() {
  if (shadowTex) return shadowTex;
  const img = files.images.get('shadow');
  let source = img;
  if (!source) {
    source = document.createElement('canvas');
    source.width = source.height = 32;
    const g = source.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 2, 16, 16, 16);
    grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
  }
  const t = new THREE.Texture(source);
  t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  if (img) shadowTex = t;
  return t;
}
const shadowGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
shadowGeometry.userData.shared = true;
// EntityRenderer.shadowRadius for common shapes: 0.5 for players and most mobs, wider for big ones, small for items.
const SHADOW_RADIUS = { 'minecraft:item': 0.15, 'minecraft:experience_orb': 0.15, 'minecraft:chicken': 0.3, 'minecraft:bat': 0.25,
  'minecraft:silverfish': 0.3, 'minecraft:endermite': 0.3, 'minecraft:rabbit': 0.3, 'minecraft:ghast': 2.5, 'minecraft:happy_ghast': 2.5,
  'minecraft:ender_dragon': 0, 'minecraft:wither': 1.0, 'minecraft:iron_golem': 0.7, 'minecraft:ravager': 1.1, 'minecraft:warden': 0.9,
  'minecraft:sniffer': 1.0, 'minecraft:spider': 1.0, 'minecraft:cave_spider': 0.7, 'minecraft:horse': 0.75, 'minecraft:cow': 0.7,
  'minecraft:pig': 0.7, 'minecraft:sheep': 0.7, 'minecraft:slime': 0.25, 'minecraft:magma_cube': 0.25 };
const NO_SHADOW = new Set(['minecraft:area_effect_cloud', 'minecraft:marker', 'minecraft:interaction', 'minecraft:block_display',
  'minecraft:item_display', 'minecraft:text_display', 'minecraft:lightning_bolt', 'minecraft:arrow', 'minecraft:spectral_arrow',
  'minecraft:item_frame', 'minecraft:glow_item_frame', 'minecraft:painting', 'minecraft:leash_knot', 'minecraft:fishing_bobber',
  // Projectiles: their renderers keep EntityRenderer's default shadow radius of 0.
  'minecraft:trident', 'minecraft:wither_skull', 'minecraft:shulker_bullet', 'minecraft:llama_spit', 'minecraft:wind_charge',
  'minecraft:breeze_wind_charge', 'minecraft:snowball', 'minecraft:egg', 'minecraft:ender_pearl', 'minecraft:splash_potion',
  'minecraft:lingering_potion', 'minecraft:experience_bottle', 'minecraft:fireball', 'minecraft:small_fireball',
  'minecraft:dragon_fireball', 'minecraft:eye_of_ender', 'minecraft:firework_rocket']);
const groundRay = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);
function groundBelow(x, y, z) {
  const cx = Math.floor(x / 16) * 16, cz = Math.floor(z / 16) * 16;
  const meshes = terrainRoot.children.filter((m) => m.position.x === cx && m.position.z === cz && m.position.y <= y + 1 && m.position.y >= y - 24);
  if (!meshes.length) return null;
  groundRay.set(new THREE.Vector3(x, y + 0.25, z), DOWN);
  groundRay.far = 6.5;
  const hit = groundRay.intersectObjects(meshes, false).find((h) => h.face && h.face.normal.y > 0.5);
  return hit ? hit.point.y : null;
}
function shadowRadiusOf(type, width, baby) {
  let r = SHADOW_RADIUS[type];
  if (r === undefined) r = type === 'minecraft:player' ? 0.5 : Math.min(2.5, Math.max(0.2, (width || 0.6) * 0.8));
  return baby ? r * 0.5 : r;
}
function updateShadow(root, type, width, baby, x, y, z, light) {
  const ud = root.userData;
  if (NO_SHADOW.has(type) || !atlas.ready) return;
  let mesh = ud.shadow;
  if (!mesh) {
    const material = new THREE.MeshBasicMaterial({ map: shadowTexture(), color: 0x000000, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    material.alphaMap = null;
    mesh = new THREE.Mesh(shadowGeometry, material);
    mesh.renderOrder = 1;
    ud.shadow = mesh;
    shadowRoot.add(mesh);
  }
  const now = performance.now();
  if (!ud.groundAt || now - ud.groundAt > 300 || Math.abs((ud.groundFrom || 0) - y) > 0.3) {
    ud.groundAt = now;
    ud.groundFrom = y;
    ud.ground = groundBelow(x, y, z);
  }
  const radius = shadowRadiusOf(type, width, baby);
  if (ud.ground === null || ud.ground === undefined || radius <= 0) { mesh.visible = false; return; }
  const dy = Math.max(0, y - ud.ground);
  // Vanilla: opacity (1 - dy / 6) * 0.5 at full strength, dimmed in the dark.
  const sky = typeof light === 'number' ? Math.max(light >> 4, light & 15) / 15 : 1;
  const alpha = Math.max(0, (1 - dy / 6) * 0.5) * (fullbright ? 1 : 0.35 + 0.65 * sky);
  mesh.visible = alpha > 0.01;
  mesh.material.opacity = alpha;
  const size = radius * 2 * Math.max(0.4, 1 - dy / 12);
  mesh.scale.set(size, 1, size);
  mesh.position.set(x, ud.ground + 0.005, z);
}
function dropShadow(root) {
  const mesh = root.userData.shadow;
  if (!mesh) return;
  shadowRoot.remove(mesh);
  mesh.material.dispose();
  root.userData.shadow = null;
}

// ---------- splash potions and effect clouds ----------
function spawnPotionSplash(x, y, z, color, instant) {
  for (let i = 0; i < 8; i++) spawnParticle('minecraft:item', x, y, z, gauss() * 0.15, Math.random() * 0.2, gauss() * 0.15, { block: 'minecraft:splash_potion' });
  const r = (color >> 16 & 255) / 255, g = (color >> 8 & 255) / 255, b = (color & 255) / 255;
  const type = instant ? 'minecraft:instant_effect' : 'minecraft:effect';
  for (let i = 0; i < 100; i++) {
    const speed = Math.random() * 4;
    const angle = Math.random() * Math.PI * 2;
    const vx = Math.cos(angle) * speed * 0.1, vz = Math.sin(angle) * speed * 0.1, vy = 0.01 + Math.random() * 0.5 * 0.1;
    const shade = 0.75 + Math.random() * 0.25;
    spawnParticle(type, x + vx * 0.1, y + 0.3, z + vz * 0.1, vx, vy, vz, { color: (Math.round(r * shade * 255) << 16) | (Math.round(g * shade * 255) << 8) | Math.round(b * shade * 255) });
  }
}
function cloudParticles(entity, dt) {
  const look = entity.look || {};
  const radius = look.motion && look.motion.radius ? look.motion.radius : Math.max(0.5, (entity.width || 3) / 2);
  const n = Math.min(40, Math.ceil(Math.PI * radius * radius * dt * 3));
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * radius;
    spawnParticle('minecraft:entity_effect', entity.x + Math.cos(a) * d, entity.y, entity.z + Math.sin(a) * d, 0, 0.01, 0, { color: look.mainTint >= 0 ? look.mainTint : 0xffffff });
  }
}

// ---------- particles ----------
// Sprites come from the game's own particle definitions (assets/*/particles/*.json -> textures/particle), packed in the
// atlas. Server broadcasts arrive as "particles" messages and are unpacked the way the client unpacks the vanilla
// packet; block-break bursts and the client-only ambient effects (torches, fire, campfires, lava, portals) are made
// here. Behaviour per type is a small table modelled on the vanilla particle classes, in ticks (20 per second).
const PARTICLE_MAX = 4000;
const particlePool = [];
const sectionEmitters = new Map();
const particleGeometry = new THREE.BufferGeometry();
const pPos = new Float32Array(PARTICLE_MAX * 3), pSize = new Float32Array(PARTICLE_MAX), pRect = new Float32Array(PARTICLE_MAX * 4), pColor = new Float32Array(PARTICLE_MAX * 4);
particleGeometry.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
particleGeometry.setAttribute('psize', new THREE.BufferAttribute(pSize, 1).setUsage(THREE.DynamicDrawUsage));
particleGeometry.setAttribute('rect', new THREE.BufferAttribute(pRect, 4).setUsage(THREE.DynamicDrawUsage));
particleGeometry.setAttribute('pcolor', new THREE.BufferAttribute(pColor, 4).setUsage(THREE.DynamicDrawUsage));
particleGeometry.setDrawRange(0, 0);
particleGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
const particleMaterial = new THREE.ShaderMaterial({
  uniforms: { atlas: uniforms.atlas, atlasSize: uniforms.atlasSize, scale: { value: 400 }, fogColor: uniforms.fogColor, fogNear: uniforms.fogNear, fogFar: uniforms.fogFar },
  vertexShader: `
attribute float psize; attribute vec4 rect; attribute vec4 pcolor;
uniform float scale;
varying vec4 vRect; varying vec4 vColor; varying float vDepth;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = psize * scale / max(0.05, -mv.z);
  vRect = rect; vColor = pcolor; vDepth = -mv.z;
}`,
  fragmentShader: `
precision highp float;
uniform sampler2D atlas; uniform float atlasSize; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
varying vec4 vRect; varying vec4 vColor; varying float vDepth;
void main() {
  vec2 px = vRect.xy + gl_PointCoord * vRect.zw;
  vec4 c = texture2D(atlas, px / atlasSize) * vColor;
  if (c.a < 0.1) discard;
  gl_FragColor = vec4(mix(c.rgb, fogColor, smoothstep(fogNear, fogFar, vDepth)), c.a);
}`,
  transparent: true, depthWrite: false
});
const particlePoints = new THREE.Points(particleGeometry, particleMaterial);
particlePoints.frustumCulled = false;
particlePoints.renderOrder = 2;
scene.add(particlePoints);
particlesReady = true;

const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
// life in ticks, gravity (blocks/tick^2, negative rises), drag per tick, size in blocks, emissive ignores nothing yet.
const PARTICLE_TYPES = {
  // Sizes are full widths in blocks: twice vanilla's quadSize (SingleQuadParticle draws -quadSize..+quadSize).
  'minecraft:flame': { life: [8, 20], gravity: 0, drag: 0.96, size: [0.2, 0.3], shrink: true, bright: true },
  'minecraft:soul_fire_flame': { life: [8, 20], gravity: 0, drag: 0.96, size: [0.2, 0.3], shrink: true, bright: true },
  'minecraft:copper_fire_flame': { life: [8, 20], gravity: 0, drag: 0.96, size: [0.2, 0.3], shrink: true, bright: true },
  'minecraft:small_flame': { life: [8, 16], gravity: 0, drag: 0.96, size: [0.1, 0.15], shrink: true, bright: true },
  'minecraft:smoke': { life: [8, 16], gravity: -0.004, drag: 0.96, size: [0.15, 0.3], grow: true },
  'minecraft:large_smoke': { life: [10, 20], gravity: -0.004, drag: 0.96, size: [0.4, 0.75], grow: true },
  'minecraft:campfire_cosy_smoke': { life: [200, 280], gravity: -0.0035, drag: 0.98, size: [0.9, 1.4], fade: true },
  'minecraft:campfire_signal_smoke': { life: [280, 400], gravity: -0.0035, drag: 0.98, size: [0.9, 1.4], fade: true },
  'minecraft:lava': { life: [16, 32], gravity: 0.075, drag: 0.999, size: [0.15, 0.4], bright: true },
  'minecraft:portal': { life: [30, 50], gravity: 0, drag: 0.92, size: [0.1, 0.14], bright: true },
  'minecraft:reverse_portal': { life: [30, 50], gravity: 0, drag: 0.92, size: [0.1, 0.14], bright: true },
  'minecraft:end_rod': { life: [40, 70], gravity: 0, drag: 0.91, size: [0.15, 0.2], bright: true },
  'minecraft:crit': { life: [6, 10], gravity: 0.05, drag: 0.7, size: [0.15, 0.3] },
  'minecraft:enchanted_hit': { life: [6, 10], gravity: 0.05, drag: 0.7, size: [0.15, 0.3] },
  'minecraft:damage_indicator': { life: [12, 20], gravity: 0.04, drag: 0.9, size: [0.2, 0.3] },
  'minecraft:explosion': { life: [6, 10], gravity: 0, drag: 1, size: [1.6, 4.0] },
  'minecraft:poof': { life: [10, 20], gravity: -0.002, drag: 0.9, size: [0.2, 0.4] },
  'minecraft:cloud': { life: [10, 20], gravity: -0.002, drag: 0.96, size: [0.4, 0.75] },
  'minecraft:heart': { life: [16, 16], gravity: -0.01, drag: 0.86, size: [0.3, 0.3] },
  'minecraft:angry_villager': { life: [16, 16], gravity: -0.01, drag: 0.86, size: [0.3, 0.3] },
  'minecraft:happy_villager': { life: [16, 24], gravity: 0, drag: 0.9, size: [0.15, 0.3] },
  'minecraft:note': { life: [6, 6], gravity: 0, drag: 0.66, size: [0.3, 0.3] },
  'minecraft:dust': { life: [8, 40], gravity: -0.002, drag: 0.96, size: [0.15, 0.3] },
  'minecraft:entity_effect': { life: [8, 20], gravity: -0.004, drag: 0.96, size: [0.15, 0.3] },
  'minecraft:effect': { life: [8, 20], gravity: -0.004, drag: 0.96, size: [0.15, 0.3] },
  'minecraft:instant_effect': { life: [8, 20], gravity: -0.004, drag: 0.96, size: [0.15, 0.3] },
  'minecraft:witch': { life: [8, 20], gravity: -0.004, drag: 0.96, size: [0.15, 0.3] },
  'minecraft:sweep_attack': { life: [4, 4], gravity: 0, drag: 1, size: [2.0, 2.0] },
  'minecraft:splash': { life: [8, 16], gravity: 0.04, drag: 0.98, size: [0.15, 0.3] },
  'minecraft:bubble': { life: [8, 30], gravity: -0.002, drag: 0.85, size: [0.1, 0.2] },
  // WaterDropParticle (rain splashes), FireworkParticles.SparkParticle, DragonBreathParticle.
  'minecraft:rain': { life: [8, 40], gravity: 0.06, drag: 0.98, size: [0.1, 0.2], ground: true },
  'minecraft:firework': { life: [20, 40], gravity: 0.004, drag: 0.91, size: [0.1, 0.2], bright: true, shrink: true },
  'minecraft:dragon_breath': { life: [10, 20], gravity: 0, drag: 0.96, size: [0.15, 0.3], bright: true, fade: true },
  // TerrainParticle and BreakingItemParticle: quadSize halved, a quarter of the sprite.
  'minecraft:block': { life: [4, 20], gravity: 0.04, drag: 0.98, size: [0.1, 0.2], block: true },
  'liveview:block_break': { life: [4, 20], gravity: 0.04, drag: 0.98, size: [0.1, 0.2], block: true },
  'minecraft:item': { life: [4, 20], gravity: 0.04, drag: 0.98, size: [0.1, 0.2], block: true, item: true }
};
const DEFAULT_PARTICLE = { life: [10, 25], gravity: 0, drag: 0.96, size: [0.15, 0.3] };

function blockSprite(block) {
  if (!block || !atlas.ready) return null;
  const colon = block.indexOf(':');
  const ns = colon >= 0 ? block.slice(0, colon) : 'minecraft';
  const path = colon >= 0 ? block.slice(colon + 1) : block;
  for (const suffix of ['', '_side', '_top', '_front', '_still', '_0']) {
    const rect = atlasRect(ns + ':block/' + path + suffix);
    if (rect) return rect;
  }
  return null;
}

function spawnParticle(type, x, y, z, vx, vy, vz, extra) {
  if (particlePool.length >= PARTICLE_MAX || !atlas.ready) return;
  const def = PARTICLE_TYPES[type] || DEFAULT_PARTICLE;
  let frames = null, rect = null;
  if (def.block) {
    const sprite = def.item ? itemIcon((extra && extra.block) || '') : blockSprite(extra && extra.block);
    if (!sprite) return;
    const cell = Math.min(sprite.w, 16) / 4;
    rect = [sprite.u + Math.floor(Math.random() * 3) * cell, sprite.v + Math.floor(Math.random() * 3) * cell, cell, cell];
  } else {
    const names = atlas.meta.particles && atlas.meta.particles[type];
    if (!names || !names.length) return;
    frames = names.map((n) => atlasRect(n)).filter(Boolean);
    if (!frames.length) return;
  }
  let r = 1, g = 1, b = 1;
  if (extra && typeof extra.color === 'number' && extra.color >= 0) { r = (extra.color >> 16 & 255) / 255; g = (extra.color >> 8 & 255) / 255; b = (extra.color & 255) / 255; }
  if (def.block && !def.item) { r = g = b = 0.6; }
  if (type === 'minecraft:smoke' || type === 'minecraft:large_smoke') { const grey = rand(0.25, 0.35); r = g = b = grey; }
  // HugeExplosionParticle and ExplodeParticle (poof): a random grey per puff.
  if (type === 'minecraft:explosion') { const grey = rand(0.4, 1); r = g = b = grey; }
  if (type === 'minecraft:poof') { const grey = rand(0.7, 1); r = g = b = grey; }
  particlePool.push({ type, def, frames, rect, x, y, z, vx, vy, vz, age: 0, life: rand(def.life[0], def.life[1]), size: rand(def.size[0], def.size[1]), r, g, b,
    floor: extra && Number.isFinite(extra.floor) ? extra.floor : undefined });
}

// The client's unpacking of ClientboundLevelParticlesPacket: count 0 is one particle with velocity d * speed,
// otherwise count particles offset by gaussian * d with gaussian * speed velocity.
function spawnServerParticles(list) {
  if (!Array.isArray(list)) return;
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 11) continue;
    const [type, x, y, z, count, dx, dy, dz, speed, block, color] = row;
    const extra = { block, color };
    if (type === 'liveview:block_break') {
      // Vanilla's destroy effect: a 4x4x4 grid of block pieces flying out from the block's center.
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) {
        const ox = (i + 0.5) / 4, oy = (j + 0.5) / 4, oz = (k + 0.5) / 4;
        spawnParticle(type, x - 0.5 + ox, y - 0.5 + oy, z - 0.5 + oz, (ox - 0.5) * 0.2, (oy - 0.5) * 0.2 + 0.05, (oz - 0.5) * 0.2, extra);
      }
      continue;
    }
    if (type === 'liveview:potion_splash' || type === 'liveview:instant_splash') {
      spawnPotionSplash(x, y, z, typeof color === 'number' && color >= 0 ? color : 0x385dc6, type === 'liveview:instant_splash');
      continue;
    }
    if (type === 'minecraft:explosion_emitter') {
      for (let i = 0; i < 6; i++) spawnParticle('minecraft:explosion', x + gauss() * 2, y + gauss() * 2, z + gauss() * 2, 0, 0, 0, extra);
      continue;
    }
    if (type === 'liveview:explosion') {
      // ClientboundExplodePacket: the big emitter for power >= 2 that breaks blocks, else one explosion sprite, plus the
      // block particles (poof and smoke) thrown out across the blast radius.
      const power = speed || 4;
      if (power >= 2 && count) for (let i = 0; i < 6; i++) spawnParticle('minecraft:explosion', x + gauss() * 2, y + gauss() * 2, z + gauss() * 2, 0, 0, 0);
      else spawnParticle('minecraft:explosion', x, y, z, 0, 0, 0);
      for (let i = 0; i < Math.min(48, 6 * power); i++) {
        const ox = gauss() * power * 0.5, oy = gauss() * power * 0.5, oz = gauss() * power * 0.5;
        const len = Math.hypot(ox, oy, oz) || 1, v = rand(0.05, 0.2);
        spawnParticle(Math.random() < 0.5 ? 'minecraft:poof' : 'minecraft:smoke', x + ox, y + oy, z + oz, ox / len * v, oy / len * v, oz / len * v);
      }
      continue;
    }
    if (type === 'liveview:poof') {
      // LivingEntity.makePoofParticles: 20 poofs inside the hitbox (dx is the width, dy the height).
      for (let i = 0; i < 20; i++) {
        spawnParticle('minecraft:poof', x + (Math.random() * 2 - 1) * dx, y + Math.random() * dy, z + (Math.random() * 2 - 1) * dx, gauss() * 0.02, gauss() * 0.02, gauss() * 0.02);
      }
      continue;
    }
    if (type === 'liveview:item_break') {
      // Snowball and egg handleEntityEvent(3): eight item pieces.
      for (let i = 0; i < 8; i++) spawnParticle('minecraft:item', x, y, z, (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08, extra);
      continue;
    }
    if (!count) { spawnParticle(type, x, y, z, dx * speed, dy * speed, dz * speed, extra); continue; }
    for (let i = 0; i < Math.min(count, 48); i++) {
      spawnParticle(type, x + gauss() * dx, y + gauss() * dy, z + gauss() * dz, gauss() * speed, gauss() * speed, gauss() * speed, extra);
    }
  }
}

// Client-only effects, at roughly the rate vanilla's animateTick produces them near the player.
const EMITTERS = {
  1: (x, y, z) => { if (Math.random() < 0.15) { spawnParticle('minecraft:smoke', x + 0.5, y + 0.7, z + 0.5, 0, 0, 0); spawnParticle('minecraft:flame', x + 0.5, y + 0.7, z + 0.5, 0, 0, 0); } },
  2: (x, y, z) => { if (Math.random() < 0.15) { spawnParticle('minecraft:smoke', x + 0.5, y + 0.7, z + 0.5, 0, 0, 0); spawnParticle('minecraft:soul_fire_flame', x + 0.5, y + 0.7, z + 0.5, 0, 0, 0); } },
  3: (x, y, z) => { if (Math.random() < 0.08) spawnParticle('minecraft:large_smoke', x + Math.random(), y + Math.random() * 0.5 + 0.5, z + Math.random(), 0, 0, 0); },
  4: (x, y, z) => { if (Math.random() < 0.08) spawnParticle('minecraft:large_smoke', x + Math.random(), y + Math.random() * 0.5 + 0.5, z + Math.random(), 0, 0, 0); },
  5: (x, y, z) => { if (Math.random() < 0.03) spawnParticle('minecraft:campfire_cosy_smoke', x + 0.5 + rand(-0.3, 0.3), y + 0.5, z + 0.5 + rand(-0.3, 0.3), 0, 0.07, 0); },
  6: (x, y, z) => { if (Math.random() < 0.003) spawnParticle('minecraft:lava', x + Math.random(), y + 1, z + Math.random(), rand(-0.05, 0.05), rand(0.15, 0.3), rand(-0.05, 0.05)); },
  7: (x, y, z) => { if (Math.random() < 0.25) spawnParticle('minecraft:portal', x + Math.random(), y + Math.random(), z + Math.random(), rand(-0.5, 0.5) * 0.5, rand(-0.5, 0.5) * 0.5, rand(-0.5, 0.5) * 0.5); },
  8: (x, y, z) => { if (Math.random() < 0.04) spawnParticle('minecraft:end_rod', x + 0.5 + rand(-0.2, 0.2), y + 0.5 + rand(-0.2, 0.2), z + 0.5 + rand(-0.2, 0.2), gauss() * 0.005, gauss() * 0.005, gauss() * 0.005); },
  9: (x, y, z) => { if (Math.random() < 0.1) spawnParticle('minecraft:small_flame', x + 0.5, y + 0.55, z + 0.5, 0, 0, 0); },
  10: (x, y, z) => { if (Math.random() < 0.05) spawnParticle('minecraft:smoke', x + 0.5, y + 1.05, z + 0.5, 0, 0, 0); }
};

function readEmitters(key, cx, sy, cz, data, offset) {
  if (data.byteLength < offset + 4) { sectionEmitters.delete(key); return; }
  const n = data.getUint32(offset);
  if (!n) { sectionEmitters.delete(key); return; }
  const list = [];
  for (let i = 0; i < n && offset + 4 + i * 4 + 4 <= data.byteLength; i++) {
    const at = offset + 4 + i * 4;
    list.push([cx * 16 + data.getUint8(at), sy * 16 + data.getUint8(at + 1), cz * 16 + data.getUint8(at + 2), data.getUint8(at + 3)]);
  }
  sectionEmitters.set(key, list);
}

let particleTicks = 0;
function updateParticles(dt) {
  if (!atlas.ready) { particleGeometry.setDrawRange(0, 0); return; }
  particleTicks += dt * 20;
  const p = camera.position;
  while (particleTicks >= 1) {
    particleTicks -= 1;
    for (const list of sectionEmitters.values()) {
      for (const [x, y, z, kind] of list) {
        const dx = x - p.x, dy = y - p.y, dz = z - p.z;
        if (dx * dx + dy * dy + dz * dz > 32 * 32) continue;
        const emit = EMITTERS[kind];
        if (emit) emit(x, y, z);
      }
    }
    for (let i = particlePool.length - 1; i >= 0; i--) {
      const q = particlePool[i];
      q.age++;
      if (q.age >= q.life) { particlePool[i] = particlePool[particlePool.length - 1]; particlePool.pop(); continue; }
      q.vy -= q.def.gravity;
      q.x += q.vx; q.y += q.vy; q.z += q.vz;
      if (q.def.ground && q.floor !== undefined && q.y < q.floor) { q.y = q.floor; q.vy = 0; q.vx *= 0.7; q.vz *= 0.7; }
      q.vx *= q.def.drag; q.vy *= q.def.drag; q.vz *= q.def.drag;
    }
  }
  const n = Math.min(particlePool.length, PARTICLE_MAX);
  // Particles take the world's light: the sky's at this time of day in the overworld, dim block light elsewhere
  // (glowing ones such as flames and portals stay full bright, as their getLightColor does in vanilla).
  const dim = lightTint(cameraDim === 'minecraft:overworld' ? 0xF0 : 0x09);
  for (let i = 0; i < n; i++) {
    const q = particlePool[i];
    const t = q.age / q.life;
    pPos[i * 3] = q.x; pPos[i * 3 + 1] = q.y; pPos[i * 3 + 2] = q.z;
    let size = q.size;
    if (q.def.shrink) size *= 1 - t * t * 0.5;
    if (q.def.grow) size *= 1 + t;
    pSize[i] = size;
    let rect = q.rect;
    if (!rect) {
      // setSpriteFromAge: frame = age * (frames - 1) / lifetime.
      const f = q.frames[Math.min(q.frames.length - 1, Math.floor(t * q.frames.length))];
      rect = [f.u, f.v, f.w, f.h];
    }
    pRect.set(rect, i * 4);
    const lit = q.def.bright ? 1 : 0;
    pColor[i * 4] = q.r * (lit || dim[0]); pColor[i * 4 + 1] = q.g * (lit || dim[1]); pColor[i * 4 + 2] = q.b * (lit || dim[2]);
    pColor[i * 4 + 3] = q.def.fade ? Math.min(1, (1 - t) * 1.5) : 1;
  }
  for (const name of ['position', 'psize', 'rect', 'pcolor']) particleGeometry.attributes[name].needsUpdate = true;
  particleGeometry.setDrawRange(0, n);
  const h = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
  particleMaterial.uniforms.scale.value = h / (2 * Math.tan(camera.fov * Math.PI / 360));
}

// ---------- sky: time of day, sun, moon, stars, clouds, rain, lightning ----------
// The server sends the overworld clock and its rain and thunder levels with the status (every 2 s); between polls
// the clock runs on at 20 ticks a second, and stops if two polls show the same time (advance_time is off).
const skyClock = { time: -1, at: 0, rate: 20, last: -1 };
const weather = { rain: 0, thunder: 0, rainTarget: 0, thunderTarget: 0, flash: 0 };
function syncSkyClock(status) {
  const t = Number(status && status.time);
  if (Number.isFinite(Number(status && status.rain))) weather.rainTarget = Math.max(0, Math.min(1, Number(status.rain)));
  if (Number.isFinite(Number(status && status.thunder))) weather.thunderTarget = Math.max(0, Math.min(1, Number(status.thunder)));
  if (!Number.isFinite(t) || t < 0) { skyClock.time = -1; return; }
  skyClock.rate = skyClock.last >= 0 && t === skyClock.last ? 0 : 20;
  skyClock.last = t;
  skyClock.time = t;
  skyClock.at = performance.now();
}
function skyTime() {
  if (skyClock.time < 0) return -1;
  return skyClock.time + (performance.now() - skyClock.at) / 1000 * skyClock.rate;
}
// DimensionType.timeOfDay: 0 at noon, 0.5 at midnight, eased so days are a little longer than nights.
function celestialAngle(t) {
  const d = ((t / 24000 - 0.25) % 1 + 1) % 1;
  return (d * 2 + (0.5 - Math.cos(d * Math.PI) / 2)) / 3;
}
// ClientLevel.getSkyDarken(partial): the sky light factor the lightmap uses, 0.2 at night to 1 at noon.
function skyLevel(angle, rain, thunder) {
  let g = 1 - Math.max(0, Math.min(1, 1 - (Math.cos(angle * 2 * Math.PI) * 2 + 0.2)));
  g *= 1 - rain * 5 / 16;
  g *= 1 - thunder * 5 / 16;
  return g * 0.8 + 0.2;
}
// ClientLevel.getSkyColor / getCloudColor: brightness from the sun's height, then rain and thunder wash the colour grey.
function weatherWash(c, rain, thunder, rainMix, thunderMix) {
  const lum = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
  if (rain > 0) { const f = 1 - rain * rainMix, g = lum * 0.6; c.setRGB(c.r * f + g * (1 - f), c.g * f + g * (1 - f), c.b * f + g * (1 - f)); }
  if (thunder > 0) { const f = 1 - thunder * thunderMix, g = lum * 0.2; c.setRGB(c.r * f + g * (1 - f), c.g * f + g * (1 - f), c.b * f + g * (1 - f)); }
  return c;
}

const skyRoot = new THREE.Group();
scene.add(skyRoot);
const SKY_DISTANCE = 300;
function skyMaterial(map) {
  return new THREE.MeshBasicMaterial({ map, color: 0xffffff, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, fog: false, side: THREE.DoubleSide });
}
function imageTexture(name) {
  const img = files.images.get(name);
  if (!img) return null;
  const t = pixelTexture(new THREE.Texture(img));
  t.flipY = true;
  t.needsUpdate = true;
  return t;
}
const sky = { sun: null, moon: null, moonPhase: -1, moonTextures: [], stars: null, clouds: null, rain: null, ready: false };
const skyPlane = new THREE.PlaneGeometry(1, 1);
skyPlane.userData.shared = true;

// Vanilla's 1500 stars: random directions, a small quad each, fading in at dusk (getStarBrightness).
function buildStars() {
  const pos = [];
  let seed = 10842;
  const next = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  while (pos.length < 1500 * 3) {
    const x = next() * 2 - 1, y = next() * 2 - 1, z = next() * 2 - 1;
    const len = Math.hypot(x, y, z);
    if (len < 0.01 || len >= 1) continue;
    pos.push(x / len * SKY_DISTANCE, y / len * SKY_DISTANCE, z / len * SKY_DISTANCE);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const points = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, depthTest: false, depthWrite: false,
    fog: false, blending: THREE.AdditiveBlending }));
  points.frustumCulled = false;
  points.renderOrder = -101;
  return points;
}

// Clouds: environment/clouds.png, one texel per 12 x 12 blocks, at y 192.33, drifting 0.03 blocks a tick toward -X
// (CloudRenderer), fading out toward the edge of the view.
const cloudVertex = `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const cloudFragment = `
precision highp float;
uniform sampler2D map; uniform float drift; uniform vec3 color; uniform vec3 eye; uniform float range; uniform float opacity;
varying vec3 vWorld;
void main() {
  vec2 cell = floor(vec2(vWorld.x + drift, vWorld.z) / 12.0);
  vec4 t = texture2D(map, (mod(cell, 256.0) + 0.5) / 256.0);
  if (t.a < 0.5) discard;
  float d = length(vWorld.xz - eye.xz);
  float a = opacity * (1.0 - smoothstep(range * 0.55, range, d));
  if (a < 0.01) discard;
  gl_FragColor = vec4(color, a);
}`;
function buildClouds() {
  const img = files.images.get('clouds');
  if (!img) return null;
  const t = pixelTexture(new THREE.Texture(img));
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: t }, drift: { value: 0 }, color: { value: new THREE.Color(1, 1, 1) }, eye: { value: new THREE.Vector3() }, range: { value: 192 }, opacity: { value: 0.8 } },
    vertexShader: cloudVertex, fragmentShader: cloudFragment, transparent: true, depthWrite: false, side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}

// Rain: WeatherEffectRenderer's columns, one camera-facing quad per block column within 10 blocks, from the column's
// surface (or 10 below the camera) to 10 above it, scrolling environment/rain.png down.
const RAIN_RADIUS = 10;
const RAIN_MAX = (2 * RAIN_RADIUS + 1) * (2 * RAIN_RADIUS + 1);
function buildRain() {
  const img = files.images.get('rain');
  if (!img) return null;
  const t = pixelTexture(new THREE.Texture(img));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_MAX * 12), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(RAIN_MAX * 8), 2).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(RAIN_MAX * 4), 1).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(new THREE.BufferAttribute(quadIndices(RAIN_MAX).slice(), 1));
  g.setDrawRange(0, 0);
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: t }, color: { value: new THREE.Color(1, 1, 1) } },
    vertexShader: `attribute float alpha; varying vec2 vUv; varying float vAlpha;
void main() { vUv = uv; vAlpha = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `precision highp float; uniform sampler2D map; uniform vec3 color; varying vec2 vUv; varying float vAlpha;
void main() { vec4 c = texture2D(map, vUv); float a = c.a * vAlpha; if (a < 0.01) discard; gl_FragColor = vec4(c.rgb * color, a); }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  return mesh;
}

function ensureSky() {
  if (sky.ready || !files.ready) return;
  const sunTex = imageTexture('sun');
  if (sunTex) { sky.sun = new THREE.Mesh(skyPlane, skyMaterial(sunTex)); sky.sun.renderOrder = -100; skyRoot.add(sky.sun); }
  for (let i = 0; i < 8; i++) sky.moonTextures.push(imageTexture('moon_' + i));
  if (sky.moonTextures.some(Boolean)) { sky.moon = new THREE.Mesh(skyPlane, skyMaterial(null)); sky.moon.renderOrder = -100; skyRoot.add(sky.moon); }
  sky.stars = buildStars();
  skyRoot.add(sky.stars);
  sky.clouds = buildClouds();
  if (sky.clouds) scene.add(sky.clouds);
  sky.rain = buildRain();
  if (sky.rain) scene.add(sky.rain);
  sky.ready = true;
}

const sunDir = new THREE.Vector3();
function updateSky(dt) {
  ensureSky();
  // The server's rain and thunder levels already ramp (0.01 a tick); this only smooths between the 2 s status polls.
  const step = dt * 0.5;
  weather.rain += Math.max(-step, Math.min(step, weather.rainTarget - weather.rain));
  weather.thunder += Math.max(-step, Math.min(step, weather.thunderTarget - weather.thunder));
  weather.flash = Math.max(0, weather.flash - dt * 6);
  const overworld = cameraDim === 'minecraft:overworld';
  const t = skyTime();
  const angle = t >= 0 ? celestialAngle(t) : 0;
  const rain = settings.weather ? weather.rain : 0, thunder = settings.weather ? weather.thunder : 0;
  sky.state = { known: t >= 0, angle, rain, thunder, level: t >= 0 ? skyLevel(angle, weather.rain, weather.thunder) : null };
  applyLighting();
  const eye = camera.position;
  const showSky = overworld && settings.sky && sky.ready;
  skyRoot.visible = showSky;
  if (showSky) {
    skyRoot.position.copy(eye);
    const theta = angle * 2 * Math.PI;
    // Sky rendering rotates Y by -90 and then X by the angle, so the sun rises in the east and sets in the west.
    sunDir.set(-Math.sin(theta), Math.cos(theta), 0);
    const clear = 1 - rain;
    if (sky.sun) {
      sky.sun.position.copy(sunDir).multiplyScalar(SKY_DISTANCE);
      sky.sun.scale.setScalar(SKY_DISTANCE * 0.3);
      sky.sun.lookAt(eye);
      sky.sun.material.color.setScalar(clear);
      sky.sun.visible = clear > 0.01;
    }
    if (sky.moon) {
      const phase = t >= 0 ? Math.floor(t / 24000) % 8 : 0;
      if (phase !== sky.moonPhase) {
        sky.moonPhase = phase;
        sky.moon.material.map = sky.moonTextures[phase] || sky.moonTextures.find(Boolean);
        sky.moon.material.needsUpdate = true;
      }
      sky.moon.position.copy(sunDir).multiplyScalar(-SKY_DISTANCE);
      sky.moon.scale.setScalar(SKY_DISTANCE * 0.2);
      sky.moon.lookAt(eye);
      sky.moon.material.color.setScalar(clear);
      sky.moon.visible = clear > 0.01;
    }
    if (sky.stars) {
      sky.stars.rotation.set(theta, -Math.PI / 2, 0, 'YXZ');
      const f = Math.max(0, Math.min(1, 1 - (Math.cos(theta) * 2 + 0.25)));
      const stars = f * f * 0.5 * clear;
      sky.stars.material.color.setScalar(stars);
      sky.stars.visible = stars > 0.01;
    }
  }
  if (sky.clouds) {
    sky.clouds.visible = overworld && settings.clouds;
    if (sky.clouds.visible) {
      const range = Math.max(160, (view.cameraChunkRadius || 8) * 16 * 1.5);
      const u = sky.clouds.material.uniforms;
      sky.clouds.position.set(eye.x, 192.33, eye.z);
      sky.clouds.scale.set(range * 2, 1, range * 2);
      u.range.value = range;
      u.eye.value.copy(eye);
      u.drift.value = t >= 0 ? (t * 0.03) % 3072 : (performance.now() / 50 * 0.03) % 3072;
      const b = Math.max(0, Math.min(1, Math.cos(angle * 2 * Math.PI) * 2 + 0.5)) * 0.9 + 0.1;
      weatherWash(u.color.value.setRGB(b, b, b * 0.85 + 0.15 * b), rain, thunder, 0.95, 0.95);
      if (fullbright) u.color.value.setRGB(1, 1, 1);
    }
  }
  updateRain(dt, eye, overworld && rain > 0.01);
}

let rainTicks = 0;
function updateRain(dt, eye, raining) {
  const mesh = sky.rain;
  if (!mesh) return;
  mesh.visible = raining;
  if (!raining) { mesh.geometry.setDrawRange(0, 0); return; }
  const rain = settings.weather ? weather.rain : 0;
  const pos = mesh.geometry.attributes.position.array, uv = mesh.geometry.attributes.uv.array, alpha = mesh.geometry.attributes.alpha.array;
  const t = skyTime() >= 0 ? skyTime() : performance.now() / 50;
  const ex = Math.floor(eye.x), ez = Math.floor(eye.z), top = eye.y + RAIN_RADIUS, bottom = eye.y - RAIN_RADIUS;
  let n = 0;
  for (let dz = -RAIN_RADIUS; dz <= RAIN_RADIUS; dz++) {
    for (let dx = -RAIN_RADIUS; dx <= RAIN_RADIUS; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 > RAIN_RADIUS * RAIN_RADIUS) continue;
      const x = ex + dx, z = ez + dz;
      const surface = surfaceAt(x + 0.5, z + 0.5);
      const y0 = Math.max(surface, bottom), y1 = top;
      if (y0 >= y1) continue;
      // The quad faces the camera across this column (half a block either side of its centre line).
      const cx = x + 0.5 - eye.x, cz = z + 0.5 - eye.z, len = Math.hypot(cx, cz) || 1;
      const ax = -cz / len * 0.5, az = cx / len * 0.5;
      const h = (Math.imul(x, Math.imul(x, 3121)) + Math.imul(x, 45238971) + Math.imul(z, Math.imul(z, 418711)) + Math.imul(z, 13761)) & 31;
      const speed = 3 + ((Math.imul(h + 7, 2654435761) >>> 0) % 1000) / 1000;
      const off = -((t + h) / 32) * speed;
      const a = ((1 - d2 / (RAIN_RADIUS * RAIN_RADIUS)) * 0.5 + 0.5) * rain;
      const p = n * 12, q = n * 8, r = n * 4;
      const px = x + 0.5, pz = z + 0.5;
      pos.set([px - ax, y1, pz - az, px + ax, y1, pz + az, px + ax, y0, pz + az, px - ax, y0, pz - az], p);
      uv.set([0, y0 * 0.25 + off, 1, y0 * 0.25 + off, 1, y1 * 0.25 + off, 0, y1 * 0.25 + off], q);
      alpha[r] = alpha[r + 1] = alpha[r + 2] = alpha[r + 3] = a;
      n++;
    }
  }
  for (const name of ['position', 'uv', 'alpha']) mesh.geometry.attributes[name].needsUpdate = true;
  mesh.geometry.setDrawRange(0, n * 6);
  const lit = lightTint(0xF0);
  mesh.material.uniforms.color.value.setRGB(lit[0], lit[1], lit[2]);
  // Splashes where the rain lands (vanilla: 100 * rain^2 tries a tick within 10 blocks; fewer here).
  rainTicks += dt * 20;
  while (rainTicks >= 1) {
    rainTicks -= 1;
    const tries = Math.round(30 * rain * rain);
    for (let i = 0; i < tries; i++) {
      const x = ex + Math.floor(rand(-RAIN_RADIUS, RAIN_RADIUS + 1)), z = ez + Math.floor(rand(-RAIN_RADIUS, RAIN_RADIUS + 1));
      const surface = surfaceAt(x + 0.5, z + 0.5);
      if (!Number.isFinite(surface) || surface < bottom || surface > top) continue;
      const fx = x + Math.random(), fz = z + Math.random();
      spawnParticle('minecraft:rain', fx, surface + 0.1, fz, 0, 0.05, 0, { floor: surface + 0.02 });
    }
  }
}

// LightningBoltRenderer, simplified: a jagged column of crossed quads from 128 blocks up, re-jittered every couple of
// ticks, lighting up the sky while it lasts.
function buildLightning(entity) {
  const root = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 0.45, 0.5), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.frustumCulled = false;
  root.add(mesh);
  root.userData = { kind: 'entity', id: entity.id, type: entity.type, baby: false, hasTexture: true, hasModel: true, still: true, bolt: mesh, boltAt: 0 };
  return root;
}
function jitterLightning(root) {
  const pos = [];
  let x = 0, z = 0;
  const pts = [];
  for (let i = 0; i <= 8; i++) { pts.push([x, i * 16, z]); x += rand(-5, 5); z += rand(-5, 5); }
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay, az] = pts[i], [bx, by, bz] = pts[i + 1];
    for (const w of [0.15, 0.35]) {
      pos.push(ax - w, ay, az, ax + w, ay, az, bx + w, by, bz, ax - w, ay, az, bx + w, by, bz, bx - w, by, bz);
      pos.push(ax, ay, az - w, ax, ay, az + w, bx, by, bz + w, ax, ay, az - w, bx, by, bz + w, bx, by, bz - w);
    }
  }
  const mesh = root.userData.bolt;
  mesh.geometry.dispose();
  mesh.geometry = new THREE.BufferGeometry();
  mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
}

// ---------- chests: block entities the server lists per section (ChestRenderer) ----------
// Each entry is a chest's position, kind (variant, single/left/right, facing) and the light in its cell. The model is
// the game's chest layer, block-local and y-up, turned by the facing (Direction.toYRot) about the block's centre; the
// lid and latch swing open (xRot -openness * 90 degrees, eased as 1 - (1 - t)^3) while you look inside.
const blockEntityRoot = new THREE.Group();
scene.add(blockEntityRoot);
const sectionChests = new Map();
const CHEST_TEXTURES = ['normal', 'trapped', 'ender', 'copper', 'copper_exposed', 'copper_weathered', 'copper_oxidized'];
const CHEST_LAYERS = ['minecraft:chest#main', 'minecraft:double_chest_left#main', 'minecraft:double_chest_right#main'];
const CHEST_YROT = [180, 0, 90, 270];
function dropChests(key) {
  const list = sectionChests.get(key);
  if (!list) return;
  for (const c of list) if (c.root) { blockEntityRoot.remove(c.root); disposeActor(c.root); }
  sectionChests.delete(key);
}
function readSpecials(key, cx, sy, cz, data, offset) {
  dropChests(key);
  if (data.byteLength < offset + 4) return;
  const n = data.getUint32(offset);
  const list = [];
  for (let i = 0; i < n && offset + 4 + i * 5 + 5 <= data.byteLength; i++) {
    const at = offset + 4 + i * 5;
    const kind = data.getUint8(at + 3) - 1;
    if (kind < 0 || kind >= CHEST_TEXTURES.length * 12) continue;
    list.push({ x: cx * 16 + data.getUint8(at), y: sy * 16 + data.getUint8(at + 1), z: cz * 16 + data.getUint8(at + 2),
      variant: Math.floor(kind / 12), type: Math.floor((kind % 12) / 4), facing: kind % 4, light: data.getUint8(at + 4), root: null, open: 0 });
  }
  if (list.length) sectionChests.set(key, list);
}
function buildChest(c) {
  const tex = atlasTexture('minecraft:entity/chest/' + CHEST_TEXTURES[c.variant] + ['', '_left', '_right'][c.type]);
  const built = tex ? modelActor(CHEST_LAYERS[c.type], tex.texture, 1, unflipped(1)) : null;
  if (!built) return false;
  built.turn.children[0].position.set(-0.5, 0, -0.5);
  built.turn.rotation.y = -CHEST_YROT[c.facing] * DEG;
  const root = new THREE.Group();
  root.add(built.turn);
  root.position.set(c.x + 0.5, c.y, c.z + 0.5);
  root.userData = { kind: 'chest', materials: [built.material] };
  c.root = root;
  c.parts = built.parts;
  blockEntityRoot.add(root);
  return true;
}
function updateChests(dt) {
  if (!atlas.ready || !models.data) return;
  const at = screen && screen.kind === 'container' && screen.at;
  let builds = 0;
  for (const list of sectionChests.values()) {
    for (const c of list) {
      if (!c.root) {
        if (builds++ > 24 || !buildChest(c)) continue;
      }
      lightActor(c.root, c.light);
      // Open while its screen is up here; a double chest's other half opens with it.
      const near = at && at[1] === c.y && (at[0] === c.x && at[2] === c.z
        || (c.type > 0 && Math.abs(at[0] - c.x) + Math.abs(at[2] - c.z) === 1));
      const target = near ? 1 : 0;
      if (c.open === target && !c.dirty) continue;
      c.open = target > c.open ? Math.min(1, c.open + dt * 2) : Math.max(0, c.open - dt * 2);
      const angle = -(1 - Math.pow(1 - c.open, 3)) * Math.PI / 2;
      for (const name of ['lid', 'lock']) if (c.parts[name]) c.parts[name].node.rotation.x = angle;
    }
  }
}

// ---------- camera ----------
// Per-viewer camera settings, kept in this browser only.
const SETTINGS_DEFAULT = { speed: 12, sprint: 3.5, sensitivity: 1, fov: 70, invertY: false, sky: true, clouds: true, weather: true };
const SETTINGS_RANGE = { speed: [1, 100], sprint: [1, 10], sensitivity: [0.1, 3], fov: [30, 110] };
const settings = { ...SETTINGS_DEFAULT };
try {
  const saved = JSON.parse(localStorage.getItem('liveview-settings') || '{}');
  for (const [name, value] of Object.entries(saved || {})) {
    if (!(name in SETTINGS_DEFAULT) || typeof value !== typeof SETTINGS_DEFAULT[name]) continue;
    const r = SETTINGS_RANGE[name];
    settings[name] = r ? Math.min(r[1], Math.max(r[0], Number.isFinite(value) ? value : SETTINGS_DEFAULT[name])) : value;
  }
} catch (error) { /* per-viewer convenience */ }
function saveSettings() {
  try { localStorage.setItem('liveview-settings', JSON.stringify(settings)); } catch (error) { /* per-viewer convenience */ }
}
// The speed slider is logarithmic (1 to 100 blocks a second), so slow and fast flight both get room.
const speedFromSlider = (v) => Math.round(Math.pow(100, v / 100) * 10) / 10;
const sliderFromSpeed = (speed) => Math.round(Math.log(speed) / Math.log(100) * 100);
const settingsEl = $('settings');
function paintSettings() {
  $('set-speed').value = sliderFromSpeed(settings.speed);
  $('set-speed-out').textContent = settings.speed.toFixed(settings.speed < 10 ? 1 : 0) + ' blocks/s';
  $('set-sprint').value = settings.sprint;
  $('set-sprint-out').textContent = '\u00d7' + settings.sprint;
  $('set-sens').value = Math.round(settings.sensitivity * 100);
  $('set-sens-out').textContent = Math.round(settings.sensitivity * 100) + '%';
  $('set-fov').value = settings.fov;
  $('set-fov-out').textContent = settings.fov + '\u00b0';
  $('set-invert').checked = settings.invertY;
  $('set-sky').checked = settings.sky;
  $('set-clouds').checked = settings.clouds;
  $('set-weather').checked = settings.weather;
}
function applySettings() {
  if (camera.fov !== settings.fov) { camera.fov = settings.fov; camera.updateProjectionMatrix(); }
  paintSettings();
  saveSettings();
}
function toggleSettings(open = settingsEl.hidden) {
  settingsEl.hidden = !open;
  $('settings-btn').setAttribute('aria-expanded', String(open));
  if (open) { if (document.pointerLockElement === canvas) document.exitPointerLock(); paintSettings(); }
}
$('settings-btn').addEventListener('click', () => toggleSettings());
settingsEl.addEventListener('submit', (event) => event.preventDefault());
settingsEl.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); toggleSettings(false); canvas.focus(); } });
settingsEl.addEventListener('input', (event) => {
  const id = event.target.id.replace(/^lv-/, '');
  if (id === 'set-speed') settings.speed = speedFromSlider(Number(event.target.value));
  else if (id === 'set-sprint') settings.sprint = Number(event.target.value);
  else if (id === 'set-sens') settings.sensitivity = Number(event.target.value) / 100;
  else if (id === 'set-fov') settings.fov = Number(event.target.value);
  else if (id === 'set-invert') settings.invertY = event.target.checked;
  else if (id === 'set-sky') settings.sky = event.target.checked;
  else if (id === 'set-clouds') settings.clouds = event.target.checked;
  else if (id === 'set-weather') settings.weather = event.target.checked;
  applySettings();
});
$('settings-reset').addEventListener('click', () => { Object.assign(settings, SETTINGS_DEFAULT); applySettings(); });
camera.fov = settings.fov;
camera.updateProjectionMatrix();

const keys = new Set();
let yaw = 0, pitch = -0.3;
let lastCameraSent = { t: 0, x: NaN, y: NaN, z: NaN, dim: '' };

function setCameraDimension(dim) {
  if (dim === cameraDim) return;
  cameraDim = dim;
  paintDims();
  queueSection(async () => clearSections());
  clearSections();
  applySky();
  sendCamera(true);
}

function applySky() {
  const color = SKY[cameraDim] !== undefined ? SKY[cameraDim] : 0x223344;
  fog.color.setHex(color);
  scene.background = new THREE.Color(color);
  scene.fog.color.setHex(color);
  if (lightingReady) applyLighting();
  const far = (view.cameraChunkRadius || 8) * 16;
  fog.near = far * 0.6; fog.far = far;
  scene.fog.near = fog.near; scene.fog.far = fog.far;
  for (const m of [opaqueMaterial, translucentMaterial]) { m.uniforms.fogNear.value = fog.near; m.uniforms.fogFar.value = fog.far; }
  // Far enough for the clouds at y 192 and the sky dome; the terrain still fogs out at its own radius.
  camera.far = Math.max(far * 1.6, 512);
  camera.updateProjectionMatrix();
}

function flyTo(player) {
  if (!player || !Number.isFinite(player.x)) return;
  stopFollow();
  setCameraDimension(player.dimension || cameraDim);
  const facing = (Number(player.yaw) || 0) * Math.PI / 180;
  const fx = -Math.sin(facing), fz = Math.cos(facing);
  camera.position.set(player.x - fx * 5, player.y + 3, player.z - fz * 5);
  const dx = player.x - camera.position.x, dy = player.y + 1.4 - camera.position.y, dz = player.z - camera.position.z;
  yaw = Math.atan2(-dx, -dz);
  pitch = Math.atan2(dy, Math.hypot(dx, dz));
  cameraPlaced = true;
  sendCamera(true);
}

function sendCamera(force) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const now = performance.now();
  const p = camera.position;
  const moved = Math.hypot(p.x - lastCameraSent.x, p.y - lastCameraSent.y, p.z - lastCameraSent.z);
  const due = force || lastCameraSent.dim !== cameraDim || (now - lastCameraSent.t >= 200 && (moved > 0.5 || !(moved >= 0))) || now - lastCameraSent.t >= 2000;
  if (!due) return;
  lastCameraSent = { t: now, x: p.x, y: p.y, z: p.z, dim: cameraDim };
  socket.send(JSON.stringify({
    type: 'camera', dimension: cameraDim,
    x: round(p.x), y: round(p.y), z: round(p.z),
    yaw: round(180 - yaw * 180 / Math.PI), pitch: round(-pitch * 180 / Math.PI)
  }));
}

const round = (value) => Math.round(value * 100) / 100;

let drag = null;
canvas.addEventListener('pointerdown', (event) => {
  if (document.pointerLockElement === canvas) return;
  drag = { x: event.clientX, y: event.clientY, moved: false };
  canvas.focus();
});
canvas.addEventListener('pointermove', (event) => {
  if (!drag || document.pointerLockElement === canvas || !(event.buttons & 1)) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  drag.x = event.clientX; drag.y = event.clientY;
  yaw -= dx * 0.005 * settings.sensitivity;
  pitch = Math.max(-1.55, Math.min(1.55, pitch - dy * 0.005 * settings.sensitivity * (settings.invertY ? -1 : 1)));
});
canvas.addEventListener('click', (event) => {
  if (document.pointerLockElement === canvas) return;
  const dragged = drag && drag.moved;
  drag = null;
  if (dragged) return;
  const hit = pick(event);
  if (hit) {
    openInventory(hit);
    return;
  }
  canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  stage.classList.toggle('flying', document.pointerLockElement === canvas);
  if (document.pointerLockElement !== canvas) keys.clear();
});
document.addEventListener('mousemove', (event) => {
  if (document.pointerLockElement !== canvas) return;
  yaw -= event.movementX * 0.0025 * settings.sensitivity;
  pitch = Math.max(-1.55, Math.min(1.55, pitch - event.movementY * 0.0025 * settings.sensitivity * (settings.invertY ? -1 : 1)));
});
// Spectator mode's scroll wheel: each notch changes the fly speed by about 15%.
let speedShownAt = 0;
canvas.addEventListener('wheel', (event) => {
  if (document.pointerLockElement !== canvas) return;
  event.preventDefault();
  if (!event.deltaY) return;
  const [lo, hi] = SETTINGS_RANGE.speed;
  settings.speed = Math.round(Math.min(hi, Math.max(lo, settings.speed * (event.deltaY < 0 ? 1.15 : 1 / 1.15))) * 10) / 10;
  speedShownAt = performance.now();
  applySettings();
}, { passive: false });
document.addEventListener('keydown', (event) => {
  if (document.pointerLockElement !== canvas && document.activeElement !== canvas) return;
  if (chatOpen) return;
  keys.add(event.code);
  if (event.code === 'Space') event.preventDefault();
});
document.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', () => keys.clear());

const raycaster = new THREE.Raycaster();
function pick(event) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  for (const hit of raycaster.intersectObjects(actorRoot.children, true)) {
    let node = hit.object;
    while (node && !node.userData.kind) node = node.parent;
    if (node && node.userData.kind === 'player') return node.userData.uuid;
  }
  return null;
}

function move(dt) {
  const fast = keys.has('ControlLeft') || keys.has('ControlRight') ? settings.sprint : 1;
  const speed = settings.speed * fast * dt;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  let dx = 0, dy = 0, dz = 0;
  if (keys.has('KeyW')) { dx += fx; dz += fz; }
  if (keys.has('KeyS')) { dx -= fx; dz -= fz; }
  if (keys.has('KeyD')) { dx += rx; dz += rz; }
  if (keys.has('KeyA')) { dx -= rx; dz -= rz; }
  if (keys.has('Space')) dy += 1;
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) dy -= 1;
  const len = Math.hypot(dx, dz) || 1;
  camera.position.x += dx / len * speed;
  camera.position.z += dz / len * speed;
  camera.position.y = Math.max(-2100, Math.min(2100, camera.position.y + dy * speed));
  camera.rotation.set(pitch, yaw, 0);
}

// The game's automatic GUI scale: the largest whole number that still leaves 320 x 240 scaled pixels on screen.
function guiScale(w, h) {
  const dpr = window.devicePixelRatio || 1;
  const fw = w * dpr, fh = h * dpr;
  let scale = 1;
  while (scale < 6 && fw / (scale + 1) >= 320 && fh / (scale + 1) >= 240) scale++;
  return scale / dpr;
}
function resize() {
  const rect = stage.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width)), h = Math.max(1, Math.floor(rect.height));
  stage.style.setProperty('--cross', (15 * guiScale(w, h)) + 'px');
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

let lastFrame = performance.now();
let hudAt = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (following) updateFollow();
  move(dt);
  sendCamera(false);
  syncActors(dt);
  updateSky(dt);
  updateChests(dt);
  updateParticles(dt);
  animateAtlas(now);
  if (mapVisible()) renderer.render(scene, camera);
  if (now - hudAt > 250) {
    hudAt = now;
    const p = camera.position;
    hudPos.textContent = p.x.toFixed(1) + '  ' + p.y.toFixed(1) + '  ' + p.z.toFixed(1);
    hudMore.textContent = dimName(cameraDim) + (now - speedShownAt < 2000 ? ', flying at ' + settings.speed + ' blocks a second' : '');
  }
  if (active) frameRequest = requestAnimationFrame(frame);
  else frameRequest = 0;
}
applySky();
// The loop only runs while the Liveview tab is the page being shown.
let frameRequest = 0;
function startFrames() {
  if (frameRequest) return;
  lastFrame = performance.now();
  frameRequest = requestAnimationFrame(frame);
}


// ---------- access: what stands between this account and the view ----------
// GET /api/liveview says whether the server is connected, whether Liveview is on there, which keys an operator
// has made, and whether this account has entered them. The gate card shows whichever of those is in the way.
// With nothing in the way, the view opens and connects.
const gate = $('gate'), gateTitle = $('gate-title'), gateText = $('gate-text'), gateForm = $('gate-form');
const gateKey = $('gate-key'), gateError = $('gate-error'), gateRetry = $('gate-retry'), gateEnter = $('gate-enter');
let access = null; // the last answer from /api/liveview
let opening = false;
let retryTimer = 0;
let retryDelay = 2000;
let lastStatus = null;

const code = (text) => Object.assign(document.createElement('code'), { textContent: text });
// What the card says for each thing that can be in the way. `text` is a list of strings and nodes.
const GATES = {
  checking: { title: 'Liveview', text: ['Checking the server…'] },
  forbidden: { title: 'Liveview is for admins', text: ['This account isn’t one of the dashboard’s admins.'] },
  signedOut: { title: 'Your login expired', text: ['Reload the page to sign in again.'] },
  unreachable: { title: 'The dashboard didn’t answer', text: ['This page tries again by itself.'], retry: true },
  offline: {
    title: 'The server isn’t connected',
    text: ['Liveview shows the world as it is right now, so it needs the Minecraft server running and connected to this dashboard. This page opens by itself when it’s back.'],
    retry: true
  },
  old: {
    title: 'The server’s mod is too old',
    text: ['Liveview needs version 2.0.0 or newer of the mcstats mod on the Minecraft server.'],
    retry: true
  },
  off: {
    title: 'Liveview is off on the server',
    text: ['It’s switched off in the mod’s settings: ', code('liveview=false'), ' in ', code('config/mcstats-chat.properties'), '.'],
    retry: true
  },
  noKey: {
    title: 'No viewer key yet',
    text: ['An operator makes one in game with ', code('/liveview key viewer'), '. The game shows it to them once; enter it here to start watching.'],
    retry: true
  },
  key: {
    title: 'Enter the viewer key',
    text: ['An operator gets it in game with ', code('/liveview key viewer'), '. You enter it once: after that this account can watch, until a new key is made.'],
    form: true
  }
};
let gateKind = null;
function showGate(kind) {
  const g = GATES[kind];
  if (gateKind !== kind) {
    gateKind = kind;
    gateTitle.textContent = g.title;
    gateText.replaceChildren(...g.text);
    gateForm.hidden = !g.form;
    gateRetry.hidden = !g.retry;
    gateError.textContent = '';
  }
  if (kind === 'old' && access && access.server.version) gateText.replaceChildren(g.text[0] + ' It’s running ' + access.server.version + '.');
  gate.hidden = false;
  app.hidden = true;
  root.classList.add('lv-gated'); // the sections, the controls button and the status only make sense once the view is open
  if (g.form && active) setTimeout(() => gateKey.focus(), 0);
}

function gateFor(a) {
  if (a.forbidden) return 'forbidden';
  if (!a.server.linked) return 'offline';
  if (a.server.old) return 'old';
  if (!a.server.liveview) return 'off';
  if (!a.server.keys.viewer) return 'noKey';
  if (!a.view) return 'key';
  return null;
}

async function fetchAccess() {
  const response = await fetch('/api/liveview', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (response.status === 401) return { signedOut: true };
  if (response.status === 403) return { forbidden: true };
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

// Finds out what's allowed, then shows the gate or the view. Safe to call again at any time.
async function openView() {
  if (!active || opening) return;
  opening = true;
  clearTimeout(retryTimer);
  try {
    if (!access) showGate('checking');
    let next;
    try {
      next = await fetchAccess();
    } catch (error) {
      if (!socket) { showGate('unreachable'); retryLater(); }
      return;
    }
    if (next.signedOut) { showGate('signedOut'); return; }
    access = next.forbidden ? { forbidden: true } : next;
    const kind = gateFor(access);
    if (kind) {
      disconnect();
      showGate(kind);
      // the ones that can clear up by themselves are checked again now and then
      if (GATES[kind].retry) retryLater(15000);
      return;
    }
    gateKind = null;
    gate.hidden = true;
    app.hidden = false;
    root.classList.remove('lv-gated');
    route();
    resize();
    connect();
  } finally {
    opening = false;
  }
}

function retryLater(ms) {
  clearTimeout(retryTimer);
  const wait = ms || retryDelay;
  if (!ms) retryDelay = Math.min(15000, retryDelay * 2);
  retryTimer = setTimeout(() => { if (active && !document.hidden) openView(); }, wait);
}

gateRetry.addEventListener('click', () => openView());
const KEY_ERRORS = {
  wrong: 'That isn’t the key. Use the newest one: each time the command is run, the earlier key stops working.',
  limited: 'Too many tries. Wait a minute, then try again.',
  not_set: 'That key hasn’t been made yet.',
  off: 'The server has this turned off.',
  offline: 'The server isn’t connected right now.',
  locked: 'Enter the viewer key first.'
};
// POST /api/liveview/unlock: the mod checks the key; the dashboard then remembers this account.
async function enterKey(level, key) {
  try {
    const response = await fetch('/api/liveview/unlock', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ level, key })
    });
    const r = await response.json().catch(() => ({}));
    if (response.ok && r.ok) return { ok: true, view: !!r.view, control: !!r.control };
    return { ok: false, message: KEY_ERRORS[r.reason] || 'The key could not be checked. Try again in a moment.' };
  } catch (error) {
    return { ok: false, message: 'The dashboard could not be reached.' };
  }
}
gateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = gateKey.value.trim();
  if (!key) return;
  gateError.textContent = '';
  gateEnter.disabled = true;
  const r = await enterKey('viewer', key);
  gateEnter.disabled = false;
  if (!r.ok) { gateError.textContent = r.message; gateKey.select(); return; }
  gateKey.value = '';
  openView();
});

// ---------- connection ----------
function setStatus(text, state) {
  statusEl.textContent = text;
  statusPill.dataset.state = state || '';
}

function disconnect() {
  const ws = socket;
  socket = null;
  if (ws) { try { ws.close(1000, 'left'); } catch (error) { /* already closed */ } }
  failPending();
  setControls(false);
}

const utf8 = new TextDecoder();
// One message from the relay: frames for this page, each u8 kind (0 JSON, 1 a terrain section), u32 length, payload.
function readBatch(buffer) {
  const view = new DataView(buffer);
  let at = 0;
  while (at + 5 <= buffer.byteLength) {
    const kind = view.getUint8(at), length = view.getUint32(at + 1);
    at += 5;
    if (at + length > buffer.byteLength) break;
    if (kind === 1) {
      const frame = buffer.slice(at, at + length);
      const inflated = startInflate(frame);
      inflated.catch(() => {});
      queueSection(() => handleFrame(frame, inflated));
    } else {
      let msg = null;
      try { msg = JSON.parse(utf8.decode(new Uint8Array(buffer, at, length))); } catch (error) { msg = null; }
      if (msg && typeof msg.type === 'string') onServerMessage(msg);
    }
    at += length;
  }
}

function connect() {
  if (socket || !active || !access || !access.view) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  setStatus('Connecting', 'wait');
  const ws = new WebSocket(proto + '//' + location.host + '/api/liveview/ws');
  socket = ws;
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('close', (event) => {
    if (socket !== ws) return;
    socket = null;
    queueSection(async () => clearSections());
    failPending();
    setControls(false);
    if (!active) return;
    setStatus(event.code === 4429 ? 'Too many pages are watching' : 'Reconnecting', 'wait');
    // the server may have gone, or the key may have been replaced: find out which before trying again
    retryLater();
  });
  ws.addEventListener('message', (event) => {
    if (socket !== ws) return;
    if (event.data instanceof ArrayBuffer) { readBatch(event.data); return; }
    // text is from the relay itself
    let msg;
    try { msg = JSON.parse(event.data); } catch (error) { return; }
    if (!msg) return;
    if (msg.type === 'relay' && msg.state === 'waiting') {
      setStatus('Waking the server', 'wait');
    } else if (msg.type === 'relay' && msg.state === 'up') {
      setStatus('Live', 'up');
      retryDelay = 2000;
      lastCameraSent = { t: 0, x: NaN, y: NaN, z: NaN, dim: '' };
      // Ask for terrain right away rather than on the first rendered frame (a background tab may not render for a while).
      const first = [...players.values()].find((p) => Number.isFinite(p.x));
      if (!cameraPlaced && first) flyTo(first); else if (cameraPlaced) sendCamera(true);
      if (inventoryUuid) ws.send(JSON.stringify({ type: 'subscribe_inventory', uuid: inventoryUuid }));
      // controls that were on before a reconnect come back on; a page that has just opened starts with them off
      if (controlsWanted) armControls(true);
    } else if (msg.type === 'armed') {
      onArmed(msg);
    }
  });
}

// One message from the server mod.
function onServerMessage(msg) {
  if (msg.type === 'hello' && msg.view) {
    view = msg.view;
    applySky();
  } else if (msg.type === 'status') {
    lastStatus = msg;
    syncSkyClock(msg);
    if (controlsOn && msg.control !== true) {
      // not switched off here: a new control key was made in game, or controls were turned off in the mod's settings
      controlsWanted = false;
      toast('The server switched controls off. You’re back to watching only.', true);
    }
    setControls(msg.control === true);
    applyLighting();
    // Nobody online to start beside: start over the world spawn, looking a little down, rather than wherever
    // the camera's zero happens to be (often inside a hill).
    if (!cameraPlaced && !players.size) {
      const s = msg.spawn;
      if (s && Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z)) {
        if (s.dimension) setCameraDimension(s.dimension);
        camera.position.set(s.x + 0.5, s.y + 9, s.z + 12.5);
        yaw = 0; pitch = -0.45;
      }
      cameraPlaced = true;
      sendCamera(true);
    }
  } else if (msg.type === 'atlas') {
    banner.hidden = true;
    queueSection(() => loadAtlas(msg).catch((error) => { terrainEl.textContent = 'The textures didn’t load'; showBanner('The game’s textures didn’t load (' + error.message + ').'); }));
  } else if (msg.type === 'assets_error') {
    terrainEl.textContent = 'Terrain is off';
    showNotice('Terrain is off: ' + (msg.message || 'the game’s textures are unavailable') + '.', 'Players and the log still update.');
  } else if (msg.type === 'window') {
    queueSection(async () => handleWindow(msg));
  } else if (msg.type === 'players' && Array.isArray(msg.players)) {
    players.clear();
    for (const player of msg.players) remember(player);
    // Only the first player list places the camera (next to whoever is online, else where it is). After that the
    // camera never moves on its own: players joining later do not pull it to them.
    if (!cameraPlaced) {
      const first = [...players.values()].find((p) => Number.isFinite(p.x));
      if (first) flyTo(first); // with nobody online, the status message that follows places it over the spawn
    }
  } else if (msg.type === 'player_deltas' && Array.isArray(msg.players)) {
    for (const delta of msg.players) merge(delta);
  } else if (msg.type === 'player_remove' && Array.isArray(msg.uuids)) {
    for (const uuid of msg.uuids) players.delete(uuid);
  } else if (msg.type === 'inventory' && typeof msg.uuid === 'string') {
    if (msg.uuid !== inventoryUuid) return;
    slots.clear();
    inventoryUnavailable = !!msg.unavailable;
    applySlots(msg.slots);
  } else if (msg.type === 'inventory_delta' && typeof msg.uuid === 'string') {
    if (msg.uuid !== inventoryUuid) return;
    inventoryUnavailable = false;
    applySlots(msg.slots);
  } else if (msg.type === 'entities' && Array.isArray(msg.entities)) {
    entities.clear();
    for (const entity of msg.entities) rememberEntity(entity);
    setThrottled(false);
  } else if (msg.type === 'entity_deltas') {
    if (Array.isArray(msg.entities)) for (const delta of msg.entities) mergeEntity(delta);
    if (Array.isArray(msg.removed)) for (const id of msg.removed) entities.delete(id);
    setThrottled(msg.throttled === true);
  } else if (msg.type === 'action') {
    const fresh = typeof msg.id !== 'number' || !seenActions.has(msg.id);
    addAction(msg);
    if (fresh) pushChat(chatSegmentsFor(msg));
  } else if (msg.type === 'command_result') {
    onCommandResult(msg);
    return;
  } else if (msg.type === 'container_result') {
    onContainerResult(msg);
  } else if (msg.type === 'container') {
    onContainer(msg);
    return;
  } else if (msg.type === 'particles') {
    if (mapVisible()) spawnServerParticles(msg.p);
    return;
  }
  schedulePaint();
}

function showBanner(text) { banner.textContent = text; banner.hidden = false; }
function showNotice(strong, rest) {
  const el = $('notice');
  el.replaceChildren(document.createTextNode(strong + ' '), Object.assign(document.createElement('span'), { textContent: rest || '' }));
  el.hidden = false;
}
function remember(player) { if (player && typeof player.uuid === 'string') { players.set(player.uuid, player); recordSample('p:' + player.uuid, player); } }
function rememberEntity(entity) { if (entity && typeof entity.id === 'number') { entities.set(entity.id, entity); recordSample('e:' + entity.id, entity); } }
function mergeEntity(delta) {
  if (!delta || typeof delta.id !== 'number') return;
  const current = entities.get(delta.id) || { id: delta.id };
  Object.assign(current, delta);
  entities.set(delta.id, current);
  recordSample('e:' + delta.id, current);
}
function merge(delta) {
  if (!delta || typeof delta.uuid !== 'string') return;
  const current = players.get(delta.uuid) || { uuid: delta.uuid };
  Object.assign(current, delta);
  players.set(delta.uuid, current);
  recordSample('p:' + delta.uuid, current);
}
function setThrottled(on) { throttleEl.hidden = !on; }
function applySlots(rows) {
  if (!Array.isArray(rows)) return;
  for (const slot of rows) {
    if (!slot || typeof slot.slot !== 'number') continue;
    if (!slot.item || slot.item === 'minecraft:air' || slot.count === 0) slots.delete(slot.slot);
    else slots.set(slot.slot, slot);
  }
}

// ---------- routing ----------
// #/live (the world), #/live/players, #/live/player/<uuid>, #/live/log, #/live/console
const liveHash = (path) => '#/live' + (path ? '/' + path : '');
function route() {
  const parts = location.hash.replace(/^#\/live\/?/, '').split('/');
  let name = parts[0] || 'map';
  if (name === 'player' && parts[1]) {
    subscribe(parts[1]);
  } else if (!['map', 'players', 'log', 'console'].includes(name)) {
    name = 'map';
  }
  currentView = name;
  for (const section of root.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== name;
  const tab = name === 'player' ? 'players' : name;
  for (const link of root.querySelectorAll('[data-tab]')) link.setAttribute('aria-selected', String(link.dataset.tab === tab));
  if (name === 'log') { unseen = 0; paintBadge(); }
  if (name === 'map') requestAnimationFrame(resize);
  if (name === 'console' && controlsOn) $('cmd').focus();
  paintAll();
}

function subscribe(uuid) {
  if (inventoryUuid === uuid) return;
  selected = uuid;
  inventoryUuid = uuid;
  slots.clear();
  inventoryUnavailable = false;
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'subscribe_inventory', uuid }));
}

// Clicking a player in the 3D view or the map's list: follow them and load their inventory.
function selectPlayer(uuid) {
  subscribe(uuid);
  flyTo(players.get(uuid));
  schedulePaint();
}

// ---------- painting ----------
let paintQueued = false;
function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; paintAll(); });
}
function paintAll() {
  paintStats();
  paintSide(false);
  if (screen && (screen.kind !== 'container' || (screen.player && screen.view))) {
    const sig = (atlas.ready ? atlas.url : '') + files.ready + inventoryUnavailable + controlsOn + [...slots.values()].map((x) => x.slot + x.item + x.count + JSON.stringify(x.tooltip || '') + (x.foil ? 'f' : '')).join('|') + (players.get(screen.uuid || screen.player) || {}).selectedSlot;
    if (sig !== screen.sig) { screen.sig = sig; paintScreen(); }
  }
  if (currentView === 'map') { paintPlayerTable($('map-players'), true); paintFeedMini(); }
  if (currentView === 'players') paintPlayerTable($('players-table'), false);
  if (currentView === 'player') paintPlayer();
  if (currentView === 'log') paintLog();
}

function setText(id, text) { const el = $(id); if (el.textContent !== text) el.textContent = text; }

function paintStats() {
  const online = players.size;
  setText('s-online', String(online));
  setText('s-online-c', online === 1 ? 'player on the server' : 'players on the server');
  setText('s-viewers-c', lastStatus && lastStatus.viewers === 1 ? 'page watching (this one)' : 'pages watching');
  let mobs = 0;
  for (const e of entities.values()) if (e.dimension === cameraDim) mobs++;
  setText('s-mobs', String(mobs));
  if (lastStatus) {
    setText('s-viewers', String(lastStatus.viewers));
    const mspt = Number(lastStatus.mspt);
    setText('s-mspt', mspt >= 0 ? mspt.toFixed(1) : '–');
    setText('s-mspt-c', mspt < 0 ? 'appears once the server has ticked' : mspt > 50 ? 'over 50, the server is lagging' : 'ms per tick, 50 is the limit');
  }
  setText('online-sub', online ? String(online) : '');
  setText('players-sub', online ? String(online) : '');
}

const DIM_NAMES = { 'minecraft:overworld': 'Overworld', 'minecraft:the_nether': 'Nether', 'minecraft:the_end': 'End' };
const dimName = (id) => DIM_NAMES[id] || (id || '').replace(/^minecraft:/, '').replace(/_/g, ' ');
const sortedPlayers = () => [...players.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

let tableSignatures = new Map();
function paintPlayerTable(host, compact) {
  const rows = sortedPlayers();
  const sig = (faceVersion) + '|' + rows.map((p) => [p.uuid, p.name, p.dimension, Math.round(p.x), Math.round(p.y), Math.round(p.z), p.health, p.gameMode, p.skin].join(',')).join('|');
  if (tableSignatures.get(host) === sig) return;
  tableSignatures.set(host, sig);
  if (!rows.length) {
    host.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Nobody is online. Players appear here as soon as they join.' }));
    return;
  }
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  const columns = compact ? ['Player', 'Where', 'Health'] : ['Player', 'Where', 'Position', 'Health', 'Game mode'];
  for (const c of columns) {
    const th = document.createElement('th');
    th.textContent = c;
    if (c === 'Health') th.className = 'num';
    if (c === 'Position') th.className = 'num hide-sm';
    head.append(th);
  }
  const body = table.createTBody();
  for (const p of rows) {
    const tr = body.insertRow();
    tr.className = 'link';
    tr.tabIndex = 0;
    const open = () => {
      if (compact) selectPlayer(p.uuid);
      else location.hash = liveHash('player/' + p.uuid);
    };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    const who = tr.insertCell();
    who.append(whoEl(p));
    if (compact) {
      const link = document.createElement('a');
      link.href = liveHash('player/' + p.uuid);
      link.textContent = 'Details';
      link.className = 'lv-details';
      link.addEventListener('click', (e) => e.stopPropagation());
      who.firstChild.append(link);
    }
    tr.insertCell().textContent = dimName(p.dimension);
    if (!compact) {
      const pos = tr.insertCell();
      pos.className = 'num muted hide-sm';
      pos.textContent = [p.x, p.y, p.z].map((v) => Number.isFinite(v) ? Math.round(v) : '–').join(', ');
    }
    const hp = tr.insertCell();
    hp.className = 'num';
    hp.textContent = Number.isFinite(p.health) ? (p.health / 2).toFixed(1) + ' ♥' : '–';
    if (!compact) tr.insertCell().textContent = cap(p.gameMode || '–');
  }
  host.replaceChildren(table);
}

function whoEl(p) {
  const wrap = document.createElement('div');
  wrap.className = 'pname';
  wrap.append(faceCanvas(p, 'lv-face'), Object.assign(document.createElement('span'), { className: 'lv-name', textContent: p.name || p.uuid.slice(0, 8) }));
  return wrap;
}

// Faces come from the real skin: the 8x8 face at (8, 8) with the hat layer at (40, 8) on top.
const skinImages = new Map();
let faceVersion = 0;
function skinImage(p) {
  const key = p && p.skin ? p.skin : defaultSkinKey(p);
  if (!key) return null;
  if (skinImages.has(key)) return skinImages.get(key);
  let image = null;
  if (p && p.skin) {
    image = new Image();
    image.onload = () => { faceVersion++; schedulePaint(); };
    image.src = p.skin;
  } else if (atlas.ready) {
    const r = atlasRect(key);
    if (r) image = cropAtlas(r, 64, 64);
  }
  if (image) skinImages.set(key, image);
  return image;
}
function defaultSkinKey(p) {
  if (!atlas.ready || !atlas.meta.playerSkins) return null;
  return atlas.meta.playerSkins[p && p.skinModel === 'slim' ? 'slim' : 'wide'];
}
function drawFace(target, p) {
  const ctx = target.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, target.width, target.height);
  const img = skinImage(p);
  const ready = img && (img instanceof HTMLCanvasElement || (img.complete && img.naturalWidth));
  if (!ready) return;
  const s = target.width / 8;
  ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8 * s, 8 * s);
  ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 8 * s, 8 * s);
}
function faceCanvas(p, className) {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  c.className = className;
  drawFace(c, p);
  return c;
}

function paintFeedMini() {
  const host = $('feed-mini');
  const recent = actions.slice(-9).reverse();
  const sig = recent.map((a) => a.id).join(',');
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  if (!recent.length) { host.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Nothing has happened yet.' })); return; }
  host.replaceChildren(...recent.map((a) => {
    const row = document.createElement('div');
    row.className = 'lv-feed-row';
    const time = document.createElement('time');
    time.textContent = clock(a.time);
    const text = document.createElement('div');
    text.className = 'log-msg';
    text.textContent = describe(a);
    row.append(time, text);
    return row;
  }));
}

// ---------- action log ----------
let unseen = 0;
let logFilter = 'all';
const FILTERS = {
  all: () => true,
  chat: (a) => a.kind === 'chat',
  blocks: (a) => a.kind === 'block_break' || a.kind === 'block_place',
  combat: (a) => a.kind === 'attack' || a.kind === 'death',
  joins: (a) => a.kind === 'join' || a.kind === 'leave' || a.kind === 'dimension_change'
};
const KIND_LABEL = { chat: 'Chat', block_break: 'Broke', block_place: 'Placed', attack: 'Attack', death: 'Death', join: 'Joined', leave: 'Left', dimension_change: 'Travel', item_use: 'Used', system_message: 'Server' };

function addAction(msg) {
  if (typeof msg.id === 'number') {
    if (seenActions.has(msg.id)) return;
    seenActions.add(msg.id);
  }
  msg.time = typeof msg.time === 'number' ? msg.time : Date.now();
  actions.push(msg);
  if (actions.length > 1000) actions.splice(0, actions.length - 1000);
  if (currentView !== 'log' && (msg.kind === 'chat' || msg.kind === 'death')) { unseen++; paintBadge(); }
}
function paintBadge() {
  const badge = $('log-badge');
  badge.hidden = unseen === 0;
  badge.textContent = unseen > 99 ? '99+' : String(unseen);
}

function actorName(a) {
  const p = a.actor ? players.get(a.actor) : null;
  return p && p.name ? p.name : a.actor ? a.actor.slice(0, 8) : '';
}
function describe(a) {
  const who = actorName(a);
  const target = prettyId(a.target || '');
  switch (a.kind) {
    case 'chat': return (who ? who + ': ' : '') + (a.message || '');
    case 'block_break': return who + ' broke ' + target;
    case 'block_place': return who + ' placed ' + target;
    case 'attack': return who + ' attacked ' + (target || 'something');
    case 'item_use': return who + ' used ' + target;
    case 'death': return a.message || who + ' died';
    case 'join': return who + ' joined';
    case 'leave': return who + ' left';
    case 'dimension_change': return who + ' went to ' + dimName(a.target || a.dimension);
    default: return a.message || [who, target].filter(Boolean).join(' ');
  }
}

let logSig = '';
function paintLog() {
  const host = $('log-table');
  const rows = actions.filter(FILTERS[logFilter]).slice(-300).reverse();
  const sig = logFilter + rows.length + (rows[0] ? rows[0].id : '');
  if (sig === logSig && host.childElementCount) return;
  logSig = sig;
  if (!rows.length) {
    host.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: logFilter === 'all' ? 'Nothing has happened since you opened this page.' : 'Nothing of this kind yet.' }));
    return;
  }
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const [label, cls] of [['Time', ''], ['What', ''], ['Detail', ''], ['Where', 'num hide-sm']]) {
    const th = document.createElement('th'); th.textContent = label; th.className = cls; head.append(th);
  }
  const body = table.createTBody();
  for (const a of rows) {
    const tr = body.insertRow();
    const t = tr.insertCell(); t.className = 'lv-time muted'; t.textContent = clock(a.time);
    const k = tr.insertCell();
    const kind = document.createElement('span');
    const group = a.kind === 'join' ? 'join' : a.kind === 'leave' ? 'leave' : a.kind;
    kind.className = 'lv-kind ' + group;
    kind.textContent = KIND_LABEL[a.kind] || cap(String(a.kind || 'event'));
    k.append(kind);
    const d = tr.insertCell(); d.className = 'log-msg'; d.textContent = describe(a);
    const w = tr.insertCell(); w.className = 'num muted hide-sm';
    w.textContent = typeof a.x === 'number' ? a.x + ', ' + a.y + ', ' + a.z : '';
  }
  host.replaceChildren(table);
}
for (const button of root.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => { logFilter = button.dataset.filter; paintFilters(); paintLog(); });
}
function paintFilters() {
  for (const button of root.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === logFilter));
}
paintFilters();

// ---------- player page ----------
let playerSig = '';
function paintPlayer() {
  const p = selected ? players.get(selected) : null;
  if (!p) {
    setText('p-name', 'Player not online');
    setText('p-where', 'They left the server, or hid themselves from Liveview with /liveview optout.');
    $('p-stats').hidden = true;
    $('p-inv').replaceChildren();
    $('p-ender').replaceChildren();
    return;
  }
  setText('p-name', p.name || p.uuid);
  setText('p-where', 'In the ' + dimName(p.dimension) + (p.gameMode ? ', ' + p.gameMode : ''));
  $('p-stats').hidden = false;
  $('p-stats').href = '#/player/' + p.uuid;
  drawFace($('p-face'), p);
  const hp = Number(p.health), max = Number(p.maxHealth) || 20;
  setText('p-health', Number.isFinite(hp) ? (hp / 2).toFixed(1) + ' / ' + (max / 2) : '–');
  $('p-health-bar').style.width = Number.isFinite(hp) ? Math.max(0, Math.min(100, hp / max * 100)) + '%' : '0';
  const food = Number(p.hunger);
  setText('p-food', Number.isFinite(food) ? food + ' / 20' : '–');
  $('p-food-bar').style.width = Number.isFinite(food) ? Math.max(0, Math.min(100, food / 20 * 100)) + '%' : '0';
  setText('p-mode', cap(p.gameMode || '–'));
  setText('p-held', p.heldItem && p.heldItem !== 'minecraft:air' ? 'Holding ' + prettyId(p.heldItem) : 'Holding nothing');
  setText('p-pos', [p.x, p.y, p.z].map((v) => Number.isFinite(v) ? Math.round(v) : '–').join(', '));
  setText('p-dim', dimName(p.dimension));
  for (const b of root.querySelectorAll('#lv-p-modes [data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === p.gameMode));
  paintTpTargets(p);
  const sig = (atlas.ready ? atlas.url : '') + files.ready + inventoryUnavailable + p.selectedSlot + lookKey(p.look) + [...slots.values()].map((s) => s.slot + s.item + s.count + JSON.stringify(s.tooltip || '') + (s.foil ? 'f' : '')).join('|');
  if (sig === playerSig && $('p-inv').childElementCount) return;
  playerSig = sig;
  paintInventory(p);
}

function paintTpTargets(p) {
  const select = $('p-tp-target');
  const others = sortedPlayers().filter((o) => o.uuid !== p.uuid);
  const sig = others.map((o) => o.uuid).join(',');
  if (select.dataset.sig === sig) return;
  select.dataset.sig = sig;
  const keep = select.value;
  select.replaceChildren(...(others.length ? others.map((o) => new Option('To ' + (o.name || o.uuid.slice(0, 8)), o.name || o.uuid)) : [new Option('No other players', '')]));
  if ([...select.options].some((o) => o.value === keep)) select.value = keep;
}

function paintInventory(p) {
  const host = $('p-inv');
  if (inventoryUnavailable) {
    host.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'This inventory is hidden: the player left, or hid themselves with /liveview optout.' }));
    $('p-ender').replaceChildren();
    return;
  }
  host.replaceChildren(inventoryScreen(p, slots));
  $('p-ender').replaceChildren(chestScreen(plain('Ender Chest'), 3, [...slots.values()], 100));
}

function itemIconKey(item) {
  if (!atlas.ready) return null;
  const colon = item.indexOf(':');
  const ns = colon >= 0 ? item.slice(0, colon) : 'minecraft';
  const path = colon >= 0 ? item.slice(colon + 1) : item;
  for (const key of [ns + ':item/' + path, ns + ':block/' + path, ns + ':block/' + path + '_front', ns + ':block/' + path + '_side']) {
    if (atlasRect(key)) return key;
  }
  return null;
}

function itemIcon(item) {
  if (!atlas.ready) return null;
  const colon = item.indexOf(':');
  const ns = colon >= 0 ? item.slice(0, colon) : 'minecraft';
  const path = colon >= 0 ? item.slice(colon + 1) : item;
  return atlasRect(ns + ':item/' + path) || atlasRect(ns + ':block/' + path) || atlasRect(ns + ':block/' + path + '_front') || atlasRect(ns + ':block/' + path + '_side');
}

function slotEl(index, ghost) {
  const el = document.createElement('div');
  el.className = 'slot';
  const slot = slots.get(index);
  const count = slot && slot.count ? slot.count : 0;
  if (!count) {
    if (ghost) el.append(Object.assign(document.createElement('span'), { className: 'ghost', textContent: ghost }));
    if (ghost) el.title = ghost + ': empty';
    return el;
  }
  el.title = (slot.customName ? '"' + slot.customName + '" ' : '') + prettyId(slot.item) + (count > 1 ? ' x' + count : '');
  if (slot.customName) el.classList.add('named');
  const rect = itemIcon(slot.item);
  if (rect) {
    const size = Math.min(rect.w, 16);
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    c.getContext('2d').drawImage(atlas.canvas, rect.u, rect.v, size, size, 0, 0, size, size);
    el.append(c);
  } else {
    el.append(Object.assign(document.createElement('span'), { className: 'txt', textContent: prettyId(slot.item) }));
  }
  if (count > 1) el.append(Object.assign(document.createElement('span'), { className: 'n', textContent: String(count) }));
  return el;
}

// ---------- controls: running commands and moving items ----------
// Watching never changes the world. Controls do, so they're a second step. The account enters the server's
// control key once (an operator makes it in game with /liveview key control); the dashboard remembers that.
// Even then controls are off each time this page opens, until they're switched on with the button at the top,
// and nothing here switches them on by itself: an action that needs them says so instead.
const controlPill = $('control-pill'), controlLabel = $('control-label');
let controlsOn = false;
let controlsWanted = false; // switched on in this visit, so a reconnect brings them back
function setControls(on) {
  if (controlsOn === on && controlPill.dataset.init) return;
  controlPill.dataset.init = '1';
  controlsOn = on;
  controlPill.setAttribute('aria-pressed', String(on));
  controlLabel.textContent = on ? 'Controls on' : 'Watching only';
  controlPill.title = on
    ? 'Commands and item moves change the world. Click to go back to watching only.'
    : 'You’re only watching: nothing you do here changes the world. Click to turn on controls.';
  // everything that needs controls is shown or swapped for a note by this one class
  root.classList.toggle('lv-controls-on', on);
  sideSig = '';
  schedulePaint();
}
controlPill.addEventListener('click', async () => {
  if (controlsOn) {
    controlsWanted = false;
    await armControls(false);
    toast('Back to watching only.');
  } else {
    await turnOnControls();
  }
});
for (const button of root.querySelectorAll('[data-controls-on]')) button.addEventListener('click', () => turnOnControls());

// The relay answers { type: 'armed', on, reason? } to { type: 'arm', on }.
let armWaiters = [];
function armControls(on) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve({ on: false, reason: 'offline' });
  socket.send(JSON.stringify({ type: 'arm', on }));
  return new Promise((resolve) => {
    armWaiters.push(resolve);
    setTimeout(() => resolve({ on: false, reason: 'offline' }), 6000);
  });
}
function onArmed(msg) {
  const waiters = armWaiters; armWaiters = [];
  for (const w of waiters) w({ on: msg.on === true, reason: msg.reason || null });
  if (msg.on !== true) controlsWanted = false;
  // the mod confirms with its next status message; this just makes the button answer at once
  if (lastStatus && lastStatus.controlAllowed === false) return;
  setControls(msg.on === true);
}

async function turnOnControls() {
  if (controlsOn) return true;
  if (!socket || socket.readyState !== WebSocket.OPEN) { toast('Not connected to the server yet.', true); return false; }
  // which keys exist, and whether this account has entered them, may have changed since the page opened
  try {
    const fresh = await fetchAccess();
    if (fresh && fresh.server) access = fresh;
  } catch (error) { /* what was known before will do */ }
  if (lastStatus && lastStatus.controlAllowed === false) {
    toast('Controls are turned off on the server (liveview_control=false in the mod’s settings).', true);
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!access.control && !(await askControlKey())) return false;
    const r = await armControls(true);
    if (r.on) {
      controlsWanted = true;
      toast('Controls are on. Commands and item moves now change the world.');
      return true;
    }
    if (r.reason !== 'locked') { toast('Controls couldn’t be turned on: the server didn’t answer.', true); return false; }
    access.control = false; // the control key was replaced since this account entered it
  }
  return false;
}

// The server refused something because controls aren't on there (say, the control key was just replaced).
function noteLocked() {
  controlsWanted = false;
  setControls(false);
  toast('Controls are off. Turn them on to change anything.', true);
}

const keyDialog = $('unlock');
let keyWaiters = [];
function askControlKey() {
  $('unlock-error').textContent = access && access.server && !access.server.keys.control
    ? 'No control key has been made yet. An operator runs /liveview key control in game first.' : '';
  if (!keyDialog.open) keyDialog.showModal();
  $('control-key').focus();
  return new Promise((resolve) => keyWaiters.push(resolve));
}
function finishKey(ok) {
  if (keyDialog.open) keyDialog.close();
  const waiters = keyWaiters; keyWaiters = [];
  for (const w of waiters) w(ok);
}
$('unlock-cancel').addEventListener('click', () => finishKey(false));
keyDialog.addEventListener('cancel', () => finishKey(false));
$('unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const field = $('control-key');
  const key = field.value.trim();
  if (!key) return;
  $('unlock-enter').disabled = true;
  const r = await enterKey('control', key);
  $('unlock-enter').disabled = false;
  if (!r.ok) { $('unlock-error').textContent = r.message; field.select(); return; }
  field.value = '';
  access.control = r.control;
  access.server.keys.control = true;
  if (!r.control) { $('unlock-error').textContent = 'The key was right, but the server has controls turned off.'; return; }
  finishKey(true);
});

// Commands travel over the view's own connection: { type: 'command', id, command } is answered with
// { type: 'command_result', id, ok, lines } (or locked: true when controls aren't on at the server).
let commandSeq = 0;
const commandWaiters = new Map();
function onCommandResult(msg) {
  const done = commandWaiters.get(msg.id);
  if (!done) return;
  commandWaiters.delete(msg.id);
  done(msg);
}
function failPending() {
  for (const done of commandWaiters.values()) done(null);
  commandWaiters.clear();
  const waiters = armWaiters; armWaiters = [];
  for (const w of waiters) w({ on: false, reason: 'offline' });
}

// Runs one command as the server console; returns { ok, lines } or null. Needs controls on: it never turns them on.
async function runCommand(command, { quiet = false } = {}) {
  if (!controlsOn) { toast('That changes the world: turn on controls first.', true); return null; }
  if (!socket || socket.readyState !== WebSocket.OPEN) { toast('Not connected to the server.', true); return null; }
  const id = ++commandSeq;
  const result = await new Promise((resolve) => {
    commandWaiters.set(id, resolve);
    setTimeout(() => { if (commandWaiters.delete(id)) resolve(null); }, 15000);
    socket.send(JSON.stringify({ type: 'command', id, command }));
  });
  if (!result) { toast('The server didn’t answer.', true); return null; }
  if (result.locked) { noteLocked(); return null; }
  logConsole(command, result);
  if (!quiet) toast((result.lines && result.lines.length ? result.lines.join(' ') : result.ok ? 'Done.' : 'The command failed.'), !result.ok);
  return result;
}

// Player names are [A-Za-z0-9_]{3,16}; anything else is refused rather than quoted into a command.
function safeName(p) {
  const name = p && p.name;
  return name && /^[A-Za-z0-9_]{1,16}$/.test(name) ? name : null;
}

const confirmTimers = new WeakMap();
function confirmed(button, label) {
  if (button.classList.contains('armed')) {
    button.classList.remove('armed');
    button.textContent = button.dataset.label;
    clearTimeout(confirmTimers.get(button));
    return true;
  }
  button.dataset.label = button.textContent;
  button.classList.add('armed');
  button.textContent = label;
  confirmTimers.set(button, setTimeout(() => { button.classList.remove('armed'); button.textContent = button.dataset.label; }, 4000));
  return false;
}

for (const button of root.querySelectorAll('[data-act]')) {
  button.addEventListener('click', async () => {
    const p = selected ? players.get(selected) : null;
    const act = button.dataset.act;
    if (act === 'view') { location.hash = liveHash(''); selectPlayer(selected); return; }
    if (act === 'follow') { if (selected && players.has(selected)) { location.hash = liveHash(''); startFollow(selected, 'first'); } return; }
    const name = safeName(p);
    if (!name) { toast('This player is not online.', true); return; }
    let command = null;
    if (act === 'tp-camera') {
      const c = camera.position;
      command = 'execute in ' + cameraDim + ' run tp ' + name + ' ' + c.x.toFixed(2) + ' ' + c.y.toFixed(2) + ' ' + c.z.toFixed(2);
    } else if (act === 'tp-player') {
      const target = $('p-tp-target').value;
      if (!/^[A-Za-z0-9_]{1,16}$/.test(target)) { toast('Pick another online player first.', true); return; }
      command = 'tp ' + name + ' ' + target;
    } else if (act === 'heal') command = 'effect give ' + name + ' minecraft:instant_health 1 10 true';
    else if (act === 'feed') command = 'effect give ' + name + ' minecraft:saturation 1 20 true';
    else if (act === 'clear-effects') command = 'effect clear ' + name;
    else if (act === 'kick') { if (!confirmed(button, 'Click again to kick')) return; command = 'kick ' + name + ' Kicked by an admin'; }
    else if (act === 'kill') { if (!confirmed(button, 'Click again to kill')) return; command = 'kill ' + name; }
    else if (act === 'clear-inv') { if (!confirmed(button, 'Click again to clear')) return; command = 'clear ' + name; }
    if (command) runCommand(command);
  });
}
for (const button of root.querySelectorAll('#lv-p-modes [data-mode]')) {
  button.addEventListener('click', () => {
    const name = safeName(selected ? players.get(selected) : null);
    if (!name) { toast('This player is not online.', true); return; }
    runCommand('gamemode ' + button.dataset.mode + ' ' + name);
  });
}

// ---------- console ----------
const cmdHistory = [];
let historyAt = 0;
function logConsole(command, result) {
  const out = $('console-out');
  if (out.firstElementChild && out.firstElementChild.classList.contains('lv-console-hint')) out.replaceChildren();
  out.append(Object.assign(document.createElement('div'), { className: 'lv-cmd', textContent: '/' + command }));
  const lines = result.lines && result.lines.length ? result.lines : [result.ok ? 'Done.' : 'The command failed.'];
  for (const line of lines) out.append(Object.assign(document.createElement('div'), { className: 'lv-out' + (result.ok ? '' : ' bad'), textContent: line }));
  while (out.childElementCount > 600) out.firstElementChild.remove();
  out.scrollTop = out.scrollHeight;
}
$('cmd-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('cmd');
  const command = input.value.trim().replace(/^\//, '');
  if (!command) return;
  cmdHistory.push(command);
  historyAt = cmdHistory.length;
  input.value = '';
  await runCommand(command, { quiet: true });
  input.focus();
});
$('cmd').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowUp' && historyAt > 0) { historyAt--; event.target.value = cmdHistory[historyAt]; event.preventDefault(); }
  if (event.key === 'ArrowDown') { historyAt = Math.min(cmdHistory.length, historyAt + 1); event.target.value = cmdHistory[historyAt] || ''; event.preventDefault(); }
});

// ---------- in-world chat (T, Enter or /), like the game's chat HUD ----------
const chatLines = $('chat-lines'), chatForm = $('chat-form'), chatInput = $('chat-input'), chatHint = $('chat-hint');
const chatHistory = [];
let chatHistoryAt = 0;
let chatOpen = false;
function chatSegmentsFor(a) {
  const who = actorName(a);
  switch (a.kind) {
    case 'chat': return [['<' + who + '> ', -1, 0], [a.message || '', -1, 0]];
    case 'join': return plain(who + ' joined the game', 0xFFFF55);
    case 'leave': return plain(who + ' left the game', 0xFFFF55);
    case 'death': return plain(a.message || who + ' died');
    case 'system_message': return plain(a.message || '');
    default: return null;
  }
}
function pushChat(segs) {
  if (!segs) return;
  const line = textCanvas(segs, 2, { shadow: true, pad: 1 });
  const c = document.createElement('canvas');
  c.width = Math.max(line.width, 1); c.height = line.height;
  c.getContext('2d').drawImage(line, 0, 0);
  c.style.width = (c.width / 2 * GUI) + 'px'; c.style.height = (c.height / 2 * GUI) + 'px';
  chatLines.append(c);
  while (chatLines.childElementCount > 100) chatLines.firstElementChild.remove();
  // Vanilla fades a line after 200 ticks unless the chat is open; only the last 10 show while closed.
  setTimeout(() => c.classList.add('gone'), 10000);
  layoutChat();
}
function layoutChat() {
  const kids = [...chatLines.children];
  kids.forEach((c, i) => { c.hidden = !chatOpen && i < kids.length - 10; });
  if (!chatOpen) kids.slice(0, Math.max(0, kids.length - 10)).forEach((c) => c.classList.add('gone'));
}
function openChat(prefix = '') {
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  chatOpen = true;
  chatLines.classList.add('open');
  chatForm.hidden = false; chatHint.hidden = false;
  layoutChat();
  chatInput.value = prefix;
  chatHistoryAt = chatHistory.length;
  setTimeout(() => { chatInput.focus(); chatInput.setSelectionRange(prefix.length, prefix.length); }, 0);
}
function closeChat() {
  chatOpen = false;
  chatLines.classList.remove('open');
  chatForm.hidden = true; chatHint.hidden = true;
  layoutChat();
  canvas.focus();
}
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); closeChat(); }
  else if (event.key === 'ArrowUp' && chatHistoryAt > 0) { chatHistoryAt--; chatInput.value = chatHistory[chatHistoryAt]; event.preventDefault(); }
  else if (event.key === 'ArrowDown') { chatHistoryAt = Math.min(chatHistory.length, chatHistoryAt + 1); chatInput.value = chatHistory[chatHistoryAt] || ''; event.preventDefault(); }
  event.stopPropagation();
});
chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  closeChat();
  if (!text) return;
  chatHistory.push(text);
  if (text.startsWith('/')) await spectatorCommand(text.slice(1).trim());
  else await sendChat(text);
});
$('chat-btn').addEventListener('click', () => openChat(''));

// Plain text goes out as dashboard chat (the same as typing on the Chat log page: "[Web] <you> text"), which
// doesn't need controls: it's a message, not a command.
async function sendChat(text) {
  try {
    const response = await fetch('/api/chat/send', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ text })
    });
    if (response.ok || response.status === 202) return;
    const r = await response.json().catch(() => ({}));
    pushChat(plain(r.error || 'The message was not sent.', 0xFF5555));
  } catch (error) {
    pushChat(plain('The message was not sent: the dashboard could not be reached.', 0xFF5555));
  }
}

// ---------- following a player: their own view (first person), or the game's two third-person views ----------
// The camera sits at the player's eyes (Entity.getEyeHeight per pose) and looks where they look, from the same
// smoothed position, yaw and pitch the world view draws them with. Behind and in front mirror the game's F5 views:
// 4 blocks back along (or ahead of) the view direction, pulled in when a block is in the way.
let following = null;
let followMode = 'first';
const FOLLOW_MODES = ['first', 'back', 'front'];
const FOLLOW_LABEL = { first: 'First person', back: 'Behind', front: 'In front' };
const followBar = $('follow-bar');
function startFollow(uuid, mode = 'first') {
  const target = players.get(uuid);
  if (!target) return;
  following = uuid;
  followMode = mode;
  if (target.dimension && target.dimension !== cameraDim) setCameraDimension(target.dimension);
  cameraPlaced = true;
  paintFollowBar();
}
function stopFollow() {
  if (!following) return;
  following = null;
  paintFollowBar();
}
function cycleFollow() {
  if (!following) return;
  followMode = FOLLOW_MODES[(FOLLOW_MODES.indexOf(followMode) + 1) % FOLLOW_MODES.length];
  paintFollowBar();
}
function paintFollowBar() {
  followBar.hidden = !following;
  if (!following) return;
  const p = players.get(following);
  $('follow-name').textContent = p ? (p.name || p.uuid.slice(0, 8)) : '';
  for (const b of followBar.querySelectorAll('[data-follow]')) b.setAttribute('aria-pressed', String(b.dataset.follow === followMode));
}
for (const b of followBar.querySelectorAll('[data-follow]')) b.addEventListener('click', () => { followMode = b.dataset.follow; paintFollowBar(); canvas.focus(); });
$('follow-stop').addEventListener('click', () => { stopFollow(); canvas.focus(); });

const followRay = new THREE.Raycaster();
const followEye = new THREE.Vector3(), followDir = new THREE.Vector3();
function eyeHeight(pose) {
  if (pose === 'crouching') return 1.27;
  if (pose === 'swimming' || pose === 'fall_flying' || pose === 'spin_attack') return 0.4;
  if (pose === 'sleeping') return 0.2;
  return 1.62;
}
// Camera.getMaxZoom: how far the third-person camera can back away before a block is in the way.
function clearDistance(from, dir, want) {
  followRay.set(from, dir);
  followRay.far = want + 0.2;
  const near = terrainRoot.children.filter((m) => m.material === opaqueMaterial
    && Math.abs(m.position.x + 8 - from.x) < 14 && Math.abs(m.position.y + 8 - from.y) < 14 && Math.abs(m.position.z + 8 - from.z) < 14);
  const hit = near.length ? followRay.intersectObjects(near, false)[0] : null;
  return hit ? Math.max(0.1, hit.distance - 0.2) : want;
}
function updateFollow() {
  const moving = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft'].some((k) => keys.has(k));
  const target = players.get(following);
  if (moving || !target) { stopFollow(); return; }
  if (target.dimension !== cameraDim) setCameraDimension(target.dimension);
  const root = actorMeshes.get('p:' + following);
  const sm = root && root.userData.smooth;
  const look = target.look || {};
  const pose = (look.motion && look.motion.pose) || 'standing';
  const Y = (sm ? sm.yaw : Number(target.yaw) || 0) * DEG, P = (sm ? sm.pitch : Number(target.pitch) || 0) * DEG;
  followEye.set(sm ? sm.x : target.x, (sm ? sm.y : target.y) + eyeHeight(pose), sm ? sm.z : target.z);
  // Minecraft's view vector: yaw 0 looks south (+Z), positive pitch looks down.
  followDir.set(-Math.sin(Y) * Math.cos(P), -Math.sin(P), Math.cos(Y) * Math.cos(P));
  if (followMode === 'first') {
    camera.position.copy(followEye);
    yaw = Math.PI - Y; pitch = -P;
  } else if (followMode === 'back') {
    const back = followDir.clone().negate();
    camera.position.copy(followEye).addScaledVector(back, clearDistance(followEye, back, 4));
    yaw = Math.PI - Y; pitch = -P;
  } else {
    camera.position.copy(followEye).addScaledVector(followDir, clearDistance(followEye, followDir, 4));
    yaw = -Y; pitch = P;
  }
  pitch = Math.max(-1.55, Math.min(1.55, pitch));
}

// ---------- commands as a spectator: /tp and /spectate move the camera, everything else runs at the camera ----------
const COORD = /^(~-?\d*\.?\d*|-?\d+\.?\d*)$/;
function resolveCoord(token, base) {
  if (token.startsWith('~')) return base + (token.length > 1 ? Number(token.slice(1)) : 0);
  return Number(token);
}
function playerByName(name) {
  const lower = String(name).toLowerCase();
  return [...players.values()].find((p) => (p.name || '').toLowerCase() === lower) || null;
}
function cameraCoords() {
  const c = camera.position;
  return c.x.toFixed(2) + ' ' + c.y.toFixed(2) + ' ' + c.z.toFixed(2);
}
function teleportCamera(x, y, z, dim) {
  if (dim) setCameraDimension(dim);
  camera.position.set(x, y, z);
  cameraPlaced = true;
  stopFollow();
  sendCamera(true);
}
function self(token) { return token === '@s' || token === '@p'; }
async function spectatorCommand(command) {
  if (!command) return;
  pushChat(plain('/' + command, 0xAAAAAA));
  const parts = command.split(/\s+/);
  const verb = parts[0].toLowerCase().replace(/^minecraft:/, '');
  const args = parts.slice(1);
  if (verb === 'tp' || verb === 'teleport') {
    // /tp <x y z>, /tp @s <x y z>, /tp <player>, /tp @s <player>: move the camera.
    let rest = args;
    if (rest.length && self(rest[0]) && rest.length !== 1) rest = rest.slice(1);
    if (rest.length === 3 && rest.every((t) => COORD.test(t))) {
      const c = camera.position;
      teleportCamera(resolveCoord(rest[0], c.x), resolveCoord(rest[1], c.y), resolveCoord(rest[2], c.z));
      pushChat(plain('Teleported the camera to ' + cameraCoords()));
      return;
    }
    if (rest.length === 1 && !self(rest[0])) {
      const target = playerByName(rest[0]);
      if (target) { stopFollow(); flyTo(target); pushChat(plain('Teleported the camera to ' + target.name)); return; }
    }
    // /tp <player> @s: bring them to the camera.
    if (args.length === 2 && self(args[1])) {
      await serverCommand('tp ' + args[0] + ' ' + cameraCoords());
      return;
    }
  }
  if (verb === 'spectate') {
    const target = args[0] ? playerByName(args[0]) : null;
    if (!target) { stopFollow(); pushChat(plain('Stopped spectating')); return; }
    // Like /spectate in game: their own view. V switches to behind or in front.
    startFollow(target.uuid, 'first');
    pushChat(plain('Now seeing what ' + target.name + ' sees. V switches the view, move or Esc to stop.'));
    return;
  }
  if (verb === 'gamemode' && (args.length === 1 || (args[1] && self(args[1])))) {
    pushChat(plain('The web view is always a spectator.', 0xFF5555));
    return;
  }
  // Everything else runs as the console, positioned and rotated at the camera, so ~ ~ ~ and ^ ^ ^ mean "here".
  const replaced = parts.map((t) => self(t) ? cameraCoords() : t).join(' ');
  await serverCommand(replaced);
}
async function serverCommand(command) {
  const yawDeg = (180 - yaw * 180 / Math.PI).toFixed(1), pitchDeg = (-pitch * 180 / Math.PI).toFixed(1);
  const wrapped = 'execute in ' + cameraDim + ' positioned ' + cameraCoords() + ' rotated ' + yawDeg + ' ' + pitchDeg + ' run ' + command;
  if (!controlsOn) { pushChat(plain('That runs on the server, so it needs controls on (the button at the top of the page).', 0xFF5555)); return; }
  const result = await runCommand(wrapped, { quiet: true });
  if (!result) return;
  const lines = result.lines && result.lines.length ? result.lines : [result.ok ? 'Done.' : 'The command failed.'];
  for (const line of lines) pushChat(plain(line, result.ok ? -1 : 0xFF5555));
}

// ---------- the players menu: teleport, spectate, inventories, edit ----------
const side = $('side');
function toggleSide(open = side.hidden) {
  side.hidden = !open;
  if (open) { if (document.pointerLockElement === canvas) document.exitPointerLock(); paintSide(true); }
}
$('menu-btn').addEventListener('click', () => toggleSide());
$('side-close').addEventListener('click', () => toggleSide(false));
// Teleport the camera to typed coordinates. ~ works as in /tp (relative to the camera), and blank Y keeps the height.
$('goto-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const c = camera.position;
  const read = (id, base) => {
    const raw = $(id).value.trim();
    if (!raw) return base;
    if (!COORD.test(raw)) return NaN;
    return resolveCoord(raw, base);
  };
  const x = read('goto-x', NaN), y = read('goto-y', c.y), z = read('goto-z', NaN);
  if (![x, y, z].every(Number.isFinite)) { toast('Type numbers for X and Z (Y is optional, ~ means relative).', true); return; }
  const dim = $('goto-dim').value || '';
  teleportCamera(x, y, z, dim || undefined);
  toggleSide(false);
  toast('Teleported to ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + (dim ? ' in ' + dimName(dim) : ''));
});
side.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); toggleSide(false); canvas.focus(); } });
$('goto-here').addEventListener('click', () => {
  const c = camera.position;
  $('goto-x').value = Math.floor(c.x); $('goto-y').value = Math.floor(c.y); $('goto-z').value = Math.floor(c.z);
  $('goto-dim').value = cameraDim;
});
let sideSig = '';
// One row per player. The first line of buttons only looks (it moves your camera or opens a screen); the second,
// which changes the player or the world, is only there while controls are on.
function paintSide(force) {
  if (side.hidden) return;
  const rows = sortedPlayers();
  const sig = faceVersion + (controlsOn ? 'c' : 'w') + rows.map((p) => [p.uuid, p.name, p.dimension, p.gameMode, Math.round(p.health || 0), Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)].join(',')).join('|');
  if (!force && sig === sideSig) return;
  sideSig = sig;
  const list = $('side-list');
  if (!rows.length) { list.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Nobody is online.' })); return; }
  const button = (label, fn, cls) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.className = 'btn' + (cls ? ' ' + cls : '');
    b.addEventListener('click', () => fn(b));
    return b;
  };
  list.replaceChildren(...rows.map((p) => {
    const row = document.createElement('div');
    row.className = 'lv-who-row';
    const head = document.createElement('div');
    head.className = 'lv-who-head';
    const label = document.createElement('div');
    label.append(Object.assign(document.createElement('span'), { className: 'lv-name', textContent: p.name || p.uuid.slice(0, 8) }),
      Object.assign(document.createElement('small'), { textContent: [Number.isFinite(p.health) ? (p.health / 2).toFixed(1) + ' ♥' : '', cap(p.gameMode || ''), dimName(p.dimension),
        Number.isFinite(p.x) ? Math.floor(p.x) + ' ' + Math.floor(p.y) + ' ' + Math.floor(p.z) : ''].filter(Boolean).join(', ') }));
    head.append(faceCanvas(p, 'lv-face'), label);
    const look = document.createElement('div');
    look.className = 'lv-acts';
    look.append(
      button('Go to', () => { stopFollow(); flyTo(players.get(p.uuid)); toggleSide(false); }, 'btn-primary'),
      button('Follow', () => { startFollow(p.uuid, 'first'); toggleSide(false); canvas.focus(); toast('Seeing what ' + p.name + ' sees. V switches the view; move or press Esc to stop.'); }),
      button('Follow behind', () => { startFollow(p.uuid, 'back'); toggleSide(false); canvas.focus(); }),
      button('Inventory', () => openInventory(p.uuid)),
      button('Ender chest', () => openInventory(p.uuid, true)),
      button('Details', () => { location.hash = liveHash('player/' + p.uuid); }));
    row.append(head, look);
    const name = safeName(p);
    if (controlsOn && name) {
      const act = document.createElement('div');
      act.className = 'lv-acts lv-acts-control';
      const modes = document.createElement('div');
      modes.className = 'seg';
      modes.setAttribute('role', 'group');
      modes.setAttribute('aria-label', 'Game mode');
      for (const mode of ['survival', 'creative', 'adventure', 'spectator']) {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = cap(mode);
        b.setAttribute('aria-pressed', String(p.gameMode === mode));
        b.addEventListener('click', () => runCommand('gamemode ' + mode + ' ' + name));
        modes.append(b);
      }
      act.append(modes,
        button('Bring here', () => runCommand('execute in ' + cameraDim + ' run tp ' + name + ' ' + cameraCoords())),
        button('Heal', () => runCommand('effect give ' + name + ' minecraft:instant_health 1 10 true')),
        button('Feed', () => runCommand('effect give ' + name + ' minecraft:saturation 1 20 true')),
        button('Clear effects', () => runCommand('effect clear ' + name)),
        button('Kill', (b) => { if (confirmed(b, 'Click again to kill')) runCommand('kill ' + name); }, 'lv-danger'),
        button('Kick', (b) => { if (confirmed(b, 'Click again to kick')) runCommand('kick ' + name + ' Kicked by an admin'); }, 'lv-danger'),
        button('Clear inventory', (b) => { if (confirmed(b, 'Click again to clear')) runCommand('clear ' + name); }, 'lv-danger'));
      row.append(act);
    }
    return row;
  }));
}

// ---------- game screens over the world: a player's inventory, an ender chest, a block container ----------
const screenWrap = $('screen-wrap'), screenHost = $('screen-host');
let screen = null; // { kind: 'inventory'|'ender'|'container', uuid?, view? }
function closeScreen() {
  if (screen && screen.kind === 'container' && socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'close_container' }));
  screen = null;
  screenWrap.hidden = true;
  screenHost.replaceChildren();
  hideTooltip();
}
screenWrap.addEventListener('click', (event) => { if (event.target === screenWrap) closeScreen(); });
function openInventory(uuid, ender = false) {
  subscribe(uuid);
  screen = { kind: ender ? 'ender' : 'inventory', uuid };
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  paintScreen();
}
function openContainerAt(x, y, z) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  // The inventory underneath: the player you follow, else the nearest one in this dimension.
  let player = following && players.get(following) ? following : null;
  if (!player) {
    let best = Infinity;
    for (const p of players.values()) {
      if (p.dimension !== cameraDim || !Number.isFinite(p.x)) continue;
      const d = Math.hypot(p.x - x, p.y - y, p.z - z);
      if (d < best) { best = d; player = p.uuid; }
    }
  }
  screen = { kind: 'container', view: null, at: [x, y, z], player, pick: null };
  if (player) subscribe(player);
  socket.send(JSON.stringify({ type: 'open_container', dimension: cameraDim, x, y, z }));
}
function paintScreen() {
  if (!screen) return;
  let el = null;
  if (screen.kind === 'inventory' || screen.kind === 'ender') {
    const p = players.get(screen.uuid);
    if (inventoryUnavailable || !p) el = Object.assign(document.createElement('div'), { className: 'empty', textContent: 'This inventory is hidden: the player left, or hid themselves with /liveview optout.' });
    else if (screen.kind === 'ender') el = chestScreen(plain('Ender Chest'), 3, [...slots.values()], 100);
    else {
      el = inventoryScreen(p, slots);
      screenLabel(el, plain(p.name || ''), 8, -10);
    }
  } else if (screen.view) {
    el = containerScreen(screen.view);
  }
  if (!el) return;
  const bar = screen.kind === 'container' ? containerBar() : null;
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'lv-screen-close'; close.textContent = '×'; close.title = 'Close (Esc)'; close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeScreen);
  if (el.classList.contains('mc-screen')) el.append(close);
  if (bar) screenHost.replaceChildren(bar, el);
  else screenHost.replaceChildren(el);
  screenWrap.hidden = false;
  if (tipFor) hideTooltip();
}
function onContainer(msg) {
  if (!screen || screen.kind !== 'container' || !screen.at) return;
  if (msg.x !== screen.at[0] || msg.y !== screen.at[1] || msg.z !== screen.at[2]) return;
  if (msg.missing) { toast('Nothing to open there: right-click a chest, barrel, shulker box, hopper or dispenser.', true); screen = null; return; }
  screen.view = msg;
  paintScreen();
}

// Right-click a block in the world: find the block under the cursor in the terrain meshes.
function pickBlock(event) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  if (document.pointerLockElement === canvas) ndc.set(0, 0);
  raycaster.setFromCamera(ndc, camera);
  raycaster.far = 64;
  const near = terrainRoot.children.filter((m) => m.position.distanceTo(camera.position) < 90);
  const chests = blockEntityRoot.children.filter((m) => m.position.distanceTo(camera.position) < 64);
  const hits = raycaster.intersectObjects(near, false).concat(raycaster.intersectObjects(chests, true)).sort((a, b) => a.distance - b.distance);
  raycaster.far = Infinity;
  if (!hits.length || !hits[0].face) return null;
  const hit = hits[0];
  // a chest is a model of its own (its latch even pokes out of its block): the block is where the model stands
  for (let node = hit.object; node; node = node.parent) {
    if (node.userData && node.userData.kind === 'chest') return [Math.floor(node.position.x), Math.round(node.position.y), Math.floor(node.position.z)];
  }
  const normal = hit.face.normal.clone();
  const p = hit.point.clone().addScaledVector(normal, -0.01);
  return [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
}
canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const hit = pickBlock(event);
  if (hit) openContainerAt(...hit);
});

// ---------- fullscreen ----------
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else stage.requestFullscreen().catch(() => toast('This browser refused fullscreen.', true));
}
$('full-btn').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  const on = document.fullscreenElement === stage;
  $('full-btn').lastElementChild.textContent = on ? 'Exit' : 'Fullscreen';
  const t = $('toast');
  (on ? stage : root).append(t);
  requestAnimationFrame(resize);
});

// Keys in the world view: T / Enter chat, / command, M players, F fullscreen, E inventory of the nearest player, Esc closes.
document.addEventListener('keydown', (event) => {
  if (!mapVisible() || chatOpen) return;
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if (inField || keyDialog.open) return;
  const inWorld = document.activeElement === canvas || document.pointerLockElement === canvas || stage.contains(document.activeElement) || document.fullscreenElement === stage;
  if (!inWorld) return;
  if (event.key === 'Escape' && screen) { closeScreen(); return; }
  if (event.key === 'Escape' && !side.hidden) { toggleSide(false); return; }
  if (event.key === 'Escape' && !settingsEl.hidden) { toggleSettings(false); return; }
  if (event.key === 'Escape' && !keysEl.hidden) { toggleKeys(false); return; }
  if (event.key === 'Escape' && following) { stopFollow(); return; }
  if ((event.key === 'v' || event.key === 'V') && following) { event.preventDefault(); cycleFollow(); return; }
  if (event.key === 't' || event.key === 'T' || event.key === 'Enter') { event.preventDefault(); openChat(''); }
  else if (event.key === '/') { event.preventDefault(); openChat('/'); }
  else if (event.key === 'm' || event.key === 'M') { event.preventDefault(); toggleSide(); }
  else if (event.key === 'f' || event.key === 'F') { event.preventDefault(); toggleFullscreen(); }
}, true);

// ---------- small things ----------
let toastTimer = 0;
function toast(text, bad) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast lv-toast' + (bad ? ' toast-error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 6000 : 3500);
}

// Day and night: the server sends the overworld's sky darkening (0 at noon, 11 at midnight). The client-side factor
// vanilla feeds its lightmap is roughly (1 - darken / 11) * 0.8 + 0.2, then * 0.95 + 0.05.
const DIM_LIGHT = { 'minecraft:the_nether': { ambient: 0.1, end: 0 }, 'minecraft:the_end': { ambient: 0, end: 1 } };
let fullbright = false;
try { fullbright = localStorage.getItem('liveview-fullbright') === '1'; } catch (error) { fullbright = false; }
const skyTint = new THREE.Color();
const FLASH_WHITE = new THREE.Color(1, 1, 1);
// Runs every frame: the sky factor follows the overworld clock and weather (or the server's integer darkening when the
// clock is unknown), and a lightning flash lights everything up for a moment, as skyFlashTime does in vanilla.
function applyLighting() {
  const st = sky.state;
  let level;
  if (st && st.level !== null) level = st.level;
  else {
    const darken = lastStatus && Number.isFinite(lastStatus.skyDarken) ? lastStatus.skyDarken : 0;
    level = (1 - Math.min(11, Math.max(0, darken)) / 11) * 0.8 + 0.2;
  }
  const overworld = cameraDim === 'minecraft:overworld';
  const flash = overworld && settings.weather ? weather.flash : 0;
  if (flash > 0) level += (1 - level) * flash * 0.9;
  const skyB = level * 0.95 + 0.05;
  const dim = DIM_LIGHT[cameraDim] || { ambient: 0, end: 0 };
  for (const m of [opaqueMaterial, translucentMaterial]) {
    m.uniforms.fullbright.value = fullbright ? 1 : 0;
    m.uniforms.skyBright.value = skyB;
    m.uniforms.ambient.value = dim.ambient;
    m.uniforms.endTint.value = dim.end;
  }
  // The overworld sky and fog follow the sun's height and the weather too, unless fullbright is on.
  const base = skyTint.setHex(SKY[cameraDim] !== undefined ? SKY[cameraDim] : 0x223344);
  if (!fullbright && overworld) {
    if (st && st.known) {
      base.multiplyScalar(Math.max(0.03, Math.min(1, Math.cos(st.angle * 2 * Math.PI) * 2 + 0.5)));
      weatherWash(base, st.rain, st.thunder, 0.75, 0.75);
    } else {
      base.multiplyScalar(Math.max(0.05, (skyB - 0.05) / 0.95));
    }
    if (flash > 0) base.lerp(FLASH_WHITE, flash * 0.4);
  }
  fog.color.copy(base);
  if (!(scene.background instanceof THREE.Color)) scene.background = new THREE.Color();
  scene.background.copy(base);
  scene.fog.color.copy(base);
}
$('fullbright').setAttribute('aria-pressed', String(fullbright));
$('fullbright').addEventListener('click', () => {
  fullbright = !fullbright;
  $('fullbright').setAttribute('aria-pressed', String(fullbright));
  try { localStorage.setItem('liveview-fullbright', fullbright ? '1' : '0'); } catch (error) { /* per-viewer convenience */ }
  applyLighting();
});
lightingReady = true;
applyLighting();
Object.assign(debugState, { stats: () => ({ sections: sections.size, vertices: vertexTotal }), pickBlock: (x, y) => pickBlock({ clientX: x, clientY: y }), openContainerAt: (x, y, z) => openContainerAt(x, y, z), materials: [opaqueMaterial, translucentMaterial], particles: () => particlePool.length, sections: () => sections.size,
  icon: itemIconCanvas, tooltip: tooltipCanvas, containerScreen, inventoryScreen, files, text: textCanvas, splash: spawnPotionSplash, camera,
  entities, players, settings, weather, follow: () => [following, followMode], sky: () => sky.state, look: (y, p) => { yaw = y; pitch = p; } });

function paintDims() {
  for (const b of root.querySelectorAll('[data-dim]')) b.setAttribute('aria-pressed', String(b.dataset.dim === cameraDim));
  if (lightingReady) applyLighting();
}
for (const b of root.querySelectorAll('[data-dim]')) b.addEventListener('click', () => setCameraDimension(b.dataset.dim));
paintDims();

// The logo is the game's own grass block side texture, once the atlas is in.
function onAtlasReady() {
  terrainEl.textContent = '';
  pixelCache.clear();
  const modelsReady = atlas.meta.models ? loadModels(atlas.meta.models).catch((error) => console.warn('liveview models', error)) : Promise.resolve();
  modelsReady.then(() => loadFiles(atlas.meta)).catch((error) => console.warn('liveview files', error));
  faceVersion++;
  playerSig = '';
  schedulePaint();
}

function prettyId(id) {
  if (!id) return '';
  const path = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  return path.split('_').map((w, i) => i === 0 ? cap(w) : w).join(' ');
}
function cap(text) { return text ? text.charAt(0).toUpperCase() + text.slice(1) : text; }
function clock(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function hash(text) {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) | 0;
  return value;
}

// ---------- the keys panel ----------
const keysEl = $('keys');
function toggleKeys(open = keysEl.hidden) {
  keysEl.hidden = !open;
  $('keys-btn').setAttribute('aria-expanded', String(open));
  if (open && document.pointerLockElement === canvas) document.exitPointerLock();
}
$('keys-btn').addEventListener('click', () => toggleKeys());
$('keys-close').addEventListener('click', () => { toggleKeys(false); canvas.focus(); });

// ---------- shown and hidden by app.js ----------
// A view that's left open in a tab nobody is looking at would keep the server streaming to it, so the
// connection is dropped after a while and picked up again when the page is looked at.
const LEAVE_MS = 30_000; // on another page of the dashboard
const HIDDEN_MS = 120_000; // the browser tab is in the background
let leaveTimer = 0;
let hiddenTimer = 0;

// The Liveview tab was opened (or its address changed): show whatever the address asks for.
export function show() {
  clearTimeout(leaveTimer);
  const was = active;
  active = true;
  startFrames();
  if (!app.hidden) route();
  if (!was || !socket) openView();
}

// Another page of the dashboard was opened.
export function hide() {
  if (!active) return;
  active = false;
  clearTimeout(retryTimer);
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  if (document.fullscreenElement === stage) document.exitFullscreen().catch(() => {});
  if (chatOpen) closeChat();
  hideTooltip();
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => { if (!active) disconnect(); }, LEAVE_MS);
}

document.addEventListener('visibilitychange', () => {
  clearTimeout(hiddenTimer);
  if (document.hidden) {
    hiddenTimer = setTimeout(() => { if (document.hidden) { disconnect(); setStatus('Paused', ''); } }, HIDDEN_MS);
  } else if (active && !socket) {
    openView();
  }
});

// How many chat messages and deaths arrived while the log wasn't being looked at, for the tab's badge.
export const unseenCount = () => unseen;
