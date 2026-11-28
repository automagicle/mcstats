// The Advancements add-on: a page of its own for the whole server's advancements.
//
// Made for all-advancements runs, where a server (or each of its teams) is trying to earn every
// advancement in the game between them: an advancement counts as earned once anyone has it. With this
// add-on switched on for a server (src/addons.js, Admin → Server), its dashboard gets an Advancements tab:
//   - how far along the run is: earned out of all of them, how many are left, the latest one
//   - the game's advancements screen for everyone at once: an advancement lights up once anyone has it,
//     with a bar under it for how many of the players do
//   - the same for each of the game's tabs (Minecraft, Nether, The End, Adventure, Husbandry)
//   - with teams, each team's own count side by side, and the whole page for one team at a time
//   - every advancement: who earned it first and who else has it, or, while it's still left, who's closest
//   - who has earned the most, and how many of those they were first to
//   - the latest ones, as they come in
// Everything is counted for the whole server unless a team is picked.
//
// On some servers everyone gets an advancement the moment anyone earns it, so who earned it means nothing.
// Their admins say so on Admin → Server ("Advancements are shared", this add-on's option), and the page
// then leaves players out: no names, no first-to-earn, no bars for how many have it, no Players list.
//
// The data is what the server mod already reports for the tree on each player's page
// (GET /api/advancements/summary, src/advancements.js); the counting is done here.
//
// Files here:
//   addon.js     this: registers the page with the dashboard (public/app.js, "add-ons")
//   addon.css    the page's styles
//
// No other server's page loads any of this.
(() => {
  // the dashboard's own helpers, handed over by setup()
  let el, recall, remember, ago, rosterOf, api, fmt, headImg, shownName, teamName, playerLink, showTip, hideTip,
    setItemIcon, advTexture, rosterLoad, activityTeams, activityTeam;

  const LISTS = [['left', 'Left'], ['earned', 'Earned'], ['all', 'All']];
  // the game's own tabs first, in the game's order; then any a data pack adds
  const ORDER = ['story/root', 'nether/root', 'end/root', 'adventure/root', 'husbandry/root'];
  const st = {
    data: null, // the last answer: { tree, ts, players, shared }
    key: '', // …as text, to tell whether a refresh brought anything new
    scope: 'all', // everyone, or a team's id
    tab: 'all', // the list: every tab of the game's, or one (its root's id)
    treeTab: null, // the tab the tree shows
    drawn: '', // which tree is on screen, to keep its place when it's drawn again
    list: 'left',
    more: false, // the whole list rather than its first rows
  };
  const ROWS = 40;
  // The tree, as on a player's page (public/app.js, "a player's advancements"): twice the game's size, a
  // 26-pixel frame every 28 pixels across and 27 down.
  const TREE = { scale: 2, dx: 28, dy: 27, box: 26, pad: 9 };
  const treeView = { view: null, tree: null };

  const teamOf = (name) => activityTeam(rosterOf(name)?.team);
  const shownTeams = () => (st.data ? activityTeams().filter((t) => st.data.players.some((p) => teamOf(p.name) === t.id)) : []);
  const when = (ts) => fmt(ts, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // The game's tabs: [{ id, root, list }], each advancement under the root it hangs from.
  function tabsOf(tree) {
    const byId = new Map(tree.map((a) => [a.id, a]));
    const rootOf = (a) => { let r = a; for (let i = 0; i < 64 && r.parent && byId.has(r.parent); i++) r = byId.get(r.parent); return r; };
    const tabs = new Map();
    for (const a of tree) {
      const r = rootOf(a);
      if (!tabs.has(r.id)) tabs.set(r.id, { id: r.id, root: r, list: [] });
      tabs.get(r.id).list.push(a);
    }
    const rank = (id) => (ORDER.findIndex((o) => id.endsWith(o)) + 1 || ORDER.length + 1);
    return [...tabs.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  }

  // Everything the page shows, counted for some of the players (everyone, or one team):
  //   rows   one per advancement: { a, tab, holders: [{ p, at }] first to earn it first, close: { p, n, of } | null }
  //   people one per player: { p, n, firsts, last }
  //   recent the latest ones earned: [{ a, p, at, first }]
  function count(players) {
    const tabs = tabsOf(st.data.tree);
    const rows = [];
    const firsts = new Map();
    const recent = [];
    for (const tab of tabs) {
      for (const a of tab.list) {
        const holders = [];
        let close = null;
        for (const p of players) {
          if (a.id in p.done) holders.push({ p, at: p.done[a.id] });
          else {
            const part = p.part?.[a.id];
            if (part && part.of > 1 && (!close || part.n / part.of > close.n / close.of)) close = { p, n: part.n, of: part.of };
          }
        }
        // a time of 0 is one the game didn't keep: it goes after the ones that are known
        holders.sort((x, y) => (x.at || Infinity) - (y.at || Infinity));
        if (holders.length) firsts.set(holders[0].p, (firsts.get(holders[0].p) || 0) + 1);
        // shared: everyone got it at the same moment, so it's one thing that happened, not one per player
        holders.forEach((h, i) => { if (h.at && (i === 0 || !st.data.shared)) recent.push({ a, p: h.p, at: h.at, first: i === 0 }); });
        rows.push({ a, tab, holders, close: holders.length ? null : close });
      }
    }
    recent.sort((x, y) => y.at - x.at);
    const people = players.map((p) => {
      const ats = Object.values(p.done);
      return { p, n: ats.length, firsts: firsts.get(p) || 0, last: Math.max(0, ...ats) };
    }).filter((x) => x.n).sort((x, y) => y.n - x.n || y.firsts - x.firsts || x.p.name.localeCompare(y.p.name));
    return { tabs, rows, people, recent, players: players.length };
  }
  const earnedIn = (rows) => rows.filter((r) => r.holders.length).length;

  /* ---------- pieces ---------- */

  const meter = (n, of, team) => el('div', { class: `av-meter${team ? ` team-${team}` : ''}`, role: 'img', 'aria-label': `${n} of ${of}` },
    el('i', { style: `width:${of ? (n / of) * 100 : 0}%` }));
  const tile = (label, value, sub, small) => el('div', { class: 'tile' },
    el('div', { class: 'tile-label', text: label }),
    el('div', { class: `tile-value${small ? ' tile-value-sm' : ''}`, text: value }),
    el('div', { class: 'tile-sub', text: sub }));
  const person = (p, size = 22) => el('span', { class: 'av-who' }, headImg(p.name, size, { width: size, height: size }),
    teamName(playerLink(el('a', { text: shownName(p.name) }), p.uuid, p.name), p.name));

  const tabIcon = (a) => { const i = el('img', { class: 'adv-tab-icon', alt: '', width: 16, height: 16 }); setItemIcon(i, a.icon); return i; };
  // An advancement as the game draws it: its frame (gold once earned) around its icon.
  function badge(a, done) {
    const b = el('span', { class: 'av-badge' },
      el('img', { class: 'av-frame', alt: '', src: advTexture(`gui/sprites/advancements/${a.frame}_frame_${done ? 'obtained' : 'unobtained'}`) }));
    const icon = el('img', { class: 'av-icon', alt: '' });
    setItemIcon(icon, a.icon);
    b.append(icon);
    return b;
  }
  // …and its tooltip, as the game's advancements screen shows it: how many of the players (n) have it and who
  // was first, or who's closest. With shared advancements, only when it was earned or how far along it is.
  function tipRows(row, n) {
    const { a, holders, close } = row;
    const shared = st.data.shared;
    const kind = a.frame === 'task' ? '' : `${a.frame === 'goal' ? 'Goal' : 'Challenge'} · `;
    const first = holders[0];
    const lines = [];
    if (first && shared) lines.push(first.at ? `Earned ${when(first.at)}` : 'Earned');
    else if (first) {
      lines.push(n > 1 ? `Earned by ${holders.length} of ${n} players` : 'Earned');
      lines.push(`First: ${shownName(first.p.name)}${first.at ? ` · ${when(first.at)}` : ''}`);
    } else if (close) lines.push(shared ? `In progress: ${close.n}/${close.of}` : `Closest: ${shownName(close.p.name)}, ${close.n}/${close.of}`);
    else lines.push('Not earned yet');
    return [{ adv: true, node: el('div', { class: `adv-tip${first ? ' done' : ''} adv-${a.frame}` },
      el('div', { class: 'adv-tip-title', text: a.title }),
      el('div', { class: 'adv-tip-body' },
        a.desc ? el('div', { class: 'adv-tip-desc', text: a.desc }) : null,
        ...lines.map((text, i) => el('div', { class: 'adv-tip-when', text: i ? text : kind + text })))) }];
  }
  function tipFor(node, row, n) {
    const show = (e) => showTip(e.clientX, e.clientY, tipRows(row, n));
    node.addEventListener('pointerenter', show);
    node.addEventListener('pointermove', show);
    node.addEventListener('pointerleave', hideTip);
  }
  // A few heads, and the rest as a number; hovering lists them all.
  function heads(holders) {
    const box = el('span', { class: 'av-heads' }, ...holders.slice(0, 5).map((h) => headImg(h.p.name, 18, { width: 18, height: 18 })));
    if (holders.length > 5) box.append(el('span', { class: 'av-more', text: `+${holders.length - 5}` }));
    const show = (e) => showTip(e.clientX, e.clientY, [{ label: `Earned by ${holders.length}` }, { players: holders.map((h) => h.p.name) }]);
    box.addEventListener('pointerenter', show);
    box.addEventListener('pointermove', show);
    box.addEventListener('pointerleave', hideTip);
    return box;
  }

  /* ---------- the tree: the game's advancements screen, for everyone at once ---------- */

  // One of the game's tabs, laid out as the game does. An advancement is lit once anyone (of the n players
  // counted) has it; the bar under a lit one is how many of them do. The view is kept between drawings, so
  // a refresh leaves it where it was scrolled to.
  function drawTree(tab, rows, n, team) {
    if (!treeView.view) {
      const tree = el('div', { class: 'adv-tree' });
      const view = el('div', { class: 'adv-view', tabindex: '-1' }, tree);
      Object.assign(treeView, { view, tree });
      // dragging with a mouse moves it around, like in the game (touch already scrolls it)
      let drag = null;
      view.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && !e.button) drag = { x: e.clientX, y: e.clientY, left: view.scrollLeft, top: view.scrollTop, moved: false };
      });
      addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        drag.moved = true;
        view.classList.add('dragging');
        hideTip();
        view.scrollLeft = drag.left - dx;
        view.scrollTop = drag.top - dy;
      });
      const end = () => { drag = null; view.classList.remove('dragging'); };
      addEventListener('pointerup', end);
      addEventListener('pointercancel', end);
    }
    const { view, tree } = treeView;
    const { scale: S, dx, dy, box, pad } = TREE;
    const list = rows.map((r) => r.a);
    const byId = new Map(rows.map((r) => [r.a.id, r]));
    const minX = Math.min(...list.map((a) => a.x)), minY = Math.min(...list.map((a) => a.y));
    const at = (a) => [Math.floor((a.x - minX) * dx) + pad, Math.floor((a.y - minY) * dy) + pad]; // in game pixels
    const w = Math.max(...list.map((a) => at(a)[0])) + box + pad, h = Math.max(...list.map((a) => at(a)[1])) + box + pad;
    tree.style.width = `${w * S}px`;
    tree.style.height = `${h * S}px`;
    view.style.backgroundImage = tab.root.bg ? `url("${advTexture(tab.root.bg)}")` : '';

    // the lines: from the parent's middle to just past its frame, up or down, then to the child's middle
    const NS = 'http://www.w3.org/2000/svg';
    const lines = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ class: 'adv-lines', width: w * S, height: h * S, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' })) lines.setAttribute(k, v);
    let d = '';
    for (const a of list) {
      const p = a.parent && byId.get(a.parent)?.a;
      if (!p) continue;
      const [px, py] = at(p), [cx, cy] = at(a);
      d += `M${px + 13} ${py + 13.5}H${px + box + 4.5}V${cy + 13.5}H${cx + 13}`;
    }
    for (const cls of ['adv-line-edge', 'adv-line']) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('class', cls);
      path.setAttribute('d', d);
      lines.append(path);
    }

    const nodes = rows.map((r) => {
      const { a, holders } = r;
      const [x, y] = at(a);
      const done = holders.length > 0;
      const state = !done ? 'Not earned' : st.data.shared || n < 2 ? 'Earned' : `Earned by ${holders.length} of ${n} players`;
      const node = el('button', { type: 'button', class: `adv-node${done ? ' done' : ''}`, style: `left:${x * S}px;top:${y * S}px`, 'aria-label': `${a.title}: ${a.desc}. ${state}` },
        el('img', { class: 'adv-frame', alt: '', src: advTexture(`gui/sprites/advancements/${a.frame}_frame_${done ? 'obtained' : 'unobtained'}`) }));
      const icon = el('img', { class: 'adv-icon', alt: '' });
      setItemIcon(icon, a.icon);
      node.append(icon);
      // how many of the players have it (not when it's shared, or there's only one of them: it's all or none)
      if (done && !st.data.shared && n > 1) {
        node.append(el('span', { class: `av-share${team ? ` team-${team}` : ''}${holders.length === n ? ' full' : ''}` }, el('i', { style: `width:${(holders.length / n) * 100}%` })));
      }
      tipFor(node, r, n);
      node.addEventListener('focus', () => {
        const b = node.getBoundingClientRect();
        showTip(b.right - 14, b.top + 6, tipRows(r, n));
      });
      node.addEventListener('blur', hideTip);
      return node;
    });
    const key = `${st.scope}/${tab.id}`;
    const keep = st.drawn === key && view.isConnected ? [view.scrollLeft, view.scrollTop] : null;
    st.drawn = key;
    tree.replaceChildren(lines, ...nodes);
    // once it's on the page: where it was, or like the game, on its root: at the left, halfway down
    return () => (keep ? view.scrollTo(...keep) : view.scrollTo(0, Math.max(0, (at(tab.root)[1] + box / 2) * S - view.clientHeight / 2)));
  }

  /* ---------- the page ---------- */

  function render(root) {
    hideTip();
    const data = st.data;
    if (!data) return;
    const title = el('h1', { class: 'page-title', text: 'Advancements' });
    if (!data.tree.length) {
      root.replaceChildren(el('div', { class: 'combat-bar' }, el('div', { class: 'card-title' }, title)),
        el('div', { class: 'card' }, el('div', { class: 'empty', text: 'No advancements yet. They show here once the server runs the mcstats mod and someone has played.' })));
      return;
    }
    const teams = shownTeams();
    if (st.scope !== 'all' && !teams.some((t) => t.id === st.scope)) st.scope = 'all';
    const team = teams.find((t) => t.id === st.scope) || null;
    const c = count(team ? data.players.filter((p) => teamOf(p.name) === team.id) : data.players);
    if (st.tab !== 'all' && !c.tabs.some((t) => t.id === st.tab)) st.tab = 'all';
    if (!c.tabs.some((t) => t.id === st.treeTab)) st.treeTab = c.tabs[0].id;
    const shared = data.shared;
    const total = c.rows.length, got = earnedIn(c.rows), left = total - got;
    const pick = (fn) => () => { fn(); st.more = false; render(root); };

    /* the bar: title, when it was last reported, and whose advancements these are */
    const bar = el('div', { class: 'combat-bar' },
      el('div', { class: 'card-title' }, title,
        el('span', { class: 'card-sub', text: `${team ? team.name : 'the whole server'}${data.ts ? ` · updated ${ago(data.ts)}` : ''}` })));
    if (teams.length) {
      const btn = (v, text, tip) => {
        const b = el('button', { type: 'button', 'aria-pressed': String(v === st.scope), title: tip, text });
        b.addEventListener('click', pick(() => { st.scope = v; remember('avScope', v); }));
        return b;
      };
      bar.append(el('div', { class: 'seg', role: 'group', 'aria-label': 'Whose advancements' },
        btn('all', 'Everyone', 'The whole server together'), ...teams.map((t) => btn(t.id, t.short, `${t.name} only`))));
    }

    /* the numbers */
    const latest = c.recent.find((r) => r.first);
    const started = c.rows.filter((r) => r.close).length;
    const done = left === 0 && latest;
    const tiles = el('div', { class: 'tiles' },
      tile('Earned', `${got}/${total}`, `${Math.floor((got / total) * 100)}% of all advancements`),
      tile('Left', done ? 'Done' : String(left), done ? `finished ${when(latest.at)}` : left ? `${started} started` : 'every one earned'),
      tile('Latest', latest ? ago(latest.at) : '–', latest ? (shared ? latest.a.title : `${latest.a.title} · ${shownName(latest.p.name)}`) : 'nothing earned yet', true),
      shared
        ? tile('Last 24 hours', String(c.recent.filter((r) => r.first && r.at > Date.now() / 1000 - 86400).length), 'earned')
        : tile('Players', String(c.people.length), c.people.length === 1 ? 'has earned one' : 'have earned one'));

    /* the game's advancements screen, one of its tabs at a time */
    const treeTab = c.tabs.find((t) => t.id === st.treeTab);
    const treeRows = c.rows.filter((r) => r.tab === treeTab);
    const placeTree = drawTree(treeTab, treeRows, c.players, team?.id);
    const treeCard = el('section', { class: 'card adv-card av-tree-card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, el('h2', { text: 'Advancements' }),
          el('span', { class: 'card-sub', text: shared || c.players < 2 ? 'lit once earned' : 'lit once anyone has it · the bar is how many players do' })),
        el('div', { class: 'adv-tabs', role: 'tablist', 'aria-label': 'Advancement tabs' }, ...c.tabs.map((t) => {
          const rows = c.rows.filter((r) => r.tab === t);
          const b = el('button', { type: 'button', role: 'tab', 'aria-selected': String(t === treeTab), title: t.root.desc || null },
            tabIcon(t.root), el('span', { text: t.root.title }), el('span', { class: 'adv-tab-n', text: `${earnedIn(rows)}/${rows.length}` }));
          b.addEventListener('click', () => { if (st.treeTab !== t.id) { st.treeTab = t.id; render(root); } });
          return b;
        }))),
      treeView.view);

    /* progress: the whole run, then each of the game's tabs (click one to see just its advancements) */
    const tabRow = (id, name, icon, rows) => {
      const n = earnedIn(rows);
      const b = el('button', { type: 'button', class: 'av-prog', 'aria-pressed': String(st.tab === id) },
        el('span', { class: 'av-prog-name' }, icon, el('span', { text: name })),
        meter(n, rows.length, team?.id),
        el('span', { class: 'av-prog-n', text: `${n}/${rows.length}` }));
      b.addEventListener('click', pick(() => { st.tab = st.tab === id ? 'all' : id; if (id !== 'all') st.treeTab = id; }));
      return b;
    };
    const progress = el('section', { class: 'card', style: `--span:${teams.length > 1 && !team ? 4 : 6}` },
      el('div', { class: 'card-head' }, el('div', { class: 'card-title' }, el('h2', { text: 'Progress' }),
        el('span', { class: 'card-sub', text: left ? `${left} to go` : 'all done' }))),
      el('div', { class: 'av-progs' },
        tabRow('all', 'All advancements', null, c.rows),
        ...c.tabs.map((t) => tabRow(t.id, t.root.title, tabIcon(t.root), c.rows.filter((r) => r.tab === t)))));

    /* teams, side by side (only while everyone is shown: a team's own page is one click away) */
    let race = null;
    if (teams.length > 1 && !team) {
      race = el('section', { class: 'card', style: '--span:2' },
        el('div', { class: 'card-head' }, el('div', { class: 'card-title' }, el('h2', { text: 'Teams' }), el('span', { class: 'card-sub', text: 'each on its own' }))),
        el('div', { class: 'av-progs' }, ...teams.map((t) => {
          const n = earnedIn(count(data.players.filter((p) => teamOf(p.name) === t.id)).rows);
          const b = el('button', { type: 'button', class: 'av-prog av-prog-team', title: `Show ${t.name} only` },
            el('span', { class: 'av-prog-name' }, el('span', { class: `team-dot team-${t.id}` }), el('span', { class: `team team-${t.id}`, text: t.name })),
            meter(n, total, t.id),
            el('span', { class: 'av-prog-n', text: `${n}/${total}` }));
          b.addEventListener('click', pick(() => { st.scope = t.id; remember('avScope', t.id); }));
          return b;
        })));
    }

    /* every advancement: what's left (and who's closest), what's earned (and who got it first) */
    const inTab = c.rows.filter((r) => st.tab === 'all' || r.tab.id === st.tab);
    const lists = {
      // closest to done first, then as the game orders them
      left: inTab.filter((r) => !r.holders.length).sort((x, y) => (y.close ? y.close.n / y.close.of : -1) - (x.close ? x.close.n / x.close.of : -1)),
      // newest first
      earned: inTab.filter((r) => r.holders.length).sort((x, y) => (y.holders[0].at || 0) - (x.holders[0].at || 0)),
      all: inTab,
    };
    const shown = lists[st.list];
    const listSeg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Which advancements' }, ...LISTS.map(([v, text]) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(v === st.list), text: `${text} ${lists[v].length}` });
      b.addEventListener('click', pick(() => { st.list = v; remember('avList', v); }));
      return b;
    }));
    const tabName = st.tab === 'all' ? null : c.tabs.find((t) => t.id === st.tab).root.title;
    const rowFor = (r) => {
      const { a, holders, close } = r;
      const line = el('li', { class: `av-row${holders.length ? ' done' : ''}` });
      const b = badge(a, holders.length > 0);
      tipFor(b, r, c.players);
      let state;
      if (holders.length) {
        const first = holders[0];
        state = el('div', { class: 'av-state' },
          el('div', { class: 'av-first' }, shared ? null : person(first.p, 18), first.at ? el('span', { class: 'muted', text: when(first.at) }) : shared ? el('span', { class: 'muted', text: 'Earned' }) : null),
          holders.length > 1 && !shared ? heads(holders.slice(1)) : null);
      } else if (close) {
        state = el('div', { class: 'av-state' },
          el('div', { class: 'av-first' }, shared ? null : person(close.p, 18), el('span', { class: 'av-close-n', text: `${close.n}/${close.of}` })),
          meter(close.n, close.of, team?.id));
      } else state = el('div', { class: 'av-state muted', text: 'Not started' });
      line.append(b, el('div', { class: 'av-text' },
        el('div', { class: 'av-title' }, el('span', { text: a.title }),
          a.frame === 'task' ? null : el('span', { class: `av-kind av-${a.frame}`, text: a.frame === 'goal' ? 'Goal' : 'Challenge' })),
        a.desc ? el('div', { class: 'av-desc', text: a.desc }) : null), state);
      return line;
    };
    const cut = st.more ? shown : shown.slice(0, ROWS);
    const listCard = el('section', { class: 'card', style: `--span:${shared ? 4 : 6}` },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-title' }, el('h2', { text: tabName || 'All advancements' }),
          tabName ? (() => { const x = el('button', { type: 'button', class: 'av-clear', text: 'Show every tab' }); x.addEventListener('click', pick(() => { st.tab = 'all'; })); return x; })() : null),
        listSeg),
      shown.length
        ? el('ul', { class: 'av-list' }, ...cut.map(rowFor))
        : el('div', { class: 'empty', text: st.list === 'left' ? 'Nothing left here: every one is earned.' : 'None earned here yet.' }));
    if (shown.length > cut.length) {
      const more = el('button', { type: 'button', class: 'av-all', text: `Show all ${shown.length}` });
      more.addEventListener('click', () => { st.more = true; render(root); });
      listCard.append(more);
    }

    /* who has the most, and how many of them they got first */
    const top = c.people[0]?.n || 1;
    const tbody = el('tbody');
    c.people.slice(0, 25).forEach((x, i) => {
      const t = rosterOf(x.p.name)?.team;
      tbody.append(el('tr', {},
        el('td', { class: 'rank', text: String(i + 1) }),
        el('td', {},
          el('div', { class: 'pname' }, headImg(x.p.name, 22), teamName(playerLink(el('a', { text: shownName(x.p.name) }), x.p.uuid, x.p.name), x.p.name)),
          el('div', { class: `bar${t ? ` team-${t}` : ''}`, style: `width:${Math.max(1, (x.n / top) * 100)}%` })),
        el('td', { class: 'num', text: String(x.n) }),
        el('td', { class: 'num', text: String(x.firsts) }),
        el('td', { class: 'num muted hide-sm', text: x.last ? ago(x.last) : '–' })));
    });
    const playersCard = shared ? null : el('section', { class: 'card', style: '--span:4' },
      el('div', { class: 'card-head' }, el('div', { class: 'card-title card-title-stacked' }, el('h2', { text: 'Players' }),
        el('span', { class: 'card-sub', text: 'First: the ones they earned before anyone else' }))),
      c.people.length
        ? el('table', {}, el('thead', {}, el('tr', {}, el('th', {}), el('th', { text: 'Player' }), el('th', { class: 'num', text: 'Earned' }),
          el('th', { class: 'num', text: 'First' }), el('th', { class: 'num hide-sm', text: 'Latest' }))), tbody)
        : el('div', { class: 'empty', text: 'Nobody has earned one yet.' }));

    /* the latest */
    const recentCard = el('section', { class: 'card', style: '--span:2' },
      el('div', { class: 'card-head' }, el('div', { class: 'card-title card-title-stacked' }, el('h2', { text: 'Recent' }),
        shared ? null : el('span', { class: 'card-sub', text: 'New: nobody had it before' }))),
      c.recent.length
        ? el('ul', { class: 'av-recent' }, ...c.recent.slice(0, 12).map((r) => {
          const b = badge(r.a, true);
          tipFor(b, c.rows.find((x) => x.a === r.a), c.players);
          return el('li', {}, b, el('div', { class: 'av-text' },
            el('div', { class: 'av-title' }, el('span', { text: r.a.title }), r.first && !shared ? el('span', { class: 'av-kind av-new', text: 'New' }) : null),
            shared ? el('div', { class: 'av-desc', text: ago(r.at) }) : el('div', { class: 'av-desc' }, person(r.p, 14), el('span', { text: ` · ${ago(r.at)}` }))));
        }))
        : el('div', { class: 'empty', text: 'Nothing earned yet.' }));

    root.replaceChildren(bar, tiles,
      el('div', { class: 'lay av-lay' }, treeCard, progress, race, listCard, playersCard, recentCard));
    placeTree();
  }

  async function show(root, { refresh = false } = {}) {
    if (!st.data && !refresh) {
      root.replaceChildren(el('div', { class: 'combat-bar' }, el('div', { class: 'card-title' }, el('h1', { class: 'page-title', text: 'Advancements' }))),
        el('div', { class: 'card av-loading' }, el('div', { class: 'empty', text: 'Loading…' })));
    }
    const [data] = await Promise.all([api('/api/advancements/summary'), rosterLoad]);
    const key = JSON.stringify(data);
    if (key === st.key && root.childElementCount && !root.querySelector('.av-loading')) return; // nothing new: leave it as it is
    st.key = key;
    st.data = { tree: Array.isArray(data.tree) ? data.tree : [], ts: data.ts || null, players: Array.isArray(data.players) ? data.players : [], shared: data.shared === true };
    render(root);
  }

  (window.MCS_ADDONS ||= []).push({
    id: 'advancements',
    setup(h) {
      ({ el, recall, remember, ago, rosterOf, api, fmt, headImg, shownName, teamName, playerLink, showTip, hideTip,
        setItemIcon, advTexture, rosterLoad, activityTeams, activityTeam } = h);
      st.scope = recall('avScope') || 'all';
      st.list = LISTS.some(([v]) => v === recall('avList')) ? recall('avList') : 'left';
    },
    page: () => ({ id: 'advancements', title: 'Advancements', show, names: render }),
  });
})();
