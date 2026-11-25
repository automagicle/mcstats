// Runs before app.js on a server's stats page (/s/<server>/). The Worker puts window.MCS on the page:
// { base: '/s/<server>', slug, name, season, email, public }.
//
// 1. The page's code asks for /api/...; this sends those requests to /s/<server>/api/... instead, where
//    this server's cookies go (they're Path=/s/<server>/). fetch and WebSocket both.
// 2. The top bar gets a sign-in: an email code makes you a member of this server (chat, and whatever the
//    owner lets you do). Signing in here means nothing on any other server.
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

  function signInPanel(close) {
    const err = h('p', { class: 'acct-err', role: 'alert', hidden: true });
    const say = (msg) => { err.textContent = msg; err.hidden = !msg; };
    const email = h('input', { class: 'adm-input', type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.org', 'aria-label': 'Email' });
    const code = h('input', { class: 'adm-input', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]{6,7}', maxlength: '7', placeholder: '123456', 'aria-label': 'Code from the email' });
    const send = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Email me a code' });
    const step1 = h('form', { class: 'acct-form' },
      h('label', { class: 'acct-label' }, 'Your email', email),
      h('p', { class: 'acct-note', text: `To chat from the website or use admin pages on ${M.name}. Use the email the server’s owner has for you.` }),
      send);
    const go = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Sign in' });
    const step2 = h('form', { class: 'acct-form', hidden: true },
      h('label', { class: 'acct-label' }, 'The 6-digit code we emailed you', code),
      h('p', { class: 'acct-note', text: 'Or open the link in the email.' }),
      h('div', { class: 'acct-row' }, go, h('button', { type: 'button', class: 'btn btn-quiet', text: 'Use another email' })));
    step1.addEventListener('submit', async (e) => {
      e.preventDefault();
      say('');
      send.disabled = true;
      try {
        await post('/api/auth/code', { email: email.value });
        step1.hidden = true;
        step2.hidden = false;
        code.focus();
      } catch (x) {
        say(x.message);
      } finally {
        send.disabled = false;
      }
    });
    step2.querySelector('.btn-quiet').addEventListener('click', () => { step2.hidden = true; step1.hidden = false; email.focus(); });
    step2.addEventListener('submit', async (e) => {
      e.preventDefault();
      say('');
      go.disabled = true;
      try {
        await post('/api/auth/verify', { email: email.value, code: code.value });
        location.reload();
      } catch (x) {
        say(x.message);
        go.disabled = false;
      }
    });
    const pop = h('div', { class: 'acct-pop', role: 'dialog', 'aria-label': 'Sign in' }, step1, step2, err);
    setTimeout(() => email.focus(), 0);
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    return pop;
  }

  function accountPanel() {
    const out = h('button', { type: 'button', class: 'btn', text: 'Sign out' });
    out.addEventListener('click', async () => {
      out.disabled = true;
      await post('/api/auth/logout').catch(() => {});
      location.reload();
    });
    return h('div', { class: 'acct-pop', role: 'dialog', 'aria-label': 'Account' },
      h('p', { class: 'acct-note', text: `Signed in on ${M.name} as ${M.email}.` }), out);
  }

  function mount() {
    const right = document.querySelector('.top-right');
    if (!right) return;
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
