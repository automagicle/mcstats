// Add-ons: features only some servers have, kept apart from the dashboard every server gets.
//
// An add-on is a folder, public/addons/<id>/, with a script that registers itself with the dashboard
// (window.MCS_ADDONS, read by public/app.js: see "add-ons" there for the hooks) and usually a stylesheet.
// A server has the add-ons named in its ADDONS setting (comma separated); the Worker puts only those on
// its page (src/index.js), so no other server loads or shows any of it. Only the site's operators
// (SUPER_ADMIN_EMAIL) can switch one on or off, on Admin → Server.
//
// An add-on can have a page of its own, with a tab in the top bar (the `page` hook in public/app.js), and
// routes of its own in the Worker, which answer only where it's switched on (hasAddon, below).
//
// An add-on can also have options (on or off each), which a server's admins set on Admin → Server once it
// has the add-on: `options: { key: { name, about } }`, kept in the server's ADDON_OPTS setting.
//
// To add one: make the folder, list it here, and switch it on for the server.
export const ADDONS = {
  eggsmp: {
    name: 'Egg SMP eggs',
    about: 'Each player’s egg on their page (abilities, level, energy), in their 3D model’s off hand with its particles, and an Egg field on Admin → Players.',
    scripts: ['/addons/eggsmp/addon.js'],
    styles: ['/addons/eggsmp/addon.css'],
  },
  advancements: {
    name: 'Advancements tab',
    about: 'An Advancements page, made for all-advancements runs: how far the whole server is, what’s left and who’s closest, who earned what first, and the same for each team. Needs the server mod.',
    scripts: ['/addons/advancements/addon.js'],
    styles: ['/addons/advancements/addon.css'],
    options: {
      shared: {
        name: 'Advancements are shared',
        about: 'For servers where everyone gets an advancement as soon as anyone earns it, so who earned it means nothing. The Advancements page then leaves players out: no names, no first-to-earn, no Players list.',
      },
    },
  },
};

// The add-ons a server's settings switch on, in the order above; names this site doesn't have are dropped.
export const addonList = (settings) => {
  const on = new Set(String(settings?.ADDONS || '').split(',').map((s) => s.trim()));
  return Object.keys(ADDONS).filter((id) => on.has(id));
};

// Whether a server (its settings, or the env made from them: src/tenantenv.js) has an add-on switched on.
export const hasAddon = (settings, id) => addonList(settings).includes(id);

// The options of the add-ons a server has, as they're set: { addonId: { key: true|false } }. Options of
// add-ons it doesn't have, and ones this site doesn't know, aren't there.
export function addonOptions(settings) {
  let saved = {};
  try { saved = JSON.parse(settings?.ADDON_OPTS || '{}') || {}; } catch { /* unreadable: all off */ }
  const out = {};
  for (const id of addonList(settings)) {
    if (!ADDONS[id].options) continue;
    out[id] = Object.fromEntries(Object.keys(ADDONS[id].options).map((key) => [key, saved?.[id]?.[key] === true]));
  }
  return out;
}
export const addonOption = (settings, id, key) => addonOptions(settings)[id]?.[key] === true;
