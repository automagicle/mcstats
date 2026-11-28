// The site analytics' counters (the DIRECTORY's site_counts table, directory-migrations/0006_site_analytics.sql):
// one number per UTC day and metric. A week's or a month's counter is kept on its first day (Monday, the 1st),
// so "this week" is Monday to Sunday and "this month" the calendar month, everywhere: here, in the browser
// (public/visit.js) and on the page (public/site-analytics.js).

const now = () => Math.floor(Date.now() / 1000);

// 'YYYY-MM-DD' (UTC) for unix seconds.
export const utcDay = (ts = now()) => new Date(ts * 1000).toISOString().slice(0, 10);

// The Monday of the week a day is in.
export function weekStart(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export const monthStart = (day) => `${day.slice(0, 7)}-01`;

// The day each period's counter is kept on: { d, w, m }.
export const periodsOf = (day) => ({ d: day, w: weekStart(day), m: monthStart(day) });

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Adds one to each [day, metric], in one batch.
export async function bump(env, pairs) {
  if (!pairs.length) return;
  const stmt = env.DIRECTORY.prepare('INSERT INTO site_counts (day, metric, n) VALUES (?, ?, 1) ON CONFLICT (day, metric) DO UPDATE SET n = n + 1');
  await env.DIRECTORY.batch(pairs.map(([day, metric]) => stmt.bind(day, metric)));
}

// Sets a counter (for numbers that are read rather than counted, like the bot's Discord servers).
export async function setCount(env, day, metric, n) {
  await env.DIRECTORY.prepare('INSERT INTO site_counts (day, metric, n) VALUES (?, ?, ?) ON CONFLICT (day, metric) DO UPDATE SET n = excluded.n')
    .bind(day, metric, n).run();
}

// An account was signed in and used the site today: counted once a day, once a week and once a month, from the
// day it was last seen (accounts.seen_day). The update only lands if nobody else got there first, so two
// requests at once count it once. Never throws: counting must not get in the way of the request.
export async function noteAccountSeen(env, accountId, prev) {
  const today = utcDay();
  if (prev === today) return;
  try {
    const r = await env.DIRECTORY.prepare('UPDATE accounts SET seen_day = ?1 WHERE id = ?2 AND seen_day IS ?3').bind(today, accountId, prev ?? null).run();
    if (!r.meta?.changes) return;
    const p = periodsOf(today);
    const was = prev && DAY_RE.test(prev) ? periodsOf(prev) : null;
    await bump(env, [
      [p.d, 'acct:d'],
      ...(was?.w === p.w ? [] : [[p.w, 'acct:w']]),
      ...(was?.m === p.m ? [] : [[p.m, 'acct:m']]),
    ]);
  } catch (err) {
    console.error('site counts (account):', err.message);
  }
}
