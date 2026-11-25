// How a server's pages look: its accent color and how the current tab is marked. Both are the server's
// own settings (ACCENT, TAB_STYLE), changed on Admin → Server, and put on the page's <html> before it's
// drawn (src/index.js), where public/style.css picks them up:
//   data-accent="green" | "blue" | "custom"   with style="--accent-custom:#rrggbb; --accent-ink:…" for custom
//   data-tabs="line" | "frame"
//
// ACCENT: 'green' (the default, as on the site's own pages), 'blue', or any #rrggbb.
// TAB_STYLE: 'line' (the default: greyer with a line in the accent color under it) or 'frame' (set in, framed).
export const ACCENTS = ['green', 'blue'];
export const TAB_STYLES = ['line', 'frame'];
const HEX_RE = /^#[0-9a-f]{6}$/;

// 'green', 'blue' or '#rrggbb' from what was typed; null if it's none of them.
export function cleanAccent(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (ACCENTS.includes(s)) return s;
  const hex = s.startsWith('#') ? s : `#${s}`;
  return HEX_RE.test(hex) ? hex : null;
}

// Text on the accent color: white, unless the color is too light for white to be read on it.
export function inkOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#16181b' : '#ffffff';
}

// { accent, tabs } as the settings have them, with the defaults filled in.
export function lookOf(settings) {
  return {
    accent: cleanAccent(settings?.ACCENT) || 'green',
    tabs: TAB_STYLES.includes(settings?.TAB_STYLE) ? settings.TAB_STYLE : 'line',
  };
}

// The attributes for <html>: { 'data-accent', 'data-tabs', style? }.
export function lookAttrs(look) {
  const custom = look.accent.startsWith('#');
  return {
    'data-accent': custom ? 'custom' : look.accent,
    'data-tabs': look.tabs,
    ...(custom && { style: `--accent-custom:${look.accent};--accent-ink:${inkOn(look.accent)}` }),
  };
}
