// The Advancements add-on: a page of its own for the whole server's advancements.
//
// Made for all-advancements runs, where a server (or each of its teams) is trying to earn every
// advancement in the game between them: an advancement counts as earned once anyone has it. With this
// add-on switched on for a server (src/addons.js, Admin → Server), its dashboard gets an Advancements tab:
//   - how far along the run is: earned out of all of them, how many are left, the latest one
//   - the same for each of the game's tabs (Minecraft, Nether, The End, Adventure, Husbandry)
//   - with teams, each team's own count side by side, and the whole page for one team at a time
//   - every advancement: who earned it first and who else has it, or, while it's still left, who's closest
//   - who has earned the most, and how many of those they were first to
//   - the latest ones, as they come in
// Everything is counted for the whole server unless a team is picked.
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
    data: null, // the last answer: { tree, ts, players }
    key: '', // …as text, to tell whether a refresh brought anything new
    scope: 'all', // everyone, or a team's id
    tab: 'all', // every tab of the game's, or one (its root's id)
    list: 'left',
    more: false, // the whole list rather than its first rows
  };
  const ROWS = 40;

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
        holders.forEach((h, i) => { if (h.at) recent.push({ a, p: h.p, at: h.at, first: i === 0 }); });
        rows.push({ a, tab, holders, close: holders.length ? null : close });
      }
    }
    recent.sort((x, y) => y.at - x.at);
    const people = players.map((p) => {
      const ats = Object.values(p.done);
      return { p, n: ats.length, firsts: firsts.get(p) || 0, last: Math.max(0, ...ats) };
    }).filter((x) => x.n).sort((x, y) => y.n - x.n || y.firsts - x.firsts || x.p.name.localeCompare(y.p.name));
    return { tabs, rows, people, recent };
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

  // An advancement as the game draws it: its frame (gold once earned) around its icon.
  function badge(a, done) {
    const b = el('span', { class: 'av-badge' },
      el('img', { class: 'av-frame', alt: '', src: advTexture(`gui/sprites/advancements/${a.frame}_frame_${done ? 'obtained' : 'unobtained'}`) }));
    const icon = el('img', { class: 'av-icon', alt: '' });
    setItemIcon(icon, a.icon);
    b.append(icon);
    return b;
  }
  // …and its tooltip, as the game's advancements screen shows it.
  function tipFor(node, row) {
    const { a, holders } = row;
    const body = () => {
      const kind = a.frame === 'task' ? '' : `${a.frame === 'goal' ? 'Goal' : 'Challenge'} · `;
      const state = holders.length ? `Earned by ${holders.length}` : row.close ? `Closest: ${row.close.n}/${row.close.of}` : 'Not earned yet';
      return [{ adv: true, node: el('div', { class: `adv-tip${holders.length ? ' done' : ''} adv-${a.frame}` },
        el('div', { class: 'adv-tip-title', text: a.title }),
        el('div', { class: 'adv-tip-body' },
          a.desc ? el('div', { class: 'adv-tip-desc', text: a.desc }) : null,
          el('div', { class: 'adv-tip-when', text: kind + state }))) }];
    };
    const show = (e) => showTip(e.clientX, e.clientY, body());
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
      tile('Latest', latest ? ago(latest.at) : '–', latest ? `${latest.a.title} · ${shownName(latest.p.name)}` : 'nothing earned yet', true),
      tile('Players', String(c.people.length), c.people.length === 1 ? 'has earned one' : 'have earned one'));

    /* progress: the whole run, then each of the game's tabs (click one to see just its advancements) */
    const tabRow = (id, name, icon, rows) => {
      const n = earnedIn(rows);
      const b = el('button', { type: 'button', class: 'av-prog', 'aria-pressed': String(st.tab === id) },
        el('span', { class: 'av-prog-name' }, icon, el('span', { text: name })),
        meter(n, rows.length, team?.id),
        el('span', { class: 'av-prog-n', text: `${n}/${rows.length}` }));
      b.addEventListener('click', pick(() => { st.tab = st.tab === id ? 'all' : id; }));
      return b;
    };
    const tabIcon = (a) => { const i = el('img', { class: 'adv-tab-icon', alt: '', width: 16, height: 16 }); setItemIcon(i, a.icon); return i; };
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
      tipFor(b, r);
      let state;
      if (holders.length) {
        const first = holders[0];
        state = el('div', { class: 'av-state' },
          el('div', { class: 'av-first' }, person(first.p, 18), first.at ? el('span', { class: 'muted', text: when(first.at) }) : null),
          holders.length > 1 ? heads(holders.slice(1)) : null);
      } else if (close) {
        state = el('div', { class: 'av-state' },
          el('div', { class: 'av-first' }, person(close.p, 18), el('span', { class: 'av-close-n', text: `${close.n}/${close.of}` })),
          meter(close.n, close.of, team?.id));
      } else state = el('div', { class: 'av-state muted', text: 'Not started' });
      line.append(b, el('div', { class: 'av-text' },
        el('div', { class: 'av-title' }, el('span', { text: a.title }),
          a.frame === 'task' ? null : el('span', { class: `av-kind av-${a.frame}`, text: a.frame === 'goal' ? 'Goal' : 'Challenge' })),
        a.desc ? el('div', { class: 'av-desc', text: a.desc }) : null), state);
      return line;
    };
    const cut = st.more ? shown : shown.slice(0, ROWS);
    const listCard = el('section', { class: 'card' },
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
    const playersCard = el('section', { class: 'card', style: '--span:4' },
      el('div', { class: 'card-head' }, el('div', { class: 'card-title card-title-stacked' }, el('h2', { text: 'Players' }),
        el('span', { class: 'card-sub', text: 'First: the ones they earned before anyone else' }))),
      c.people.length
        ? el('table', {}, el('thead', {}, el('tr', {}, el('th', {}), el('th', { text: 'Player' }), el('th', { class: 'num', text: 'Earned' }),
          el('th', { class: 'num', text: 'First' }), el('th', { class: 'num hide-sm', text: 'Latest' }))), tbody)
        : el('div', { class: 'empty', text: 'Nobody has earned one yet.' }));

    /* the latest */
    const recentCard = el('section', { class: 'card', style: '--span:2' },
      el('div', { class: 'card-head' }, el('div', { class: 'card-title card-title-stacked' }, el('h2', { text: 'Recent' }),
        el('span', { class: 'card-sub', text: 'New: nobody had it before' }))),
      c.recent.length
        ? el('ul', { class: 'av-recent' }, ...c.recent.slice(0, 12).map((r) => {
          const row = { a: r.a, holders: [r], close: null };
          const b = badge(r.a, true);
          tipFor(b, row);
          return el('li', {}, b, el('div', { class: 'av-text' },
            el('div', { class: 'av-title' }, el('span', { text: r.a.title }), r.first ? el('span', { class: 'av-kind av-new', text: 'New' }) : null),
            el('div', { class: 'av-desc' }, person(r.p, 14), el('span', { text: ` · ${ago(r.at)}` }))));
        }))
        : el('div', { class: 'empty', text: 'Nothing earned yet.' }));

    root.replaceChildren(bar, tiles,
      el('div', { class: 'lay av-lay' }, progress, race, listCard, playersCard, recentCard));
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
    st.data = { tree: Array.isArray(data.tree) ? data.tree : [], ts: data.ts || null, players: Array.isArray(data.players) ? data.players : [] };
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
