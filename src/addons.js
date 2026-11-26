// Add-ons: features only some servers have, kept apart from the dashboard every server gets.
//
// An add-on is a folder, public/addons/<id>/, with a script that registers itself with the dashboard
// (window.MCS_ADDONS, read by public/app.js: see "add-ons" there for the hooks) and usually a stylesheet.
// A server has the add-ons named in its ADDONS setting (comma separated); the Worker puts only those on
// its page (src/index.js), so no other server loads or shows any of it. Only the site's operators
// (SUPER_ADMIN_EMAIL) can switch one on or off, on Admin → Server.
//
// To add one: make the folder, list it here, and switch it on for the server.
export const ADDONS = {
  eggsmp: {
    name: 'Egg SMP eggs',
    about: 'Each player’s egg on their page (abilities, level, energy), in their 3D model’s off hand with its particles, and an Egg column on Admin → Settings.',
    scripts: ['/addons/eggsmp/addon.js'],
    styles: ['/addons/eggsmp/addon.css'],
  },
};

// The add-ons a server's settings switch on, in the order above; names this site doesn't have are dropped.
export const addonList = (settings) => {
  const on = new Set(String(settings?.ADDONS || '').split(',').map((s) => s.trim()));
  return Object.keys(ADDONS).filter((id) => on.has(id));
};
