// Runs before app.js on a server's stats page (/s/<server>/). The Worker puts window.MCS on the page:
// { base: '/s/<server>', slug, name, season, email, account, public }. email: who they are on this server (a
// member); account: the mcstats account that's signed in, member here or not.
//
// 1. The page's code asks for /api/...; this sends those requests to /s/<server>/api/... instead, where
//    this server's viewer cookie goes (it's Path=/s/<server>/). fetch and WebSocket both.
// 2. The top bar gets a sign-in: to an mcstats account (the site's /account page), which then becomes a
//    member of this server (chat, and whatever the owner lets you do). Being a member here means nothing on
//    any other server.
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
      h('div', { class: 'acct-row' }, signOut()));
    setTimeout(() => go.focus(), 0);
    return pop;
  }

  function accountPanel() {
    return h('div', { class: 'acct-pop', role: 'dialog', 'aria-label': 'Account' },
      h('p', { class: 'acct-note', text: `Signed in as ${M.email}.` }),
      h('div', { class: 'acct-row' }, h('a', { class: 'btn', href: '/account', text: 'Your account' }), signOut()));
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
    const wrap = h('div', { class: 'acct' });
    const btn = h('button', { type: 'button', class: M.email ? 'btn btn-quiet acct-btn' : 'btn acct-btn', 'aria-expanded': 'false', text: M.email ? M.email : 'Sign in' });
    if (M.email) btn.title = `Signed in as ${M.email}`;
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
    const brand = document.querySelector('.brand span:last-child');
    if (brand && M.name) brand.textContent = M.name;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
