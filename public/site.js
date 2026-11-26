// The site's own pages: the landing page (/), joining a server (/join), making one (/new) and the mcstats
// account (/account), the account's own list of servers (/servers) and the mod's own page (/mod). Which one this is comes from <body data-page>. Talks to /api/site/* (src/site.js) and
// /api/account/* (src/account.js).
(() => {
  const page = document.body.dataset.page;
  const $ = (s, root = document) => root.querySelector(s);

  // ---- small helpers ----
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
  async function api(path, body, { method } = {}) {
    const res = await fetch(path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(out.error || `Something went wrong (HTTP ${res.status}).`);
      err.status = res.status;
      err.field = out.field;
      throw err;
    }
    return out;
  }
  const errorLine = () => h('p', { class: 'site-err', role: 'alert', hidden: true });
  const say = (line, msg) => { line.textContent = msg || ''; line.hidden = !msg; };
  const field = (label, input, note) => h('label', { class: 'site-field' }, h('span', { class: 'site-label', text: label }), input, note ? h('span', { class: 'site-hint', text: note }) : null);
  const input = (attrs) => h('input', { class: 'adm-input site-input', ...attrs });
  async function busy(btn, fn) {
    btn.disabled = true;
    try { return await fn(); } finally { btn.disabled = false; }
  }
  function copyButton(getText, label = 'Copy') {
    const b = h('button', { type: 'button', class: 'btn', text: label });
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(getText());
        b.textContent = 'Copied';
      } catch {
        b.textContent = 'Select and copy it';
      }
      setTimeout(() => { b.textContent = label; }, 2000);
    });
    return b;
  }
  const fmtTime = (ts) => new Date(ts * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  // ---- theme switch (same as the stats page: dark by default, a choice is remembered) ----
  const toggle = $('#theme-toggle');
  if (toggle) {
    const sync = () => toggle.setAttribute('aria-checked', String(document.documentElement.dataset.theme === 'dark'));
    sync();
    toggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      const apply = () => {
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('theme', next); } catch {}
        sync();
      };
      // the whole page cross-fades into the other theme (the home page's sky plays its own sunset or sunrise)
      if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(apply);
      else apply();
    });
  }

  const params = new URLSearchParams(location.search);
  const main = $('#site-main');

  // The link in a code email (src/email.js) leads to /account and ends in #email=…&code=…. Taken off the address at once, so
  // it isn't left in the history or copied along with the page's address. -> { email, code } or null
  const emailed = (() => {
    const hash = new URLSearchParams(location.hash.slice(1));
    const email = hash.get('email'), code = hash.get('code');
    if (!email || !/^\d{8}$/.test(code || '')) return null;
    history.replaceState(null, '', location.pathname + location.search);
    return { email, code };
  })();

  // ---------------- /join ----------------
  function joinPage() {
    const err = errorLine();
    const name = input({ name: 'server', autocomplete: 'off', required: true, autocapitalize: 'none', spellcheck: 'false', value: params.get('server') || '' });
    const pass = input({ name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const go = h('button', { type: 'submit', class: 'btn btn-primary site-go', text: 'Join' });
    const form = h('form', { class: 'site-form' },
      field('Server name', name, 'The name the server’s owner gave you.'),
      field('Server password', pass),
      go, err);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      say(err, '');
      busy(go, async () => {
        try {
          const r = await api('/api/site/join', { server: name.value, password: pass.value });
          location.assign(r.url);
        } catch (x) {
          say(err, x.message);
          pass.select();
        }
      });
    });

    // members (an invited admin, say) get in with their mcstats account instead of the password
    const slugOf = (v) => v.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s_-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const signIn = h('a', { href: '/account', text: 'Sign in to your mcstats account' });
    signIn.addEventListener('click', () => {
      const slug = slugOf(name.value);
      if (slug) signIn.href = `/account?${new URLSearchParams({ next: `/s/${slug}/` })}`;
    });
    const members = h('p', { class: 'site-hint site-more' }, 'Did the owner add you by email? ', signIn, ' instead: no server password needed.');

    main.replaceChildren(h('section', { class: 'card site-card' },
      h('h1', { class: 'site-title', text: 'Join a server' }),
      h('p', { class: 'site-sub', text: 'See its players, chat and fights. You need the server’s name and password from its owner.' }),
      form, members));
    (name.value ? pass : name).focus();
  }

  // ---------------- signing in to an mcstats account (/account, and the first step of /new) ----------------

  // A page of this site to go on to after signing in (never another site's address).
  const localPath = (v) => (typeof v === 'string' && /^\/(?![/\\])[A-Za-z0-9\-._~/?=&%]{0,200}$/.test(v) ? v : null);

  // The forms: sign in with a password; or prove the email with a code and choose a password, which is both
  // how an account is made and how a forgotten password is replaced. done(email) runs once signed in.
  //   next   where the link in the code email should lead on to
  //   start  { email, code } from that link: opens on choosing a password
  const MISMATCH = 'The two passwords aren’t the same.';
  function authForms({ next, start, done }) {
    const err = errorLine();
    const box = h('div', { class: 'auth' });
    let address = start?.email || '';

    const passwordField = (auto) => {
      const pw = input({ type: 'password', autocomplete: auto, required: true, minlength: auto === 'new-password' ? '8' : null, maxlength: '200' });
      const show = h('input', { type: 'checkbox' });
      show.addEventListener('change', () => { pw.type = show.checked ? 'text' : 'password'; });
      return { pw, show: h('label', { class: 'site-check auth-show' }, show, 'Show password') };
    };
    const link = (text, fn) => h('button', { type: 'button', class: 'auth-link', text, onclick: () => { say(err, ''); fn(); } });
    const draw = (title, form, ...links) => {
      box.replaceChildren(...[title && h('h2', { class: 'site-h2 auth-title', text: title }), form, err,
        links.length && h('p', { class: 'auth-links' }, ...links)].filter(Boolean));
      const first = [...form.querySelectorAll('input')].find((i) => !i.value && !i.readOnly && i.type !== 'checkbox');
      if (first) first.focus();
    };
    const submit = (form, btn, fn) => form.addEventListener('submit', (e) => {
      e.preventDefault();
      say(err, '');
      busy(btn, async () => {
        try { await fn(); } catch (x) { say(err, x.message); }
      });
    });

    function signIn() {
      const email = input({ type: 'email', name: 'email', autocomplete: 'username', required: true, value: address });
      const { pw, show } = passwordField('current-password');
      const go = h('button', { type: 'submit', class: 'btn btn-primary site-go', text: 'Sign in' });
      const form = h('form', { class: 'site-form' }, field('Email', email), field('Password', pw), show, go);
      email.addEventListener('input', () => { address = email.value; });
      submit(form, go, async () => {
        const r = await api('/api/account/login', { email: email.value, password: pw.value }).catch((x) => { pw.select(); throw x; });
        await done(r.email);
      });
      draw(null, form, link('Create an account', () => askCode('create')), link('Forgot password?', () => askCode('forgot')));
    }

    // what: 'create' | 'forgot'. The same thing happens either way; only the words differ.
    function askCode(what) {
      const email = input({ type: 'email', name: 'email', autocomplete: 'username', required: true, value: address });
      const go = h('button', { type: 'submit', class: 'btn btn-primary site-go', text: 'Email me a code' });
      const form = h('form', { class: 'site-form' },
        field('Email', email, what === 'create' ? 'We’ll email a code, to check the address is yours.' : 'We’ll email a code that lets you set a new password.'), go);
      submit(form, go, async () => {
        await api('/api/account/code', { email: email.value, ...(next && { next }) });
        address = email.value.trim();
        choose(what);
      });
      draw(what === 'create' ? 'Create an account' : 'Forgot password', form, link('Back to sign in', signIn));
    }

    function choose(what, code = '') {
      const email = input({ type: 'email', name: 'email', autocomplete: 'username', readonly: true, value: address });
      const codeIn = input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]{8,9}', maxlength: '9', placeholder: '12345678', required: true, value: code });
      const { pw, show } = passwordField('new-password');
      // typed twice, so a slip of the finger isn't the password
      const again = input({ type: 'password', autocomplete: 'new-password', required: true, maxlength: '200' });
      show.querySelector('input').addEventListener('change', () => { again.type = pw.type; });
      const go = h('button', { type: 'submit', class: 'btn btn-primary site-go', text: what === 'create' ? 'Create account' : 'Save and sign in' });
      const form = h('form', { class: 'site-form' },
        field('Email', email),
        field('The 8-digit code we emailed you', codeIn, code ? null : 'Or open the link in the email. Both work for 10 minutes.'),
        field(what === 'create' ? 'Choose a password' : 'New password', pw, 'At least 8 characters. A few words in a row is a good one.'),
        field('The password again', again), show, go);
      submit(form, go, async () => {
        if (pw.value !== again.value) { again.select(); throw new Error(MISMATCH); }
        const r = await api('/api/account/password', { email: address, code: codeIn.value, password: pw.value, confirm: again.value })
          .catch((x) => { (x.field === 'code' ? codeIn : x.field === 'confirm' ? again : pw).select(); throw x; });
        await done(r.email);
      });
      draw(what === 'create' ? 'Create an account' : what === 'forgot' ? 'Forgot password' : null, form,
        link('Send a new code', () => askCode(what === 'link' ? 'forgot' : what)), link('Back to sign in', signIn));
    }

    if (start) choose('link', start.code);
    else signIn();
    return box;
  }

  async function accountPage() {
    const next = localPath(params.get('next'));
    const me = emailed ? { email: null } : await api('/api/account/me').catch(() => ({ email: null }));
    if (!me.email) {
      main.replaceChildren(h('section', { class: 'card site-card' },
        h('h1', { class: 'site-title', text: emailed ? 'Choose a password' : 'Sign in' }),
        h('p', { class: 'site-sub', text: emailed ? `For the mcstats account of ${emailed.email}.` : 'One mcstats account for every server you’re part of, and for making your own.' }),
        authForms({ next, start: emailed, done: () => location.assign(next || '/account') })));
      return;
    }
    if (next) { location.replace(next); return; }

    const site = await api('/api/site/me').catch(() => ({ servers: [] }));
    const made = (site.servers || []).map((s) => h('li', {},
      h('a', { href: `/s/${s.slug}/`, text: s.name }), ' · ', h('a', { class: 'site-hint', href: `/new?server=${s.slug}`, text: s.step < 7 ? `finish setting up (step ${s.step} of 7)` : 'setup' })));

    const err = errorLine();
    const ok = h('p', { class: 'site-ok', role: 'status', hidden: true, text: 'Password changed. Your other devices were signed out.' });
    const user = input({ type: 'email', autocomplete: 'username', readonly: true, value: me.email, hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
    const current = input({ type: 'password', autocomplete: 'current-password', required: true, maxlength: '200' });
    const fresh = input({ type: 'password', autocomplete: 'new-password', required: true, minlength: '8', maxlength: '200' });
    const again = input({ type: 'password', autocomplete: 'new-password', required: true, maxlength: '200' });
    const save = h('button', { type: 'submit', class: 'btn', text: 'Change password' });
    const change = h('form', { class: 'site-form' }, user, field('Current password', current), field('New password', fresh, 'At least 8 characters.'),
      field('The new password again', again), save, err, ok);
    change.addEventListener('submit', (e) => {
      e.preventDefault();
      say(err, '');
      ok.hidden = true;
      if (fresh.value !== again.value) { say(err, MISMATCH); again.select(); return; }
      busy(save, async () => {
        try {
          await api('/api/account/change', { current: current.value, password: fresh.value, confirm: again.value });
          current.value = fresh.value = again.value = '';
          ok.hidden = false;
        } catch (x) {
          say(err, x.message);
          (x.field === 'current' ? current : x.field === 'confirm' ? again : fresh).select();
        }
      });
    });
    const out = (path, text) => h('button', { type: 'button', class: 'btn', text, onclick: async () => { await api(path, {}).catch(() => {}); location.assign('/'); } });

    main.replaceChildren(h('section', { class: 'card site-card acct-page' },
      h('h1', { class: 'site-title', text: 'Your account' }),
      h('p', { class: 'site-sub', text: `Signed in as ${me.email}` }),
      h('h2', { class: 'site-h2', text: 'Your servers' }),
      h('p', { class: 'site-sub', text: 'Every server you’ve made, joined or added, with who’s on and your role in each.' }),
      h('div', { class: 'site-row' }, h('a', { class: 'btn btn-primary', href: '/servers', text: 'Open your servers' }),
        h('a', { class: 'btn', href: '/new?fresh=1', text: 'Create a server' }), h('a', { class: 'btn', href: '/join', text: 'Join a server' })),
      made.length ? h('h2', { class: 'site-h2', text: 'Setting up the ones you made' }) : null,
      made.length ? h('ul', { class: 'wiz-mine' }, made) : null,
      h('h2', { class: 'site-h2', text: 'Password' }), change,
      h('h2', { class: 'site-h2', text: 'Sign out' }),
      h('p', { class: 'site-sub', text: '“Everywhere” also signs out your other browsers and devices.' }),
      h('div', { class: 'site-row' }, out('/api/account/logout', 'Sign out'), out('/api/account/logout-all', 'Sign out everywhere'))));
  }

  // ---------------- /servers: the account's own list ----------------
  // Each row: the server (a link to it), your role there, who's on now, and Remove. Dragged by its grip to
  // reorder (or the grip's arrow keys). Who's on is asked for again every minute.
  const ROLE = {
    owner: ['Owner', 'You made this server.'],
    admin: ['Admin', 'You can use its Admin page.'],
    member: ['Member', 'Signed in here: you can chat from the website.'],
    super: ['Site admin', 'You run mcstats, so you can do everything here.'],
    viewer: ['Joined', 'You joined with the server’s password. Sign in on its page to chat.'],
    visitor: ['Visitor', 'A public server you added. Sign in on its page to chat.'],
    none: ['No access', 'You can’t see this server right now.'],
  };
  const roleOf = (s) => (s.role && ROLE[s.role] ? s.role : s.super ? 'super' : s.access === false ? 'none' : s.viewer ? 'viewer' : s.public ? 'visitor' : 'none');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // the same player heads the stats page uses (minotar, then mc-heads if that fails), drawn at a whole multiple
  const playerHead = (name) => {
    const img = h('img', { class: 'my-head', src: `https://minotar.net/helm/${encodeURIComponent(name)}/32`, alt: '', width: '16', height: '16', loading: 'lazy', title: name });
    img.addEventListener('error', () => { if (!img.dataset.retry) { img.dataset.retry = '1'; img.src = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/32`; } });
    return img;
  };

  function onlineCell(s) {
    if (s.access == null) return h('div', { class: 'my-online' }, h('span', { class: 'my-status' }, h('span', { class: 'my-dot' }), 'Couldn’t load it'));
    if (!s.access) {
      return h('div', { class: 'my-online' },
        h('span', { class: 'my-status' }, h('span', { class: 'my-dot' }), 'Can’t see it now'),
        h('a', { class: 'my-again', href: `/join?server=${encodeURIComponent(s.slug)}`, text: 'Join again' }));
    }
    const text = s.status === 'up' ? (s.online ? `${s.online}${s.max ? ` / ${s.max}` : ''} online` : 'Nobody on')
      : s.status === 'down' ? 'Offline' : s.status === 'paused' ? 'Paused' : 'No status yet';
    const title = s.status === 'unknown' ? 'The server hasn’t been checked lately: it has no address set, or the mod isn’t sending.' : null;
    const heads = (s.players || []).map(playerHead);
    return h('div', { class: 'my-online' },
      h('span', { class: 'my-status', title, 'data-state': s.status }, h('span', { class: 'my-dot' }), text),
      heads.length ? h('span', { class: 'my-heads', 'aria-label': `On now: ${s.players.join(', ')}${s.more ? ` and ${plural(s.more, 'other', 'others')}` : ''}` },
        ...heads, s.more ? h('span', { class: 'my-more', text: `+${s.more}` }) : null) : null);
  }

  async function serversPage() {
    const me = emailed ? { email: null } : await api('/api/account/me').catch(() => ({ email: null }));
    if (!me.email) {
      main.replaceChildren(h('section', { class: 'card site-card' },
        h('h1', { class: 'site-title', text: 'Your servers' }),
        h('p', { class: 'site-sub', text: 'Sign in to see the servers you’ve made, joined or added, all in one place.' }),
        authForms({ next: '/servers', start: emailed, done: () => location.assign('/servers') })));
      return;
    }
    const err = errorLine();
    const list = h('ol', { class: 'my-list', 'aria-label': 'Your servers' });
    const empty = h('div', { class: 'my-empty', hidden: true },
      h('p', { class: 'site-sub', text: 'Nothing here yet. Servers you make or join show up by themselves, and every server’s page has an “Add to my servers” button at the top.' }));
    const rows = new Map(); // slug -> { li, name, meta, online }
    let dragging = null;

    // ---- saving the order: a moment after the last move, so a few quick ones are one request ----
    let orderTimer = 0;
    const order = () => [...list.children].map((li) => li.dataset.slug);
    const saveOrder = () => {
      clearTimeout(orderTimer);
      orderTimer = setTimeout(async () => {
        try {
          say(err, '');
          await api('/api/site/mine/order', { servers: order() });
        } catch (x) {
          say(err, `The new order wasn’t saved: ${x.message}`);
          load();
        }
      }, 400);
    };

    // ---- one row ----
    function fill(r, s) {
      const role = roleOf(s);
      r.name.textContent = s.name;
      r.name.href = `/s/${s.slug}/`;
      // (replaceChildren writes a null out as text, so the parts that may be missing are filtered first)
      r.meta.replaceChildren(...[
        h('span', { class: `my-role my-role-${role}`, text: ROLE[role][0], title: ROLE[role][1] }),
        h('span', { class: 'my-slug', text: `/s/${s.slug}` }),
        s.owner && s.step != null && s.step < 7 ? h('a', { class: 'my-setup', href: `/new?server=${encodeURIComponent(s.slug)}`, text: `Finish setting up (step ${s.step} of 7)` }) : null,
        s.owner && s.step === 7 ? h('a', { class: 'my-setup', href: `/new?server=${encodeURIComponent(s.slug)}&step=6`, text: 'Setup' }) : null,
      ].filter(Boolean));
      const cell = onlineCell(s);
      r.online.replaceWith(cell);
      r.online = cell;
      r.grip.setAttribute('aria-label', `Move ${s.name}`);
      r.remove.setAttribute('aria-label', `Remove ${s.name} from your servers`);
    }

    function makeRow(s) {
      const li = h('li', { class: 'my-row', 'data-slug': s.slug });
      const grip = h('button', { type: 'button', class: 'my-grip', title: 'Drag to move, or use the arrow keys' });
      const name = h('a', { class: 'my-name' });
      const meta = h('div', { class: 'my-meta' });
      const online = h('div', { class: 'my-online' });
      // two clicks: the first asks, in red, for a few seconds
      const remove = h('button', { type: 'button', class: 'btn btn-quiet my-remove', text: 'Remove' });
      let armed = 0;
      remove.addEventListener('click', async () => {
        if (!armed) {
          remove.classList.add('armed');
          remove.textContent = 'Remove?';
          armed = setTimeout(() => { armed = 0; remove.classList.remove('armed'); remove.textContent = 'Remove'; }, 3000);
          return;
        }
        clearTimeout(armed);
        remove.disabled = true;
        try {
          await api('/api/site/mine/remove', { server: s.slug });
          const next = li.nextElementSibling?.querySelector('.my-grip') || li.previousElementSibling?.querySelector('.my-grip');
          li.remove();
          rows.delete(s.slug);
          empty.hidden = rows.size > 0;
          next?.focus();
        } catch (x) {
          say(err, x.message);
          remove.disabled = false;
        }
      });
      li.append(grip, h('div', { class: 'my-main' }, name, meta), online, remove);
      const r = { li, grip, name, meta, online, remove };
      fill(r, s);
      dragBy(grip, li);
      return r;
    }

    // ---- moving rows: drag the grip (mouse, pen or finger), or its arrow keys ----
    function move(li, by) {
      const to = by < 0 ? li.previousElementSibling : li.nextElementSibling?.nextElementSibling ?? null;
      if (by < 0 && !to) return false;
      if (by > 0 && !li.nextElementSibling) return false;
      list.insertBefore(li, to);
      return true;
    }
    function dragBy(grip, li) {
      grip.addEventListener('keydown', (e) => {
        const by = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        if (!by) return;
        e.preventDefault();
        if (move(li, by)) { grip.focus(); saveOrder(); }
      });
      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        const start = order().join();
        dragging = li;
        li.classList.add('dragging');
        const onMove = (ev) => {
          // Past the middle of the row above or below: swap with it. It's always the other row that's moved:
          // taking the dragged row out of the page, even for a moment, would let go of the pointer.
          const prev = li.previousElementSibling, next = li.nextElementSibling;
          if (prev) { const b = prev.getBoundingClientRect(); if (ev.clientY < b.top + b.height / 2) { list.insertBefore(prev, next); return; } }
          if (next) { const b = next.getBoundingClientRect(); if (ev.clientY > b.top + b.height / 2) list.insertBefore(next, li); }
        };
        const onUp = () => {
          for (const [t, f] of ends) grip.removeEventListener(t, f);
          li.classList.remove('dragging');
          dragging = null;
          if (order().join() !== start) saveOrder();
        };
        const ends = [['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp], ['lostpointercapture', onUp]];
        for (const [t, f] of ends) grip.addEventListener(t, f);
      });
    }

    // ---- loading, and again every minute for who's on ----
    async function load() {
      let r;
      try {
        r = await api('/api/site/mine');
      } catch (x) {
        say(err, x.message);
        return;
      }
      if (dragging) return; // not while a row is in someone's hand; the next minute will do
      const seen = new Set();
      for (const s of r.servers) {
        seen.add(s.slug);
        const row = rows.get(s.slug);
        if (row) fill(row, s);
        else rows.set(s.slug, makeRow(s));
      }
      for (const [slug, row] of rows) if (!seen.has(slug)) { row.li.remove(); rows.delete(slug); }
      // in the order the server has (the same as on screen, unless it changed in another tab)
      for (const s of r.servers) list.append(rows.get(s.slug).li);
      empty.hidden = rows.size > 0;
    }

    main.replaceChildren(h('section', { class: 'card site-card my-page' },
      h('h1', { class: 'site-title', text: 'Your servers' }),
      h('p', { class: 'site-sub', text: 'The servers you’ve made, joined or added. Drag one by its handle to change the order.' }),
      list, empty, err,
      h('p', { class: 'site-hint my-note', text: 'Removing a server only takes it off this list: you keep whatever you are there, and can add it again from its page.' }),
      h('div', { class: 'site-row' }, h('a', { class: 'btn', href: '/join', text: 'Join a server' }), h('a', { class: 'btn', href: '/new?fresh=1', text: 'Create a server' }))));
    await load();
    setInterval(() => { if (!document.hidden) load(); }, 60_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  }

  // ---------------- /new ----------------
  const STEPS = ['Your account', 'Name the server', 'Install the mods', 'Connect the mod', 'First upload', 'Optional setup', 'Done'];
  const W = { me: null, server: null, view: 1, key: null, mod: null, poll: null, waitingSince: null };

  function stepper() {
    const current = W.server ? W.server.step : (W.me?.email ? 2 : 1);
    return h('ol', { class: 'wiz-steps', 'aria-label': 'Steps' }, STEPS.map((label, i) => {
      const n = i + 1;
      const done = n < current || (n === 7 && current === 7 && W.view === 7);
      const can = W.server ? n >= 3 && n <= current : n === W.view;
      const state = n === W.view ? 'now' : done ? 'done' : 'todo';
      const mark = h('span', { class: 'wiz-n', text: state === 'done' ? '' : String(n) }); // done: a pixel check, drawn in CSS
      const inner = can && n !== W.view
        ? h('button', { type: 'button', class: 'wiz-step-btn', onclick: () => show(n) }, mark, label)
        : h('span', { class: 'wiz-step-btn' }, mark, label);
      return h('li', { class: `wiz-step ${state}`, 'aria-current': n === W.view ? 'step' : null }, inner);
    }));
  }

  function frame(title, sub, ...body) {
    main.replaceChildren(
      h('div', { class: 'wiz' },
        h('nav', { class: 'wiz-nav' }, stepper(), W.me?.email ? accountLine() : null),
        h('section', { class: 'card site-card wiz-panel' },
          h('h1', { class: 'site-title', text: title }),
          sub ? h('p', { class: 'site-sub', text: sub }) : null,
          ...body)));
    const first = main.querySelector('.wiz-panel input, .wiz-panel select, .wiz-panel textarea');
    if (first && !first.readOnly) first.focus();
  }

  function accountLine() {
    const out = h('button', { type: 'button', class: 'btn btn-quiet', text: 'Sign out' });
    out.addEventListener('click', async () => { await api('/api/account/logout', {}); location.assign('/new'); });
    const mine = (W.me.servers || []).map((s) => h('li', {}, h('a', { href: `/new?server=${s.slug}`, text: s.name }), s.step < 7 ? h('span', { class: 'site-hint', text: ` · step ${s.step} of 7` }) : null));
    return h('div', { class: 'wiz-account' },
      h('p', { class: 'site-hint', text: `Signed in as ${W.me.email}` }),
      mine.length ? h('div', {}, h('p', { class: 'site-label', text: 'Your servers' }), h('ul', { class: 'wiz-mine' }, mine),
        mine.length < W.me.max ? h('a', { href: '/new?fresh=1', class: 'site-hint', text: '+ Make another' }) : null) : null,
      out);
  }

  async function refreshServer() {
    W.server = await api(`/api/site/servers/${W.server.slug}`);
    return W.server;
  }

  async function show(n) {
    clearInterval(W.poll);
    W.poll = null;
    W.view = n;
    if (W.server && n >= 3 && W.server.step < n) await api(`/api/site/servers/${W.server.slug}/step`, { step: n }).then((s) => { W.server = s; });
    const url = new URL(location.href);
    if (W.server) url.searchParams.set('server', W.server.slug);
    url.searchParams.set('step', String(n));
    url.searchParams.delete('fresh');
    history.replaceState(null, '', url);
    ({ 1: stepEmail, 2: stepName, 3: stepInstall, 4: stepKey, 5: stepWait, 6: stepOptional, 7: stepDone })[n]();
  }
  const next = (n) => h('button', { type: 'button', class: 'btn btn-primary site-go', text: 'Next', onclick: () => show(n) });

  function stepEmail() {
    frame('Make a server', 'First, sign in to your mcstats account, or create one. You’ll be the server’s owner.',
      authForms({ next: '/new', done: async () => { W.me = await api('/api/site/me'); markAccount(W.me.email); show(2); } }));
  }

  // Who can see the stats: a pair of choices, the picked one greyer with a green line under it.
  function visibilityChoice(initial, onChange) {
    const group = h('div', { class: 'wiz-vis', role: 'radiogroup', 'aria-label': 'Who can see the stats' });
    const opt = (value, title, text) => {
      const radio = h('input', { type: 'radio', name: 'visibility', value, class: 'wiz-vis-radio' });
      radio.checked = value === initial;
      radio.addEventListener('change', () => onChange(value));
      return h('label', { class: 'wiz-vis-opt' }, radio, h('span', { class: 'wiz-vis-title', text: title }), h('span', { class: 'wiz-vis-text', text }));
    };
    group.append(
      opt('private', 'Private', 'Players need the join password to see the stats.'),
      opt('public', 'Public', 'Anyone with the address can see the stats. Chatting and admin still need a sign-in.'));
    return group;
  }

  function stepName() {
    if (W.server) return show(3);
    if (W.me.servers.length >= W.me.max && !W.me.super) {
      return frame('Name the server', null, h('p', { class: 'site-sub', text: `You have ${W.me.max} servers, which is as many as one person can have.` }));
    }
    const err = errorLine();
    const name = input({ required: true, maxlength: '60', autocomplete: 'off' });
    const slug = h('input', { class: 'wiz-url-input', required: true, maxlength: '32', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-describedby': 'wiz-slug-status' });
    const status = h('span', { class: 'wiz-slug-status', id: 'wiz-slug-status', 'aria-live': 'polite' });
    const pass = input({ type: 'password', minlength: '8', autocomplete: 'new-password' });
    const confirm = input({ type: 'password', minlength: '8', autocomplete: 'new-password' });
    let visibility = 'private';
    let slugTouched = false;
    let free = null; // the last answer: { slug, ok, error }
    const slugify = (v) => v.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s_-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

    // ask whether the address is free, a moment after typing stops
    let timer = 0, asked = 0;
    const checkSlug = () => {
      clearTimeout(timer);
      free = null;
      const v = slug.value;
      if (!v) { status.className = 'wiz-slug-status'; status.textContent = 'Players open the stats at this address.'; return; }
      status.className = 'wiz-slug-status';
      status.textContent = 'Checking…';
      timer = setTimeout(async () => {
        const n = ++asked;
        try {
          const r = await api(`/api/site/slug?name=${encodeURIComponent(v)}`);
          if (n !== asked) return;
          free = r;
          if (r.slug !== v) slug.value = r.slug;
          status.className = `wiz-slug-status ${r.ok ? 'ok' : 'bad'}`;
          status.textContent = r.ok ? `${location.host}/s/${r.slug}/ is free.` : r.error;
        } catch (x) {
          if (n === asked) { status.className = 'wiz-slug-status bad'; status.textContent = x.message; }
        }
      }, 350);
    };
    name.addEventListener('input', () => { if (!slugTouched) { slug.value = slugify(name.value); checkSlug(); } });
    slug.addEventListener('input', () => {
      slugTouched = true;
      const at = slug.selectionStart;
      slug.value = slug.value.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
      slug.setSelectionRange(at, at);
      checkSlug();
    });
    checkSlug();

    const passBox = h('div', { class: 'site-form wiz-pass' },
      field('Join password', pass, 'Players type it once to see the stats. At least 8 characters.'),
      field('The password again', confirm));
    const publicNote = h('p', { class: 'site-hint wiz-pass-note', hidden: true, text: 'No password needed. If you make it private later, you’ll set one then.' });
    const syncVis = (v) => {
      visibility = v;
      passBox.hidden = v === 'public';
      publicNote.hidden = v !== 'public';
      pass.required = confirm.required = v === 'private';
    };
    syncVis(visibility);

    const go = h('button', { type: 'submit', class: 'btn btn-primary site-go', text: 'Make the server' });
    const fields = { name, slug, password: pass, confirm };
    const form = h('form', { class: 'site-form' },
      field('Display name', name, 'Shown on its pages, e.g. “Egg SMP”.'),
      h('label', { class: 'site-field' }, h('span', { class: 'site-label', text: 'Address' }),
        h('span', { class: 'wiz-url' }, h('span', { class: 'wiz-url-host', text: `${location.host}/s/` }), slug), status),
      h('fieldset', { class: 'site-field wiz-fieldset' }, h('legend', { class: 'site-label', text: 'Who can see the stats' }), visibilityChoice(visibility, syncVis)),
      passBox, publicNote,
      go, err);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      say(err, '');
      if (free && !free.ok && free.slug === slug.value) { say(err, free.error); slug.focus(); return; }
      if (visibility === 'private' && pass.value !== confirm.value) { say(err, 'The two passwords aren’t the same.'); confirm.focus(); return; }
      busy(go, async () => {
        try {
          const body = { name: name.value, slug: slug.value, visibility };
          if (visibility === 'private') Object.assign(body, { password: pass.value, confirm: confirm.value });
          const r = await api('/api/site/servers', body);
          W.me = await api('/api/site/me');
          W.server = { slug: r.server.slug };
          await refreshServer();
          show(3);
        } catch (x) {
          say(err, x.message);
          if (x.field === 'slug') checkSlug();
          fields[x.field]?.focus();
        }
      });
    });
    frame('Name the server', 'Pick its address and who can see it. You can change who can see it later.', form);
  }

  // What the server needs and where the jar goes, read from the mod itself (/api/site/mod). With checks, each
  // item can be ticked off (/new); without, it's a plain numbered list (/mod).
  function installList(m, checks) {
    const item = (title, ...body) => h('li', { class: 'wiz-check' },
      checks ? h('label', { class: 'wiz-check-head' }, h('input', { type: 'checkbox' }), h('span', { text: title }))
        : h('div', { class: 'wiz-check-head mod-head' }, h('span', { text: title })),
      h('div', { class: 'wiz-check-body' }, ...body));
    const code = (t) => h('code', { text: t });
    const extra = Object.entries(m.other_depends || {});
    return h('ol', { class: checks ? 'wiz-checks' : 'wiz-checks mod-steps' },
      item(`Minecraft ${m.minecraft.replace(/^~/, '')}.x (Java Edition)`,
        h('p', {}, 'The server must run Minecraft ', code(m.minecraft_built), ' (any ', code(`${m.minecraft_built}.x`), ' release; the mod asks for ', code(m.minecraft), '), on Java ', code(m.java.replace('>=', '')), ' or newer.')),
      item(`Fabric Loader ${m.loader.replace('>=', '')} or newer`,
        h('p', {}, 'The server needs the Fabric mod loader, version ', code(m.loader.replace('>=', '')), ' or newer (the mod is built with ', code(m.loader_built), '). Install it with the ', h('a', { href: m.loader_installer, target: '_blank', rel: 'noopener', text: 'official Fabric server installer' }), '. Many hosting panels can switch a server to Fabric for you.')),
      item('Fabric API: not needed',
        h('p', {}, 'The pieces of Fabric API the mod uses (', code(m.fabric_api.version), ') are built into its jar. If the server has Fabric API already, that’s fine too.')),
      extra.length ? item('Other mods it needs', h('ul', {}, extra.map(([k, v]) => h('li', {}, code(k), ' ', code(String(v)))))) : null,
      item(`The mcstats mod ${m.version}`,
        h('p', {}, h('a', { class: 'btn btn-primary', href: m.jar_url, download: m.jar, text: `Download ${m.jar}` }))),
      item('Put it in the server’s mods folder, and restart',
        h('p', {}, 'Copy ', code(m.jar), ' into the ', code('mods/'), ' folder of the ', h('strong', { text: 'server' }), ' (next to its ', code('server.properties'), '), then restart the server. Players don’t install anything.'),
        h('p', {}, 'On its first start the mod makes ', code(m.config_file), checks ? '; the next step fills it in.' : '; setting up your server’s page fills it in.')));
  }

  async function stepInstall() {
    W.mod ||= await api('/api/site/mod');
    frame('Install the mods', 'On the Minecraft server, not on players’ games. These are read from the mod itself, so they’re exact.',
      installList(W.mod, true), next(4));
  }

  // ---------------- /mod: the mod by itself, for whoever came looking for it ----------------
  async function modPage() {
    const m = await api('/api/site/mod');
    const me = await api('/api/site/me').catch(() => ({ servers: [] }));
    const mine = (me.servers || []).map((s) => h('li', {}, h('a', { href: `/new?server=${s.slug}&step=4`, text: s.name }), h('span', { class: 'site-hint', text: ' · make or replace its key' })));
    main.replaceChildren(h('section', { class: 'card site-card mod-page' },
      h('h1', { class: 'site-title', text: 'The mcstats mod' }),
      h('p', { class: 'site-sub', text: 'It runs on the Minecraft server and sends what happens there to the server’s mcstats page. It’s for whoever runs the server: players don’t install anything.' }),
      h('div', { class: 'mod-get' },
        h('a', { class: 'btn btn-primary site-go', href: m.jar_url, download: m.jar, text: `Download mcstats ${m.version}` }),
        h('span', { class: 'site-hint', text: `${m.jar} · Minecraft ${m.minecraft_built}.x · Fabric · server side` })),
      h('h2', { class: 'site-h2', text: 'Installing it' }),
      installList(m, false),
      h('h2', { class: 'site-h2', text: 'Connecting it' }),
      h('p', { class: 'site-sub', text: 'The mod needs your server’s key to know where to send things. You get the key, and the file to put it in, when you set up the server’s page.' }),
      mine.length ? h('ul', { class: 'wiz-mine' }, mine) : null,
      h('div', { class: 'site-row' }, h('a', { class: 'btn', href: mine.length ? '/new?fresh=1' : '/new', text: 'Create a server' }))));
  }

  function stepKey() {
    const s = W.server;
    const err = errorLine();
    const out = h('div', { class: 'wiz-key' });
    const make = h('button', { type: 'button', class: 'btn btn-primary', text: s.info.key_created_at ? 'Make a new key' : 'Make the key' });
    const shown = (r) => {
      W.key = r;
      const area = h('textarea', { class: 'adm-input wiz-config', readonly: true, rows: '12', spellcheck: 'false' });
      area.value = r.config;
      out.replaceChildren(
        h('p', { class: 'wiz-warn', text: 'This key is shown only now. Copy it somewhere safe; if it’s lost, make a new one.' }),
        h('div', { class: 'wiz-keyline' }, h('code', { class: 'wiz-keytext', text: r.key }), copyButton(() => r.key, 'Copy key')),
        h('p', {}, 'Open ', h('code', { text: r.config_file }), ' in the Minecraft server’s folder and replace everything in it with this (or set just its ', h('code', { text: 'url=' }), ' and ', h('code', { text: 'token=' }), ' lines). The mod picks it up within a few seconds; no restart needed.'),
        area, h('p', {}, copyButton(() => r.config, 'Copy the file')));
    };
    make.addEventListener('click', () => {
      if (s.info.key_created_at && !confirm('Make a new key? The old key stops working at once, so the server stops uploading until you put the new one in.')) return;
      say(err, '');
      busy(make, async () => {
        try {
          const r = await api(`/api/site/servers/${s.slug}/key`, {});
          W.server = r.state;
          shown(r);
          make.textContent = 'Make a new key';
        } catch (x) { say(err, x.message); }
      });
    });
    if (W.key) shown(W.key);
    else if (s.info.key_created_at) out.append(h('p', { class: 'site-sub', text: `A key was made ${fmtTime(s.info.key_created_at)}. It isn’t shown again; make a new one if you need it (the old one stops working at once).` }));
    frame('Connect the mod', 'The key tells the site that uploads come from your server. Only uploads with it reach your server’s stats.',
      h('div', { class: 'site-row' }, make), out, err,
      h('div', { class: 'site-row' }, next(5)));
  }

  async function stepWait() {
    // where the mod is told to upload (the site's main address, whichever one this page is open at)
    W.mod ||= await api('/api/site/mod').catch(() => null);
    const upload = W.mod?.ingest_url || `${location.origin}/api/ingest/chat`;
    const status = h('div', { class: 'wiz-wait', 'aria-live': 'polite' });
    const tips = h('div', { class: 'wiz-tips', hidden: true },
      h('p', { class: 'site-label', text: 'Nothing yet? Check:' }),
      h('ul', {},
        h('li', {}, h('strong', { text: 'The key. ' }), 'The ', h('code', { text: 'token=' }), ' line must be the whole key, starting ', h('code', { text: 'mcs_' }), ', from the last time you made one. The server’s log says “the token isn’t this server’s key” if not.'),
        h('li', {}, h('strong', { text: 'The url. ' }), 'It must be ', h('code', { text: upload }), '.'),
        h('li', {}, h('strong', { text: 'The mod loaded. ' }), 'Look in the server log, just after it starts, for “mcstats”. If it isn’t there, the jar isn’t in ', h('code', { text: 'mods/' }), ', the server isn’t on Fabric, or its Minecraft or Java version is wrong.'),
        h('li', {}, h('strong', { text: 'Something happens. ' }), 'The mod sends chat, joins and leaves as they happen. Join the server or say something in chat.'),
        h('li', {}, h('strong', { text: 'Outgoing HTTPS. ' }), 'Some hosts block connections from the server to the internet. It needs to reach ', h('code', { text: new URL(upload).host }), ' on port 443.')));
    const go = next(6);
    go.hidden = true;
    W.waitingSince ||= Date.now();
    const draw = () => {
      const i = W.server.info;
      if (i.first_upload_at) {
        status.className = 'wiz-wait ok';
        status.replaceChildren(h('span', { class: 'wiz-dot' }), h('span', { text: `Connected. The first upload arrived ${fmtTime(i.first_upload_at)}.` }));
        go.hidden = false;
        tips.hidden = true;
        clearInterval(W.poll);
      } else {
        status.className = 'wiz-wait';
        status.replaceChildren(h('span', { class: 'wiz-dot' }), h('span', { text: 'Waiting for your server… Join it or say something in chat.' }));
        tips.hidden = Date.now() - W.waitingSince < 3 * 60_000;
      }
    };
    frame('Waiting for the first upload', 'This turns green when an upload with your server’s key arrives.', status, tips,
      h('div', { class: 'site-row' }, go, h('button', { type: 'button', class: 'btn btn-quiet', text: 'Skip for now', onclick: () => show(6) })));
    draw();
    W.poll = setInterval(async () => {
      try { await refreshServer(); draw(); } catch { /* try again */ }
    }, 5000);
  }

  function stepOptional() {
    const s = W.server;
    const set = s.info.settings || {};
    const err = errorLine();
    const ok = h('p', { class: 'site-ok', role: 'status', hidden: !W.saved, text: 'Saved.' });
    W.saved = false;
    const name = input({ value: s.name, maxlength: '60' });
    const address = input({ value: s.info.mc_server || '', placeholder: 'play.example.com or 1.2.3.4:25565', autocapitalize: 'none', spellcheck: 'false' });
    const tz = input({ value: set.TZ_NAME || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', autocapitalize: 'none', spellcheck: 'false' });
    let vis = s.info.public ? 'public' : 'private';
    const pass = input({ type: 'password', autocomplete: 'new-password', minlength: '8' });
    const confirm2 = input({ type: 'password', autocomplete: 'new-password', minlength: '8' });
    const passWrap = h('details', { class: 'site-more' }, h('summary', { text: s.has_password ? 'Change the join password' : 'Set a join password' }),
      field(s.has_password ? 'New join password' : 'Join password', pass, s.has_password ? 'Everyone who joined with the old one has to join again.' : 'Needed to make it private.'),
      field('The password again', confirm2));
    const needPass = h('p', { class: 'site-hint', hidden: true, text: 'This server has no join password yet: set one to make it private.' });
    const pick = (v) => {
      vis = v;
      const must = v === 'private' && !s.has_password;
      needPass.hidden = !must;
      if (must) passWrap.open = true;
      pass.required = confirm2.required = must;
    };
    const save = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Save' });
    const form = h('form', { class: 'site-form' },
      field('Display name', name),
      field('Server address', address, 'For the online count and charts: the site checks the server once a minute. Leave blank to skip.'),
      field('Time zone', tz, 'Times on the pages are shown in it, e.g. Europe/London.'),
      h('fieldset', { class: 'site-field wiz-fieldset' }, h('legend', { class: 'site-label', text: 'Who can see the stats' }), visibilityChoice(vis, pick), needPass),
      passWrap,
      h('div', { class: 'site-row' }, save), err, ok);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      say(err, '');
      ok.hidden = true;
      busy(save, async () => {
        try {
          const body = { NAME: name.value, MC_SERVER: address.value, TZ_NAME: tz.value, PUBLIC: vis === 'public' ? '1' : '' };
          if (pass.value) Object.assign(body, { password: pass.value, confirm: confirm2.value });
          W.server = await api(`/api/site/servers/${s.slug}/settings`, body);
          W.saved = true;
          stepOptional(); // drawn again: whether it has a password may have changed
        } catch (x) { say(err, x.message); }
      });
    });

    const iErr = errorLine();
    const iOk = h('p', { class: 'site-ok', role: 'status', hidden: true });
    const iEmail = input({ type: 'email', autocomplete: 'off', placeholder: 'friend@example.org' });
    const iRole = h('select', { class: 'adm-input' }, h('option', { value: 'admin', text: 'Admin' }), h('option', { value: 'member', text: 'Member' }));
    const iGo = h('button', { type: 'submit', class: 'btn', text: 'Invite' });
    const invite = h('form', { class: 'site-form' },
      h('div', { class: 'site-inline' }, iEmail, iRole, iGo),
      h('span', { class: 'site-hint', text: 'They get an email, and sign in to mcstats with that address (making an account if they don’t have one). Admins can use the Admin page; you can change anyone’s access later on its Roles tab.' }),
      iErr, iOk);
    invite.addEventListener('submit', (e) => {
      e.preventDefault();
      say(iErr, '');
      iOk.hidden = true;
      busy(iGo, async () => {
        try {
          await api(`/api/site/servers/${s.slug}/invite`, { email: iEmail.value, role: iRole.value });
          iOk.textContent = `Invited ${iEmail.value}.`;
          iOk.hidden = false;
          iEmail.value = '';
        } catch (x) { say(iErr, x.message); }
      });
    });

    frame('Optional setup', 'All of this can be changed later here, from “Your servers”.',
      form,
      h('h2', { class: 'site-h2', text: 'Invite admins' }), invite,
      h('h2', { class: 'site-h2', text: 'Roster, teams and chat rules' }),
      h('p', { class: 'site-sub', text: 'Who’s on which team, players’ real names, hidden players and which chat lines to leave out are on the server’s own Admin page, once you’ve opened it (the last step).' }),
      h('div', { class: 'site-row' }, next(7)));
  }

  function stepDone() {
    const s = W.server;
    const share = s.info.public
      ? `See our server’s stats on mcstats: ${s.url}`
      : `See our server’s stats on mcstats: ${location.origin}/join?server=${s.slug}\nServer name: ${s.slug}\nPassword: (ask me)`;
    const open = h('button', { type: 'button', class: 'btn btn-primary site-go', text: 'Open my server' });
    open.addEventListener('click', () => busy(open, async () => {
      const r = await api(`/api/site/servers/${s.slug}/open`, {});
      location.assign(r.url);
    }));
    const area = h('textarea', { class: 'adm-input wiz-config', readonly: true, rows: '3' });
    area.value = share;
    frame('Done', `${s.name} is set up.`,
      h('p', {}, 'Its address: ', h('a', { href: s.url, text: s.url })),
      h('p', { class: 'site-sub', text: s.info.public ? 'It’s public: anyone with the address can see the stats.' : 'It’s private: players need the join password to see the stats.' }),
      h('p', { class: 'site-label', text: s.info.public ? 'Send this to your players:' : 'Send this to your players (with the password):' }),
      area, h('div', { class: 'site-row' }, copyButton(() => share, 'Copy'), open));
  }

  async function newPage() {
    W.me = await api('/api/site/me').catch(() => ({ email: null, servers: [] }));
    if (!W.me.email) return show(1);
    const want = params.get('server');
    const pick = want ? W.me.servers.find((x) => x.slug === want) : (!params.has('fresh') && W.me.servers.find((x) => x.step < 7));
    if (pick || (want && W.me.super)) {
      W.server = { slug: pick?.slug || want };
      try {
        await refreshServer();
      } catch {
        W.server = null;
        return show(2);
      }
      const asked = Number(params.get('step'));
      return show(asked >= 3 && asked <= W.server.step ? asked : Math.max(3, W.server.step));
    }
    show(2);
  }

  // The top bar says who's signed in, on every one of these pages: a link to /account.
  const acct = h('a', { class: 'btn btn-quiet acct-btn top-acct', href: '/account', hidden: true });
  const mineLink = h('a', { class: 'btn btn-quiet top-acct top-mine', href: '/servers', hidden: true, 'aria-current': page === 'servers' ? 'page' : null });
  toggle?.before(mineLink, acct);
  function markAccount(email) {
    mineLink.hidden = !email;
    mineLink.textContent = matchMedia('(max-width: 640px)').matches ? 'Servers' : 'Your servers';
    // on a phone the bar has no room for an address
    acct.textContent = email ? (matchMedia('(max-width: 640px)').matches ? 'Account' : email) : 'Sign in';
    acct.title = email ? `Signed in as ${email}` : '';
    acct.hidden = page === 'account' && !email;
  }
  api('/api/account/me').then((me) => markAccount(me.email), () => {});
  const fail = (x) => main.replaceChildren(h('section', { class: 'card site-card' }, h('p', { class: 'site-err', text: x.message })));

  if (page === 'join') joinPage();
  else if (page === 'account') accountPage().catch(fail);
  else if (page === 'new') newPage().catch(fail);
  else if (page === 'mod') modPage().catch(fail);
  else if (page === 'servers') serversPage().catch(fail);
})();
