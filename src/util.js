export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// For the mod's endpoints: null once its key for this server was checked (src/tenant.js sets INGEST_OK on
// the server's env), otherwise the 401 to send.
export const ingestDenied = (env) => (env.INGEST_OK === true ? null : json({ error: 'unauthorized' }, 401));

// A time zone by location, the way browsers name them ("America/Los_Angeles", "Europe/London", "UTC"): its
// canonical spelling, or null when it isn't one. Abbreviations and fixed offsets ("PST", "+08:00") aren't taken:
// they don't follow a place's clock changes.
export function cleanTz(v) {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  if (name.length > 64) return null;
  if (/^(utc|etc\/utc)$/i.test(name)) return 'UTC';
  if (!/^[A-Za-z][A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(name) || /^etc\//i.test(name)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
