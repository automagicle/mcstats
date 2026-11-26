// Runs before app.js on a server's stats page (/s/<server>/). The Worker puts window.MCS on the page:
// { base: '/s/<server>', slug, name, season, email, account, public }. email: who they are on this server (a
// member); account: the mcstats account that's signed in, member here or not.
//
// 1. The page's code asks for /api/...; this sends those requests to /s/<server>/api/... instead, where
//    this server's viewer cookie goes (it's Path=/s/<server>/). fetch and WebSocket both.
// 2. The top bar gets a sign-in: to an mcstats account (the site's /account page), which then becomes a
//    member of this server (chat, and whatever the owner lets you do). Being a member here means nothing on
//    any other server.
// 3. And "Add to my servers": this server on the account's own list (/servers, src/myservers.js). M.saved says
//    whether it's on it (null: nobody's signed in, so the button leads to signing in first).
(() => {
  const M = window.MCS;
  if (!M || !M.base) return;

  const scoped = (path) => (typeof path === 'string' && path.startsWith('/api/') ? M.base + path : path);
  const scopedUrl = (u) => {
    try {
      const url = new URL(u, location.href);
      if (url.host === location.host && url.pathname.startsWith('/api/')) {
        url.pathname = M.base + url.pathname;
        return url.href;
      }
    } catch { /* leave it */ }
    return u;
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string') return realFetch(input.startsWith('/') ? scoped(input) : scopedUrl(input), init);
    if (input instanceof URL) return realFetch(scopedUrl(input.href), init);
    if (input instanceof Request) {
      const to = scopedUrl(input.url);
      return realFetch(to === input.url ? input : new Request(to, input), init);
    }
    return realFetch(input, init);
  };
  const RealWebSocket = window.WebSocket;
  if (RealWebSocket) {
    const Scoped = function WebSocket(url, protocols) {
      return protocols === undefined ? new RealWebSocket(scopedUrl(String(url))) : new RealWebSocket(scopedUrl(String(url)), protocols);
    };
    Scoped.prototype = RealWebSocket.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Scoped[k] = RealWebSocket[k];
    window.WebSocket = Scoped;
  }

  const post = async (path, body) => {
    const res = await realFetch(M.base + path, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
  };

  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') e.textContent = v;
      else if (k === 'class') e.className = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    e.append(...kids.filter(Boolean));
    return e;
  };

  // Signing in is to an mcstats account, on the site's own /account page (it comes back here afterwards).
  // Being someone on this server is asked for: the server's owner can see its members' emails.
  const signInUrl = `/account?${new URLSearchParams({ next: `${M.base}/` })}`;
  const signOut = () => {
    const out = h('button', { type: 'button', class: 'btn', text: 'Sign out' });
    out.addEventListener('click', async () => {
      out.disabled = true;
      // the account is the site's, not this server's: asked of /api/account directly, not under /s/<server>
      await realFetch('/api/account/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
      location.reload();
    });
    return out;
  };

  const ENTER_KEY = `mcs-enter:${M.slug}`;
  const enter = () => post('/api/auth/enter');

  function signInPanel(close) {
    const pop = h('div', { class: 'acct-pop', role: 'dialog', 'aria-label': 'Sign in' });
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    const what = `To chat from the website or use admin pages on ${M.name}.`;
    if (!M.account) {
      const go = h('a', { class: 'btn btn-primary', href: signInUrl, text: 'Sign in to mcstats' });
      // remembered in this tab only: coming back signed in finishes what this click asked for (see mount)
      go.addEventListener('click', () => { try { sessionStorage.setItem(ENTER_KEY, '1'); } catch { /* they'll press Continue */ } });
      pop.append(
        h('p', { class: 'acct-note', text: `${what} Use the email the server’s owner has for you.` }),
        h('div', { class: 'acct-row' }, go),
        h('p', { class: 'acct-note', text: 'No account yet? You can create one there. The server’s owner will see your email.' }));
      setTimeout(() => go.focus(), 0);
      return pop;
    }
    // signed in to mcstats, but nobody on this server yet
    const err = h('p', { class: 'acct-err', role: 'alert', hidden: true });
    const go = h('button', { type: 'button', class: 'btn btn-primary', text: `Continue as ${M.account}` });
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        await enter();
        location.reload();
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
        go.disabled = false;
      }
    });
    pop.append(
      h('p', { class: 'acct-note', text: `You’re signed in to mcstats as ${M.account}. ${what}` }),
      h('div', { class: 'acct-row' }, go),
      h('p', { class: 'acct-note', text: 'The server’s owner will see your email.' }),
      err,
      h('div', { class: 'acct-row' }, myServersLink(), signOut()));
    setTimeout(() => go.focus(), 0);
    return pop;
  }

  const myServersLink = () => h('a', { class: 'btn', href: '/servers', text: 'Your servers' });

  function accountPanel() {
    return h('div', { class: 'acct-pop', role: 'dialog', 'aria-label': 'Account' },
      h('p', { class: 'acct-note', text: `Signed in as ${M.email}.` }),
      h('div', { class: 'acct-row' }, myServersLink(), h('a', { class: 'btn', href: '/account', text: 'Your account' }), signOut()));
  }

  // ---- "Add to my servers" ----
  const SAVE_KEY = `mcs-save:${M.slug}`;
  // a bookmark, drawn in 2px squares like the rest of the site's icons; filled once it's saved
  const SVG = 'http://www.w3.org/2000/svg';
  const bookmark = () => {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 10 12');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('class', 'save-icon');
    const path = document.createElementNS(SVG, 'path');
    // outline: the sides and top, and the notch at the bottom
    path.setAttribute('class', 'save-line');
    path.setAttribute('d', 'M0 0h10v12H8v-2H6V8H4v2H2v2H0zM2 2v6h2V6h2v2h2V2z');
    const fill = document.createElementNS(SVG, 'path');
    fill.setAttribute('class', 'save-fill');
    fill.setAttribute('d', 'M2 2h6v6H6V6H4v2H2z');
    svg.append(fill, path);
    return svg;
  };
  function toast(text, link) {
    document.querySelector('.save-toast')?.remove();
    const t = h('div', { class: 'toast save-toast', role: 'status' }, text, link ? ' ' : null, link || null);
    document.body.append(t);
    setTimeout(() => t.classList.add('toast-out'), 3200);
    setTimeout(() => t.remove(), 3600);
  }
  function saveButton() {
    const label = h('span', { class: 'save-label' });
    const btn = h('button', { type: 'button', class: 'save-btn' }, bookmark(), label);
    const draw = () => {
      const on = M.saved === true;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      label.textContent = on ? 'Saved' : 'Save';
      btn.title = on ? 'On your servers list. Click to take it off.' : `Add ${M.name} to your servers list`;
      btn.setAttribute('aria-label', on ? `${M.name} is on your servers list` : `Add ${M.name} to your servers list`);
    };
    const set = async (saved) => {
      btn.disabled = true;
      try {
        await post('/api/mine', { saved });
        M.saved = saved;
        draw();
        toast(saved ? `Added ${M.name} to your servers.` : `Took ${M.name} off your servers.`, saved ? h('a', { href: '/servers', text: 'See the list' }) : null);
      } catch (x) {
        toast(x.message);
      } finally {
        btn.disabled = false;
      }
    };
    btn.addEventListener('click', () => {
      if (M.saved == null) {
        // signed out: sign in first, and this click is finished on the way back (see mount)
        try { sessionStorage.setItem(SAVE_KEY, '1'); } catch { /* they'll press it again */ }
        location.assign(signInUrl);
        return;
      }
      set(!M.saved);
    });
    draw();
    return { btn, set };
  }

  function mount() {
    const right = document.querySelector('.top-right');
    if (!right) return;
    // Back from signing in, which the button on this page sent them to: they asked to be someone here.
    try {
      const asked = sessionStorage.getItem(ENTER_KEY);
      sessionStorage.removeItem(ENTER_KEY);
      if (asked && M.account && !M.email) enter().then(() => location.reload(), () => {});
    } catch { /* no storage: the Continue button does it */ }
    const save = saveButton();
    try {
      const asked = sessionStorage.getItem(SAVE_KEY);
      sessionStorage.removeItem(SAVE_KEY);
      if (asked && M.saved === false) save.set(true);
    } catch { /* no storage: the button does it */ }
    const wrap = h('div', { class: 'acct' });
    // signed in, the bar shows only the first letter of their email; the whole address is in the tooltip and the menu
    const btn = M.email
      ? h('button', { type: 'button', class: 'acct-btn acct-me', 'aria-expanded': 'false', 'aria-label': `Account: ${M.email}`, title: `Signed in as ${M.email}`, text: M.email.trim().charAt(0) || '?' })
      : h('button', { type: 'button', class: 'btn acct-btn', 'aria-expanded': 'false', text: 'Sign in' });
    let pop = null;
    const close = () => {
      pop?.remove();
      pop = null;
      btn.setAttribute('aria-expanded', 'false');
    };
    btn.addEventListener('click', () => {
      if (pop) return close();
      pop = M.email ? accountPanel() : signInPanel(close);
      wrap.append(pop);
      btn.setAttribute('aria-expanded', 'true');
    });
    document.addEventListener('click', (e) => { if (pop && !wrap.contains(e.target)) close(); });
    wrap.append(btn);
    right.insertBefore(wrap, document.getElementById('theme-toggle'));
    right.insertBefore(save.btn, wrap);
    const brand = document.querySelector('.brand span:last-child');
    if (brand && M.name) brand.textContent = M.name;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
