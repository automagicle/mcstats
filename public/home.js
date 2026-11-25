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
  }, 9000);

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
  for (const n of FEATURED) {
    const p = byName.get(n);
    pick.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', 'data-name': n, onclick: () => showPlayer(n, false) }, head(p, 24), n));
  }
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
    [17 * 60 + 6, 'Pebble_', 'chat', 'meet at spawn for the raid'],
    [17 * 60 + 7, 'Pebble_', 'chat', 'bring arrows pls'],
    [17 * 60 + 9, 'minty', 'chat', 'omw'],
    [17 * 60 + 31, 'oakleaf', 'death', 'tried to swim in lava'],
    [17 * 60 + 32, 'dandelion', 'chat', 'rip oak'],
    [17 * 60 + 32, 'oakleaf', 'chat', 'my whole inventory 😭'],
    [18 * 60 + 30, 'oakleaf', 'leave', 'left the game'],
    [19 * 60 + 40, 'kestrel', 'death', 'was slain by Pebble_'],
    [19 * 60 + 41, 'kestrel', 'chat', 'that was an accident right'],
    [19 * 60 + 41, 'Pebble_', 'chat', 'absolutely'],
    [20 * 60 + 12, 'Saltwater', 'join', 'joined the game'],
    [20 * 60 + 18, 'minty', 'advancement', 'has made the advancement [We Need to Go Deeper]'],
    [20 * 60 + 19, 'Saltwater', 'chat', 'portal is next to the big oak btw'],
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
    const adv = /^(.*)\[(.+)\]$/.exec(m.text);
    if (adv) body.append(adv[1], h('span', { class: 'home-adv', text: `[${adv[2]}]` }));
    else body.append(m.text);
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
    log.scrollTop = log.scrollHeight;
  }
  function addSys(kind, name, text) { add({ kind, name, text }); }
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
  const REPLIES = [
    'wait you can type from the website??',
    'hiii',
    'who is that lol',
    'come online we need help with the farm',
    'saw that in game, works!',
  ];
  let said = 0;
  $('c-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    add({ kind: 'chat', name: 'You', you: true, text });
    input.value = '';
    send.disabled = true;
    const who = [...online][said % online.size] || 'Pebble_';
    const reply = /\?$/.test(text) ? 'no idea tbh' : /^(hi|hey|hello|yo)\b/i.test(text) ? `hey! o/` : REPLIES[said % REPLIES.length];
    said++;
    setTimeout(() => add({ kind: 'chat', name: who, text: reply }), 1300);
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

  /* ---------------- the hills behind the hero window: blocks, trees and clouds, painted once per size ---------------- */

  {
    const cv = $('land');
    const shot = cv.parentElement;
    const B = 24; // a block on screen
    const draw = () => {
      const cols = Math.ceil(shot.clientWidth / B) + 1;
      const rows = Math.ceil(shot.clientHeight / B) + 1;
      cv.width = cols * 8;
      cv.height = rows * 8;
      cv.style.width = `${cols * B}px`;
      cv.style.height = `${rows * B}px`;
      const ctx = cv.getContext('2d');
      const r = rng('hills');
      const pickc = (list) => list[Math.floor(r() * list.length)];
      const block = (bx, by, top) => {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const grass = top && y < 2 + ((x * 7 + bx) % 3 === 0 ? 1 : 0);
          ctx.fillStyle = by >= rows - 2 ? pickc(['#7c7c7c', '#707070', '#868686'])
            : grass ? pickc(['#5c9e3f', '#68ac48', '#559238']) : pickc(['#86603d', '#7a5534', '#946c47', '#6c4a2c']);
          ctx.fillRect(bx * 8 + x, by * 8 + y, 1, 1);
        }
      };
      const leaves = (bx, by) => {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          if (r() < 0.1) continue;
          ctx.fillStyle = pickc(['#3c7a2a', '#4a8f34', '#336b23']);
          ctx.fillRect(bx * 8 + x, by * 8 + y, 1, 1);
        }
      };
      const log = (bx, by) => {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          ctx.fillStyle = x % 4 === 0 ? '#4e3a22' : pickc(['#6b5132', '#5e4629']);
          ctx.fillRect(bx * 8 + x, by * 8 + y, 1, 1);
        }
      };
      // ground height per column: gentle hills, taller toward the edges where the window doesn't cover them
      let hgt = 3;
      for (let c = 0; c < cols; c++) {
        const edge = Math.min(c, cols - 1 - c) / cols;
        const want = Math.round(3 + (edge < 0.12 ? 4 : 1) + r() * 2);
        hgt += Math.sign(want - hgt) * (r() < 0.6 ? 1 : 0);
        hgt = Math.max(2, Math.min(rows - 2, hgt));
        for (let k = 0; k < hgt; k++) block(c, rows - 1 - k, k === hgt - 1);
        if (r() < 0.12 && c > 1 && c < cols - 2) {
          const top = rows - hgt;
          for (let k = 1; k <= 3; k++) log(c, top - k);
          for (let dx = -1; dx <= 1; dx++) for (let dy = 4; dy <= 5; dy++) leaves(c + dx, top - dy);
          leaves(c, top - 6);
        }
      }
      // clouds
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      for (let i = 0; i < Math.ceil(cols / 10); i++) {
        const x = Math.floor(r() * cols * 8), y = Math.floor(r() * 3 * 8) + 4, w = 24 + Math.floor(r() * 40);
        ctx.fillRect(x, y, w, 6);
        ctx.fillRect(x + 8, y - 4, w - 20, 4);
      }
    };
    let t = 0;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(draw, 80); }).observe(shot);
    draw();
  }
})();
