// How a server's pages are laid out: which sections each page shows, in what order, how wide, and under
// what title; and which number tiles show, in what order. Changed on Admin → Layout, kept in the server's
// LAYOUT setting (JSON), and put on the page with the rest of window.MCS (src/index.js), where
// public/app.js arranges the page by it before anything is drawn.
//
//   { home:   [{ id, w, hide?, title? }],   in their order; w is 'full' | 'wide' | 'half' | 'narrow'
//     player: [...], combat: [...],
//     tiles:  { home: [{ id, hide? }], player: [...] } }
//
// The ids are the sections' data-sec and the tiles' data-tile in public/stats.html; public/app.js has the
// same lists (LAYOUT_PAGES) with their names. A section or tile this list doesn't know is dropped, and one
// it knows that's missing is added at the end, as it is by default, so a layout saved before a section
// existed still shows it.
export const WIDTHS = ['full', 'wide', 'half', 'narrow'];

export const SECTIONS = {
  home: [['about', 'full'], ['now', 'full'], ['timeline', 'full'], ['daily', 'full'], ['leaderboard', 'wide'], ['busiest', 'narrow']],
  player: [['addon', 'narrow'], ['combat', 'wide'], ['activity', 'full'], ['when', 'narrow'], ['recent', 'wide'], ['advancements', 'full']],
  combat: [['score', 'full'], ['chart', 'full'], ['leaderboard', 'full']],
};
export const TILES = {
  home: ['online', 'peak', 'played', 'seen'],
  player: ['total', 'sessions', 'longest', 'chat'],
};
const MAX_TITLE = 40;
const MAX_JSON = 6000;

export function defaultLayout() {
  const out = {};
  for (const [page, list] of Object.entries(SECTIONS)) out[page] = list.map(([id, w]) => ({ id, w }));
  out.tiles = Object.fromEntries(Object.entries(TILES).map(([page, ids]) => [page, ids.map((id) => ({ id }))]));
  return out;
}

const cleanTitle = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '');

// A layout as given (an object, or its JSON) -> the whole layout, every page and tile in it; or null if it
// isn't one at all. Never throws.
export function cleanLayout(raw) {
  let v = raw;
  if (typeof v === 'string') {
    if (!v.trim()) return defaultLayout();
    if (v.length > MAX_JSON) return null;
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [page, list] of Object.entries(SECTIONS)) {
    const known = new Map(list);
    const seen = new Set();
    const rows = [];
    for (const s of Array.isArray(v[page]) ? v[page] : []) {
      if (!s || typeof s !== 'object' || !known.has(s.id) || seen.has(s.id)) continue;
      seen.add(s.id);
      const row = { id: s.id, w: WIDTHS.includes(s.w) ? s.w : known.get(s.id) };
      if (s.hide === true) row.hide = true;
      const title = cleanTitle(s.title);
      if (title) row.title = title;
      rows.push(row);
    }
    for (const [id, w] of list) if (!seen.has(id)) rows.push({ id, w });
    out[page] = rows;
  }
  out.tiles = {};
  for (const [page, ids] of Object.entries(TILES)) {
    const given = Array.isArray(v.tiles?.[page]) ? v.tiles[page] : [];
    const seen = new Set();
    const rows = [];
    for (const t of given) {
      if (!t || typeof t !== 'object' || !ids.includes(t.id) || seen.has(t.id)) continue;
      seen.add(t.id);
      rows.push(t.hide === true ? { id: t.id, hide: true } : { id: t.id });
    }
    for (const id of ids) if (!seen.has(id)) rows.push({ id });
    // a row of tiles with none in it would leave an empty frame: the first one stays
    if (rows.every((t) => t.hide)) delete rows[0].hide;
    out.tiles[page] = rows;
  }
  return out;
}

// What to keep in the LAYOUT setting: '' when it's the default (so nothing is stored), else its JSON.
export function layoutSetting(layout) {
  const s = JSON.stringify(layout);
  return s === JSON.stringify(defaultLayout()) ? '' : s;
}

// The layout the settings give, filled in.
export const layoutOf = (settings) => cleanLayout(settings?.LAYOUT || '') || defaultLayout();

// The server's description: plain text on its Activity page, one paragraph.
export const MAX_ABOUT = 280;
export const cleanAbout = (v) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

// ---- the server's icon: a square PNG, made from what was uploaded by the admin page ----
export const MAX_ICON_BYTES = 64 * 1024;

// A data: URL (data:image/png;base64,…) -> its bytes, if they're a square PNG 16 to 256 pixels wide; else an error.
export function iconFromDataUrl(v) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(typeof v === 'string' ? v : '');
  if (!m) return { error: 'The icon is a PNG image.' };
  if (m[1].length > Math.ceil(MAX_ICON_BYTES / 3) * 4 + 4) return { error: 'The icon is too large (at most 64 KB).' };
  let bin;
  try { bin = atob(m[1]); } catch { return { error: 'The icon couldn’t be read.' }; }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (bytes.length > MAX_ICON_BYTES) return { error: 'The icon is too large (at most 64 KB).' };
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || sig.some((b, i) => bytes[i] !== b) || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') {
    return { error: 'The icon is a PNG image.' };
  }
  const dv = new DataView(bytes.buffer);
  const w = dv.getUint32(16), h = dv.getUint32(20);
  if (w !== h || w < 16 || w > 256) return { error: 'The icon is square, 16 to 256 pixels wide.' };
  return { bytes, size: w };
}
