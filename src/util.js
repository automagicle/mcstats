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
