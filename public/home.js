// The landing page (/): an example server, Birchwood SMP, shown with the dashboard's own parts.
// Nothing here talks to the server: the players, their numbers and the chat are made up below, and the
// same name always gets the same numbers. The pieces are:
//   the hero window   the Activity page: tiles, who's online (a player joins or leaves now and then), today's chart
//   #players          a player's page; pick another player, or click a name anywhere on the page
//   #chat             the chat log with its filter, and a message box that "sends" and gets a reply
//   #more             busiest hours, fights, and the password box
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

  /* ---------------- the players ---------------- */

  // skin: one of the game's nine default skins, [arm model, name], drawn from the game's own texture
  const PLAYERS = [
    { name: 'oakleaf', skin: ['wide', 'steve'] },
    { name: 'Pebble_', skin: ['slim', 'alex'] },
    { name: 'kestrel', skin: ['wide', 'kai'] },
    { name: 'minty', skin: ['slim', 'noor'] },
    { name: 'Saltwater', skin: ['wide', 'sunny'] },
    { name: 'nightowl_', skin: ['wide', 'zuri'] },
    { name: 'Brickhouse', skin: ['wide', 'efe'] },
    { name: 'dandelion', skin: ['slim', 'makena'] },
    { name: 'Quartzy', skin: ['slim', 'ari'] },
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
  // what public/player3d.js draws: their skin, armor and held items
  const specOf = (p, gear) => ({ name: p.name, skin: { path: skinPath(p), slim: p.skin[0] === 'slim' }, ...gear });

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
  const hours = (m) => ((m = Math.round(m)) < 60 ? `${Math.round(m)}m` : `${Math.floor(m / 60)}h${Math.round(m % 60) ? ` ${Math.round(m % 60)}m` : ''}`);
  const clock = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;

  /* ---------------- who's online (the hero window) ---------------- */

  const online = new Set(['Pebble_', 'kestrel', 'minty', 'Saltwater']);
  const NOW = 20 * 60 + 30; // the example's "now"
  // players on, every half hour of today until now
  const today = [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 1, 1, 0, 1, 2, 2, 3, 2, 2, 1, 1, 1, 1, 2, 3, 4, 5, 5, 6, 5, 4, 5, 4, 4, 4];

  const chips = $('w-chips');
  function chip(p, fresh) {
    const c = h('a', { class: `chip${fresh && !reduced() ? ' chip-enter' : ''}`, href: '#players', 'data-name': p.name },
      head(p, 24), p.name, h('span', { class: 'since', text: fresh ? 'just now' : `${hours(20 + p.name.length * 9)}` }));
    c.addEventListener('click', () => showPlayer(p.name));
    return c;
  }
  chips.append(...[...online].map((n) => chip(byName.get(n), false)));

  const Y = (n) => 96 - n * 14;
  function drawChart() {
    let d = `M0 ${Y(today[0])}`;
    for (let i = 1; i < today.length; i++) if (today[i] !== today[i - 1]) d += `H${i * 30}V${Y(today[i])}`;
    d += `H${NOW}`;
    $('w-line').setAttribute('d', d);
    $('w-area').setAttribute('d', `${d}V100H0Z`);
  }
  drawChart();

  function setCount() {
    const n = online.size;
    $('w-online').textContent = n;
    $('w-live').textContent = `${n} online`;
    today[today.length - 1] = n;
    drawChart();
  }

  // now and then someone joins or leaves, as on a real server
  setInterval(() => {
    if (document.hidden) return;
    const off = PLAYERS.filter((p) => !online.has(p.name));
    const join = online.size <= 3 || (online.size < 6 && Math.random() < 0.5);
    if (join) {
      const p = off[Math.floor(Math.random() * off.length)];
      online.add(p.name);
      chips.append(chip(p, true));
      addPick(p.name); // whoever joins gets a page too
      addSys('join', p.name, 'joined the game');
    } else {
      const names = [...online];
      const name = names[Math.floor(Math.random() * names.length)];
      online.delete(name);
      chips.querySelector(`[data-name="${CSS.escape(name)}"]`)?.remove();
      addSys('leave', name, 'left the game');
    }
    setCount();
    if (current) renderProfile(current);
  }, 30000); // not often: the log is mostly what players do

  // hovering the chart shows how many were on then
  const plot = $('w-plot');
  const cursor = $('w-cursor');
  plot.addEventListener('pointermove', (e) => {
    const r = plot.getBoundingClientRect();
    const m = Math.max(0, Math.min(NOW, ((e.clientX - r.left) / r.width) * 1440));
    const n = today[Math.min(today.length - 1, Math.floor(m / 30))];
    cursor.hidden = false;
    cursor.style.left = `${(m / 1440) * 100}%`;
    $('w-marker').style.top = `${Y(n)}%`;
    const tip = $('w-tip');
    tip.textContent = `${n} online at ${clock(Math.floor(m / 5) * 5)}`;
    tip.classList.toggle('flip', m > 1000);
  });
  plot.addEventListener('pointerleave', () => { cursor.hidden = true; });

  /* ---------------- a player's page ---------------- */

  const KILLERS = ['Creeper', 'Skeleton', 'Zombie', 'falling', 'lava', 'Pebble_', 'Drowned'];
  function statsOf(p) {
    if (p.stats) return p.stats;
    const r = rng(p.name);
    const days = Array.from({ length: 30 }, (_, i) => {
      const weekend = (i + 2) % 7 >= 5;
      return r() < 0.25 ? 0 : Math.round((weekend ? 90 : 35) + r() * (weekend ? 200 : 110));
    });
    const total = days.reduce((a, b) => a + b, 0) + Math.round(r() * 900);
    const sessions = Math.max(4, Math.round(total / (35 + r() * 30)));
    const peak = 15 + Math.floor(r() * 7); // their usual hour
    const usual = Array.from({ length: 24 }, (_, hr) => {
      const d = Math.min(Math.abs(hr - peak), 24 - Math.abs(hr - peak));
      return Math.max(0, Math.round((1 - d / 5) * 100 * (0.7 + r() * 0.3)));
    });
    const recent = [0, 1, 2].map((k) => {
      const start = (peak - 2 + Math.floor(r() * 3)) * 60 + Math.floor(r() * 4) * 15;
      const len = 25 + Math.round(r() * 150);
      return { day: ['Today', 'Yesterday', 'Friday'][k], start, len };
    });
    days[29] = recent[0].len;
    p.stats = {
      days, total, sessions, usual, recent,
      longest: Math.max(...recent.map((x) => x.len), 160 + Math.round(r() * 120)),
      messages: Math.round(40 + r() * 300),
      kills: Math.round(r() * 24), deaths: Math.round(2 + r() * 14),
      killer: KILLERS[Math.floor(r() * KILLERS.length)],
      seen: `today at ${clock(recent[0].start + recent[0].len)}`,
    };
    return p.stats;
  }

  const profile = $('p-info');
  let current = null;
  function bars(values, { w, hgt, gap, label, now }) {
    const max = Math.max(1, ...values);
    const bw = (w - gap * (values.length - 1)) / values.length;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    svg.setAttribute('class', 'pc-graph home-bars');
    svg.setAttribute('preserveAspectRatio', 'none');
    values.forEach((v, i) => {
      const bh = v ? Math.max(2, (v / max) * hgt) : 2;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', i * (bw + gap));
      rect.setAttribute('y', hgt - bh);
      rect.setAttribute('width', bw);
      rect.setAttribute('height', bh);
      rect.setAttribute('class', `pc-bar${v ? '' : ' zero'}${i === now ? ' now' : ''}`);
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      t.textContent = label(v, i);
      rect.append(t);
      svg.append(rect);
    });
    return svg;
  }
  function renderProfile(name) {
    const p = byName.get(name);
    const s = statsOf(p);
    const on = online.has(name);
    profile.replaceChildren(
      h('div', { class: 'player-head' },
        head(p, 64, 'p-avatar'),
        h('div', {},
          h('div', { class: 'home-pname', text: p.name }),
          h('div', { class: 'card-sub home-pstatus' }, on ? h('span', { class: 'pc-dot' }) : null, on ? 'Online now' : `Last seen ${s.seen}`))),
      h('div', { class: 'tiles' },
        tile('Total played', hours(s.total), 'this season'),
        tile('Sessions', s.sessions, `${hours(s.total / s.sessions)} on average`),
        tile('Longest session', hours(s.longest), 'one sitting'),
        tile('Messages', s.messages, 'in chat')),
      h('div', { class: 'home-pgrid' },
        h('div', {},
          h('div', { class: 'pc-section', text: 'Last 30 days' }),
          bars(s.days, { w: 300, hgt: 64, gap: 2, now: 29, label: (v, i) => `${i === 29 ? 'Today' : `${29 - i} days ago`}: ${v ? hours(v) : 'not on'}` })),
        h('div', {},
          h('div', { class: 'pc-section' }, 'Usually on ', h('span', { class: 'muted', text: `around ${clock(s.usual.indexOf(Math.max(...s.usual)) * 60)}` })),
          h('div', { class: 'pc-hours' },
            bars(s.usual, { w: 300, hgt: 46, gap: 2, label: (v, i) => `${clock(i * 60)}: ${v ? 'often' : 'rarely'}` }),
            h('div', { class: 'pc-axis' }, ...['00', '06', '12', '18'].map((t, i) => h('span', { style: `left:${i * 25}%`, text: t }))))),
        h('div', { class: 'home-prow' },
          h('div', { class: 'pc-section', text: 'Recent sessions' }),
          h('table', {}, h('tbody', {}, ...s.recent.map((x) => h('tr', {},
            h('td', { text: x.day }), h('td', { class: 'muted', text: `${clock(x.start)} to ${clock(x.start + x.len)}` }), h('td', { class: 'num', text: hours(x.len) })))))),
        h('div', { class: 'home-prow' },
          h('div', { class: 'pc-section', text: 'Fights' }),
          h('div', { class: 'pc-stats home-pfights' },
            stat(s.kills, 'kills'), stat(s.deaths, 'deaths'), stat(s.killer, 'killed them most')))));
  }
  const tile = (label, value, sub) => h('div', { class: 'tile' },
    h('div', { class: 'tile-label', text: label }), h('div', { class: 'tile-value', text: String(value) }), h('div', { class: 'tile-sub', text: sub }));
  const stat = (v, label) => h('div', { class: 'pc-stat' }, h('div', { class: 'pc-value', text: String(v) }), h('div', { class: 'pc-label', text: label }));

  const pick = $('p-pick');
  const FEATURED = ['oakleaf', 'Pebble_', 'kestrel', 'Brickhouse'];
  // a chip per player with a page: the featured four, then everyone who joins while the page is open
  function addPick(n) {
    if (pick.querySelector(`[data-name="${CSS.escape(n)}"]`)) return;
    const p = byName.get(n);
    pick.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(n === current), 'data-name': n, onclick: () => showPlayer(n, false) }, head(p, 24), n));
    setTimeout(() => { if (three) three.warm(specOf(p, gearOf(p))); }); // its model is ready before it's picked
  }
  for (const n of FEATURED) addPick(n);
  function showPlayer(name, scroll = true) {
    current = name;
    renderProfile(name);
    showGear(name);
    for (const b of pick.children) b.setAttribute('aria-pressed', String(b.dataset.name === name));
    if (!reduced()) {
      profile.classList.remove('home-swap');
      void profile.offsetWidth;
      profile.classList.add('home-swap');
    }
    if (scroll) document.getElementById('players').scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
  }
  current = 'oakleaf';
  renderProfile(current);
  pick.firstChild.setAttribute('aria-pressed', 'true');

  /* ---------------- their model and gear (public/home3d.js, loaded as soon as the page is idle) ---------------- */

  let three = null;
  let model = null;
  // the salt picks rolls where the four example players between them show off swords, a spear, a mace and a shield
  const gearOf = (p) => (p.gear ??= three.rollGear(`${p.name}:18`));
  const article = (n) => (/(Leaves|Shears)$/.test(n) ? 'some' : /^[AEIOU]/.test(n) ? 'an' : 'a');
  function showGear(name) {
    if (!three) return;
    const p = byName.get(name);
    const g = gearOf(p);
    model?.show(specOf(p, g));
    const main = g.mainhand?.name;
    const off = g.offhand?.name;
    $('p-held').textContent = main ? `Holding ${article(main)} ${main}${off ? ` and ${article(off)} ${off}` : ''}` : 'Empty-handed';
  }

  // The game's item tooltip over whatever piece of gear the pointer is on (tap on touch screens).
  const roman = (n) => ['', 'I', 'II', 'III', 'IV', 'V'][n] ?? String(n);
  const tip = h('div', { class: 'home-mctip', role: 'tooltip', hidden: true });
  document.body.append(tip);
  let tipSlot = null;
  function showTip(x, y) {
    const slot = model?.pick(x, y);
    const g = current && three ? gearOf(byName.get(current)) : null;
    const item = slot && g ? (g.armor[slot] ?? g[slot]) : null;
    if (!item) { tip.hidden = true; tipSlot = null; return; }
    if (tipSlot !== `${current}:${slot}`) {
      tipSlot = `${current}:${slot}`;
      tip.replaceChildren(...[ // the DOM writes a null child as the word "null", so the missing lines are dropped
        h('b', { class: `r-${item.rarity ?? 'common'}`, text: item.name }),
        ...(item.enchants ?? []).map(([n, lv]) => h('span', { text: lv > 1 || !['Mending', 'Aqua Affinity', 'Silk Touch'].includes(n) ? `${n} ${roman(lv)}` : n })),
        item.trim ? h('span', { class: 'mctip-trim' }, 'Upgrade:', h('i', { text: `${title(item.trim.pattern)} Armor Trim` }), h('i', { text: `${title(item.trim.palette.replace('_darker', ''))} Material` })) : null,
      ].filter(Boolean));
    }
    tip.hidden = false;
    // beside the pointer, as in the game, kept on screen
    const w = tip.offsetWidth, ht = tip.offsetHeight;
    const left = x + 14 + w > innerWidth - 8 ? x - 14 - w : x + 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, Math.min(innerHeight - ht - 8, y - 20))}px`;
  }
  const title = (s) => s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  $('p-model').addEventListener('pointermove', (e) => { if (e.buttons) tip.hidden = true; else if (e.pointerType === 'mouse') showTip(e.clientX, e.clientY); });
  $('p-model').addEventListener('pointerleave', () => { tip.hidden = true; });
  $('p-model').addEventListener('click', (e) => { if (e.pointerType !== 'mouse') showTip(e.clientX, e.clientY); });
  addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });

  let loading = null;
  const load3d = () => (loading ??= import('/home3d.js').then((m) => { three = m; return m; }));
  const near = (el, fn) => {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); fn(); } }, { rootMargin: '1200px' });
    io.observe(el);
  };
  // Fetch the 3D code and every texture the first models need while the reader is still up top, so the
  // models are drawn the moment they come near (the WebGL scenes themselves still wait until then).
  (window.requestIdleCallback ?? ((f) => setTimeout(f, 200)))(() => {
    load3d().then((m) => {
      for (const p of byName.values()) m.warm(specOf(p, gearOf(p)));
    }).catch(() => {});
  });
  near($('profile'), async () => {
    try {
      const m = await load3d();
      model = m.mountPlayer($('p-model'));
      $('p-model').classList.remove('loading');
      showGear(current);
    } catch {
      $('p-model').classList.remove('loading');
      $('p-held').textContent = 'This browser can’t show the 3D model.';
    }
  });

  /* ---------------- the chat log ---------------- */

  // kind: chat | join | leave | death | advancement. t: minutes into today.
  const LOG = [
    [17 * 60 + 2, 'kestrel', 'join', 'joined the game'],
    [17 * 60 + 4, 'Pebble_', 'chat', 'meet at spawn for the raid'],
    [17 * 60 + 5, 'Pebble_', 'chat', 'bring arrows pls'],
    [17 * 60 + 5, 'minty', 'chat', 'omw'],
    [17 * 60 + 9, 'kestrel', 'advancement', 'has made the advancement [Voluntary Exile]'],
    [17 * 60 + 14, 'minty', 'death', 'was shot by Pillager'],
    [17 * 60 + 14, 'minty', 'chat', 'NOT the crossbow guys again'],
    [17 * 60 + 18, 'Pebble_', 'advancement', 'has completed the challenge [Hero of the Village]'],
    [17 * 60 + 19, 'kestrel', 'chat', 'gg!! free emeralds'],
    [17 * 60 + 31, 'oakleaf', 'death', 'tried to swim in lava'],
    [17 * 60 + 32, 'dandelion', 'chat', 'rip oak'],
    [17 * 60 + 32, 'oakleaf', 'chat', 'my whole inventory 😭'],
    [17 * 60 + 40, 'oakleaf', 'advancement', 'has made the advancement [Hot Stuff]'],
    [17 * 60 + 41, 'oakleaf', 'chat', 'thanks game very helpful'],
    [18 * 60 + 5, 'dandelion', 'advancement', 'has made the advancement [Diamonds!]'],
    [18 * 60 + 6, 'dandelion', 'chat', 'found a vein of 7 at y -58'],
    [18 * 60 + 6, 'Pebble_', 'chat', 'coords?? 👀'],
    [18 * 60 + 7, 'dandelion', 'chat', 'nope'],
    [18 * 60 + 52, 'kestrel', 'death', 'was blown up by Creeper'],
    [19 * 60 + 40, 'kestrel', 'death', 'was slain by Pebble_ using [Diamond Sword]'],
    [19 * 60 + 41, 'kestrel', 'chat', 'that was an accident right'],
    [19 * 60 + 41, 'Pebble_', 'chat', 'absolutely'],
    [19 * 60 + 47, 'Pebble_', 'death', 'was slain by kestrel using [Mace]'],
    [19 * 60 + 47, 'kestrel', 'chat', 'also an accident'],
    [20 * 60 + 12, 'Saltwater', 'join', 'joined the game'],
    [20 * 60 + 18, 'minty', 'advancement', 'has made the advancement [We Need to Go Deeper]'],
    [20 * 60 + 19, 'Saltwater', 'chat', 'portal is next to the big oak btw'],
    [20 * 60 + 24, 'Saltwater', 'death', 'fell from a high place'],
  ].map(([t, name, kind, text]) => ({ t, name, kind, text }));

  const SYS = {
    join: ['M7 4.5 10.5 8 7 11.5', 'M2.5 8h8', 'M9.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3'],
    leave: ['M10.5 4.5 14 8l-3.5 3.5', 'M6 8h8', 'M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3'],
    death: ['M3 7.2a5 5 0 0 1 10 0v2.3l-1.5 1v2.5h-7v-2.5L3 9.5z', 'M6.2 7.8h.01', 'M9.8 7.8h.01', 'M7 13v-1.5M9 13v-1.5'],
    advancement: ['M8 2.2l1.75 3.6 3.95.55-2.87 2.78.69 3.92L8 11.2l-3.52 1.85.69-3.92L2.3 6.35l3.95-.55z'],
  };
  function icon(paths) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) s.setAttribute(k, v);
    for (const d of paths) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      s.append(p);
    }
    return s;
  }
  const nameLink = (name) => {
    if (!byName.has(name)) return h('span', { class: 'msg-name', text: name });
    return h('a', { class: 'msg-name', href: '#players', onclick: () => showPlayer(name), text: name });
  };

  // the chat log's tooltips (items and advancements), drawn as on a server's own chat log
  const ctip = h('div', { class: 'tooltip', role: 'tooltip', hidden: true });
  document.body.append(ctip);
  function chatTip(node, make, kind) {
    const show = (x, y) => {
      ctip.replaceChildren(make());
      ctip.classList.toggle('tip-item', kind === 'item');
      ctip.classList.toggle('tip-adv', kind === 'adv');
      ctip.hidden = false;
      const w = ctip.offsetWidth, ht = ctip.offsetHeight;
      let left = x + 14, top = y - ht - 10;
      if (left + w > innerWidth - 8) left = x - w - 14;
      if (top < 8) top = y + 18;
      ctip.style.left = `${Math.max(8, left)}px`;
      ctip.style.top = `${top}px`;
    };
    node.addEventListener('pointerenter', (e) => show(e.clientX, e.clientY));
    node.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
    node.addEventListener('pointerleave', () => { ctip.hidden = true; });
    node.addEventListener('focus', () => { const r = node.getBoundingClientRect(); show(r.left, r.top); });
    node.addEventListener('blur', () => { ctip.hidden = true; });
  }
  $('c-log').addEventListener('scroll', () => { ctip.hidden = true; }, { passive: true });

  const log = $('c-log');
  let filter = 'all';
  let clockNow = NOW;
  function row(m, prev) {
    if (m.kind === 'chat') {
      const line = h('div', { class: 'msg-line' }, h('time', { class: 'msg-gutter', 'aria-hidden': 'true', text: clock(m.t) }), m.text);
      if (prev && prev.kind === 'chat' && prev.name === m.name && m.t - prev.t < 5) return [line];
      const p = byName.get(m.name);
      return [h('div', { class: 'msg-group' },
        h('span', { class: 'msg-lead' }, p ? head(p, 24, 'chat-head') : h('span', { class: 'logo chat-logo', style: 'width:24px;height:24px' })),
        h('div', { class: 'msg-body' },
          h('div', { class: 'msg-meta' }, m.you ? h('span', { class: 'msg-admin', text: 'You' }) : nameLink(m.name),
            m.you ? h('span', { class: 'msg-tag', text: 'web' }) : null,
            h('time', { class: 'msg-time', text: clock(m.t) })),
          line))];
    }
    const body = h('div', { class: 'sys-text' }, nameLink(m.name), ' ');
    // a [bracketed] name: the advancement, or the item a kill was made with; pointing at it shows its tooltip
    const br = /^(.*?)\[(.+?)\](.*)$/.exec(m.text);
    if (br && m.kind === 'advancement') {
      const a = ADV_BY_TITLE.get(br[2]) ?? { frame: /challenge/.test(br[1]) ? 'challenge' : /goal/.test(br[1]) ? 'goal' : 'task', title: br[2], desc: '' };
      const span = h('span', { class: `msg-item has-tip home-adv${a.frame === 'challenge' ? ' home-adv-ch' : ''}`, tabindex: '0', text: `[${br[2]}]` });
      chatTip(span, () => h('div', { class: `adv-tip done adv-${a.frame}` },
        h('div', { class: 'adv-tip-title', text: a.title }),
        h('div', { class: 'adv-tip-body' },
          a.desc ? h('div', { class: 'adv-tip-desc', text: a.desc }) : null,
          h('div', { class: 'adv-tip-when', text: `${a.frame === 'task' ? '' : `${a.frame === 'goal' ? 'Goal' : 'Challenge'} · `}Earned today at ${clock(m.t)}` }))), 'adv');
      body.append(br[1], span, br[3]);
    } else if (br && (m.item ??= itemLines(br[2]))) {
      const lines = m.item;
      const span = h('span', { class: 'msg-item has-tip', tabindex: '0', style: `color:${lines[0][0].c === '#ffffff' ? 'inherit' : lines[0][0].c}`, text: `[${br[2]}]` });
      chatTip(span, () => h('div', { class: 'item-tip' }, ...lines.map((line, k) => h('div', { class: `it-line${k ? '' : ' it-name'}` },
        ...(line.length ? line.map((p) => h('span', { style: `${p.c ? `color:${p.c};` : ''}${p.i ? 'font-style:italic' : ''}`, text: p.t })) : ['\u00a0'])))), 'item');
      body.append(br[1], span, br[3]);
    } else body.append(m.text);
    return [h('div', { class: `msg-sys sys-${m.kind}` }, h('span', { class: 'msg-lead' }, icon(SYS[m.kind])), body, h('time', { class: 'msg-time', text: clock(m.t) }))];
  }
  function renderLog() {
    const shown = LOG.filter((m) => filter === 'all' || m.kind === filter);
    const out = [h('div', { class: 'chat-day', text: 'Today' })];
    shown.forEach((m, i) => out.push(...row(m, shown[i - 1])));
    if (!shown.length) out.push(h('div', { class: 'chat-empty', text: 'Nothing like that today.' }));
    log.replaceChildren(...out);
    log.scrollTop = log.scrollHeight;
  }
  function add(m) {
    // follow new messages only when already at the bottom, so reading (or a tooltip) isn't pulled away
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    m.t = clockNow = Math.max(clockNow, LOG.at(-1).t) + 1;
    const prev = LOG.at(-1);
    LOG.push(m);
    if (filter !== 'all' && filter !== m.kind) return;
    const nodes = row(m, filter === 'all' ? prev : null);
    // a line that continues the last group goes inside it
    const last = log.lastElementChild;
    if (nodes[0].classList.contains('msg-line') && last?.classList.contains('msg-group')) last.querySelector('.msg-body').append(nodes[0]);
    else log.append(...nodes);
    if (!reduced()) nodes[0].classList.add('msg-new');
    if (atEnd || m.you) log.scrollTop = log.scrollHeight;
  }
  function addSys(kind, name, text) { add({ kind, name, text }); }

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
  const MOB_DEATHS = [
    'was blown up by Creeper', 'was slain by Zombie', 'was shot by Skeleton', 'drowned', 'fell from a high place',
    'hit the ground too hard', 'was killed by Witch using magic', 'was slain by Enderman', 'burned to death',
    'was obliterated by a sonically-charged shriek whilst trying to escape Warden', 'was pricked to death',
    'was squashed by a falling anvil', 'was impaled by Drowned', 'tried to swim in lava', 'went off with a bang',
    'was shot by Pillager', 'was slain by Piglin Brute', 'was fireballed by Ghast', 'was stung to death',
    'fell out of the world', 'starved to death', 'suffocated in a wall', 'was frozen to death', 'was struck by lightning',
    'experienced kinetic energy', 'was slain by Vindicator', 'was killed by Evoker using magic', 'was shot by Breeze',
    'discovered the floor was lava', 'was poked to death by a sweet berry bush', 'fell off some vines', 'was slain by Hoglin',
  ];
  const PVP = ['was slain by {a} using [{w}]', 'was shot by {a} using [Bow]', 'was blown up by {a} using [Firework Rocket]',
    'was knocked into the void by {a}', 'was doomed to fall by {a}', 'was slain by {a}', 'walked into fire while fighting {a}',
    'drowned while trying to escape {a}', 'was impaled by {a} using [Trident]', 'was smashed by {a} using [Mace]'];
  const WEAPONS = ['Diamond Sword', 'Netherite Sword', 'Mace', 'Iron Spear', 'Netherite Axe', 'Diamond Spear', 'Trident', 'Excalibur'];
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
  const ADV_BY_TITLE = new Map(ADVANCEMENTS.map(([frame, title, desc]) => [title, { frame, title, desc }]));
  const ADV_WORDS = { task: 'has made the advancement', goal: 'has reached the goal', challenge: 'has completed the challenge' };
  const advText = ([frame, title]) => `${ADV_WORDS[frame]} [${title}]`;

  // The items named in deaths, with their tooltips as the game draws them: the name (aqua when
  // enchanted, magenta for the epic mace, in italics when renamed), the enchantments in grey, then
  // what it does in the main hand, in green. Each kill rolls its own enchantments.
  const ITEMS = {
    'Diamond Sword': { pool: ['Sharpness V', 'Sweeping Edge III', 'Looting III', 'Fire Aspect II', 'Knockback II', 'Unbreaking III', 'Mending'], hand: [7, 1.6] },
    'Netherite Sword': { pool: ['Sharpness V', 'Sweeping Edge III', 'Looting III', 'Fire Aspect II', 'Unbreaking III', 'Mending'], hand: [8, 1.6] },
    Excalibur: { base: 'Netherite Sword', renamed: true, pool: ['Sharpness V', 'Fire Aspect II', 'Looting III', 'Unbreaking III', 'Mending'], hand: [8, 1.6] },
    'Netherite Axe': { pool: ['Sharpness V', 'Efficiency V', 'Unbreaking III', 'Mending'], hand: [10, 1] },
    'Iron Spear': { pool: ['Sharpness V', 'Lunge III', 'Knockback II', 'Unbreaking III', 'Mending'] },
    'Diamond Spear': { pool: ['Sharpness V', 'Lunge III', 'Knockback II', 'Unbreaking III', 'Mending'] },
    Mace: { epic: true, pool: ['Density V', 'Breach IV', 'Wind Burst III', 'Fire Aspect II', 'Unbreaking III', 'Mending'], hand: [6, 0.6] },
    Trident: { pool: ['Loyalty III', 'Impaling V', 'Channeling', 'Unbreaking III', 'Mending'], hand: [9, 1.1] },
    Bow: { pool: ['Power V', 'Punch II', 'Flame', 'Infinity', 'Unbreaking III'] },
    'Firework Rocket': { plain: true, extra: [[{ t: 'Flight Duration: 3', c: '#aaaaaa' }]] },
  };
  // Some enchantments can't go together; only the first of each group is kept.
  const CLASH = [['Density V', 'Breach IV'], ['Loyalty III', 'Riptide III'], ['Infinity', 'Mending']];
  function itemLines(name) {
    const it = ITEMS[name];
    if (!it) return null;
    let ench = it.plain ? [] : it.pool.filter(() => Math.random() < 0.6);
    if (!it.plain && !ench.length) ench = [it.pool[0]];
    for (const group of CLASH) { const keep = ench.find((e) => group.includes(e)); ench = ench.filter((e) => !group.includes(e) || e === keep); }
    const color = it.epic ? '#ff55ff' : ench.length ? '#55ffff' : '#ffffff';
    const lines = [[{ t: name, c: color, i: it.renamed ? 1 : 0 }], ...ench.map((e) => [{ t: e, c: '#aaaaaa' }]), ...(it.extra ?? [])];
    if (it.hand) lines.push([], [{ t: 'When in Main Hand:', c: '#aaaaaa' }], [{ t: ` ${it.hand[0]} Attack Damage`, c: '#00aa00' }], [{ t: ` ${it.hand[1]} Attack Speed`, c: '#00aa00' }]);
    return lines;
  }
  const any = (list) => list[Math.floor(Math.random() * list.length)];
  const coord = () => String(Math.round((Math.random() - 0.5) * 4000));
  // fills in {a} {b} {c} (other players), {w} (a weapon) and {x} {y} {z} (coordinates)
  const fill = (text, others) => text
    .replace(/\{([abc])\}/g, (_, k) => others['abc'.indexOf(k)] ?? others[0] ?? 'someone')
    .replace('{w}', any(WEAPONS)).replace('{x}', coord()).replace('{y}', String(Math.round(Math.random() * 120) - 20)).replace('{z}', coord());
  const later = (ms, f) => setTimeout(f, ms);
  function happen() {
    const on = [...online];
    if (!on.length) return;
    const who = any(on), roll = Math.random();
    const others = on.filter((n) => n !== who).sort(() => Math.random() - 0.5);
    if (roll < 0.22 && others.length) {
      // a conversation
      const talk = any(TALKS), cast = [who, ...others];
      talk.forEach(([i, text], k) => later(k * (1400 + Math.random() * 900), () => {
        const name = cast[i] ?? cast[k % cast.length];
        add({ kind: 'chat', name, text: fill(text, cast.filter((n) => n !== name)) });
      }));
    } else if (roll < 0.5) {
      add({ kind: 'chat', name: who, text: fill(any(CHAT), others) });
      if (others.length && Math.random() < 0.5) later(1200 + Math.random() * 1500, () => add({ kind: 'chat', name: others[0], text: any(REPLY) }));
    } else if (roll < 0.75) {
      const text = others.length && Math.random() < 0.4 ? fill(any(PVP), others) : any(MOB_DEATHS);
      add({ kind: 'death', name: who, text });
      if (Math.random() < 0.35) later(1500, () => add({ kind: 'chat', name: Math.random() < 0.5 ? who : (others[0] ?? who), text: any(['rip', 'NOOO', 'my stuff!!', 'f', 'lol', 'gg', 'not again', 'how', '💀']) }));
    } else {
      addSys('advancement', who, advText(any(ADVANCEMENTS)));
      if (others.length && Math.random() < 0.4) later(1300, () => add({ kind: 'chat', name: others[0], text: any(['gg!', 'congrats', 'nice', 'finally lol', 'lets go!', 'gg ' + who]) }));
    }
  }
  (function tick() {
    setTimeout(() => { if (!document.hidden) happen(); tick(); }, 3500 + Math.random() * 3500);
  })();
  renderLog();

  for (const b of $('c-filter').children) {
    b.addEventListener('click', () => {
      filter = b.dataset.k;
      for (const o of $('c-filter').children) o.setAttribute('aria-pressed', String(o === b));
      renderLog();
    });
  }

  // you write from the page, and someone in game answers
  const input = $('c-input');
  const send = $('c-send');
  input.addEventListener('input', () => { send.disabled = !input.value.trim(); });
  // Replies to what you write, by what it's about (first match wins), and sometimes a second player
  // chimes in. {you} is "You"; {n} is the one answering.
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

  /* ---------------- more ---------------- */

  // busiest hours: days across, two-hour blocks down, as on the Activity page
  {
    const week = $('m-week');
    const r = rng('week');
    week.append(h('span'), ...['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => h('span', { class: 'dlabel', text: d })));
    for (let b = 0; b < 12; b++) {
      week.append(h('span', { class: 'hlabel', text: b % 3 === 0 ? String(b * 2).padStart(2, '0') : '' }));
      for (let d = 0; d < 7; d++) {
        const evening = b >= 8 && b <= 10 ? 2 : b >= 7 ? 1 : 0;
        const weekend = d >= 5 && b >= 5 ? 1 : 0;
        const late = b <= 1 && d >= 4 ? 1 : 0;
        const lv = Math.min(4, evening + weekend + late + (r() < 0.3 ? 1 : 0) - (b >= 2 && b <= 4 ? 1 : 0));
        week.append(h('span', { class: `wcell lv${Math.max(0, lv)}` }));
      }
    }
  }
  // fights
  {
    const rows = [['Pebble_', 14, 3], ['Saltwater', 9, 6], ['kestrel', 4, 11]];
    const most = 14;
    $('m-kd').append(
      h('thead', {}, h('tr', {}, h('th', { text: 'Player' }), h('th', { class: 'num', text: 'Kills' }), h('th', { class: 'num', text: 'Deaths' }))),
      h('tbody', {}, ...rows.map(([n, k, d]) => h('tr', {},
        h('td', {}, h('div', { class: 'pname' }, head(byName.get(n), 24), nameLink(n)), h('div', { class: 'bar', style: `width:${(k / most) * 100}%` })),
        h('td', { class: 'num', text: String(k) }),
        h('td', { class: 'num', text: String(d) })))));
  }
  $('m-pass').textContent = '••••••••';


  /* ---------------- the sky: the game's clouds, sun and moon, by day and by night ----------------
     Blocky clouds cut from the game's own cloud texture drift with the wind and wrap round. In the light
     theme it's day: a blue sky and the game's sun. In the dark theme it's night: the moon, stars, and a
     light rain from some of the clouds. Switching themes turns the sky half way round: the sun sets as
     the moon rises, the wind races, the clouds darken, the stars come out and the rain starts. The
     pointer only tilts the view a little. Drawn only while the hero is on screen. */
  {
    const hero = $('hero');
    const sky = hero.querySelector('.home-sky');
    const cv = $('sky');
    const ctx = cv.getContext('2d');
    const still = reduced();
    const r = rng('sky');
    const C = 15; // one cloud cell on screen at the nearest layer, in CSS pixels
    // three depths, each in its own band of sky (top = farthest), so clouds rarely cross one another
    const LAYERS = [
      { k: 0.6, speed: 6, alpha: 0.65, band: [0.03, 0.12] },
      { k: 0.85, speed: 10, alpha: 0.82, band: [0.22, 0.32] },
      { k: 1.1, speed: 15, alpha: 0.95, band: [0.47, 0.58] },
    ];
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

    // The game's cloud layer (textures/environment/clouds.png): each opaque pixel is one 12×12-block cell
    // of cloud. A sky cloud is one clump cut from it, a connected patch that fills most of its box, so
    // it's the game's own blocky shape but plump rather than stringy. Until the texture arrives (or if
    // it can't), a rounded blob of blocks stands in. -> { cells: [[x, y]…], cols, rows }
    let map = null;
    function shape(maxCols, maxRows) {
      if (map) {
        for (let tries = 0; tries < 120; tries++) {
          const x0 = Math.floor(r() * map.w), y0 = Math.floor(r() * map.h);
          if (!map.on(x0, y0)) continue;
          const seen = new Set([`${x0},${y0}`]), todo = [[x0, y0]], cells = [];
          while (todo.length && cells.length < 600) {
            const [x, y] = todo.pop();
            cells.push([x, y]);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
              if (seen.has(k) || Math.abs(nx - x0) > maxCols / 2 || Math.abs(ny - y0) > maxRows / 2 || !map.on(nx, ny)) continue;
              seen.add(k);
              todo.push([nx, ny]);
            }
          }
          const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
          const minX = Math.min(...xs), minY = Math.min(...ys), cols = Math.max(...xs) - minX + 1, rows = Math.max(...ys) - minY + 1;
          if (cells.length >= 28 && cols >= 8 && cells.length / (cols * rows) >= 0.58) {
            return { cells: cells.map(([x, y]) => [x - minX, y - minY]), cols, rows };
          }
        }
      }
      const cols = Math.round(maxCols * 0.7), rows = Math.round(maxRows * 0.6), cells = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const dx = (x + 0.5 - cols / 2) / (cols / 2), dy = (y + 0.5 - rows / 2) / (rows / 2);
        if (dx * dx + dy * dy < 0.85 + r() * 0.2) cells.push([x, y]);
      }
      return { cells, cols, rows };
    }

    // Drawn as the game draws its clouds: a slab seen from a little above, each cell's flat top and,
    // under the cells with nothing in front of them, the slab's front face, darker (the game shades
    // tops 1.0 and sides 0.9 and 0.8). One picture for the day and one for the night, cross-faded.
    const SHADES = { day: ['#ffffff', '#dde3ec', '#cfd6e2'], night: ['#bcc5da', '#8f99b4', '#7f89a4'] };
    function paint(c, [top, front, side]) {
      const b = c.cw, d = c.cd, f = c.cf;
      const s = document.createElement('canvas');
      s.width = Math.ceil(c.w * dpr);
      s.height = Math.ceil(c.h * dpr);
      const g = s.getContext('2d');
      g.scale(dpr, dpr);
      const has = new Set(c.cells.map(([x, y]) => `${x},${y}`));
      for (const [x, y] of [...c.cells].sort((a, z) => a[1] - z[1])) { // back to front
        g.fillStyle = top;
        g.fillRect(x * b, y * d, b, d + 0.5);
        if (!has.has(`${x},${y + 1}`)) {
          g.fillStyle = front;
          g.fillRect(x * b, (y + 1) * d, b, f);
          // the left end of a run of front face shows a sliver of the side
          if (!has.has(`${x - 1},${y}`)) { g.fillStyle = side; g.fillRect(x * b, (y + 1) * d, Math.max(2, Math.round(b * 0.18)), f); }
        }
      }
      return s;
    }
    function sprite(c) {
      c.cw = Math.max(5, Math.round(C * c.layer.k)); // a cell's width
      c.cd = Math.max(3, Math.round(c.cw * 0.55)); // its depth on screen, seen at a slant
      c.cf = Math.max(3, Math.round(c.cw * 0.7)); // the slab's thickness
      c.w = c.cols * c.cw;
      c.h = c.rows * c.cd + c.cf;
      c.day = paint(c, SHADES.day);
      c.night = paint(c, SHADES.night);
    }
    const clouds = [];
    function makeCloud(layer, x, y) {
      const L = LAYERS[layer];
      // about half the clouds rain at night
      const c = { layer: L, li: layer, x, y, ...shape(26, 14), rainy: r() < 0.55 };
      sprite(c);
      clouds.push(c);
      clouds.sort((a, b) => a.li - b.li);
    }
    const drops = [], stars = [];

    function resize() {
      const rect = cv.getBoundingClientRect();
      dpr = Math.min(devicePixelRatio || 1, 2);
      const first = !W;
      W = rect.width; H = rect.height;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      if (first) {
        // per layer, a few clouds evenly spaced along a loop a bit longer than the sky, so they keep
        // their spacing as they drift (all in a layer move at the same speed)
        LAYERS.forEach((L, li) => {
          const n = Math.max(2, Math.round(W / (li === 2 ? 520 : 380)));
          L.track = W + 420;
          for (let i = 0; i < n; i++) {
            const y = H * (L.band[0] + r() * (L.band[1] - L.band[0]));
            makeCloud(li, (i / n) * L.track - 200 + r() * (L.track / n) * 0.3, y);
          }
        });
        for (let i = 0; i < 90; i++) stars.push({ x: r(), y: r() * 0.7, s: r() < 0.2 ? 2 : 1, p: r() * 6 });
      } else { clouds.forEach(sprite); LAYERS.forEach((L) => { L.track = W + 420; }); }
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

    // the pointer only tilts the view a little (nearer things shift more); it never moves the clouds
    const ptr = { x: 0.5, y: 0.5, in: false };
    const par = { x: 0, y: 0 };
    const offset = (k) => [par.x * k * -14, par.y * k * -6];
    addEventListener('pointermove', (e) => {
      const b = hero.getBoundingClientRect();
      ptr.in = e.clientY >= b.top && e.clientY <= b.bottom;
      if (ptr.in) { ptr.x = (e.clientX - b.left) / b.width; ptr.y = (e.clientY - b.top) / b.height; }
    }, { passive: true });

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
      const [sx, sy] = offset(0.3);
      const R = Math.max(W * 0.5, H * 1.15), UP = 0.55; // the wheel, and how far right of the top "up" is
      const cx = W / 2, cy = H * 0.22 + R * Math.cos(UP);
      const at = (a) => [cx + R * Math.sin(a) + sx, cy - R * Math.cos(a) + sy];
      const [sunX, sunY] = at(UP + turn), [moonX, moonY] = at(UP + turn + Math.PI);
      if (sunY < H + big) body(sun, sunX, sunY, big * 1.15, 'rgba(255,240,170,0.45)', 1 - m * 0.3);
      if (moonY < H + big) body(moon, moonX, moonY, big, 'rgba(190,205,255,0.28)', 0.7 + m * 0.3);

      for (const c of clouds) {
        c.x += (still ? 0 : c.layer.speed * rush) * dt;
        if (c.x > W + 210) c.x -= c.layer.track; // round the loop, keeping the layer's spacing
        const [ox, oy] = offset(c.layer.k);
        const x = Math.round(c.x + ox), y = Math.round(c.y + oy);
        if (m < 1) { ctx.globalAlpha = c.layer.alpha; ctx.drawImage(c.day, x, y, c.w, c.h); }
        if (m > 0) { ctx.globalAlpha = c.layer.alpha * m; ctx.drawImage(c.night, x, y, c.w, c.h); }
        // a light rain at night
        if (c.rainy && !still && r() < m * dt * 22 * c.layer.k) {
          const [cx] = c.cells[Math.floor(r() * c.cells.length)];
          drops.push({ x: x + cx * c.cw + r() * c.cw, y: y + c.h - 4, vy: 360 + r() * 140, k: c.layer.k });
        }
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

    // the clouds wait (briefly) for the game's cloud texture, so they're cut from it from the start
    const tex = new Image();
    const start = () => { if (!W) resize(); wake(); };
    tex.onload = () => {
      const c = document.createElement('canvas');
      c.width = tex.width; c.height = tex.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(tex, 0, 0);
      const px = g.getImageData(0, 0, tex.width, tex.height).data;
      const wrap = (v, n) => ((v % n) + n) % n; // the texture tiles, as the game's sky does
      map = { w: tex.width, h: tex.height, on: (x, y) => px[(wrap(y, tex.height) * tex.width + wrap(x, tex.width)) * 4 + 3] > 0 };
      start();
    };
    tex.onerror = start;
    tex.src = '/api/mc/textures/environment/clouds.png';
    setTimeout(start, 1500);
  }
})();
