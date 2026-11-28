// Counts this browser for the site analytics: once a day, once a week and once a month, without an id.
//
// It keeps, in its own localStorage ("mcs_seen"), the day, week and month it was last counted in, for any visit (a),
// a visit signed in (s) and a visit to a server's dashboard (b), and sends those back the first time each day
// (by this browser's clock). The Worker adds 1 to each period they're behind on and says which to remember now
// (src/siteanalytics.js, recordVisit). Nothing it sends can tell this browser from another one.
//
// Not counted at all: a browser asking not to be tracked (Global Privacy Control or Do Not Track), one driven by
// automation, and one whose storage is off (it couldn't remember, so it would be counted on every page).
// Loaded by every page of the site except /site-analytics; site.js calls mcstatsVisit.signedIn() after signing in.
(() => {
  const KEY = 'mcs_seen';
  const KINDS = ['a', 's', 'b'];
  const off = () => navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.webdriver === true;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const st = raw ? JSON.parse(raw) : null;
      return { st: st && st.v === 1 ? st : null, ok: true };
    } catch {
      return { st: null, ok: false };
    }
  }
  function save(st) {
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* it'll be asked again next time */ }
  }
  const clientDay = () => {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };

  let sending = false;
  async function send() {
    if (sending || off()) return;
    const { st: had, ok } = load();
    if (!ok) return;
    const fresh = !had;
    const st = had || { v: 1, cd: {} };
    st.cd ||= {};
    const day = clientDay();
    // window.MCS is a server's dashboard (src/index.js): it says whether an account is signed in
    const dashboard = !!window.MCS;
    const signed = dashboard ? !!window.MCS.account : st.si === true;
    const want = { a: true, s: signed, b: dashboard };
    const due = KINDS.filter((k) => want[k] && st.cd[k] !== day);
    if (!due.length) return;
    const msg = { n: fresh };
    for (const k of KINDS) msg[k] = due.includes(k) ? (st[k] || {}) : null;
    sending = true;
    let again = false;
    try {
      const res = await fetch('/api/site/visit', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      });
      if (!res.ok) return;
      const out = await res.json();
      if (!out || !out.periods) return;
      const now = load().st || st; // another tab may have written meanwhile
      now.cd ||= {};
      for (const k of due) {
        if (out.counted?.[k] == null) continue;
        now[k] = out.periods;
        now.cd[k] = day;
      }
      now.si = !!out.signedIn;
      save(now);
      again = !!out.signedIn && !want.s; // signed in after all: count that too, now
    } catch {
      /* offline, blocked: try again on the next page */
    } finally {
      sending = false;
    }
    if (again) send();
  }

  window.mcstatsVisit = {
    // just signed in on this page: count the signed-in visit now rather than on the next page
    signedIn() {
      const { st } = load();
      if (st) { st.si = true; save(st); }
      send();
    },
  };
  // after the page's own work, when the browser has a moment
  const go = () => send();
  if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 4000 });
  else setTimeout(go, 1500);
})();
