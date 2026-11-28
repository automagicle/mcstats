// /site-analytics: the site's own numbers, for its operators (src/siteanalytics.js serves this file to nobody else).
// Everything comes from GET /api/site-analytics/data and is drawn here; the census of the servers is refreshed
// a batch at a time with POST /api/site-analytics/census. Charts are drawn as SVG on the panel, as everywhere
// on the site (DESIGN.md, "Charts"): the accent for the main series, blue for a second one, a dashed line in
// --ink-2 for a baseline, gridlines in --grid and a tooltip on hover.
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const SVG = 'http://www.w3.org/2000/svg';
  const main = $('#sa-main');

  // ---------- small helpers ----------
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'text') e.textContent = v;
      else if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    e.append(...kids.flat(Infinity).filter((x) => x != null && x !== false).map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : x)));
    return e;
  };
  const s = (tag, attrs = {}) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
    return e;
  };
  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(out.error || `Something went wrong (HTTP ${res.status}).`);
      err.field = out.field;
      throw err;
    }
    return out;
  }
  const fmt = (n) => (n == null || Number.isNaN(n) ? '–' : Math.round(n).toLocaleString('en-US'));
  const pct = (n, of) => (of > 0 ? `${Math.round((n / of) * 1000) / 10}%` : '–');
  const plus = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '±0');
  const store = {
    get(k, d) { try { return localStorage.getItem(`sa-${k}`) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`sa-${k}`, v); } catch { /* fine */ } },
  };

  // ---------- days ----------
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const addMonths = (day, n) => { const d = new Date(`${day.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); };
  const weekStart = (day) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return iso(d); };
  const monthStart = (day) => `${day.slice(0, 7)}-01`;
  function daysFrom(from, to) {
    const out = [];
    for (let d = from; d <= to && out.length < 4000; d = addDays(d, 1)) out.push(d);
    return out;
  }
  const dayLabel = (day, long = false) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', long
    ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }
    : { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const monthLabel = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const ago = (ts) => {
    const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  };

  // ---------- theme switch (as on the site's other pages) ----------
  const toggle = $('#theme-toggle');
  if (toggle) {
    const sync = () => toggle.setAttribute('aria-checked', String(document.documentElement.dataset.theme === 'dark'));
    sync();
    toggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch {}
      sync();
      redrawAll();
    });
  }

  // ---------- tooltip ----------
  const tip = h('div', { class: 'tooltip', role: 'status', hidden: true });
  document.body.append(tip);
  function showTip(x, y, content) {
    tip.replaceChildren(...content);
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }
  const hideTip = () => { tip.hidden = true; };
  const tipRow = (label, value, color, kind = 'bar') => h('div', { class: 'sa-tip-row' },
    h('span', {}, color ? h('i', { class: `sa-key ${kind}`, style: kind === 'dash' ? '' : `background:${color}` }) : null, label),
    h('b', { text: value }));

  // ---------- charts ----------
  // spec: { days: [labels], series: [{ label, color, values, kind: 'bar' | 'line' | 'step', dash }], tip(i) → nodes,
  //         height, short, xLabel(day) }. Bars stack in the order given; lines are drawn over them.
  const charts = new Set();
  const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
  // The axis for counts: whole steps of 1, 2 or 5 × 10ⁿ, three to five of them, the top at or above the data.
  function scaleFor(top) {
    if (!(top > 0)) return { max: 4, step: 1 };
    const raw = top / 4;
    const p = 10 ** Math.floor(Math.log10(raw));
    const step = Math.max(1, [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw));
    return { max: Math.max(step, Math.ceil(top / step) * step), step };
  }
  function chart(spec) {
    const box = h('div', { class: `sa-chart${spec.short ? ' short' : ''}` });
    const wrap = h('div', {}, legend(spec.series), box);
    const draw = () => drawChart(box, spec);
    box._draw = draw;
    charts.add(box);
    new ResizeObserver(() => draw()).observe(box);
    return wrap;
  }
  function legend(series) {
    if (series.length < 2) return null;
    return h('div', { class: 'sa-legend' }, series.map((x) => h('span', {},
      h('i', { class: `sa-key${x.dash ? ' dash' : x.kind === 'bar' ? '' : ' line'}`, style: x.dash ? '' : `background:${x.color}` }), x.label)));
  }
  function redrawAll() {
    for (const c of charts) {
      if (!c.isConnected) charts.delete(c);
      else c._draw();
    }
  }
  function drawChart(box, spec) {
    const W = box.clientWidth;
    const H = box.clientHeight;
    if (!W || !H) return;
    const n = spec.days.length;
    const padL = 40, padR = 6, padT = 6, padB = 22;
    const pw = Math.max(10, W - padL - padR), ph = Math.max(10, H - padT - padB);
    const bars = spec.series.filter((x) => x.kind === 'bar');
    const lines = spec.series.filter((x) => x.kind !== 'bar');
    let top = 0;
    for (let i = 0; i < n; i++) {
      top = Math.max(top, bars.reduce((a, x) => a + (x.values[i] || 0), 0));
      for (const l of lines) top = Math.max(top, l.values[i] ?? 0);
    }
    const { max: yMax, step } = scaleFor(top);
    const y = (v) => padT + ph - (v / yMax) * ph;
    const band = pw / Math.max(1, n);
    const cx = (i) => padL + band * i + band / 2;
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': spec.label || '' });

    // grid and y labels
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      svg.append(s('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: v === 0 ? css('--axis') : css('--grid'), 'stroke-width': 1 }));
      const t = s('text', { x: padL - 6, y: yy + 3.5, 'text-anchor': 'end' });
      t.textContent = v >= 10000 ? `${Math.round(v / 1000)}k` : v.toLocaleString('en-US');
      svg.append(t);
    }
    // x labels: about one per 70px, on whole steps
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 70))));
    for (let i = 0; i < n; i += every) {
      const t = s('text', { x: cx(i), y: H - 6, 'text-anchor': 'middle' });
      t.textContent = (spec.xLabel || dayLabel)(spec.days[i]);
      svg.append(t);
    }
    // bars, stacked, with a 2px gap between neighbours when there's room
    const gap = band > 6 ? 2 : band > 3 ? 1 : 0;
    const bw = Math.max(1, band - gap);
    for (let i = 0; i < n; i++) {
      let base = 0;
      for (const b of bars) {
        const v = b.values[i] || 0;
        if (v <= 0) continue;
        const y1 = y(base + v), y0 = y(base);
        svg.append(s('rect', { x: padL + band * i + gap / 2, y: y1, width: bw, height: Math.max(1, y0 - y1 - (base > 0 ? 2 : 0)), fill: b.color }));
        base += v;
      }
    }
    // lines
    for (const l of lines) {
      let d = '';
      let prev = null;
      for (let i = 0; i < n; i++) {
        const v = l.values[i];
        if (v == null) { prev = null; continue; }
        const px = cx(i), py = y(v);
        if (prev == null) d += `M${n === 1 ? padL : px},${py}`;
        else if (l.kind === 'step') d += `H${px - band / 2}V${py}H${px}`;
        else d += `L${px},${py}`;
        if (n === 1) d += `H${W - padR}`;
        prev = v;
      }
      if (l.kind === 'step' && prev != null) d += `H${W - padR}`;
      if (d) svg.append(s('path', { d, fill: 'none', stroke: l.dash ? css('--ink-2') : l.color, 'stroke-width': 2, 'stroke-dasharray': l.dash ? '5 4' : null, 'stroke-linejoin': 'round' }));
    }
    // hover: a guide, the round markers on the lines, and the tooltip
    const guide = s('line', { y1: padT, y2: padT + ph, stroke: css('--axis'), 'stroke-width': 1, visibility: 'hidden' });
    const marks = lines.filter((l) => !l.dash).map((l) => s('circle', { r: 4, fill: l.color, stroke: css('--surface'), 'stroke-width': 2, visibility: 'hidden' }));
    svg.append(guide, ...marks);
    const hit = s('rect', { x: padL, y: 0, width: pw, height: H, fill: 'transparent' });
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(n - 1, Math.floor((ev.clientX - r.left - padL) / band)));
      guide.setAttribute('x1', cx(i)); guide.setAttribute('x2', cx(i)); guide.setAttribute('visibility', 'visible');
      lines.filter((l) => !l.dash).forEach((l, k) => {
        const v = l.values[i];
        marks[k].setAttribute('visibility', v == null ? 'hidden' : 'visible');
        if (v != null) { marks[k].setAttribute('cx', cx(i)); marks[k].setAttribute('cy', y(v)); }
      });
      showTip(ev.clientX, ev.clientY, spec.tip(i));
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { hideTip(); guide.setAttribute('visibility', 'hidden'); marks.forEach((m) => m.setAttribute('visibility', 'hidden')); });
    svg.append(hit);
    box.replaceChildren(svg);
    if (spec.empty) box.append(h('div', { class: 'sa-empty', text: spec.empty }));
  }

  // Labelled horizontal bars: rows [{ label, small, value, alt, note }], each as a share of `of` (or of the largest).
  function hbars(rows, { of = null, showPct = true } = {}) {
    const max = Math.max(1, ...rows.map((r) => r.value || 0));
    const whole = of ?? rows.reduce((a, r) => a + (r.value || 0), 0);
    return h('div', { class: 'sa-hbars' }, rows.map((r) => [
      h('span', { class: 'l', title: r.title || null }, r.label, r.small ? h('small', { text: r.small }) : null),
      h('span', { class: 't' }, h('i', { class: `${r.value ? '' : 'zero'}${r.alt ? ' alt' : ''}`, style: `width:${((r.value || 0) / (of ?? max)) * 100}%` })),
      h('span', { class: 'v', text: fmt(r.value) }),
      showPct ? h('span', { class: 'p', text: pct(r.value || 0, whole) }) : h('span', {}),
      r.note ? h('span', { class: 'd', text: r.note }) : null,
    ]));
  }

  const tile = (label, value, sub, title) => h('div', { class: 'tile', title: title || null },
    h('div', { class: 'tile-label', text: label }),
    h('div', { class: 'tile-value', text: value }),
    sub ? h('div', { class: 'tile-sub' }, sub) : null);
  const card = (title, sub, ...body) => h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: title }), sub ? h('div', { class: 'card-sub' }, sub) : null)),
    ...body);
  function seg(options, value, onPick, label) {
    const el = h('div', { class: 'seg', role: 'group', 'aria-label': label });
    for (const [v, text] of options) {
      el.append(h('button', { type: 'button', 'aria-pressed': String(String(v) === String(value)), text, onclick: () => onPick(v) }));
    }
    return el;
  }

  // ---------- state ----------
  let D = null;
  let loadedAt = 0;
  const RANGES = [['30', '30d'], ['90', '90d'], ['365', '1y'], ['all', 'All']];
  const view = {
    range: store.get('range', '90'),
    growth: { accounts: store.get('growth-accounts', 'total'), servers: store.get('growth-servers', 'total') },
    devices: store.get('devices', 'd'),
  };
  let census = { running: false, text: '' };

  // counters: metric|day -> n
  let C = new Map();
  const cnt = (metric, day) => C.get(`${metric}|${day}`) || 0;
  let dlByDay = new Map(); // day -> { web, cli }
  let dlByFile = new Map(); // file -> { web, cli }
  let snapByDay = new Map();

  function index() {
    C = new Map(D.counts.map(([day, m, n]) => [`${m}|${day}`, n]));
    dlByDay = new Map();
    dlByFile = new Map();
    for (const [day, m, n] of D.downloads) {
      const [, kind, file] = m.split(':');
      const k = kind === 'web' ? 'web' : 'cli';
      if (!dlByDay.has(day)) dlByDay.set(day, { web: 0, cli: 0 });
      dlByDay.get(day)[k] += n;
      if (!dlByFile.has(file)) dlByFile.set(file, { web: 0, cli: 0 });
      dlByFile.get(file)[k] += n;
    }
    snapByDay = new Map(D.snapshots);
  }

  // The first day anything was recorded, for "All".
  function firstDay() {
    const firsts = [D.history.accounts[0]?.[0], D.history.servers[0]?.[0], D.counts[0]?.[0], D.downloads[0]?.[0], D.snapshots[0]?.[0]].filter(Boolean);
    return firsts.length ? firsts.sort()[0] : D.today;
  }
  function rangeDays() {
    // "All" from the first day anything was recorded (at least a week, so a new site still draws a chart)
    const from = view.range === 'all' ? [firstDay(), addDays(D.today, -6)].sort()[0] : addDays(D.today, -(Number(view.range) - 1));
    return daysFrom(from, D.today);
  }
  const rangeName = () => (view.range === 'all' ? 'all time' : view.range === '365' ? 'the last year' : `the last ${view.range} days`);

  // Totals by day from "new on day" pairs: values for each of `days`, counting everything before them too.
  function cumulative(pairs, days) {
    const out = [];
    let i = 0, total = 0;
    for (const day of days) {
      while (i < pairs.length && pairs[i][0] <= day) total += pairs[i++][1];
      out.push(total);
    }
    return out;
  }
  const newIn = (pairs, from) => pairs.filter(([d]) => d >= from).reduce((a, [, n]) => a + n, 0);

  // The baseline in force on a day: the latest one from on or before it (one with no date counts from the start).
  function baselineFn(metric) {
    const list = D.baselines.filter((b) => b.metric === metric)
      .map((b) => ({ ...b, k: b.from_day || '' }))
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.set_at - b.set_at));
    return (day) => {
      let v = null;
      for (const b of list) if (b.k <= day) v = b.value;
      return v;
    };
  }

  // People, estimated for one period: active accounts, plus devices that were never signed in, divided by how
  // many devices a signed-in person tends to use. Devices from browsers asking not to be tracked aren't in it.
  function people(kind, day) {
    const all = cnt(`dev:a:${kind}`, day);
    const signed = cnt(`dev:s:${kind}`, day);
    const anon = Math.max(0, all - signed);
    const accounts = cnt(`acct:${kind}`, day);
    const perPerson = accounts > 0 && signed > 0 ? Math.max(1, signed / accounts) : 1;
    return { all, signed, anon, accounts, perPerson, est: accounts + anon / perPerson, dash: cnt(`dev:b:${kind}`, day), fresh: kind === 'd' ? cnt('dev:new', day) : null };
  }

  // ---------- load ----------
  async function load() {
    try {
      D = await api('/api/site-analytics/data');
      loadedAt = Date.now();
      index();
      render();
      const c = D.totals.census;
      // servers never asked, or the oldest answer more than 6 hours old: ask those now
      if (!census.running && (c.missing > 0 || (c.oldest && D.now - c.oldest > 6 * 3600))) runCensus(D.now - 6 * 3600, false);
    } catch (err) {
      main.replaceChildren(card('Site analytics', null, h('p', { class: 'sa-err', text: err.message })));
    }
  }

  // Asks the servers again, a batch per request, until every census is newer than `since`.
  async function runCensus(since, discordToo = true) {
    if (census.running) return;
    census = { running: true, text: 'Asking servers…' };
    paintCensus();
    let asked = 0;
    try {
      for (let k = 0; k < 200; k++) {
        const r = await api('/api/site-analytics/census', { since, discord: discordToo && k === 0 });
        asked += r.asked;
        census.text = `Asked ${fmt(asked)} server${asked === 1 ? '' : 's'}${r.left ? `, ${fmt(r.left)} to go` : ''}…`;
        paintCensus();
        if (!r.left || !r.asked || r.asked === r.failed) break;
      }
      census = { running: false, text: '' };
      await load();
    } catch (err) {
      census = { running: false, text: err.message };
      paintCensus();
    }
  }
  function paintCensus() {
    const el = $('#sa-census');
    if (el) el.replaceChildren(...censusLine());
  }
  function censusLine() {
    const c = D.totals.census;
    const btn = h('button', { type: 'button', class: 'btn btn-quiet', text: 'Refresh', disabled: census.running || null,
      title: 'Ask every server for its numbers again', onclick: () => runCensus(Math.floor(D.now + (Date.now() - loadedAt) / 1000)) });
    if (census.text) return [h('span', { class: 'sa-progress', text: census.text }), census.running ? null : btn];
    const parts = [`Servers counted ${c.oldest ? ago(c.oldest) : 'never'}`];
    if (c.missing) parts.push(`${fmt(c.missing)} not yet`);
    if (c.failed) parts.push(`${fmt(c.failed)} didn’t answer`);
    return [h('span', { text: parts.join(' · ') }), btn];
  }

  // ---------- page ----------
  function render() {
    hideTip();
    charts.clear();
    const days = rangeDays();
    const from = days[0];

    const head = h('div', { class: 'sa-head' },
      h('div', {},
        h('h1', { class: 'page-title', text: 'Site analytics' }),
        h('div', { class: 'sa-head-sub' }, h('span', { id: 'sa-census' }, censusLine()))),
      h('div', { class: 'sa-head-right' },
        seg(RANGES, view.range, (v) => { view.range = String(v); store.set('range', view.range); render(); }, 'Range')));

    main.replaceChildren(...[
      head,
      growthSection(days, from),
      peopleSection(days),
      accountsSection(),
      serversSection(),
      modSection(days, from),
      discordSection(days),
      trendsSection(days),
      settingsSection(),
      privacySection(),
    ].flat());
  }

  // ----- growth: accounts and servers, with their baselines -----
  function growthSection(days, from) {
    const T = D.totals;
    const out = [h('h2', { class: 'sa-section', text: 'Growth' })];
    const tiles = h('div', { class: 'tiles sa-tiles' });
    const p = people('m', D.periods.m);
    for (const metric of ['accounts', 'servers']) {
      const total = T[metric];
      const base = baselineFn(metric)(D.today);
      const added = newIn(D.history[metric], from);
      tiles.append(tile(metric === 'accounts' ? 'Accounts' : 'Servers', fmt(total),
        [base != null ? h('b', { text: `${fmt(Math.max(0, total - base))} above baseline` }) : null, base != null ? ' · ' : '', `${plus(added)} in ${rangeName()}`],
        base != null ? `Baseline ${fmt(base)} (set below)` : null));
    }
    tiles.append(
      tile('People, est.', p.all || p.accounts ? `≈${fmt(p.est)}` : '–', ['this month · ', h('b', { text: `${fmt(p.accounts)} accounts` }), ` + ${fmt(p.anon)} devices never signed in`],
        'Active accounts this month, plus devices that were never signed in this month, divided by how many devices a signed-in person uses. See the table under People.'),
      tile('Devices', fmt(p.all), [`this month · ${fmt(p.signed)} signed in`], 'Browsers that opened any mcstats page this calendar month (UTC), each counted once. Browsers asking not to be tracked aren’t counted.'),
    );
    out.push(tiles);
    const grid = h('div', { class: 'grid2' });
    for (const metric of ['accounts', 'servers']) grid.append(growthCard(metric, days));
    out.push(grid);
    return out;
  }

  function growthCard(metric, days) {
    const name = metric === 'accounts' ? 'Accounts' : 'Servers';
    const mode = view.growth[metric];
    const totals = cumulative(D.history[metric], days);
    const bf = baselineFn(metric);
    const base = days.map((d) => bf(d));
    const hasBase = base.some((v) => v != null);
    const newByDay = new Map(D.history[metric]);
    const above = totals.map((t, i) => (base[i] == null ? t : Math.max(0, t - base[i])));
    const series = mode === 'net' && hasBase
      ? [{ label: 'Above baseline', color: css('--series-1'), values: above, kind: 'line' }]
      : [{ label: 'Total', color: css('--series-1'), values: totals, kind: 'line' },
        ...(hasBase ? [{ label: 'Baseline', values: base, kind: 'step', dash: true }] : [])];
    const c = chart({
      label: `${name} over time`, days, series,
      tip: (i) => [
        h('div', { class: 'sa-tip-day', text: dayLabel(days[i], true) }),
        tipRow('Total', fmt(totals[i]), css('--series-1'), 'line'),
        hasBase ? tipRow('Baseline', base[i] == null ? '–' : fmt(base[i]), null) : null,
        hasBase ? tipRow('Above baseline', base[i] == null ? '–' : fmt(totals[i] - base[i]), null) : null,
        tipRow(`New that day`, fmt(newByDay.get(days[i]) || 0), null),
      ],
    });
    const control = hasBase
      ? seg([['total', 'Total'], ['net', 'Above baseline']], mode, (v) => { view.growth[metric] = v; store.set(`growth-${metric}`, v); render(); }, `${name} chart`)
      : null;
    const el = card(name, mode === 'net' && hasBase ? 'Above the baseline you set' : hasBase ? 'Total, with your baseline dashed' : 'Total; set a baseline under Settings', c);
    if (control) $('.card-head', el).append(control);
    return el;
  }

  // ----- people and devices -----
  function peopleSection(days) {
    const out = [h('h2', { class: 'sa-section', text: 'People' })];
    const kind = view.devices;
    // the periods along the chart
    let points;
    if (kind === 'd') points = days;
    else if (kind === 'w') points = [...new Set(days.map(weekStart))];
    else points = [...new Set(days.map(monthStart))];
    const rows = points.map((d) => people(kind, d));
    const label = kind === 'd' ? (d) => dayLabel(d) : kind === 'w' ? (d) => dayLabel(d) : (d) => monthLabel(d);
    const anyData = rows.some((r) => r.all > 0 || r.accounts > 0);
    const c = chart({
      label: 'Devices', days: points, xLabel: label,
      series: [
        { label: 'Signed in', color: css('--series-1'), values: rows.map((r) => r.signed), kind: 'bar' },
        { label: 'Never signed in', color: css('--sa-2'), values: rows.map((r) => r.anon), kind: 'bar' },
        { label: 'People, est.', color: css('--ink-2'), values: rows.map((r) => (r.all || r.accounts ? r.est : null)), kind: 'line', dash: true },
      ],
      empty: anyData ? null : 'Nothing counted yet: devices are counted from the day this was deployed.',
      tip: (i) => {
        const r = rows[i];
        const when = kind === 'd' ? dayLabel(points[i], true) : kind === 'w' ? `Week of ${dayLabel(points[i])}` : monthLabel(points[i]);
        return [
          h('div', { class: 'sa-tip-day', text: when }),
          tipRow('Devices', fmt(r.all), null),
          tipRow('Signed in', fmt(r.signed), css('--series-1')),
          tipRow('Never signed in', fmt(r.anon), css('--sa-2')),
          r.fresh != null ? tipRow('New devices', fmt(r.fresh), null) : null,
          tipRow('Opened a dashboard', fmt(r.dash), null),
          tipRow('Active accounts', fmt(r.accounts), null),
          tipRow('People, est.', r.all || r.accounts ? `≈${fmt(r.est)}` : '–', null),
        ];
      },
    });
    const devCard = card('Devices', 'Each browser once per day, week or month (UTC)', c,
      h('p', { class: 'sa-note' }, 'Stacked: devices that were signed in at least once in the period, and the rest. The dashed line is the estimate of people.'));
    $('.card-head', devCard).append(seg([['d', 'Days'], ['w', 'Weeks'], ['m', 'Months']], kind, (v) => { view.devices = v; store.set('devices', v); render(); }, 'Devices by'));

    // the table: this and the last day, week and month
    const P = D.periods;
    const lines = [
      ['Today', 'd', P.d, true], ['Yesterday', 'd', addDays(P.d, -1)],
      ['This week', 'w', P.w, true], ['Last week', 'w', addDays(P.w, -7)],
      ['This month', 'm', P.m, true], ['Last month', 'm', addMonths(P.m, -1)],
    ];
    const table = h('table', { class: 'sa-table' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Period' }), ...['Devices', 'Signed in', 'Never signed in', 'Active accounts', 'Devices per account', 'People, est.'].map((t) => h('th', { class: 'num', text: t })))),
      h('tbody', {}, lines.map(([name, k, day, now]) => {
        const r = people(k, day);
        return h('tr', { class: now ? 'sa-cur' : null },
          h('td', { text: name }),
          h('td', { class: 'num', text: fmt(r.all) }), h('td', { class: 'num', text: fmt(r.signed) }), h('td', { class: 'num', text: fmt(r.anon) }),
          h('td', { class: 'num', text: fmt(r.accounts) }),
          h('td', { class: 'num', text: r.accounts && r.signed ? (Math.round(r.perPerson * 100) / 100).toFixed(2) : '–' }),
          h('td', { class: 'num est', text: r.all || r.accounts ? `≈${fmt(r.est)}` : '–' }));
      })));
    const estCard = card('People, estimated', 'Signed in or not', h('div', { class: 'sa-scroll' }, table),
      h('p', { class: 'sa-note' },
        h('b', { text: 'People ≈ active accounts + devices never signed in ÷ devices per account.' }),
        ' Active accounts are exact (counted on the server, every request). Devices are counted by each browser once per period, with no id; ',
        '“devices per account” is signed-in devices ÷ active accounts, taken as at least 1, and corrects for one person using a phone and a laptop. ',
        'Browsers with Do Not Track or Global Privacy Control, private windows (each one is a new device) and cleared storage make the device numbers a little off, the first two low and the others high.'));
    out.push(devCard, estCard);
    return out;
  }

  // ----- accounts: roles across servers -----
  function accountsSection() {
    const T = D.totals;
    const out = [h('h2', { class: 'sa-section', text: 'Accounts' })];
    const a = T.accounts_active;
    out.push(h('div', { class: 'tiles sa-tiles' },
      tile('Active today', fmt(a.d), `${pct(a.d, T.accounts)} of accounts`, 'Accounts signed in and using the site today (UTC).'),
      tile('Active this week', fmt(a.w), `${pct(a.w, T.accounts)} · since Monday`),
      tile('Active this month', fmt(a.m), `${pct(a.m, T.accounts)} · calendar month`),
      tile('Invited, no account', fmt(T.invited_no_account), 'members by email who haven’t made one', 'Emails added to a server (Roles, or invited on /new) with no mcstats account yet.'),
    ));
    const r = T.roles;
    const then = snapshotAgo(30);
    const delta = (k) => (then?.roles ? `${plus(r[k] - (then.roles[k] || 0))} since ${dayLabel(then.day)}` : null);
    const roleRows = [
      { label: 'Player only', small: 'member everywhere', value: r.member, note: delta('member') },
      { label: 'Admin only', small: 'admin wherever they’re in', value: r.admin, note: delta('admin') },
      { label: 'Owner only', small: 'owns every server they’re in', value: r.owner, note: delta('owner') },
      { label: 'Mixed', small: 'different roles on different servers', value: r.mixed, note: delta('mixed') },
      { label: 'In no server', small: 'an account, but no role anywhere', value: r.none, note: delta('none') },
    ];
    const spa = T.servers_per_account;
    const inSome = (spa['1'] || 0) + (spa['2'] || 0) + (spa['3+'] || 0);
    out.push(h('div', { class: 'grid2' },
      card('What accounts are', `Their roles across every server · ${fmt(T.accounts)} accounts`, hbars(roleRows, { of: T.accounts }),
        h('p', { class: 'sa-note' }, 'From the servers’ member lists as of the last census. An account with one role everywhere is that role; one that is, say, an owner on one server and a player on another is Mixed.')),
      card('Servers per account', `Of the ${fmt(inSome)} accounts in at least one server`,
        hbars([{ label: '1 server', value: spa['1'] }, { label: '2 servers', value: spa['2'] }, { label: '3 or more', value: spa['3+'] }], { of: inSome }),
        h('p', { class: 'sa-note' }, 'Membership only (a role on the server), not servers joined with a password or public ones looked at.'))));
    return out;
  }
  // The snapshot about `days` ago (the oldest one if there's nothing that old), or null with fewer than two.
  function snapshotAgo(days) {
    if (D.snapshots.length < 2) return null;
    const want = addDays(D.today, -days);
    let pick = D.snapshots[0];
    for (const sn of D.snapshots) if (sn[0] <= want) pick = sn;
    if (pick[0] === D.today) return null;
    return { day: pick[0], ...pick[1] };
  }

  // ----- servers -----
  function serversSection() {
    const T = D.totals;
    const out = [h('h2', { class: 'sa-section', text: 'Servers' })];
    out.push(h('div', { class: 'tiles sa-tiles' },
      tile('Active this week', fmt(T.servers_active_7d), `${pct(T.servers_active_7d, T.servers)} of servers`, 'The mod uploaded something, or a player was seen, in the last 7 days.'),
      tile('Players on now', fmt(T.online_now), `on ${fmt(T.servers_online_now)} server${T.servers_online_now === 1 ? '' : 's'}`),
      tile('Minecraft players', fmt(T.players.total), [h('b', { text: fmt(T.players.d7) }), ' played this week'], 'Players each server has seen, added up across servers (someone on two servers counts twice).'),
      tile('Chat lines', fmt(T.chat_7d), 'logged in the last 7 days'),
    ));
    const funnel = [
      { label: 'Created', value: T.servers },
      { label: 'Finished setup', value: T.servers_setup, small: 'went through /new' },
      { label: 'Mod connected', value: T.servers_uploaded, small: 'at least once' },
      { label: 'Active, 30 days', value: T.servers_active_30d },
      { label: 'Active, 7 days', value: T.servers_active_7d },
      { label: 'Active, 24 hours', value: T.servers_active_1d },
      { label: 'Players on now', value: T.servers_online_now },
    ];
    const counted = T.census.counted || 0;
    const facts = [
      { label: 'Public', value: T.servers_public },
      { label: 'Private', value: Math.max(0, counted - T.servers_public) },
      { label: 'Address set', value: T.servers_address, small: 'pinged every minute' },
      { label: 'Discord linked', value: T.servers_discord },
      { label: 'Paused', value: T.servers_paused },
    ];
    out.push(h('div', { class: 'grid2' },
      card('From created to active', 'Each step out of every server made', hbars(funnel, { of: T.servers }),
        h('p', { class: 'sa-note' }, 'Active: the mod uploaded something, or a player was seen (by the mod or by pinging the server’s address), in that time. Finished setup counts servers whose owner reached the last step of /new.')),
      card('What servers are like', `Of the ${fmt(counted)} counted`,
        hbars(facts, { of: counted }),
        h('div', { class: 'sa-sub-h', text: 'Members per server' }),
        hbars(Object.entries(T.members_per_server).map(([label, value]) => ({ label, value }))),
        h('div', { class: 'sa-sub-h', text: 'Minecraft players per server' }),
        hbars(Object.entries(T.players_per_server).map(([label, value]) => ({ label, value }))))));
    return out;
  }

  // ----- the mod -----
  function modSection(days, from) {
    const T = D.totals;
    const out = [h('h2', { class: 'sa-section', text: 'Mod' })];
    let total = { web: 0, cli: 0 }, inRange = 0;
    for (const v of dlByFile.values()) { total.web += v.web; total.cli += v.cli; }
    for (const [day, v] of dlByDay) if (day >= from) inRange += v.web + v.cli;
    const latest = D.mod.latest;
    const onLatest = T.mod_versions[latest] || 0;
    out.push(h('div', { class: 'tiles sa-tiles' },
      tile('Connected now', fmt(T.servers_mod_now), 'servers with the mod on', 'Its web chat connection is up, or it uploaded in the 10 minutes before the census.'),
      tile('Uploading this week', fmt(T.servers_mod_7d), `${fmt(T.servers_uploaded)} ever connected`),
      tile(`On ${latest}`, fmt(onLatest), `${pct(onLatest, T.servers_uploaded)} of servers with the mod`, 'The newest version, as each mod last said when it connected.'),
      tile('Downloads', fmt(total.web + total.cli), `${plus(inRange)} in ${rangeName()}`, 'From /downloads/ on this site: one per address and file a day. Counting started when this was deployed.'),
    ));
    const versions = Object.entries(T.mod_versions).sort((a, b) => cmpVersion(b[0], a[0]));
    const mcs = Object.entries(T.mc_versions).sort((a, b) => cmpVersion(b[0], a[0]));
    const dl = days.map((d) => dlByDay.get(d) || { web: 0, cli: 0 });
    const files = [...dlByFile.entries()].sort((a, b) => (b[1].web + b[1].cli) - (a[1].web + a[1].cli));
    const known = new Map(D.mod.files.map((f) => [f.file, f]));
    out.push(h('div', { class: 'grid2' },
      card('Versions in use', 'Servers that have connected the mod, by what it last said',
        versions.length ? hbars(versions.map(([v, n]) => ({ label: v, small: v === latest ? 'latest' : null, value: n, alt: v !== latest }))) : h('p', { class: 'sa-note', text: 'No server has connected the mod yet.' }),
        h('div', { class: 'sa-sub-h', text: 'Minecraft versions' }),
        mcs.length ? hbars(mcs.map(([v, n]) => ({ label: v, value: n }))) : h('p', { class: 'sa-note', text: 'None yet.' }),
        h('p', { class: 'sa-note', text: 'Mods from 2.3.0 say their Minecraft version; older ones show as unknown.' })),
      card('Downloads', `Of the mod’s jars, by day · ${fmt(total.web)} from browsers, ${fmt(total.cli)} from other tools`,
        chart({
          label: 'Mod downloads', days,
          series: [
            { label: 'Browser', color: css('--series-1'), values: dl.map((x) => x.web), kind: 'bar' },
            { label: 'Other (curl, wget…)', color: css('--sa-2'), values: dl.map((x) => x.cli), kind: 'bar' },
          ],
          empty: dl.some((x) => x.web || x.cli) ? null : 'No downloads in this range.',
          tip: (i) => [h('div', { class: 'sa-tip-day', text: dayLabel(days[i], true) }), tipRow('Browser', fmt(dl[i].web), css('--series-1')), tipRow('Other', fmt(dl[i].cli), css('--sa-2'))],
        }),
        files.length ? h('div', { class: 'sa-scroll', style: 'margin-top:12px' }, h('table', { class: 'sa-table' },
          h('thead', {}, h('tr', {}, h('th', { text: 'Jar' }), h('th', { class: 'num', text: 'Browser' }), h('th', { class: 'num', text: 'Other' }), h('th', { class: 'num', text: 'All' }))),
          h('tbody', {}, files.map(([f, v]) => h('tr', {},
            h('td', {}, known.get(f) ? `${known.get(f).version} · Minecraft ${known.get(f).label}` : f),
            h('td', { class: 'num', text: fmt(v.web) }), h('td', { class: 'num', text: fmt(v.cli) }), h('td', { class: 'num', text: fmt(v.web + v.cli) })))))) : null)));
    return out;
  }
  function cmpVersion(a, b) {
    const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10)), pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10));
    if (Number.isNaN(pa[0])) return -1;
    if (Number.isNaN(pb[0])) return 1;
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  // ----- Discord -----
  function discordSection(days) {
    const T = D.totals;
    const out = [h('h2', { class: 'sa-section', text: 'Discord bot' })];
    // the bot's own count, as Discord last said it: the latest day it was read
    const reads = D.counts.filter(([, m]) => m === 'discord:guilds');
    const last = reads[reads.length - 1];
    out.push(h('div', { class: 'tiles sa-tiles three' },
      tile('Discord servers', last ? fmt(last[2]) : '–', last ? `the bot is in, as of ${dayLabel(last[0])}` : D.discord_ready ? 'press Refresh to ask Discord' : 'the bot isn’t set up here',
        'Discord’s own count of the servers the bot has been added to (approximate_guild_count), linked to an mcstats server or not.'),
      tile('Linked to a server', fmt(T.discord.linked), last ? `${pct(T.discord.linked, last[2])} of them` : 'with /mcstats setup or Admin → Discord'),
      tile('Discord users linked', fmt(T.discord.players), 'to a Minecraft player'),
    ));
    const readByDay = new Map(reads.map(([d, , n]) => [d, n]));
    let lastRead = null;
    const bot = days.map((d) => { if (readByDay.has(d)) lastRead = readByDay.get(d); return lastRead; });
    // before the range starts, the most recent read before it
    if (bot[0] == null) {
      const before = reads.filter(([d]) => d < days[0]).pop();
      if (before) { let v = before[2]; for (let i = 0; i < bot.length && bot[i] == null; i++) bot[i] = v; }
    }
    const linked = cumulative(D.history.discord, days);
    const feeds = T.discord.feeds;
    out.push(h('div', { class: 'grid2' },
      card('Discord servers over time', null, chart({
        label: 'Discord servers', days,
        series: [
          { label: 'Bot is in', color: css('--series-1'), values: bot, kind: 'step' },
          { label: 'Linked to an mcstats server', color: css('--sa-2'), values: linked, kind: 'line' },
        ],
        tip: (i) => [h('div', { class: 'sa-tip-day', text: dayLabel(days[i], true) }), tipRow('Bot is in', bot[i] == null ? '–' : fmt(bot[i]), css('--series-1'), 'line'), tipRow('Linked', fmt(linked[i]), css('--sa-2'), 'line')],
      }), h('p', { class: 'sa-note', text: 'Linked counts the links there are now, by when each was made (an unlinked server drops out of the past too). The bot’s own count is read once an hour.' })),
      card('Feeds switched on', `Of the ${fmt(T.servers_discord)} linked servers`, hbars([
        { label: 'Live status', value: feeds.status || 0 },
        { label: 'Events', small: 'joins, deaths, advancements', value: feeds.events || 0 },
        { label: 'Chat bridge', value: feeds.chat || 0 },
        { label: 'Daily summary', value: feeds.digest || 0 },
      ], { of: T.servers_discord }))));
    return out;
  }

  // ----- trends from the daily snapshots -----
  function trendsSection(days) {
    const out = [h('h2', { class: 'sa-section', text: 'Trends' })];
    const have = D.snapshots.filter(([d]) => d >= days[0]);
    const since = D.snapshots[0]?.[0];
    if (D.snapshots.length < 2) {
      out.push(card('Day by day', null, h('p', { class: 'sa-note', text: `These charts fill in as days go by: one point a day, from ${since ? dayLabel(since, true) : 'today'}. Accounts, servers and Discord links above have their whole history already.` })));
      return out;
    }
    const by = new Map(have);
    const pts = days.filter((d) => d >= since);
    const val = (f) => pts.map((d) => (by.has(d) ? f(by.get(d)) : null));
    const small = (title, sub, f) => {
      const values = val(f);
      return card(title, sub, chart({
        label: title, days: pts, short: true,
        series: [{ label: title, color: css('--series-1'), values, kind: 'line' }],
        tip: (i) => [h('div', { class: 'sa-tip-day', text: dayLabel(pts[i], true) }), tipRow(title, values[i] == null ? 'not counted' : fmt(values[i]), null)],
      }));
    };
    out.push(h('div', { class: 'grid2' },
      small('Servers active this week', 'The mod uploaded or a player was seen, in the 7 days before', (x) => x.servers_active_7d),
      small('Minecraft players this week', 'Played in the 7 days before, all servers', (x) => x.players?.d7),
    ), h('div', { class: 'grid2' },
      small('Accounts active this month', 'Since the 1st, as of each day', (x) => x.accounts_active?.m),
      small('Servers with the mod connected', 'At the day’s last census', (x) => x.servers_mod_now),
    ));
    return out;
  }

  // ----- settings: baselines and who can see this page -----
  function settingsSection() {
    const out = [h('h2', { class: 'sa-section', text: 'Settings' })];
    const sup = D.me.super;
    const cols = h('div', { class: 'sa-cols' });
    for (const metric of ['accounts', 'servers']) cols.append(baselineEditor(metric, sup));
    out.push(card('Baselines', sup ? 'A line on the Growth charts, taken off for “above baseline”' : 'Set by the site’s super admins', cols,
      h('p', { class: 'sa-note' }, 'The baseline on a day is the latest one from on or before it; one with no date counts from the start. Use it for your own test accounts and servers, or the numbers at a launch, and set a new one when that changes.')));
    if (sup) out.push(accessCard());
    return out;
  }

  function baselineEditor(metric, sup) {
    const name = metric === 'accounts' ? 'Accounts' : 'Servers';
    const list = D.baselines.filter((b) => b.metric === metric);
    const now = baselineFn(metric)(D.today);
    const box = h('div', {},
      h('div', { class: 'sa-sub-h' }, `${name}: `, h('span', { class: 'sa-big', text: now == null ? 'none' : fmt(now) })),
      list.length ? h('ul', { class: 'sa-list' }, list.map((b) => h('li', {},
        h('span', { class: 'grow' }, h('b', { text: fmt(b.value) }), ` ${b.from_day ? `from ${dayLabel(b.from_day, true)}` : 'from the start'}`, b.note ? h('span', { class: 'meta', text: ` · ${b.note}` }) : null),
        h('span', { class: 'meta', text: `${b.set_by.split('@')[0]}, ${dayLabel(new Date(b.set_at * 1000).toISOString().slice(0, 10))}` }),
        sup ? h('button', { type: 'button', class: 'btn btn-quiet', text: 'Remove', onclick: async (ev) => {
          ev.target.disabled = true;
          try { D.baselines = (await api('/api/site-analytics/baselines', { remove: b.id })).baselines; render(); } catch (err) { ev.target.disabled = false; alert(err.message); }
        } }) : null))) : h('p', { class: 'sa-note', text: 'No baseline yet.' }));
    if (!sup) return box;
    const value = h('input', { class: 'adm-input', type: 'number', min: '0', step: '1', required: true, style: 'width:90px', value: String(D.totals[metric]) });
    const day = h('input', { class: 'adm-input', type: 'date', max: D.today, style: 'width:150px' });
    const note = h('input', { class: 'adm-input', type: 'text', maxlength: '120', placeholder: 'e.g. my test servers', style: 'width:170px' });
    const err = h('p', { class: 'sa-err', hidden: true });
    const form = h('form', { class: 'sa-form' },
      h('label', {}, 'Baseline', value),
      h('label', {}, 'From (empty: the start)', day),
      h('label', {}, 'Note', note),
      h('button', { type: 'submit', class: 'btn btn-primary', text: 'Set' }));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      const btn = $('button', form);
      btn.disabled = true;
      try {
        D.baselines = (await api('/api/site-analytics/baselines', { metric, value: Number(value.value), from_day: day.value || null, note: note.value })).baselines;
        render();
      } catch (e) {
        err.textContent = e.message; err.hidden = false; btn.disabled = false;
      }
    });
    box.append(form, err);
    return box;
  }

  function accessCard() {
    const A = D.access;
    const email = h('input', { class: 'adm-input', type: 'email', required: true, placeholder: 'their account’s email', style: 'width:240px', autocomplete: 'off' });
    const err = h('p', { class: 'sa-err', hidden: true });
    const form = h('form', { class: 'sa-form' }, h('label', {}, 'Let another account see this page', email), h('button', { type: 'submit', class: 'btn btn-primary', text: 'Add' }));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      try {
        D.access = await api('/api/site-analytics/viewers', { email: email.value });
        render();
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    });
    const rows = [
      ...A.supers.map((e) => h('li', {}, h('span', { class: 'grow', text: e }), h('span', { class: 'sa-tag ok', text: 'Super admin' }), h('span', { class: 'meta', text: 'SUPER_ADMIN_EMAIL' }))),
      ...A.viewers.map((v) => h('li', {},
        h('span', { class: 'grow', text: v.email }),
        h('span', { class: `sa-tag${v.has_account ? '' : ''}`, text: v.has_account ? 'Can view' : 'No account yet' }),
        h('span', { class: 'meta', text: `added by ${v.added_by.split('@')[0]}, ${dayLabel(new Date(v.added_at * 1000).toISOString().slice(0, 10))}` }),
        h('button', { type: 'button', class: 'btn btn-quiet', text: 'Remove', onclick: async (ev) => {
          ev.target.disabled = true;
          try { D.access = await api('/api/site-analytics/viewers', { email: v.email, remove: true }); render(); } catch (e) { ev.target.disabled = false; alert(e.message); }
        } }))),
    ];
    return card('Who can see this page', 'Super admins, and the accounts you add here. Viewers can look and refresh, not change settings.',
      h('ul', { class: 'sa-list' }, rows), form, err,
      h('p', { class: 'sa-note' }, 'Nothing on the site links here. Anyone else who opens /site-analytics is told they aren’t authorized. Signed out? Sign in at ', h('a', { href: '/account?next=/site-analytics', text: '/account?next=/site-analytics' }), '.'));
  }

  function privacySection() {
    return [h('h2', { class: 'sa-section', text: 'How this is counted' }), h('section', { class: 'card sa-priv' },
      h('p', {}, h('b', { text: 'Devices' }), ': each browser keeps, in its own storage, the day, week and month it was last counted, and sends those back once a day. The site adds one to each period it is behind on. No id, cookie, address or browser details are stored, so devices can be counted but never told apart or followed. Browsers with Do Not Track or Global Privacy Control are left out.'),
      h('p', {}, h('b', { text: 'Accounts' }), ': the last day each account used the site (a day, not a time). Roles across servers come from a census of each server’s members, which keeps keyed hashes of their emails, never the emails, matched against the accounts here and then forgotten.'),
      h('p', {}, h('b', { text: 'Servers, the mod and Discord' }), ': counts and version numbers from each server’s own objects, asked once an hour (Refresh asks now). No server names, player names or chat leave them. Downloads are counted one per address and jar a day, with the address only ever as an unreadable rate-limit key.'),
      h('p', {}, 'Everything is aggregate. This page shows nothing about a single person or server that its owner couldn’t see on their own pages.'))];
  }

  load();
})();
