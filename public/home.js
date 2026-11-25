// The landing page (/): an example server, Birchwood SMP, shown with the dashboard's own parts.
// Nothing here talks to the server. The players, their sessions, gear, fights and chat are made up
// below, and every number on the page is worked out from them, so the pieces agree with each other:
// who the chart's tooltip lists, a player's page, the fights table. The pieces are:
//   the hero window   the Activity page: tiles, who's online (a player joins or leaves now and then),
//                     and the Players online chart with its range control
//   #players          a player's page; pick another player, or click a name anywhere on the page
//                     for their card and its View profile button
//   #chat             the chat log, and a message box that "sends" and gets a reply
//   #more             busiest times, the fights table, and the join form
// Each piece is built as public/app.js builds the real one, with the dashboard's own classes
// (public/style.css); the function it follows is named beside it.
(() => {
  const $ = (id) => document.getElementById(id);
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  const sv = (tag, attrs = {}, ...kids) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    e.append(...kids);
    return e;
  };
  const icon = (paths, size = 16) => sv('svg', {
    width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }, ...paths.map((d) => sv('path', { d })));
  const title = (s) => s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  const any = (list) => list[Math.floor(Math.random() * list.length)];

  // the same name always rolls the same numbers
  function rng(seed) {
    let s = 0;
    for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- the example's clock ----------------
     Times are minutes from this morning's midnight (earlier days are negative). It's evening on the
     example server when the page opens, whatever the time really is, and its clock runs from there. */

  const DAY = 1440;
  const OPENED = Date.now();
  const now = () => 20 * 60 + 34 + Math.floor((Date.now() - OPENED) / 60000);
  const today = () => Math.floor(now() / DAY);
  const SEASON_DAYS = 91;
  const START = -SEASON_DAYS * DAY; // the server's first day
  const MIDNIGHT = new Date();
  MIDNIGHT.setHours(0, 0, 0, 0);
  const mod = (n, m) => ((n % m) + m) % m;
  const at = (t) => new Date(MIDNIGHT.getFullYear(), MIDNIGHT.getMonth(), MIDNIGHT.getDate() + Math.floor(t / DAY), 0, mod(t, DAY));
  const hourOf = (t) => Math.floor(mod(t, DAY) / 60);
  const dowOf = (t) => at(t).getDay();
  const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // written as the dashboard writes them: "8:34 PM", "Nov 24", "9p", "1h 5m", "3h ago"
  const fmts = new Map();
  const fmt = (t, opts) => {
    const key = JSON.stringify(opts);
    if (!fmts.has(key)) fmts.set(key, new Intl.DateTimeFormat('en-US', opts));
    return fmts.get(key).format(at(t));
  };
  const clock = (t) => fmt(t, { hour: 'numeric', minute: '2-digit' });
  const hourName = (hr, short) => `${hr % 12 || 12}${hr < 12 ? (short ? 'a' : ' AM') : (short ? 'p' : ' PM')}`;
  const dur = (mins) => {
    const m = Math.round(mins);
    return m < 60 ? `${m}m` : m >= 6000 ? `${Math.floor(m / 60).toLocaleString()}h` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  };
  const ago = (t) => {
    const m = now() - t;
    return m < 3 ? 'just now' : m < 60 ? `${m}m ago` : m < DAY ? `${Math.round(m / 60)}h ago` : `${Math.round(m / DAY)}d ago`;
  };
  const fmtHours = (hrs) => (hrs >= 100 ? Math.round(hrs).toLocaleString() : hrs >= 10 ? hrs.toFixed(0) : hrs.toFixed(1));
  // [start, end) cut into pieces that each fall inside one hour
  function eachHourChunk(start, end, fn) {
    for (let t = start; t < end;) {
      const next = Math.min(end, (Math.floor(t / 60) + 1) * 60);
      fn(t, next - t);
      t = next;
    }
  }

  /* ---------------- the players ---------------- */

  // skin: one of the game's nine default skins, [arm model, name], drawn from the game's own texture.
  // plays: how likely they're on on a weekday and at the weekend, the hour they usually start, and for
  // how many minutes. today: this day's sessions as [start, end]; no end means they're on now.
  const PLAYERS = [
    { name: 'oakleaf', skin: ['wide', 'steve'], plays: [0.6, 0.85, 18, 95], today: [[1030, 1078]] },
    { name: 'Pebble_', skin: ['slim', 'alex'], plays: [0.9, 0.95, 17, 165], today: [[1008]] },
    { name: 'kestrel', skin: ['wide', 'kai'], plays: [0.75, 0.9, 18, 130], today: [[1022]] },
    { name: 'minty', skin: ['slim', 'noor'], plays: [0.55, 0.8, 18, 85], today: [[1015]] },
    { name: 'Saltwater', skin: ['wide', 'sunny'], plays: [0.65, 0.85, 20, 100], today: [[1212]] },
    { name: 'nightowl_', skin: ['wide', 'zuri'], plays: [0.7, 0.85, 21, 150], today: [[8, 97]] },
    { name: 'Brickhouse', skin: ['wide', 'efe'], plays: [0.35, 0.75, 15, 75], today: [[790, 868]] },
    { name: 'dandelion', skin: ['slim', 'makena'], plays: [0.45, 0.7, 17, 70], today: [[1040, 1114]] },
    { name: 'Quartzy', skin: ['slim', 'ari'], plays: [0.5, 0.8, 16, 95], today: [[925, 1052]] },
  ];
  const byName = new Map(PLAYERS.map((p) => [p.name, p]));
  const skinPath = (p) => `entity/player/${p.skin[0]}/${p.skin[1]}`;

  // Their face as the dashboard shows faces: the skin's 8×8 front of the head, with the hat layer on top.
  const faceOf = (p) => (p.face ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);
      ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8);
      resolve(c.toDataURL());
    };
    img.onerror = () => resolve(null);
    img.src = `/api/mc/textures/${skinPath(p)}.png`;
  }));
  const head = (p, size, cls) => {
    const img = h('img', { alt: '', width: size, height: size, class: cls });
    faceOf(p).then((url) => { if (url) img.src = url; });
    return img;
  };

  // Every session since the server's first day, oldest first: [start, end], end null while they're on.
  // Past days are rolled from their habits; today's are written out above, to match the chat log.
  function sessionsOf(p) {
    if (p.sessions) return p.sessions;
    const r = rng(`${p.name}:plays`), out = [];
    const [weekday, weekend, hour, mins] = p.plays;
    for (let d = -(SEASON_DAYS - 1 - Math.floor(r() * 6)); d < 0; d++) {
      const dow = dowOf(d * DAY), free = dow === 0 || dow === 6;
      if (r() > (free || dow === 5 ? weekend : weekday)) continue;
      const start = d * DAY + hour * 60 + Math.round((r() - 0.5) * 140);
      // at the weekend, sometimes an afternoon sitting as well
      if (free && r() < 0.4) {
        const a = start - 220 - Math.round(r() * 110);
        out.push([a, a + 25 + Math.round(r() * 70)]);
      }
      const end = Math.min(start + Math.round(mins * (0.35 + r() * 1.3)), -10); // never into today's
      if (end > start) out.push([start, end]);
    }
    out.push(...p.today.map(([a, b]) => [a, b ?? null]));
    return (p.sessions = out);
  }
  const online = new Set(PLAYERS.filter((p) => sessionsOf(p).at(-1)[1] === null).map((p) => p.name));
  const playedBetween = (p, from, to) => sessionsOf(p).reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b ?? now(), to) - Math.max(a, from)), 0);
  // how many were on in each minute from..to (to itself isn't counted)
  function counts(from, to) {
    const d = new Int16Array(to - from + 1);
    for (const p of PLAYERS) {
      for (const [a, b] of sessionsOf(p)) {
        const s = Math.max(a, from), e = Math.min(b ?? Infinity, to);
        if (e > s) { d[s - from]++; d[e - from]--; }
      }
    }
    let n = 0;
    return Array.from({ length: to - from }, (_, i) => (n += d[i]));
  }
  // names on at minute t (or at any point in the `len` minutes from t)
  const whoAt = (t, len = 1) => PLAYERS.filter((p) => sessionsOf(p).some(([a, b]) => a < t + len && (b ?? Infinity) > t)).map((p) => p.name);

  /* ---------------- tooltips (app.js: showTip, playerList, itemTip) ---------------- */

  const tip = h('div', { class: 'tooltip', role: 'tooltip', hidden: true });
  document.body.append(tip);
  // Clicking what a tooltip is for freezes it where it is, so it can be read; it stays until a click
  // anywhere else (or Escape).
  let tipPinned = false, tipSkipPin = false;
  const tipHeads = new Map(); // reused across redraws so heads don't blink while the pointer moves
  function playerList(names) {
    const list = h('div', { class: 'tip-players' });
    for (const name of names.slice(0, 10)) {
      if (!tipHeads.has(name)) tipHeads.set(name, head(byName.get(name), 14));
      list.append(h('div', { class: 'tip-player' }, tipHeads.get(name), h('span', { text: name })));
    }
    if (names.length > 10) list.append(h('div', { class: 'tip-more', text: `+${names.length - 10} more` }));
    return list;
  }
  // rows: [{ value, label, color } | { players } | { node, adv }]
  function showTip(x, y, rows) {
    if (tipPinned) return;
    tip.replaceChildren(...rows.map((r) => (r.players ? playerList(r.players) : r.node ? r.node : h('div', { class: 'row' },
      r.color ? h('span', { class: 'key', style: `background:${r.color}` }) : null,
      r.value != null ? h('span', { class: 'tv', text: r.value }) : null,
      r.label ? h('span', { class: 'tl', text: r.label }) : null))));
    tip.classList.toggle('tip-item', rows.some((r) => r.node && !r.adv)); // an item's tooltip looks like the game's
    tip.classList.toggle('tip-adv', rows.some((r) => r.adv));
    tip.hidden = false;
    const w = tip.offsetWidth, ht = tip.offsetHeight;
    let left = x + 14, top = y - ht - 10;
    if (left + w > innerWidth - 8) left = x - w - 14;
    if (top < 8) top = y + 18;
    if (top + ht > innerHeight - 8) top = Math.max(8, innerHeight - ht - 8);
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${top}px`;
  }
  const hideTip = () => { if (!tipPinned) tip.hidden = true; };
  function closeTip() {
    tipPinned = false;
    tip.classList.remove('pinned');
    tip.hidden = true;
  }
  document.addEventListener('click', (e) => {
    const skip = tipSkipPin;
    tipSkipPin = false;
    if (skip || tipPinned || tip.hidden || tip.contains(e.target) || e.target.closest?.('a[href]')) return;
    tipPinned = true;
    tip.classList.add('pinned');
  });
  document.addEventListener('pointerdown', (e) => {
    if (!tipPinned || tip.contains(e.target)) return;
    closeTip();
    tipSkipPin = true;
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && tipPinned) closeTip(); });
  // scrolling the page moves what it was for out from under it
  addEventListener('scroll', closeTip, { passive: true });
  function cellTips(root, selector, rowsOf) {
    const over = (e) => {
      const t = e.target.closest?.(selector);
      if (!t || !root.contains(t)) return hideTip();
      showTip(e.clientX, e.clientY, rowsOf(t));
    };
    root.addEventListener('pointermove', over);
    root.addEventListener('pointerdown', over);
    root.addEventListener('pointerleave', hideTip);
  }

  // A name in the game's color, as the dashboard shows them (app.js, mcStyle): exact on the light page
  // (pale ones get the game's text shadow), lightened where it needs it on the dark one.
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  function mc(color, text) {
    const n = parseInt(color.slice(1), 16), rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    let dark = rgb;
    for (let k = 0; k <= 1 && contrast(lum(dark), 0.01) < 4; k += 0.05) dark = rgb.map((c) => c + (255 - c) * k);
    const shadow = contrast(lum(rgb), 0.96) < 2 ? `1px 1px 0 ${toHex(rgb.map((c) => c / 4))}` : 'none';
    return h('span', { class: 'mc', style: `--cl:${color};--cs:${shadow};--cd:${toHex(dark)}`, text });
  }
  // An item's tooltip as the game draws it: lines of { t, c?, i? } pieces. Hovering (or focusing, or
  // tapping) the node shows it.
  const itemTipNode = (lines) => h('div', { class: 'item-tip' }, ...lines.map((line, k) => h('div', { class: `it-line${k ? '' : ' it-name'}` },
    ...(line.length ? line.map((p) => h('span', { style: `${p.c ? `color:${p.c};` : ''}${p.i ? 'font-style:italic' : ''}`, text: p.t })) : [' ']))));
  function hoverTip(node, rows) {
    node.classList.add('has-tip');
    node.tabIndex = 0;
    const show = (e) => showTip(e.clientX, e.clientY, rows());
    node.addEventListener('pointerenter', show);
    node.addEventListener('pointermove', show);
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => { const r = node.getBoundingClientRect(); showTip(r.left, r.top, rows()); });
    node.addEventListener('blur', hideTip);
    return node;
  }

  /* ---------------- what they wear and carry ----------------
     Each player's gear fits how far along they are. Early game: leather, chainmail and iron, stone and
     iron tools, nothing enchanted. Mid: iron and diamond, a few low enchantments. Late: diamond and
     netherite, fully enchanted and trimmed, a named weapon, a totem.
     armor: head, chest, legs, feet as a material, * when enchanted, #rrggbb for dyed leather.
     carry: the weapons and tools on them as [item, its custom name or null, ...enchantments]. */

  const GEAR = {
    Pebble_: { armor: ['netherite*', 'netherite*', 'netherite*', 'netherite*'], trim: ['spire', 'amethyst'], off: 'totem_of_undying', carry: [
      ['netherite_sword', 'Excalibur', 'Sharpness V', 'Sweeping Edge III', 'Looting III', 'Unbreaking III', 'Mending'],
      ['netherite_axe', null, 'Sharpness V', 'Efficiency V', 'Unbreaking III', 'Mending'],
      ['netherite_pickaxe', null, 'Efficiency V', 'Fortune III', 'Unbreaking III', 'Mending']] },
    nightowl_: { armor: ['netherite*', 'netherite*', 'diamond*', 'netherite*'], trim: ['ward', 'emerald'], off: 'totem_of_undying', carry: [
      ['diamond_spear', 'Stargazer', 'Sharpness V', 'Lunge III', 'Unbreaking III', 'Mending'],
      ['netherite_axe', null, 'Efficiency V', 'Unbreaking III', 'Mending'],
      ['netherite_pickaxe', null, 'Efficiency V', 'Silk Touch', 'Unbreaking III', 'Mending']] },
    kestrel: { armor: ['diamond*', 'netherite*', 'diamond*', 'diamond*'], trim: ['flow', 'copper'], off: 'shield', carry: [
      ['mace', 'Bonk', 'Density IV', 'Wind Burst II', 'Unbreaking III'],
      ['diamond_sword', null, 'Sharpness IV', 'Looting III', 'Unbreaking III'],
      ['diamond_pickaxe', null, 'Efficiency IV', 'Unbreaking III']] },
    Quartzy: { armor: ['iron*', 'diamond*', 'iron*', 'iron*'], trim: ['coast', 'quartz'], off: 'shield', carry: [
      ['diamond_sword', null, 'Sharpness II', 'Knockback I'],
      ['diamond_pickaxe', null, 'Efficiency III', 'Fortune II'],
      ['iron_axe', null]] },
    Saltwater: { armor: ['diamond*', 'diamond', 'iron', 'iron*'], off: 'water_bucket', carry: [
      ['diamond_sword', null, 'Sharpness III', 'Unbreaking II'],
      ['iron_pickaxe', null, 'Efficiency III', 'Unbreaking II'],
      ['iron_axe', null]] },
    oakleaf: { armor: ['iron', 'iron*', 'iron', 'iron'], off: 'lava_bucket', carry: [
      ['iron_sword', null, 'Sharpness II', 'Unbreaking I'],
      ['iron_pickaxe', null, 'Efficiency II'],
      ['stone_axe', null]] },
    minty: { armor: ['iron', 'iron', 'chainmail', 'iron'], off: 'shield', carry: [
      ['iron_sword', null, 'Smite III'],
      ['iron_axe', null],
      ['iron_pickaxe', null, 'Efficiency I', 'Unbreaking I']] },
    dandelion: { armor: ['leather#f8c627', 'iron', 'leather#5e7c16', 'iron'], off: 'shears', carry: [
      ['stone_sword', null],
      ['iron_pickaxe', null]] },
    Brickhouse: { armor: [null, 'iron', 'leather#a06540', 'leather#a06540'], off: 'bread', carry: [
      ['stone_sword', null],
      ['iron_pickaxe', null],
      ['stone_axe', null]] },
  };
  const SLOTS = ['head', 'chest', 'legs', 'feet'], PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];
  // The best weapon they carry comes first: mace, then sword, spear, axe, pickaxe; better material
  // first (app.js, weaponRank). It's the one in the model's hand until another is picked.
  const KINDS = ['mace', 'trident', 'sword', 'spear', 'axe', 'pickaxe'], MATERIALS = ['netherite', 'diamond', 'iron', 'copper', 'stone'];
  const kindOf = (it) => it.id.split('_').pop();
  const weaponRank = (it) => KINDS.indexOf(kindOf(it)) * 100 + MATERIALS.indexOf(it.id.split('_')[0]) * 2 + (it.glint ? 0 : 1);
  // Items as the server mod reports them, which is what public/player3d.js draws.
  function gearOf(p) {
    if (p.gear) return p.gear;
    const g = GEAR[p.name], armor = {};
    g.armor.forEach((a, i) => {
      if (!a) return;
      const [, mat, shine, dye] = /^([a-z]+)(\*)?(#\w+)?$/.exec(a);
      armor[SLOTS[i]] = {
        id: `${mat}_${PIECES[i]}`, asset: mat, glint: !!shine,
        ...(dye && { dye: parseInt(dye.slice(1), 16) }),
        // a trim the same color as its armor would vanish, so the game uses a darker shade there
        ...(g.trim && { trim: { pattern: g.trim[0], palette: g.trim[1] === mat ? `${mat}_darker` : g.trim[1] } }),
      };
    });
    const carry = g.carry.map(([id, name, ...enchants]) => ({ id, name, enchants, glint: enchants.length > 0 }))
      .sort((a, b) => weaponRank(a) - weaponRank(b));
    const offhand = { id: g.off, ...(g.off === 'shield' && { special: 'shield' }) };
    return (p.gear = { armor, carry, offhand });
  }
  const picked = new Map(); // player -> the weapon picked from the list under their model
  const heldOf = (p) => picked.get(p.name) ?? gearOf(p).carry[0];
  const specOf = (p) => ({ name: p.name, skin: { path: skinPath(p), slim: p.skin[0] === 'slim' }, armor: gearOf(p).armor, mainhand: heldOf(p), offhand: gearOf(p).offhand });

  // Its name in the game's colors (aqua when enchanted, magenta for the mace) and its tooltip as the
  // game draws it: the name (slanted when it's a custom one), the enchantments in grey, then what it
  // does in the main hand, in green.
  const itemName = (it) => it.name || title(it.id);
  const itemColor = (it) => (it.id === 'mace' ? '#ff55ff' : it.glint ? '#55ffff' : '#ffffff');
  const TIERS = ['stone', 'iron', 'diamond', 'netherite'];
  const HAND = { sword: [[5, 6, 7, 8], [1.6, 1.6, 1.6, 1.6]], axe: [[9, 9, 9, 10], [0.8, 0.9, 1, 1]], pickaxe: [[3, 4, 5, 6], [1.2, 1.2, 1.2, 1.2]], mace: [[6], [0.6]] };
  function tipLines(it) {
    const stats = HAND[kindOf(it)], tier = Math.max(0, TIERS.indexOf(it.id.split('_')[0]));
    const lines = [[{ t: itemName(it), c: itemColor(it), ...(it.name && { i: 1 }) }], ...it.enchants.map((e) => [{ t: e, c: '#aaaaaa' }])];
    if (stats) {
      lines.push([], [{ t: 'When in Main Hand:', c: '#aaaaaa' }],
        [{ t: ` ${stats[0][tier]} Attack Damage`, c: '#00aa00' }], [{ t: ` ${stats[1][tier]} Attack Speed`, c: '#00aa00' }]);
    }
    return lines;
  }
  const itemTip = (node, it) => hoverTip(node, () => [{ node: itemTipNode(tipLines(it)) }]);

  /* ---------------- fights ---------------- */

  // What kills players besides each other: [what the dashboard calls it, the game's death message].
  const MOB_DEATHS = [
    ['Creeper', 'was blown up by Creeper'], ['Zombie', 'was slain by Zombie'], ['Skeleton', 'was shot by Skeleton'],
    ['Drowning', 'drowned'], ['Fall', 'fell from a high place'], ['Fall', 'hit the ground too hard'],
    ['Witch', 'was killed by Witch using magic'], ['Enderman', 'was slain by Enderman'], ['Fire', 'burned to death'],
    ['Warden', 'was obliterated by a sonically-charged shriek whilst trying to escape Warden'], ['Cactus', 'was pricked to death'],
    ['Anvil', 'was squashed by a falling anvil'], ['Drowned', 'was impaled by Drowned'], ['Lava', 'tried to swim in lava'],
    ['Fireworks', 'went off with a bang'], ['Pillager', 'was shot by Pillager'], ['Piglin Brute', 'was slain by Piglin Brute'],
    ['Ghast', 'was fireballed by Ghast'], ['Bee', 'was stung to death'], ['Void', 'fell out of the world'],
    ['Starvation', 'starved to death'], ['Suffocation', 'suffocated in a wall'], ['Freezing', 'was frozen to death'],
    ['Lightning', 'was struck by lightning'], ['Elytra', 'experienced kinetic energy'], ['Vindicator', 'was slain by Vindicator'],
    ['Evoker', 'was killed by Evoker using magic'], ['Breeze', 'was shot by Breeze'], ['Lava', 'discovered the floor was lava'],
    ['Sweet Berry Bush', 'was poked to death by a sweet berry bush'], ['Fall', 'fell off some vines'], ['Hoglin', 'was slain by Hoglin'],
  ];
  // Every death this season, oldest first: { who, by (the player who did it), cause (anything else) }.
  // Before today: who killed whom how often, and a few deaths each to the world, more for the less geared.
  const DEATHS = [];
  for (const [by, who, n] of [['Pebble_', 'kestrel', 5], ['Pebble_', 'nightowl_', 3], ['Pebble_', 'Saltwater', 3], ['Pebble_', 'Quartzy', 2],
    ['nightowl_', 'Pebble_', 2], ['nightowl_', 'kestrel', 3], ['nightowl_', 'Saltwater', 2], ['kestrel', 'Saltwater', 2], ['kestrel', 'nightowl_', 2],
    ['kestrel', 'minty', 1], ['Saltwater', 'kestrel', 1], ['Saltwater', 'Quartzy', 2], ['Quartzy', 'minty', 1], ['minty', 'oakleaf', 1]]) {
    for (let i = 0; i < n; i++) DEATHS.push({ who, by });
  }
  for (const p of PLAYERS) {
    const r = rng(`${p.name}:deaths`);
    const n = (GEAR[p.name].trim ? 2 : 5) + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) DEATHS.push({ who: p.name, cause: MOB_DEATHS[Math.floor(r() * 16)][0] });
  }
  // everyone's kills and deaths (app.js, combatPlayers)
  const fighters = () => PLAYERS.map((p) => {
    const kills = DEATHS.filter((d) => d.by === p.name).length, mine = DEATHS.filter((d) => d.who === p.name);
    return { name: p.name, kills, deaths: mine.length, pvpDeaths: mine.filter((d) => d.by).length, kd: kills / Math.max(1, mine.length) };
  });
  const fmtKd = (p) => (p.kills + p.deaths === 0 ? '–' : p.kd.toFixed(2));

  /* ---------------- the hero window: the Activity page ---------------- */

  // A player badge (app.js, makeChip). Clicking one opens their card.
  function chip(p, fresh) {
    return h('a', { class: `chip${fresh && !reduced() ? ' chip-enter' : ''}`, href: '#players', 'data-name': p.name, 'data-card': p.name },
      head(p, 24), h('span', { class: 'chip-name', text: p.name }), h('span', { class: 'since', text: `since ${clock(sessionsOf(p).at(-1)[0])}` }));
  }
  // Keeps a row of badges in step with who's online: a new one pops in, one that left folds away.
  function syncChips(list, fresh) {
    for (const c of list.querySelectorAll('.chip:not(.leaving)')) {
      if (online.has(c.dataset.name)) continue;
      if (reduced()) { c.remove(); continue; }
      c.classList.add('leaving');
      c.style.width = `${c.offsetWidth}px`;
      c.classList.add('collapsing');
      requestAnimationFrame(() => c.classList.add('collapsed'));
      setTimeout(() => c.remove(), 260);
    }
    for (const name of online) {
      if (!list.querySelector(`.chip:not(.leaving)[data-name="${CSS.escape(name)}"]`)) list.append(chip(byName.get(name), fresh));
    }
  }

  $('w-week-mode').addEventListener('change', () => renderTiles());
  function renderTiles() {
    const n = online.size, t = now();
    $('w-online').textContent = n;
    $('w-live').textContent = `${n} online`;
    $('c-online-n').textContent = `${n} online`;
    $('w-peak').textContent = Math.max(n, ...counts(today() * DAY, t + 1));
    // all time, or the last 7 days (app.js, renderTiles)
    const week = $('w-week-mode').value === '7d';
    $('w-week-label').textContent = week ? 'Played this week' : 'Total played';
    $('w-week').textContent = fmtHours(PLAYERS.reduce((sum, p) => sum + playedBetween(p, week ? t - 7 * DAY : START, t), 0) / 60);
    $('w-seen').textContent = PLAYERS.length;
  }

  /* the Players online chart's range (app.js: TL_PRESETS, resolveWindow, shiftWindow, windowLabel) */
  const PRESETS = [
    { v: '6h', count: 360, long: 'Last 6 hours' },
    // Live it's the last 24 hours; stepping back pages through whole days, midnight to midnight.
    { v: '24h', count: DAY, long: 'Last 24 hours' },
    { v: '7d', count: 7 * DAY, long: 'Last 7 days' },
    { v: '30d', count: 30 * DAY, long: 'Last 30 days' },
    { v: '90d', count: 90 * DAY, long: 'Last 90 days' },
  ];
  // { count (minutes), end (null: up to now), preset, day (a whole day, when paging the 24h range) }
  let win = { count: DAY, end: null, preset: '24h' };
  const spanOf = (w) => (w.day != null ? [w.day * DAY, (w.day + 1) * DAY] : [(w.end ?? now()) - w.count, w.end ?? now()]);
  const isLive = (w) => w.day == null && w.end == null;
  function shiftWindow(w, dir) {
    if (w.preset === '24h' && (w.day != null || w.end == null)) {
      const day = w.day != null ? w.day + dir : dir < 0 ? today() - 1 : null;
      return day == null || day >= today() ? { count: DAY, end: null, preset: '24h' } : { count: DAY, end: null, preset: '24h', day };
    }
    const end = spanOf(w)[1] + dir * w.count;
    return { ...w, end: end >= now() - 2 ? null : end }; // within a couple of minutes of now counts as now
  }
  function windowLabel(w) {
    const p = PRESETS.find((x) => x.v === w.preset);
    if (isLive(w) && p) return p.long;
    const md = { month: 'short', day: 'numeric' }, hm = { hour: 'numeric', minute: '2-digit' };
    if (w.day != null) return fmt(w.day * DAY, md);
    const [from, to] = spanOf(w);
    if (isLive(w)) return `${fmt(from, { ...md, ...hm })} – now`;
    const sameDay = Math.floor(from / DAY) === Math.floor((to - 1) / DAY);
    return `${fmt(from, { ...md, ...hm })} – ${fmt(to, sameDay ? hm : { ...md, ...hm })}`;
  }

  // [calendar] [presets | Custom] [‹] [›] (app.js, rangeControl)
  {
    const host = $('w-ctl');
    let pop = null;
    const set = (w) => { win = w; close(); sync(); drawTimeline(); };
    const cal = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Choose a date range', title: 'Choose a date range', onclick: () => toggle() },
      icon(['M2.5 4.5h11v9h-11z', 'M2.5 7.5h11', 'M5.5 2.5v3', 'M10.5 2.5v3']));
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' });
    const presets = PRESETS.map((p) => [p.v, seg.appendChild(h('button', { type: 'button', text: p.v, onclick: () => set({ count: p.count, end: null, preset: p.v }) }))]);
    const custom = seg.appendChild(h('button', { type: 'button', text: 'Custom', hidden: true, onclick: () => toggle() }));
    const prev = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Earlier', title: 'Earlier', onclick: () => set(shiftWindow(win, -1)) }, icon(['M10 3.5 5.5 8l4.5 4.5']));
    const next = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Later', title: 'Later', onclick: () => set(shiftWindow(win, 1)) }, icon(['M6 3.5 10.5 8 6 12.5']));
    host.replaceChildren(cal, seg, prev, next);
    function sync() {
      for (const [v, b] of presets) b.setAttribute('aria-pressed', String(win.preset === v));
      custom.hidden = win.preset !== 'custom';
      custom.setAttribute('aria-pressed', String(win.preset === 'custom'));
      next.disabled = isLive(win);
      prev.disabled = spanOf(shiftWindow(win, -1))[0] < START; // nothing was recorded before the first day
    }
    function close() {
      if (!pop) return;
      pop.remove();
      pop = null;
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key);
    }
    const outside = (e) => { if (!host.contains(e.target)) close(); };
    const key = (e) => { if (e.key === 'Escape') close(); };
    // a time as a datetime-local input writes it, and back
    const two = (n) => String(n).padStart(2, '0');
    const local = (t) => { const d = at(t); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`; };
    const parse = (v) => Math.round((new Date(v) - MIDNIGHT) / 60000);
    function toggle() {
      if (pop) return close();
      const [from, to] = spanOf(win);
      const field = (t) => h('input', { type: 'datetime-local', min: local(START), max: local(now()), value: local(Math.min(t, now())) });
      const fromIn = field(from), toIn = field(to);
      const error = h('div', { class: 'range-error', role: 'alert', hidden: true });
      pop = h('form', { class: 'range-pop', 'aria-label': 'Choose a date range' },
        h('label', {}, h('span', { text: 'From' }), fromIn), h('label', {}, h('span', { text: 'To' }), toIn), error,
        h('div', { class: 'range-actions' },
          h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: close }), h('button', { type: 'submit', class: 'btn btn-primary', text: 'Apply' })));
      pop.addEventListener('submit', (e) => {
        e.preventDefault();
        const a = Math.max(START, parse(fromIn.value)), b = Math.min(now(), parse(toIn.value));
        const bad = !fromIn.value || !toIn.value ? 'Pick both a start and an end.' : b - a < 10 ? 'Pick a range of at least 10 minutes.' : null;
        if (bad) { error.textContent = bad; error.hidden = false; return; }
        set({ count: b - a, end: b >= now() - 1 ? null : b, preset: PRESETS.find((p) => p.count === b - a)?.v ?? 'custom' });
      });
      host.append(pop);
      fromIn.focus();
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', key);
    }
    sync();
    // the clock moves: what the arrows can do is checked again as it does
    setInterval(sync, 60000);
  }

  // Who was on, minute by minute; over ranges longer than six hours, with the hour's average as a
  // second line; over ranges longer than eight days, each hour's average and peak (app.js, loadTimeline).
  function drawTimeline() {
    const [from, to] = spanOf(win);
    $('w-label').textContent = windowLabel(win);
    const c1 = 'var(--series-1)', c2 = 'var(--series-2)', c3 = 'var(--series-3)';
    const key = (color, text) => h('span', {}, h('span', { class: 'key', style: `background:${color}` }), text);
    const lo = Math.max(START, from - 30), hi = Math.min(now() + 1, to + 31); // a little past each edge, for the average
    const each = counts(lo, hi);
    let opts;
    if (to - from <= 8 * DAY) {
      const pts = each.map((v, i) => ({ t: lo + i, v }));
      const series = [{ name: 'online', cls: '1', color: c1, area: true, pts }];
      const trend = to - from > 361;
      if (trend) {
        // the average over the hour around each minute
        const avg = [];
        let a = 0, b = 0, sum = 0;
        for (const p of pts) {
          while (b < pts.length && pts[b].t <= p.t + 30) sum += pts[b++].v;
          while (pts[a].t < p.t - 30) sum -= pts[a++].v;
          avg.push({ t: p.t, v: sum / (b - a) });
        }
        series.push({ name: 'avg (1 hour)', cls: '2', color: c2, pts: avg });
      }
      opts = {
        from, to, step: 1, series, whoAt: (t) => whoAt(t),
        fmtValue: (v) => (Number.isInteger(v) ? `${v} ${v === 1 ? 'player' : 'players'}` : v.toFixed(1)),
        fmtTime: (t) => fmt(t, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
      };
      $('w-legend').replaceChildren(...(trend ? [key(c1, 'Players online'), key(c2, 'Average online (1 hour)')] : []));
    } else {
      const avg = [], peak = [];
      for (let t = Math.ceil(lo / 60) * 60; t < hi; t += 60) {
        const hour = each.slice(t - lo, t - lo + 60);
        avg.push({ t, v: hour.reduce((x, y) => x + y, 0) / hour.length });
        peak.push({ t, v: Math.max(...hour) });
      }
      opts = {
        from, to, step: 60, whoAt: (t) => whoAt(t, 60),
        series: [{ name: 'average', cls: '1', color: c1, area: true, pts: avg }, { name: 'peak', cls: '3', color: c3, pts: peak }],
        fmtValue: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
        fmtTime: (t) => `${fmt(t, { weekday: 'short', month: 'short', day: 'numeric' })}, ${hourName(hourOf(t))}`,
      };
      $('w-legend').replaceChildren(key(c1, 'Average online'), key(c3, 'Peak online'));
    }
    lineChart($('w-chart'), opts);
  }

  // The chart itself (app.js, drawLineChart), without the paging slide or pinch zoom.
  // opts: { from, to, step, series: [{ name, cls, color, area, pts: [{ t, v }] }], fmtValue, fmtTime, whoAt(t) }
  function lineChart(root, opts) {
    const { from, to, step, series } = opts, pts0 = series[0].pts;
    if (root.matches(':hover')) hideTip(); // its tooltip is about a point that's being redrawn
    if (!pts0.some((p) => p.t >= from - step && p.t <= to + step)) {
      root.replaceChildren(h('div', { class: 'empty-chart', text: 'No data in this range yet' }));
      return;
    }
    const W = Math.max(280, root.clientWidth), H = root.clientHeight || 240;
    const m = { l: 30, r: 10, t: 10, b: 24 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    // up to the most online in the range, in steps of 5, never less than 0-10 so the scale stays steady
    let vmax = 0;
    for (const s of series) for (const p of s.pts) if (p.v > vmax && p.t >= from - step && p.t <= to + step) vmax = p.v;
    const ymax = Math.max(10, Math.ceil(vmax / 5) * 5);
    const n2 = (v) => Math.round(v * 100) / 100;
    const x = (t) => n2(m.l + ((t - from) / (to - from)) * pw), y = (v) => n2(m.t + ph - (v / ymax) * ph);
    const text = (attrs, s) => { const t = sv('text', { class: 'axis-text', ...attrs }); t.textContent = s; return t; };
    const svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Players online over time' });

    for (let v = 0; v <= ymax; v += 5) {
      if (v > 0) svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'gridline' }));
      svg.append(text({ x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, v));
    }
    svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: 'baseline' }));

    // x ticks: hours for short ranges, midnights for long ones; which get a label depends on the
    // clock, not on where the range starts
    const days = (to - from) / DAY;
    const apart = days <= 0.6 ? 60 : days <= 1.5 ? 180 : DAY;
    const every = Math.max(1, Math.ceil((to - from) / apart / Math.max(2, Math.floor(pw / 80))));
    for (let t = Math.ceil(from / 60) * 60; t < to; t += 60) {
      const hour = hourOf(t);
      if (!(days <= 0.6 || (days <= 1.5 ? hour % 3 === 0 : hour === 0)) || Math.round(t / apart) % every) continue;
      svg.append(text({ x: x(t), y: H - 6, 'text-anchor': 'middle' },
        days <= 1.5 ? hourName(hour, false) : fmt(t, days <= 8 ? { weekday: 'short' } : { month: 'short', day: 'numeric' })));
    }

    // the lines, clipped to the plot (a little is drawn past each edge)
    const plot = sv('g', { 'clip-path': 'url(#w-chart-clip)' });
    svg.append(sv('clipPath', { id: 'w-chart-clip' }, sv('rect', { x: m.l, y: 0, width: pw, height: m.t + ph + 1 })), plot);
    for (const s of series) {
      let line = '', area = '', first = null, last = null;
      const closeArea = () => { if (s.area && first) area += `L${x(last.t)},${y(0)}L${x(first.t)},${y(0)}Z`; };
      for (const p of s.pts) {
        const at2 = `${x(p.t)},${y(p.v)}`;
        if (!last || p.t - last.t > step * 2.5) { // a gap in the data breaks the line
          closeArea();
          line += `M${at2}`;
          if (s.area) area += `M${at2}`;
          first = p;
        } else {
          line += `L${at2}`;
          if (s.area) area += `L${at2}`;
        }
        last = p;
      }
      closeArea();
      if (s.area) plot.append(sv('path', { d: area, class: `area-${s.cls}` }));
      plot.append(sv('path', { d: line, class: `line-${s.cls}` }));
    }

    // crosshair and tooltip: the nearest point, each line's value there, the time, and who was on
    const cross = sv('line', { y1: m.t, y2: m.t + ph, class: 'crosshair', visibility: 'hidden' });
    const markers = series.map((s) => sv('circle', { r: 4, style: `fill:${s.color}`, class: 'marker', visibility: 'hidden' }));
    const hit = sv('rect', { x: m.l, y: 0, width: pw, height: H, fill: 'transparent' });
    svg.append(cross, ...markers, hit);
    const move = (e) => {
      const t = from + ((e.clientX - svg.getBoundingClientRect().left - m.l) / pw) * (to - from);
      const i = Math.max(0, Math.min(pts0.length - 1, Math.round((t - pts0[0].t) / step)));
      const p = pts0[i], px = x(p.t);
      cross.setAttribute('x1', px);
      cross.setAttribute('x2', px);
      cross.setAttribute('visibility', 'visible');
      series.forEach((s, k) => {
        markers[k].setAttribute('cx', px);
        markers[k].setAttribute('cy', y(s.pts[i].v));
        markers[k].setAttribute('visibility', 'visible');
      });
      const rows = series.map((s) => ({ value: opts.fmtValue(s.pts[i].v), label: s.name, color: series.length > 1 ? s.color : null }));
      rows.push({ label: opts.fmtTime(p.t) });
      const who = opts.whoAt(p.t);
      if (who.length) rows.push({ players: who });
      showTip(e.clientX, e.clientY, rows);
    };
    const leave = () => {
      cross.setAttribute('visibility', 'hidden');
      for (const mk of markers) mk.setAttribute('visibility', 'hidden');
      hideTip();
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', leave);
    root.replaceChildren(svg);
  }

  /* ---------------- a player's page (app.js: showPlayer and what it calls) ---------------- */

  const FEATURED = ['Pebble_', 'oakleaf', 'kestrel', 'Brickhouse']; // late game, mid, late, early
  let current = FEATURED[0];
  let three = null, model = null;

  // Little bars, one per hour, with the hour labels under them as text (app.js, hourBars).
  // A full bar is fullAt minutes, or the biggest bar.
  function hourBars(bars, labels, aria, H, fullAt = null) {
    const W = 240, slot = W / bars.length, max = fullAt ?? Math.max(10, ...bars.map((b) => b.v));
    const svg = sv('svg', { width: '100%', height: H, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'pc-graph', role: 'img', 'aria-label': aria });
    bars.forEach((b, i) => {
      const bh = Math.max(b.v > 0.5 ? 2 : 1, (b.v / max) * H);
      svg.append(sv('rect', { x: i * slot + 1, y: H - bh, width: slot - 2, height: bh, class: `pc-bar${b.now ? ' now' : ''}${b.v <= 0.5 ? ' zero' : ''}`, 'data-i': i }));
    });
    cellTips(svg, '.pc-bar', (bar) => bars[bar.dataset.i].tip);
    return h('div', { class: 'pc-hours' }, svg, h('div', { class: 'pc-axis' }, ...labels.map(([f, s]) => h('span', { style: `left:${f * 100}%`, text: s }))));
  }
  // Hour by weekday, like a week calendar: days across, hours running down (app.js, renderWeekGrid).
  // grid[dow][hour] = number; describe(value, label) -> tooltip rows
  function weekGrid(root, grid, describe) {
    const max = Math.max(0, ...grid.flat());
    const level = (v) => (v <= 0 || max <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));
    const g = h('div', { class: 'weekgrid', role: 'img', 'aria-label': 'Activity by weekday and hour' }, h('span'), DOWS.map((d) => h('span', { class: 'dlabel', text: d })));
    for (let hr = 0; hr < 24; hr++) {
      g.append(h('span', { class: 'hlabel', text: hr % 3 ? '' : hourName(hr, true) }));
      for (let d = 0; d < 7; d++) g.append(h('span', { class: `wcell lv${level(grid[d][hr])}`, 'data-d': d, 'data-h': hr }));
    }
    const scale = h('div', { class: 'scale' }, h('span', { class: 'lbl', text: 'Less' }), [0, 1, 2, 3, 4].map((i) => h('span', { class: `sw lv${i}` })), h('span', { class: 'lbl', text: 'More' }));
    root.replaceChildren(g, scale);
    // the tooltips are attached once, and read whatever was drawn last
    const first = !root.week;
    root.week = { grid, describe };
    if (!first) return;
    cellTips(root, '.wcell', (c) => {
      const d = Number(c.dataset.d), hr = Number(c.dataset.h);
      return root.week.describe(root.week.grid[d][hr], `${DOWS[d]} ${hourName(hr)}–${hourName((hr + 1) % 24)}`);
    });
  }
  // minutes online in each hour of each weekday
  function weekOf(players) {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const p of players) {
      for (const [a, b] of sessionsOf(p)) eachHourChunk(a, b ?? now(), (t, mins) => { grid[dowOf(t)][hourOf(t)] += mins; });
    }
    return grid;
  }

  const chatsOf = (p) => { // messages they've sent: before today (made up), and in today's log
    p.chatBase ??= Math.round(40 + rng(`${p.name}:chat`)() * 500);
    const sent = LOG.filter((m) => m.kind === 'chat' && m.name === p.name).length;
    return { total: p.chatBase + sent, today: sent };
  };

  function renderProfile() {
    const p = byName.get(current), sessions = sessionsOf(p), t = now();
    const on = online.has(p.name), last = sessions.at(-1), first = sessions[0][0];
    $('p-head').replaceWith(Object.assign(head(p, 64, 'p-avatar'), { id: 'p-head' }));
    $('p-name').textContent = p.name;
    $('p-status').replaceChildren(...(on ? [h('span', { class: 'badge', text: 'Online' }), `since ${clock(last[0])}`] : [`Last seen ${ago(last[1])}`]),
      ` · first seen ${fmt(first, { month: 'short', day: 'numeric', year: 'numeric' })}`);

    let total = 0, longest = [0, 0];
    for (const [a, b] of sessions) {
      const len = (b ?? t) - a;
      total += len;
      if (len > longest[0]) longest = [len, a];
    }
    $('p-total').textContent = dur(total);
    $('p-total-sub').textContent = `${dur(playedBetween(p, t - 7 * DAY, t))} in the last 7 days`;
    $('p-sessions').textContent = sessions.length;
    $('p-avg').textContent = `avg ${dur(total / sessions.length)}`;
    $('p-longest').textContent = dur(longest[0]);
    $('p-longest-sub').textContent = fmt(longest[1], { month: 'short', day: 'numeric', year: 'numeric' });
    renderChatTile();
    renderCombat();
  }
  // Chat messages sent, all time or today (app.js, renderPlayerChatTile)
  function renderChatTile() {
    const c = chatsOf(byName.get(current));
    $('p-chat').textContent = ($('p-chat-mode').value === 'today' ? c.today : c.total).toLocaleString();
    const from = START + 16 * 60; // the chat mod went in on the first afternoon
    $('p-chat-sub').textContent = `data starts ${fmt(from, { month: 'numeric', day: 'numeric' })} ${fmt(from, { hour: 'numeric' }).replace(/\s/g, '').toLowerCase()}`;
  }
  $('p-chat-mode').addEventListener('change', renderChatTile);

  // Their kills and deaths, where that puts them among everyone, and who and what is behind them
  // (app.js, renderPlayerCombat; the list of their latest ones is left out here).
  function renderCombat() {
    const everyone = fighters().filter((f) => f.kills + f.deaths > 0), me = everyone.find((f) => f.name === current);
    const rank = (k) => (!me[k] || everyone.length < 2 ? '' : `#${1 + everyone.filter((f) => f[k] > me[k]).length} of ${everyone.length}`);
    const stat = (label, value, sub, cls = '') => h('div', { class: `pcb-stat ${cls}` },
      h('div', { class: 'pcb-label', text: label }), h('div', { class: 'pcb-value', text: value }), h('div', { class: 'pcb-sub', text: sub }));
    const tally = (list, keyOf) => {
      const n = new Map();
      for (const d of list) n.set(keyOf(d), (n.get(keyOf(d)) || 0) + 1);
      return [...n].sort((a, b) => b[1] - a[1]);
    };
    const person = ([who, n]) => h('li', {},
      h('a', { class: 'pcb-who', href: '#players', 'data-card': who }, head(byName.get(who), 16), h('span', { text: who })), h('span', { class: 'pcb-n', text: `×${n}` }));
    const thing = ([what, n]) => h('li', {}, h('span', { class: 'pcb-who', text: what }), h('span', { class: 'pcb-n', text: `×${n}` }));
    const list = (heading, items, render, none) => h('div', { class: 'pcb-list' }, h('h3', { text: heading }),
      items.length ? h('ul', { class: 'pcb-scroll', tabindex: '0' }, items.map(render)) : h('div', { class: 'muted pcb-none', text: none }));
    const mine = DEATHS.filter((d) => d.who === current);
    $('p-combat').replaceChildren(
      h('div', { class: 'pcb-stats' },
        stat('Kills', me.kills, rank('kills'), 'kills'),
        stat('Deaths', me.deaths, me.deaths ? `${me.pvpDeaths} PvP · ${me.deaths - me.pvpDeaths} other` : '', 'deaths'),
        stat('K/D', fmtKd(me), rank('kd'))),
      h('div', { class: 'pcb-lists' },
        list('Killed most', tally(DEATHS.filter((d) => d.by === current), (d) => d.who), person, 'No kills yet'),
        list('Killed by most', tally(mine.filter((d) => d.by), (d) => d.by), person, 'Never killed by a player'),
        list('Other deaths', tally(mine.filter((d) => !d.by), (d) => d.cause), thing, 'None')));
  }

  // Under the model: the weapon in their hand as the game styles it (hover for its tooltip), with a
  // list of everything else they carry next to it, and when it was reported (app.js, renderModelNote).
  function renderModelNote() {
    const p = byName.get(current), all = gearOf(p).carry, held = heldOf(p);
    closeGearMenu();
    const toggle = h('button', {
      type: 'button', class: 'p-gear-toggle', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      title: `All ${all.length} weapons and tools they carry`, 'aria-label': `All ${all.length} weapons and tools they carry`,
      onclick: (e) => { e.stopPropagation(); if (gearMenu.hidden) openGearMenu(toggle, p); else closeGearMenu(); },
    }, h('span', { class: 'p-gear-count', text: all.length }), icon(['M4 6l4 4 4-4'], 12));
    const on = online.has(p.name);
    $('p-model-note').replaceChildren(
      h('div', { class: 'p-model-held' }, itemTip(h('span', { class: 'msg-item p-weapon' }, mc(itemColor(held), itemName(held))), held), toggle),
      h('div', { class: 'muted p-model-when', text: `Gear updated ${on ? 'just now' : ago(sessionsOf(p).at(-1)[1])}` }));
  }
  // The list of everything they carry, each in its game colors (hover for its tooltip); picking one
  // puts it in the model's hand (app.js, openGearMenu).
  const gearMenu = h('div', { class: 'gear-menu', role: 'menu', hidden: true });
  document.body.append(gearMenu);
  function closeGearMenu() {
    if (gearMenu.hidden) return;
    gearMenu.hidden = true;
    document.querySelector('.p-gear-toggle[aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
    hideTip();
  }
  function openGearMenu(toggle, p) {
    const held = heldOf(p);
    gearMenu.replaceChildren(h('div', { class: 'gear-menu-head', text: 'Weapons and tools they carry' }), ...gearOf(p).carry.map((it, i) => {
      const on = it === held;
      const row = h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(on), class: `gear-row${on ? ' picked' : ''}` },
        h('span', { class: 'gear-check' }, on ? icon(['M3.5 8.5l3 3 6-7'], 12) : null),
        h('span', { class: 'gear-name msg-item' }, mc(itemColor(it), itemName(it))),
        h('span', { class: 'gear-sub muted', text: [it.name ? title(it.id) : '', i === 0 ? 'best' : ''].filter(Boolean).join(' · ') }));
      // its tooltip beside the list
      const show = () => { const r = row.getBoundingClientRect(); showTip(r.right + 4, r.top + 12, [{ node: itemTipNode(tipLines(it)) }]); };
      row.addEventListener('pointerenter', show);
      row.addEventListener('focus', () => { if (row.matches(':focus-visible')) show(); else hideTip(); });
      row.addEventListener('pointerleave', hideTip);
      row.addEventListener('click', () => {
        picked.set(p.name, it);
        closeGearMenu();
        renderModelNote();
        model?.setMainhand(it);
        $('p-model-note').querySelector('.p-gear-toggle')?.focus({ preventScroll: true });
      });
      return row;
    }));
    gearMenu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    const r = toggle.getBoundingClientRect(), { width, height } = gearMenu.getBoundingClientRect();
    gearMenu.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - width / 2, innerWidth - width - 8))}px`;
    gearMenu.style.top = `${r.bottom + 6 + height > innerHeight - 8 ? Math.max(8, r.top - height - 6) : r.bottom + 6}px`;
    (gearMenu.querySelector('.gear-row.picked') || gearMenu.querySelector('.gear-row'))?.focus({ preventScroll: true });
  }
  document.addEventListener('pointerdown', (e) => {
    if (!gearMenu.hidden && !gearMenu.contains(e.target) && !e.target.closest('.p-gear-toggle')) closeGearMenu();
  });
  gearMenu.addEventListener('keydown', (e) => {
    const rows = [...gearMenu.querySelectorAll('.gear-row')], i = rows.indexOf(document.activeElement);
    if (e.key === 'Escape') { closeGearMenu(); $('p-model-note').querySelector('.p-gear-toggle')?.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    }
  });
  addEventListener('scroll', closeGearMenu, { passive: true });
  addEventListener('resize', closeGearMenu);

  // a badge per player with a page: the featured four, then everyone who joins while the page is open
  const pick = $('p-pick');
  function addPick(n) {
    if (pick.querySelector(`[data-name="${CSS.escape(n)}"]`)) return;
    const p = byName.get(n);
    pick.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(n === current), 'data-name': n, onclick: () => showPlayer(n, false) }, head(p, 24), n));
    setTimeout(() => { if (three) three.warm(specOf(p)); }); // its model is ready before it's picked
  }
  for (const n of FEATURED) addPick(n);
  function showPlayer(name, scroll = true) {
    current = name;
    addPick(name);
    renderProfile();
    renderModelNote();
    model?.show(specOf(byName.get(name)));
    for (const b of pick.children) b.setAttribute('aria-pressed', String(b.dataset.name === name));
    const page = $('p-page');
    if (!reduced()) {
      page.classList.remove('home-swap');
      void page.offsetWidth;
      page.classList.add('home-swap');
    }
    if (scroll) $('players').scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
  }

  /* their model (public/home3d.js, loaded as soon as the page is idle) */
  let loading = null;
  const load3d = () => (loading ??= import('/home3d.js').then((m) => { three = m; return m; }));
  const near = (el, fn) => {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); fn(); } }, { rootMargin: '1200px' });
    io.observe(el);
  };
  // Fetch the 3D code and every texture the first models need while the reader is still up top, so the
  // models are drawn the moment they come near (the WebGL scenes themselves still wait until then).
  (window.requestIdleCallback ?? ((f) => setTimeout(f, 200)))(() => {
    load3d().then((m) => { for (const p of PLAYERS) m.warm(specOf(p)); }).catch(() => {});
  });
  near($('profile'), async () => {
    try {
      const m = await load3d();
      model = m.mountPlayer($('p-model'));
      await model.show(specOf(byName.get(current)));
    } catch {
      $('p-model-card').hidden = true; // no WebGL, or the library couldn't load: the page does without it
    }
    $('p-model').classList.remove('loading');
  });

  /* ---------------- the chat log (app.js: renderChat, msgGroup, sysRow) ---------------- */

  // [minutes into today, who, kind, text, and for a death who or what did it]
  // kind: chat | join | leave | death | advancement
  const LOG = [
    [1022, 'kestrel', 'join', 'joined the game'],
    [1024, 'Pebble_', 'chat', 'meet at spawn for the raid'],
    [1025, 'Pebble_', 'chat', 'bring arrows pls'],
    [1025, 'minty', 'chat', 'omw'],
    [1029, 'kestrel', 'advancement', 'has made the advancement [Voluntary Exile]'],
    [1030, 'oakleaf', 'join', 'joined the game'],
    [1034, 'minty', 'death', 'was shot by Pillager', 'Pillager'],
    [1034, 'minty', 'chat', 'NOT the crossbow guys again'],
    [1038, 'Pebble_', 'advancement', 'has completed the challenge [Hero of the Village]'],
    [1039, 'kestrel', 'chat', 'gg!! free emeralds'],
    [1040, 'dandelion', 'join', 'joined the game'],
    [1051, 'oakleaf', 'death', 'tried to swim in lava', 'Lava'],
    [1052, 'dandelion', 'chat', 'rip oak'],
    [1052, 'oakleaf', 'chat', 'my whole inventory 😭'],
    [1052, 'Quartzy', 'leave', 'left the game'],
    [1060, 'oakleaf', 'advancement', 'has made the advancement [Hot Stuff]'],
    [1061, 'oakleaf', 'chat', 'thanks game very helpful'],
    [1078, 'oakleaf', 'leave', 'left the game'],
    [1085, 'dandelion', 'advancement', 'has made the advancement [Diamonds!]'],
    [1086, 'dandelion', 'chat', 'found a vein of 7 at y -58'],
    [1086, 'Pebble_', 'chat', 'coords?? 👀'],
    [1087, 'dandelion', 'chat', 'nope'],
    [1114, 'dandelion', 'leave', 'left the game'],
    [1132, 'kestrel', 'death', 'was blown up by Creeper', 'Creeper'],
    [1180, 'kestrel', 'death', 'was slain by Pebble_ using [Excalibur]', 'Pebble_'],
    [1181, 'kestrel', 'chat', 'that was an accident right'],
    [1181, 'Pebble_', 'chat', 'absolutely'],
    [1187, 'Pebble_', 'death', 'was smashed by kestrel with [Bonk]', 'kestrel'],
    [1187, 'kestrel', 'chat', 'also an accident'],
    [1212, 'Saltwater', 'join', 'joined the game'],
    [1218, 'minty', 'advancement', 'has made the advancement [We Need to Go Deeper]'],
    [1219, 'Saltwater', 'chat', 'portal is next to the big oak btw'],
    [1224, 'Saltwater', 'death', 'fell from a high place', 'Fall'],
  ].map(([t, name, kind, text, cause]) => ({ t, name, kind, text, cause }));
  const died = (m) => DEATHS.push(byName.has(m.cause) ? { who: m.name, by: m.cause } : { who: m.name, cause: m.cause });
  LOG.filter((m) => m.kind === 'death').forEach(died);

  const SYS = {
    join: ['M7 4.5 10.5 8 7 11.5', 'M2.5 8h8', 'M9.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3'],
    leave: ['M10.5 4.5 14 8l-3.5 3.5', 'M6 8h8', 'M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3'],
    death: ['M3 7.2a5 5 0 0 1 10 0v2.3l-1.5 1v2.5h-7v-2.5L3 9.5z', 'M6.2 7.8h.01', 'M9.8 7.8h.01', 'M7 13v-1.5M9 13v-1.5'],
    advancement: ['M8 2.2l1.75 3.6 3.95.55-2.87 2.78.69 3.92L8 11.2l-3.52 1.85.69-3.92L2.3 6.35l3.95-.55z'],
  };
  // a name opens that player's card
  const nameLink = (name) => (byName.has(name)
    ? h('a', { class: 'msg-name', href: '#players', 'data-card': name, text: name })
    : h('span', { class: 'msg-name', text: name }));

  const log = $('c-log'), list = $('c-list');
  // the log moving under the pointer leaves a tooltip pointing at nothing
  log.addEventListener('scroll', () => { if (log.matches(':hover')) hideTip(); }, { passive: true });
  // A run of messages from one player: head and name once, then their lines.
  function msgGroup(m) {
    const p = byName.get(m.name);
    return h('div', { class: 'msg-group' },
      p ? h('a', { class: 'msg-lead', href: '#players', tabindex: '-1', 'aria-hidden': 'true', 'data-card': m.name }, head(p, 24, 'chat-head'))
        : h('span', { class: 'msg-lead' }, h('span', { class: 'logo chat-logo', style: 'width:24px;height:24px' })),
      h('div', { class: 'msg-body' }, h('div', { class: 'msg-meta' },
        m.you ? h('span', { class: 'msg-name msg-admin', text: 'You' }) : nameLink(m.name),
        m.you ? h('span', { class: 'msg-tag', text: 'web', title: 'Sent from this dashboard' }) : null,
        h('time', { class: 'msg-time', text: clock(m.t) }))));
  }
  const chatLine = (m) => h('div', { class: 'msg-line' }, h('time', { class: 'msg-gutter', 'aria-hidden': 'true', text: clock(m.t).replace(/\s?[AP]M$/, '') }), m.text);
  // Joins, leaves, deaths and advancements: one line each. A [bracketed] name is the advancement, or
  // the named weapon a kill was made with, in the game's colors; pointing at it shows its tooltip.
  function sysRow(m) {
    const body = h('div', { class: 'sys-text' }, nameLink(m.name), ' ');
    // every other player named in it is a link as well
    const rest = (text) => text.split(new RegExp(`\\b(${PLAYERS.map((p) => p.name).join('|')})(?![\\w])`)).map((s) => (byName.has(s) ? nameLink(s) : s));
    const br = /^(.*?)\[(.+?)\](.*)$/.exec(m.text);
    if (br && m.kind === 'advancement') {
      const a = ADV_BY_TITLE.get(br[2]) ?? { frame: 'task', title: br[2], desc: '' };
      const span = hoverTip(h('span', { class: 'msg-item' }, mc(a.frame === 'challenge' ? '#aa00aa' : '#55ff55', `[${br[2]}]`)), () => [{ adv: true, node: h('div', { class: `adv-tip done adv-${a.frame}` },
        h('div', { class: 'adv-tip-title', text: a.title }),
        h('div', { class: 'adv-tip-body' },
          a.desc ? h('div', { class: 'adv-tip-desc', text: a.desc }) : null,
          h('div', { class: 'adv-tip-when', text: `${a.frame === 'task' ? '' : `${a.frame === 'goal' ? 'Goal' : 'Challenge'} · `}Earned ${fmt(m.t, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` }))) }]);
      body.append(br[1], span, br[3]);
    } else if (br) {
      const it = gearOf(byName.get(m.cause)).carry.find((c) => c.name === br[2]);
      body.append(...rest(br[1]), itemTip(h('span', { class: 'msg-item' }, mc(itemColor(it), `[${br[2]}]`)), it), br[3]);
    } else body.append(...rest(m.text));
    return h('div', { class: `msg-sys sys-${m.kind}` }, h('span', { class: 'msg-lead' }, icon(SYS[m.kind], 14)), body, h('time', { class: 'msg-time', text: clock(m.t) }));
  }
  // One more line at the end of the log: in the last group when it's the same player within five
  // minutes, else a group or a line of its own.
  let lastShown = null, group = null;
  function put(m, fresh) {
    let node;
    if (m.kind === 'chat') {
      const opens = !group || lastShown.kind !== 'chat' || lastShown.name !== m.name || m.t - lastShown.t > 5;
      if (opens) list.append((group = msgGroup(m)));
      node = group.lastChild.appendChild(chatLine(m));
      if (fresh && opens) node = group;
    } else {
      group = null;
      node = list.appendChild(sysRow(m));
    }
    if (fresh && !reduced()) node.classList.add('msg-new');
    lastShown = m;
  }
  function add(m) {
    // follow new messages only when already at the bottom, so reading (or a tooltip) isn't pulled away
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    m.t = now();
    LOG.push(m);
    put(m, true);
    if (m.kind === 'death') { died(m); renderFights(); }
    if (m.name === current && (m.kind === 'death' || m.kind === 'chat')) { renderChatTile(); renderCombat(); }
    else if (m.cause === current) renderCombat();
    if (atEnd || m.you) log.scrollTop = log.scrollHeight;
  }

  // The server keeps going while the page is open: whoever's online talks, fights, dies and earns
  // advancements every few seconds. Some chat is a short back-and-forth between two or three players.
  // Kills name the killer, who's online too. {a} {b} {c} are other online players, {x} {y} {z} coordinates.
  const CHAT = [
    'anyone want to go to the end tonight', 'who took my elytra', 'lol', 'brb dinner', 'back', 'nice base {a}',
    'can someone help me with the wither', 'gg', 'there is a creeper on my roof AGAIN', 'trading hall finally done',
    'mending villager found!!', 'who left the nether portal unlit', 'i have 3 stacks of iron if anyone needs',
    'come see my sheep farm', 'is the server lagging or is it me', 'just got mending on my pick',
    'anyone have spare ender pearls', 'ok who keeps killing the cows', 'the ancient city is SO scary',
    'found a trial chamber near spawn', 'i hear a warden', 'wow the sunset', 'shield up shield up',
    'selling 64 glass for 3 diamonds', 'buying netherite scrap, paying well', 'free food at spawn, help yourselves',
    'base is at {x} {y} {z} if anyone wants to visit', 'phantoms are back, someone sleep pls', 'sleeping', 'zzz',
    'whos up for a pvp tournament at 9', 'just tamed a wolf, his name is Biscuit', 'raid at the village!!', 'need 2 more blaze rods',
    'the iron farm is broken again', 'who built the giant dirt tower', '{a} that was you wasnt it', 'my house is on fire help',
    'found a mansion', 'anyone seen my horse', 'cherry grove at {x} {z}, its beautiful', 'brb mom', 'afk 5 min',
    'just beat the ender dragon solo 😎', 'trident with riptide is so fun', 'its raining, perfect for riptide', 'who wants to go mining',
    'note to self: do not punch the iron golem', 'my villagers keep dying', 'goodnight everyone', 'morning all',
    'new world record: 3 deaths in 2 minutes', 'please stop stealing from the community chest', 'does anyone know a good mob farm design',
    'emergency: i am in the nether with no food', 'bastion at {x} {z}, bring gold', 'my creeper farm makes so much gunpowder lol',
  ];
  const REPLY = ['same', 'lol', 'omw', 'where?', 'nice!!', 'no way', 'haha', 'ill help', 'not me', 'ok', 'coming', 'gg',
    'wait for me', 'what', 'lmaooo', 'big if true', 'rip', 'on it', 'ty', 'sus', '👀', 'brb', 'k', 'pics or it didnt happen', 'lets gooo'];
  // short conversations, said in turn by two or three players ([speaker 0/1/2, text])
  const TALKS = [
    [[0, 'anyone have a spare diamond pick'], [1, 'yeah i have one'], [0, 'can i borrow it'], [1, 'if you give it back this time']],
    [[0, 'who placed tnt next to my base'], [1, 'wasnt me'], [2, 'wasnt me either'], [0, '...']],
    [[0, 'wanna trade 10 emeralds for a mending book?'], [1, 'deal'], [0, 'meet at the market']],
    [[0, 'how do i get to the end'], [1, 'eyes of ender, throw them and follow'], [0, 'thanks!!'], [2, 'bring a water bucket']],
    [[0, 'the warden just chased me for 5 minutes'], [1, 'did you survive'], [0, 'barely'], [2, 'skill issue']],
    [[0, 'coords for the stronghold?'], [1, '{x} {z}'], [0, 'omw']],
    [[0, 'i found 12 diamonds'], [1, 'share??'], [0, 'no'], [1, 'rude']],
    [[0, 'server restart soon?'], [1, 'idk ask the admin'], [2, 'maybe in an hour']],
    [[0, 'who wants to build a castle together'], [1, 'me!'], [2, 'me too'], [0, 'meet at spawn in 10']],
    [[0, 'lost my whole inventory to lava'], [1, 'f'], [2, 'f'], [0, 'thanks for the support']],
    [[0, 'my farm finally works'], [1, 'which one'], [0, 'the auto sugar cane'], [1, 'nice!']],
    [[0, 'can someone sleep, its night'], [1, 'sleeping'], [2, 'sleeping']],
    [[0, 'just got killed by a baby zombie'], [1, 'classic'], [2, 'they are the worst']],
    [[0, 'anyone want to raid an ocean monument'], [1, 'what do we need'], [0, 'water breathing and prayers'], [1, 'im in']],
  ];
  // Killed by another player. The game names the weapon only when it has a name of its own.
  const PVP = ['was slain by {a}', 'was slain by {a}', 'was shot by {a}', 'was knocked into the void by {a}', 'was doomed to fall by {a}',
    'walked into fire while fighting {a}', 'drowned while trying to escape {a}'];
  function killedBy(a) {
    const it = gearOf(byName.get(a)).carry[0];
    if (!it.name || Math.random() < 0.3) return any(PVP).replace('{a}', a);
    return it.id === 'mace' ? `was smashed by ${a} with [${it.name}]` : `was slain by ${a} using [${it.name}]`;
  }
  // [frame, title, what it's for]: the game's own advancements (frame: task, goal or challenge)
  const ADVANCEMENTS = [
    ['task', 'Stone Age', 'Mine Stone with your new Pickaxe'], ['task', 'Getting an Upgrade', 'Construct a better Pickaxe'],
    ['task', 'Acquire Hardware', 'Smelt an Iron Ingot'], ['task', 'Suit Up', 'Protect yourself with a piece of iron armor'],
    ['task', 'Hot Stuff', 'Fill a Bucket with lava'], ['task', "Isn't It Iron Pick", 'Upgrade your Pickaxe'],
    ['task', 'Not Today, Thank You', 'Deflect a projectile with a Shield'], ['task', 'Ice Bucket Challenge', 'Obtain a block of Obsidian'],
    ['task', 'Diamonds!', 'Acquire diamonds'], ['task', 'We Need to Go Deeper', 'Build, light and enter a Nether Portal'],
    ['task', 'Cover Me with Diamonds', 'Diamond armor saves lives'], ['task', 'Enchanter', 'Enchant an item at an Enchanting Table'],
    ['task', 'Eye Spy', 'Follow an Eye of Ender'], ['task', 'Into Fire', 'Relieve a Blaze of its rod'],
    ['task', 'Hidden in the Depths', 'Obtain Ancient Debris'], ['task', 'Remote Getaway', 'Escape the island'],
    ['task', 'Monster Hunter', 'Kill any hostile monster'], ['task', 'Sniper Duel', 'Kill a Skeleton from at least 50 meters away'],
    ['task', 'Voluntary Exile', 'Kill a raid captain. Maybe consider staying away from villages for the time being...'],
    ['task', "Who's the Pillager Now?", 'Give a Pillager a taste of their own medicine'], ['task', 'Bullseye', 'Hit the bullseye of a Target block from at least 30 meters away'],
    ['task', 'A Seedy Place', 'Plant a seed and watch it grow'], ['task', 'Best Friends Forever', 'Tame an animal'],
    ['task', 'Sticky Situation', 'Jump into a Honey Block to break your fall'], ['task', 'Total Beelocation', 'Move a Bee Nest, with 3 Bees inside, using Silk Touch'],
    ['task', 'Sneak 100', 'Sneak near a Sculk Sensor or Warden to prevent it from detecting you'],
    ['task', 'Under Lock and Key', 'Unlock a Vault with a Trial Key'], ['task', 'Respecting the Remnants', 'Brush a Suspicious block to obtain a Pottery Sherd'],
    ['task', 'Crafters Crafting Crafters', 'Be near a Crafter when it crafts a Crafter'], ['task', 'The Power of Books', 'Read the power signal of a Chiseled Bookshelf using a Comparator'],
    ['task', 'Smells Interesting', 'Obtain a Sniffer Egg'], ['task', 'Country Lode, Take Me Home', 'Use a Compass on a Lodestone'],
    ['goal', 'Zombie Doctor', 'Weaken and then cure a Zombie Villager'], ['goal', 'Free the End', 'Good luck'],
    ['goal', "Sky's the Limit", 'Find Elytra'], ['goal', 'The City at the End of the Game', 'Go on in, what could happen?'],
    ['goal', 'The Next Generation', 'Hold the Dragon Egg'],
    ['challenge', 'Hero of the Village', 'Successfully defend a village from a raid'], ['challenge', 'Return to Sender', 'Destroy a Ghast with a fireball'],
    ['challenge', 'Over-Overkill', 'Deal 50 hearts of damage in a single hit using the Mace'], ['challenge', 'Arbalistic', 'Kill five unique mobs with one crossbow shot'],
    ['challenge', 'Adventuring Time', 'Discover every biome'], ['challenge', 'How Did We Get Here?', 'Have every effect applied at the same time'],
    ['challenge', 'Two by Two', 'Breed all the animals!'], ['challenge', 'Cover Me in Debris', 'Get a full suit of Netherite armor'],
    ['challenge', 'Monsters Hunted', 'Kill one of every hostile monster'],
    ['challenge', 'Serious Dedication', 'Use a Netherite Ingot to upgrade a Hoe, and then reevaluate your life choices'],
  ];
  const ADV_BY_TITLE = new Map(ADVANCEMENTS.map(([frame, name, desc]) => [name, { frame, title: name, desc }]));
  const ADV_WORDS = { task: 'has made the advancement', goal: 'has reached the goal', challenge: 'has completed the challenge' };

  const coord = () => String(Math.round((Math.random() - 0.5) * 4000));
  // fills in {a} {b} {c} (other players) and {x} {y} {z} (coordinates)
  const fill = (text, others) => text
    .replace(/\{([abc])\}/g, (_, k) => others['abc'.indexOf(k)] ?? others[0] ?? 'someone')
    .replace('{x}', coord()).replace('{y}', String(Math.round(Math.random() * 120) - 20)).replace('{z}', coord());
  const later = (ms, f) => setTimeout(f, ms);
  function happen() {
    const on = [...online];
    if (!on.length) return;
    const who = any(on), roll = Math.random();
    const others = on.filter((n) => n !== who).sort(() => Math.random() - 0.5);
    if (roll < 0.25 && others.length) {
      // a conversation
      const talk = any(TALKS), cast = [who, ...others];
      talk.forEach(([i, text], k) => later(k * (1400 + Math.random() * 900), () => {
        const name = cast[i] ?? cast[k % cast.length];
        add({ kind: 'chat', name, text: fill(text, cast.filter((n) => n !== name)) });
      }));
    } else if (roll < 0.68) {
      add({ kind: 'chat', name: who, text: fill(any(CHAT), others) });
      if (others.length && Math.random() < 0.5) later(1200 + Math.random() * 1500, () => add({ kind: 'chat', name: others[0], text: any(REPLY) }));
    } else if (roll < 0.82) {
      if (others.length && Math.random() < 0.35) add({ kind: 'death', name: who, text: killedBy(others[0]), cause: others[0] });
      else { const [cause, text] = any(MOB_DEATHS); add({ kind: 'death', name: who, text, cause }); }
      if (Math.random() < 0.35) later(1500, () => add({ kind: 'chat', name: Math.random() < 0.5 ? who : (others[0] ?? who), text: any(['rip', 'NOOO', 'my stuff!!', 'f', 'lol', 'gg', 'not again', 'how', '💀']) }));
    } else {
      const [frame, name] = any(ADVANCEMENTS);
      add({ kind: 'advancement', name: who, text: `${ADV_WORDS[frame]} [${name}]` });
      if (others.length && Math.random() < 0.4) later(1300, () => add({ kind: 'chat', name: others[0], text: any(['gg!', 'congrats', 'nice', 'finally lol', 'lets go!', 'gg ' + who]) }));
    }
  }
  (function tick() {
    setTimeout(() => { if (!document.hidden) happen(); tick(); }, 3500 + Math.random() * 3500);
  })();

  // who's online now: one row of badges under the message box, or folded into a floating count
  function setOnlineBar(open) {
    $('c-online').classList.toggle('collapsed', !open);
    $('c-online-pill').hidden = open;
  }
  $('c-online-close').addEventListener('click', () => setOnlineBar(false));
  $('c-online-pill').addEventListener('click', () => setOnlineBar(true));

  // you write from the page, and someone in game answers
  const input = $('c-input');
  const send = $('c-send');
  input.addEventListener('input', () => { send.disabled = !input.value.trim(); });
  // Replies to what you write, by what it's about (first match wins), and sometimes a second player
  // chimes in. {n} is the one answering.
  const ANSWERS = [
    [/^(hi|hey|hello|yo|sup|hiya|howdy|heyo|hai)\b/i, ['hey! o/', 'hiii', 'yo!', 'hello from the overworld', 'hey whats up', 'o/', 'hi!! are you on the website?', 'heyyy']],
    [/\b(bye|cya|goodnight|gn|later|see ya)\b/i, ['bye!', 'cya!', 'gn!', 'see you tomorrow', 'night!', 'byeee']],
    [/\b(thanks|thank you|ty|thx)\b/i, ['np!', 'anytime', 'no problem', 'youre welcome :)', 'np np']],
    [/\b(diamond|diamonds)\b/i, ['diamonds?? where', 'i have like 4 lol', 'check y -58, thats where i found mine', 'trade you 3 for some iron', 'no diamonds for you']],
    [/\b(help|stuck|lost|dying)\b/i, ['omw!', 'where are you?', 'send coords', 'coming, hold on', 'cant right now sorry', 'type your coords']],
    [/\b(coords|where|location)\b/i, ['{x} {y} {z}', 'near spawn', 'by the big oak', 'in the nether, under the fortress', 'not telling 😏']],
    [/\b(creeper|zombie|skeleton|warden|enderman)\b/i, ['RUN', 'lol good luck', 'they got me earlier too', 'shield up!', 'i hate those']],
    [/\b(build|base|house|castle)\b/i, ['show me!', 'my base is better', 'need help building?', 'ooh nice', 'is it made of dirt again']],
    [/\b(lol|lmao|haha|xd|lmfao)\b/i, ['lol', 'haha', 'lmaooo', '😂', 'xD']],
    [/\b(gg|wp|nice|cool|awesome|wow)\b/i, ['gg', 'ty!', 'right?!', 'ikr', 'thanks :D']],
    [/\b(come|join|online|play)\b/i, ['im on rn!', 'join us at spawn', 'maybe later', 'already on', 'cant right now, homework']],
    [/\b(website|site|web|page|browser)\b/i, ['wait you can type from the website??', 'this website is so cool', 'the stats page says im on 55 hours lol', 'how do i get on the site']],
    [/\b(who|you)\b.*\?$/i, ['its me, {n}', 'just a player', 'idk who are YOU', 'a legend']],
    [/\?$/, ['no idea tbh', 'yes', 'nope', 'maybe?', 'ask {a}', 'good question', 'probably', 'idk ask the admin']],
    [/./, ['saw that in game, works!', 'who is that lol', 'hiii', 'come online we need help with the farm', 'ok!', 'lol', 'true', 'nice',
      'hello website person', 'cool', 'agreed', 'what', 'real', 'say that again but in game', 'ok but why', '👍', 'noted']],
  ];
  const CHIME = ['lol', 'same', 'true', 'haha', '+1', 'what {n} said', 'wait whos typing from the site', 'hi website!'];
  $('c-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    add({ kind: 'chat', name: 'You', you: true, text });
    input.value = '';
    send.disabled = true;
    const on = [...online];
    if (!on.length) return;
    const who = any(on), others = on.filter((n) => n !== who);
    const [, options] = ANSWERS.find(([re]) => re.test(text));
    const reply = fill(any(options), others).replace('{n}', who);
    later(900 + Math.random() * 900, () => add({ kind: 'chat', name: who, text: reply }));
    if (others.length && Math.random() < 0.45) later(2400 + Math.random() * 1200, () => add({ kind: 'chat', name: others[0], text: any(CHIME).replace('{n}', who) }));
  });

  /* ---------------- a player's card: click a name or a badge anywhere (app.js: openCard, renderCard) ---------------- */

  const pcard = h('div', { class: 'pcard', role: 'dialog', 'aria-label': 'Player', hidden: true });
  document.body.append(pcard);
  let cardFor = null;
  const pcStat = (value, label) => h('div', { class: 'pc-stat' }, h('div', { class: 'pc-value', text: value }), h('div', { class: 'pc-label', text: label }));
  function openCard(a) {
    if (cardFor === a && !pcard.hidden) return closeCard();
    hideTip();
    cardFor = a;
    const p = byName.get(a.dataset.card), t = now(), last = sessionsOf(p).at(-1), sent = chatsOf(p).today;
    // minutes online in each of the last 24 hours, oldest first, ending with the hour now (app.js, last24Hours)
    const first = (Math.floor(t / 60) - 23) * 60, mins = Array(24).fill(0);
    for (const [s, e] of sessionsOf(p)) {
      if ((e ?? t) > first) eachHourChunk(Math.max(s, first), e ?? t, (from, n) => { mins[Math.floor((from - first) / 60)] += n; });
    }
    const bars = mins.map((v, i) => {
      const hr = hourOf(first + i * 60);
      return {
        v, now: i === 23,
        tip: [{ value: v < 0.5 ? 'Not on' : `${Math.round(v)} min` },
          { label: `${i === 23 ? 'This hour' : fmt(first + i * 60, { weekday: 'short' })}, ${hourName(hr)}–${hourName((hr + 1) % 24)}` }],
      };
    });
    const labels = [];
    for (let i = 0; i < 20; i++) {
      const hr = hourOf(first + i * 60);
      if (hr % 6 === 0) labels.push([i / 24, hourName(hr, true)]);
    }
    labels.push([1, 'now']);
    pcard.replaceChildren(
      h('div', { class: 'pc-head' }, head(p, 48, 'pc-avatar'), h('div', { class: 'pc-who' },
        h('div', { class: 'pc-name', text: p.name }),
        h('div', { class: 'pc-status' }, last[1] == null ? [h('span', { class: 'pc-dot' }), `Online since ${clock(last[0])}`] : `Last seen ${ago(last[1])}`))),
      h('div', { class: 'pc-stats' },
        pcStat(sent, sent === 1 ? 'message today' : 'messages today'),
        pcStat(dur(playedBetween(p, today() * DAY, t)), 'played today'),
        pcStat(dur(playedBetween(p, t - 7 * DAY, t)), 'last 7 days')),
      h('div', { class: 'pc-section', text: 'Past 24 hours' }),
      hourBars(bars, labels, 'Time online in each of the last 24 hours', 40, 60), // a full bar is the whole hour
      h('a', { class: 'pc-open', href: '#players', onclick: () => { closeCard(); showPlayer(p.name); } }, 'View profile'));
    pcard.hidden = false;
    if (!reduced()) pcard.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 140, easing: 'ease-out' });
    // under what was clicked, or above it when there's no room
    const r = a.getBoundingClientRect(), w = pcard.offsetWidth, ht = pcard.offsetHeight;
    pcard.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;
    pcard.style.top = `${r.bottom + 6 + ht > innerHeight - 8 ? Math.max(8, r.top - ht - 6) : r.bottom + 6}px`;
  }
  function closeCard() {
    pcard.hidden = true;
    cardFor = null;
    hideTip();
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('[data-card]');
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openCard(a);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!pcard.hidden && !pcard.contains(e.target) && !e.target.closest?.('[data-card]')) closeCard();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pcard.hidden) closeCard(); });
  addEventListener('scroll', () => { if (!pcard.hidden) closeCard(); }, { passive: true }); // the page, not the chat log
  addEventListener('resize', () => { if (!pcard.hidden) closeCard(); });

  /* ---------------- more ---------------- */

  // busiest times: the average number online in each hour of each weekday (app.js, renderServerWeekGrid)
  function renderBusiest() {
    const happened = Array(7).fill(0); // how many of each weekday there have been
    for (let d = -SEASON_DAYS; d <= today(); d++) happened[dowOf(d * DAY)]++;
    weekGrid($('m-week'), weekOf(PLAYERS).map((row, d) => row.map((v) => v / 60 / happened[d])),
      (v, label) => [{ value: `${v.toFixed(1)} players`, label: 'avg' }, { label: `${label} · last 90 days` }]);
  }

  // the Combat page's leaderboard: click a heading to sort by it (app.js, renderCombatLeaderboard)
  const COLS = [
    { key: 'name', label: 'Player', first: 1, hint: 'Sort by name' },
    { key: 'kills', label: 'Kills', first: -1, hint: 'Players they killed' },
    { key: 'deaths', label: 'Deaths', first: -1, hint: 'Every time they died, to a player or not' },
    { key: 'kd', label: 'K/D', first: -1, hint: 'Kills for every death' },
  ];
  let sort = { key: 'kills', dir: -1 };
  function renderFights() {
    const { key, dir } = sort;
    const players = fighters().sort((a, b) => (key === 'name' ? dir * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      : dir * (a[key] - b[key]) || b.kills - a.kills || a.deaths - b.deaths));
    // the bar under each name is the column it's sorted by
    const barKey = key === 'name' ? 'kills' : key;
    const top = Math.max(...players.map((p) => p[barKey]), 0) || 1;
    const arrow = (d) => sv('svg', { width: 10, height: 12, viewBox: '0 0 10 12', 'aria-hidden': 'true', class: 'sort-arrow' },
      sv('path', { d: 'M2 4.5 5 1.5l3 3', class: d > 0 ? 'on' : '' }), sv('path', { d: 'M2 7.5l3 3 3-3', class: d < 0 ? 'on' : '' }));
    const heads = COLS.map((c) => {
      const on = c.key === key;
      return h('th', { class: `sortable${c.key === 'name' ? '' : ' num'}${on ? ' sorted' : ''}`, 'aria-sort': on ? (dir < 0 ? 'descending' : 'ascending') : 'none' },
        h('button', { type: 'button', title: on ? `${c.hint} (click to reverse)` : c.hint, onclick: () => { sort = on ? { key, dir: -dir } : { key: c.key, dir: c.first }; renderFights(); } },
          h('span', { text: c.label }), arrow(on ? dir : 0)));
    });
    const cell = (k, text, tip2) => h('td', { class: `num${k === key ? ' sorted' : ''}${text === '0' ? ' zero' : ''}`, text, title: tip2 });
    $('m-fights').replaceChildren(h('table', { class: 'cb-table' },
      h('thead', {}, h('tr', {}, h('th'), heads)),
      h('tbody', {}, players.map((p, i) => h('tr', { class: 'link', onclick: () => showPlayer(p.name) },
        h('td', { class: 'rank', text: String(i + 1) }),
        h('td', { class: key === 'name' ? 'sorted' : '' },
          h('div', { class: 'pname' }, head(byName.get(p.name), 22), h('a', { href: '#players', text: p.name })),
          h('div', { class: `bar${barKey === 'deaths' ? ' bar-deaths' : ''}`, style: `width:${Math.max(1, (p[barKey] / top) * 100)}%` })),
        cell('kills', String(p.kills)),
        cell('deaths', String(p.deaths), `${p.pvpDeaths} by players · ${p.deaths - p.pvpDeaths} other`),
        cell('kd', fmtKd(p), `${p.kills} ${p.kills === 1 ? 'kill' : 'kills'} ÷ ${p.deaths} ${p.deaths === 1 ? 'death' : 'deaths'}`))))));
  }

  /* ---------------- first drawing, and what changes while the page is open ---------------- */

  syncChips($('w-chips'));
  syncChips($('c-chips'));
  renderTiles();
  drawTimeline();
  renderProfile();
  renderModelNote();
  list.append(h('div', { class: 'chat-day', role: 'separator' }, h('span', { text: 'Today' })));
  for (const m of LOG) put(m);
  log.scrollTop = log.scrollHeight;
  renderBusiest();
  renderFights();

  // the chart is drawn to its box's width
  let wide = $('w-chart').clientWidth;
  new ResizeObserver(() => {
    const w = $('w-chart').clientWidth;
    if (w && w !== wide) { wide = w; drawTimeline(); }
  }).observe($('w-chart'));

  // now and then someone joins or leaves, as on a real server
  setInterval(() => {
    if (document.hidden) return;
    const off = PLAYERS.filter((p) => !online.has(p.name));
    const join = online.size <= 3 || (online.size < 6 && Math.random() < 0.5);
    const name = join ? any(off).name : any([...online]);
    if (join) {
      sessionsOf(byName.get(name)).push([now(), null]);
      online.add(name);
      addPick(name); // whoever joins gets a page too
    } else {
      sessionsOf(byName.get(name)).at(-1)[1] = now();
      online.delete(name);
    }
    add({ kind: join ? 'join' : 'leave', name, text: join ? 'joined the game' : 'left the game' });
    syncChips($('w-chips'), true);
    syncChips($('c-chips'), true);
    renderTiles();
    if (isLive(win)) drawTimeline();
    if (name === current) { renderProfile(); renderModelNote(); }
  }, 30000); // not often: the log is mostly what players do
  // and the minutes pass: the live chart and the numbers that count time move on
  let minute = now();
  setInterval(() => {
    if (document.hidden || minute === now()) return;
    minute = now();
    renderTiles();
    if (isLive(win) && !$('w-chart').matches(':hover')) drawTimeline();
  }, 5000);

  /* ---------------- the sky: the game's clouds, sun and moon, by day and by night ----------------
     The clouds are the game's: one flat layer of see-through white slabs, laid out by the game's own
     cloud texture, seen from the ground and running off to the horizon, all drifting the same way. In
     the light theme it's day: a blue sky and the game's sun. In the dark theme it's night: the moon,
     stars, darker and thinner clouds, and a light rain here and there. Switching themes turns the sky
     half way round: the sun sets as the moon rises and the wind races. The pointer only tilts the view
     a little. Drawn only while the hero is on screen. */
  {
    const hero = $('hero');
    const sky = hero.querySelector('.home-sky');
    const cv = $('sky');
    const ctx = cv.getContext('2d');
    const layer = document.createElement('canvas'); // the cloud layer, drawn solid, then laid on see-through
    const lg = layer.getContext('2d');
    const still = reduced();
    const r = rng('sky');
    let W = 0, H = 0, dpr = 1;
    const dark = () => {
      const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
      return m ? (+m[0] + +m[1] + +m[2]) / 3 < 100 : false;
    };
    // The sky turns like the game's: the sun and the moon opposite each other on one big wheel. Day has
    // the sun up, night the moon; each switch turns the wheel half way round, always the same way, so
    // the sun sets on one side as the moon rises on the other. `turn` is the wheel's angle (0 day, π night).
    let turn = dark() ? Math.PI : 0, from = turn, to = turn, t0 = 0;
    const SPIN = 2.6; // seconds for half a turn
    // the sky starts in the right state, with no fade on load
    sky.style.transition = 'none';
    sky.classList.toggle('night', turn > 0);
    requestAnimationFrame(() => requestAnimationFrame(() => { sky.style.transition = ''; }));
    const ease = (t) => t * t * (3 - 2 * t);

    // The game's cloud layer (textures/environment/clouds.png): each opaque pixel is one cell of cloud,
    // 12 blocks square and 4 thick, and the picture repeats across the whole sky. Until the texture
    // arrives (or if it can't), a made-up pattern of blocky patches stands in.
    const wrap = (v, n) => ((v % n) + n) % n;
    const fallback = (() => {
      const n = 64, on = new Uint8Array(n * n);
      for (let k = 0; k < 46; k++) {
        const x0 = Math.floor(r() * n), y0 = Math.floor(r() * n), w = 2 + Math.floor(r() * 7), d = 1 + Math.floor(r() * 4);
        for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) on[wrap(y0 + y, n) * n + wrap(x0 + x, n)] = 1;
      }
      return { on: (x, y) => on[wrap(y, n) * n + wrap(x, n)] === 1 };
    })();
    let map = fallback;

    // What's seen from the ground: the slabs' undersides and the sides facing you (the game shades the
    // faces differently, and tints the whole layer darker at night). [underside, front, side] by day and by night.
    const SHADES = [[[232, 237, 245], [255, 255, 255], [245, 248, 252]], [[82, 93, 122], [112, 124, 155], [97, 108, 138]]];
    const mix = (i, m) => `rgb(${SHADES[0][i].map((v, k) => Math.round(v + (SHADES[1][i][k] - v) * m)).join(',')})`;

    // The view: you stand under the layer and look toward the horizon, which sits just under the hero.
    // A point X across, Y up and Z away lands at (cx + F·X/Z, HZ − F·Y/Z). Z = 1 is the top of the hero.
    let HZ = 0, F = 0, CELL = 0, drift = 0;
    const UP = 0.6; // the layer's height: a cell at the top of the hero looks 0.6 as deep as it's wide
    const FAR = 9; // how far the layer is drawn, in hero-top distances
    function view() {
      HZ = H * 1.04;
      F = HZ / UP;
      CELL = Math.min(132, Math.max(72, W * 0.085)) / F; // a cell at the top of the hero is about this wide
    }
    function drawClouds(m, camX, camY) {
      const cx = W / 2 + camX, hz = HZ + camY, thick = CELL / 3;
      lg.setTransform(dpr, 0, 0, dpr, 0, 0);
      lg.clearRect(0, 0, W, H);
      const under = mix(0, m), front = mix(1, m), side = mix(2, m);
      const j0 = Math.max(1, Math.floor(0.45 / CELL)), j1 = Math.ceil(FAR / CELL);
      const shift = -drift; // the layer slides sideways: column i spans X from (i + shift)·CELL
      for (let j = j1; j >= j0; j--) { // far to near, so nearer slabs cover farther ones
        const zn = j * CELL, zf = zn + CELL;
        const yn = hz - (F * UP) / zn, yf = hz - (F * UP) / zf; // the underside's near and far edges
        if (yf < -2) break; // this row and every nearer one are above the hero
        const yt = hz - (F * (UP + thick)) / zn, ytf = hz - (F * (UP + thick)) / zf; // the top of the near face, and of the far one
        const half = ((W / 2 + Math.abs(camX) + 40) * zf) / F;
        const i0 = Math.floor(-half / CELL - shift) - 1, i1 = Math.ceil(half / CELL - shift) + 1;
        const pu = new Path2D(), pf = new Path2D(), ps = new Path2D();
        for (let i = i0; i <= i1; i++) {
          if (!map.on(i, j)) continue;
          let e = i;
          while (e < i1 && map.on(e + 1, j)) e++;
          const X0 = (i + shift) * CELL, X1 = (e + 1 + shift) * CELL;
          const an = cx + (F * X0) / zn, bn = cx + (F * X1) / zn, af = cx + (F * X0) / zf, bf = cx + (F * X1) / zf;
          pu.moveTo(an, yn); pu.lineTo(bn, yn); pu.lineTo(bf, yf); pu.lineTo(af, yf); pu.closePath();
          // the side facing the middle of the view shows, at either end of the run
          if (X0 > 0) { ps.moveTo(an, yn); ps.lineTo(an, yt); ps.lineTo(af, ytf); ps.lineTo(af, yf); ps.closePath(); }
          if (X1 < 0) { ps.moveTo(bn, yn); ps.lineTo(bn, yt); ps.lineTo(bf, ytf); ps.lineTo(bf, yf); ps.closePath(); }
          // the front face, where no slab stands in front of it
          for (let k = i; k <= e; k++) {
            if (map.on(k, j - 1)) continue;
            let q = k;
            while (q < e && !map.on(q + 1, j - 1)) q++;
            const fa = cx + (F * (k + shift) * CELL) / zn, fb = cx + (F * (q + 1 + shift) * CELL) / zn;
            pf.rect(fa, yt, fb - fa, yn - yt + 0.5);
            k = q;
          }
          i = e;
        }
        lg.fillStyle = side; lg.fill(ps);
        lg.fillStyle = under; lg.fill(pu);
        lg.fillStyle = front; lg.fill(pf);
      }
      // the layer thins into the distance, as the game's fog takes it
      lg.globalCompositeOperation = 'destination-in';
      const fog = lg.createLinearGradient(0, 0, 0, hz);
      fog.addColorStop(0, 'rgba(0,0,0,1)'); fog.addColorStop(0.5, 'rgba(0,0,0,0.9)'); fog.addColorStop(0.86, 'rgba(0,0,0,0)');
      lg.fillStyle = fog;
      lg.fillRect(0, 0, W, H);
      lg.globalCompositeOperation = 'source-over';
      // see-through, and more so at night (as the game's are)
      ctx.globalAlpha = 0.8 - 0.25 * m;
      ctx.drawImage(layer, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    // Rain falls in a few showers that drift across with the wind, covering about a third of the sky.
    const drops = [], stars = [], showers = [];
    const TRACK = () => W + 700;

    function resize() {
      const rect = cv.getBoundingClientRect();
      dpr = Math.min(devicePixelRatio || 1, 2);
      const first = !W;
      W = rect.width; H = rect.height;
      for (const c of [cv, layer]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      view();
      if (first) {
        const n = Math.max(1, Math.round(W / 640));
        for (let i = 0; i < n; i++) showers.push({ x: ((i + 0.2 + r() * 0.6) / n) * TRACK(), w: 170 + r() * 130 });
        for (let i = 0; i < 90; i++) stars.push({ x: r(), y: r() * 0.7, s: r() < 0.2 ? 2 : 1, p: r() * 6 });
      }
    }

    // The game's sun and full moon: 32-pixel pictures on black that the game adds onto the sky as light.
    // Here the canvas is see-through over the CSS sky, so each is turned once into a picture whose
    // brightness is its opacity, which looks the same over any sky.
    const glow = (src) => {
      const out = { ready: false, img: document.createElement('canvas') };
      const img = new Image();
      img.onload = () => {
        const c = out.img;
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const data = g.getImageData(0, 0, c.width, c.height), d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          const a = Math.max(d[i], d[i + 1], d[i + 2]);
          if (a) { d[i] = (d[i] * 255) / a; d[i + 1] = (d[i + 1] * 255) / a; d[i + 2] = (d[i + 2] * 255) / a; }
          d[i + 3] = (a * d[i + 3]) / 255;
        }
        g.putImageData(data, 0, 0);
        // cropped to what shows (the picture is mostly empty around the disc)
        let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
          if (d[(y * c.width + x) * 4 + 3] > 24) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        }
        if (x1 >= 0) {
          const crop = document.createElement('canvas');
          crop.width = x1 - x0 + 1; crop.height = y1 - y0 + 1;
          crop.getContext('2d').drawImage(c, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
          out.img = crop;
        }
        out.ready = true;
      };
      img.src = src;
      return out;
    };
    const sun = glow('/api/mc/textures/environment/celestial/sun.png');
    const moon = glow('/api/mc/textures/environment/celestial/moon/full_moon.png');
    function body(o, x, y, size, halo, alpha) {
      if (!o.ready || alpha <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      const g = ctx.createRadialGradient(x, y, size * 0.3, x, y, size * 1.6); // a soft glow around it
      g.addColorStop(0, halo);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - size * 1.6, y - size * 1.6, size * 3.2, size * 3.2);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(o.img, Math.round(x - size / 2), Math.round(y - size / 2), size, size);
      ctx.restore();
    }

    // the pointer only tilts the view a little; it never moves the clouds
    const ptr = { x: 0.5, y: 0.5, in: false };
    const par = { x: 0, y: 0 };
    addEventListener('pointermove', (e) => {
      const b = hero.getBoundingClientRect();
      ptr.in = e.clientY >= b.top && e.clientY <= b.bottom;
      if (ptr.in) { ptr.x = (e.clientX - b.left) / b.width; ptr.y = (e.clientY - b.top) / b.height; }
    }, { passive: true });

    const WIND = 0.14; // cells a second: a cell at the top of the hero crosses about 12px a second
    let last = 0, raf = 0, on = false;
    function frame(t) {
      const dt = Math.min(0.05, (t - (last || t)) / 1000);
      last = t;
      // a theme switch starts half a turn of the wheel
      const night = dark();
      if ((Math.round(to / Math.PI) % 2 === 1) !== night) { from = turn; to += Math.PI; t0 = t; }
      let p = 1;
      if (turn !== to) {
        p = still ? 1 : Math.min(1, (t - t0) / 1000 / SPIN);
        turn = p >= 1 ? to : from + (to - from) * ease(p);
      }
      sky.classList.toggle('night', night);
      const m = (1 - Math.cos(turn)) / 2; // 0 day … 1 night, for colors, stars and rain
      const rush = turn !== to ? 1 + 24 * Math.sin(Math.PI * p) : 1; // the wind races while the sky turns
      par.x += ((ptr.in ? ptr.x - 0.5 : 0) - par.x) * Math.min(1, dt * 3);
      par.y += ((ptr.in ? ptr.y - 0.5 : 0) - par.y) * Math.min(1, dt * 3);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // stars come out at night
      if (m > 0.01) {
        ctx.fillStyle = '#e8ecff';
        for (const s of stars) {
          ctx.globalAlpha = m * (0.35 + 0.35 * Math.sin(t / 900 + s.p));
          ctx.fillRect(Math.round(s.x * W - par.x * 6), Math.round(s.y * H - par.y * 3), s.s, s.s);
        }
        ctx.globalAlpha = 1;
      }
      // the sun and moon on their wheel, behind the clouds as in the game: up at the top right, and
      // going down to the right as the other comes up from the left
      const big = Math.round(Math.min(180, Math.max(110, W * 0.13)));
      const sx = par.x * -4, sy = par.y * -2;
      const R = Math.max(W * 0.5, H * 1.15), UPR = 0.55; // the wheel, and how far right of the top "up" is
      const wx = W / 2, wy = H * 0.22 + R * Math.cos(UPR);
      const at = (a) => [wx + R * Math.sin(a) + sx, wy - R * Math.cos(a) + sy];
      const [sunX, sunY] = at(UPR + turn), [moonX, moonY] = at(UPR + turn + Math.PI);
      if (sunY < H + big) body(sun, sunX, sunY, big * 1.15, 'rgba(255,240,170,0.45)', 1 - m * 0.3);
      if (moonY < H + big) body(moon, moonX, moonY, big, 'rgba(190,205,255,0.28)', 0.7 + m * 0.3);

      const wind = still ? 0 : WIND * rush * dt;
      drift += wind;
      drawClouds(m, par.x * -16, par.y * -6);

      // a light rain at night, under the showers
      const track = TRACK(), push = wind * CELL * F * 0.6; // the showers move with the clouds overhead
      for (const s of showers) {
        s.x += push;
        if (s.x > W + 350) s.x -= track;
        if (!still && r() < m * dt * 30) drops.push({ x: s.x + (r() - 0.5) * s.w, y: -10 - r() * 30, vy: 360 + r() * 140, k: 0.6 + r() * 0.5 });
      }
      ctx.fillStyle = '#7f9be0';
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        d.y += d.vy * dt;
        if (d.y > H - 6) { // a splash: two specks
          ctx.globalAlpha = 0.5 * m;
          ctx.fillRect(d.x - 3, H - 8, 2, 2); ctx.fillRect(d.x + 2, H - 9, 2, 2);
          drops.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = 0.55 * m;
        ctx.fillRect(Math.round(d.x), Math.round(d.y), 1.5, Math.round(6 * d.k + 4));
      }
      ctx.globalAlpha = 1;
      raf = on && !document.hidden ? requestAnimationFrame(frame) : 0;
    }
    const wake = () => { if (!raf && on && !document.hidden && W) { last = 0; raf = requestAnimationFrame(frame); } };
    new IntersectionObserver(([e]) => { on = e.isIntersecting; wake(); }).observe(hero);
    document.addEventListener('visibilitychange', wake);
    new ResizeObserver(() => { if (W) { resize(); wake(); } }).observe(cv);
    // a theme switch wakes the sky even if nothing else would
    new MutationObserver(wake).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // the clouds wait (briefly) for the game's cloud texture, so they're laid out by it from the start
    const tex = new Image();
    const start = () => { if (!W) resize(); wake(); };
    tex.onload = () => {
      const c = document.createElement('canvas');
      c.width = tex.width; c.height = tex.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(tex, 0, 0);
      const px = g.getImageData(0, 0, tex.width, tex.height).data;
      map = { on: (x, y) => px[(wrap(y, tex.height) * tex.width + wrap(x, tex.width)) * 4 + 3] > 0 }; // the texture tiles, as the game's sky does
      start();
    };
    tex.onerror = start;
    tex.src = '/api/mc/textures/environment/clouds.png';
    setTimeout(start, 1500);
  }
})();
