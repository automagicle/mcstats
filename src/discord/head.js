// GET /api/discord/head/<uuid>.png: a player's face (with the hat layer), 64×64, for webhook avatars and embed
// thumbnails. Discord fetches these itself, so unlike the dashboard's skins they need no sign-in. It takes a
// Mojang uuid only, never a name, and says nothing about which servers that player plays on (skins are public
// at Mojang anyway). Made from the same cached skin the dashboard's player pages use (src/mcassets.js).
import { serveSkin } from '../mcassets.js';

const SIZE = 64;
const enc = new TextEncoder();

export async function serveHead(env, uuid) {
  if (!/^[0-9a-f]{32}$/.test(uuid)) return new Response('Not found', { status: 404 });
  const cache = caches.default;
  const key = new Request(`https://mcstats-cache.invalid/discord-head/${uuid}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  // the name is only used when Mojang can't be asked by uuid; any valid one does
  const skin = await serveSkin(env, 'Steve', uuid);
  let png = null;
  if (skin.ok) {
    try {
      png = await face(new Uint8Array(await skin.arrayBuffer()));
    } catch (err) {
      console.error('discord head:', err.message);
    }
  }
  if (!png) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=300' } });
  const res = new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
  await cache.put(key, res.clone());
  return res;
}

// The 8×8 face at (8, 8) with the hat at (40, 8) over it, scaled up to 64×64.
async function face(bytes) {
  const img = await decodePng(bytes);
  if (!img || img.width < 64 || img.height < 32) return null;
  const out = new Uint8Array(SIZE * SIZE * 4);
  const scale = SIZE / 8;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const base = img.pixel(8 + x, 8 + y);
      const hat = img.pixel(40 + x, 8 + y);
      const a = hat[3] / 255;
      const px = [0, 1, 2].map((i) => Math.round(hat[i] * a + base[i] * (1 - a))).concat(255);
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) out.set(px, ((y * scale + dy) * SIZE + (x * scale + dx)) * 4);
      }
    }
  }
  return encodePng(SIZE, SIZE, out);
}

// ---- just enough PNG: 8-bit RGB or RGBA (or palette), not interlaced, which is what skins are ----

const readU32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

async function inflate(data) {
  const s = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function deflate(data) {
  const s = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function decodePng(b) {
  if (b.length < 33 || readU32(b, 0) !== 0x89504e47) return null;
  let i = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (i + 8 <= b.length) {
    const len = readU32(b, i);
    const kind = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const data = b.subarray(i + 8, i + 8 + len);
    if (kind === 'IHDR') { width = readU32(data, 0); height = readU32(data, 4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    i += 12 + len;
  }
  const channels = { 2: 3, 6: 4, 3: 1, 0: 1, 4: 2 }[type];
  if (depth !== 8 || interlace || !channels || width > 1024 || height > 1024) return null;
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let at = 0;
  for (const d of idat) { joined.set(d, at); at += d.length; }
  const raw = await inflate(joined);
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const up = y ? px[(y - 1) * stride + x] : 0;
      const ul = y && x >= channels ? px[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - ul, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
      }
      px[y * stride + x] = v & 255;
    }
  }
  const pixel = (x, y) => {
    const o = y * stride + x * channels;
    if (type === 6) return [px[o], px[o + 1], px[o + 2], px[o + 3]];
    if (type === 2) return [px[o], px[o + 1], px[o + 2], 255];
    if (type === 0) return [px[o], px[o], px[o], 255];
    if (type === 4) return [px[o], px[o], px[o], px[o + 1]];
    const c = px[o];
    return palette ? [palette[c * 3], palette[c * 3 + 1], palette[c * 3 + 2], trns && c < trns.length ? trns[c] : 255] : [0, 0, 0, 0];
  };
  return { width, height, pixel };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(kind, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(enc.encode(kind), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function encodePng(width, height, rgba) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export const _test = { decodePng, encodePng, face };
