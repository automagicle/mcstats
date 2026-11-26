// Player aliases (the player_aliases table): another account's name that belongs to the same person.
// Everything recorded under an alias is shown as, and counted with, the name it points to. Nothing is
// rewritten; the accounts are merged here when the data is read.

// SQL: the name to show for the player name in `col`.
export const canonName = (col) => `COALESCE((SELECT pa.name FROM player_aliases pa WHERE pa.alias = ${col}), ${col})`;

// SQL: the uuid to link to for that player: the main account's, when the name is an alias and it has one.
export const canonUuid = (nameCol, uuidCol) =>
  `COALESCE((SELECT p2.uuid FROM player_aliases pa JOIN players p2 ON pa.name = p2.name
             WHERE pa.alias = ${nameCol} ORDER BY p2.first_seen DESC LIMIT 1), ${uuidCol})`;

// Every account of the player with this uuid (or name): { name, uuid, first_seen, uuids, names }, where name
// and uuid are the main account's. null if there's no such player.
// Someone the server mod has named (its online list, the chat log, a gear report) but whose time on the server
// was never recorded counts too, with first_seen null: a new server's first minute, or one whose status check
// wasn't running (src/poll.js), would otherwise link to a player page that isn't there.
export async function playerGroup(db, { uuid = null, name = null }) {
  let seen = null; // { uuid, name } from what the mod sent, when the players table doesn't have them
  if (uuid) {
    name = (await db.prepare('SELECT name FROM players WHERE uuid = ?').bind(uuid).first())?.name;
    if (!name) {
      seen = await namedByMod(db, { uuid });
      name = seen?.name;
    }
  }
  if (!name) return null;
  const main = (await db.prepare('SELECT name FROM player_aliases WHERE alias = ?').bind(name).first())?.name || name;
  const { results } = await db.prepare(
    `SELECT uuid, name, first_seen FROM players p
     WHERE p.name = ?1 COLLATE NOCASE OR EXISTS (SELECT 1 FROM player_aliases pa WHERE pa.name = ?1 AND pa.alias = p.name)
     ORDER BY first_seen`
  ).bind(main).all();
  if (!results.length) {
    seen ??= await namedByMod(db, { name: main });
    if (!seen) return null;
    return { name: main, uuid: seen.uuid, first_seen: null, uuids: [seen.uuid], names: [...new Set([main, seen.name])] };
  }
  const own = results.filter((r) => r.name.toLowerCase() === main.toLowerCase()).pop() || results[results.length - 1];
  const uuids = results.map((r) => r.uuid);
  if (seen && !uuids.includes(seen.uuid)) uuids.push(seen.uuid);
  return {
    name: own.name.toLowerCase() === main.toLowerCase() ? own.name : main,
    uuid: own.uuid,
    first_seen: results[0].first_seen,
    uuids,
    names: [...new Set([main, ...results.map((r) => r.name), ...(seen ? [seen.name] : [])])],
  };
}

// { uuid, name } for a player the server mod has named by this uuid (or name), latest first: who's on now,
// then the chat log, then gear reports. null if it never has.
async function namedByMod(db, { uuid = null, name = null }) {
  const [col, v] = uuid ? ['uuid', uuid.toLowerCase()] : ['name', name];
  const match = (c) => (uuid ? `lower(${c}) = ?1` : `${c} = ?1 COLLATE NOCASE`);
  const tries = [
    `SELECT json_extract(o.value, '$.uuid') AS uuid, json_extract(o.value, '$.name') AS name
     FROM server_online s, json_each(s.players) o WHERE s.stopping = 0 AND ${match(`json_extract(o.value, '$.${col}')`)} LIMIT 1`,
    `SELECT uuid, name FROM chat WHERE ${match(col)} AND uuid IS NOT NULL AND name IS NOT NULL ORDER BY ts_ms DESC LIMIT 1`,
    `SELECT uuid, name FROM gear WHERE ${match(col)} AND uuid IS NOT NULL ORDER BY ts DESC LIMIT 1`,
  ];
  for (const q of tries) {
    try {
      const row = await db.prepare(q).bind(v).first();
      if (row?.uuid && row?.name) return { uuid: String(row.uuid).toLowerCase(), name: row.name };
    } catch { /* a table not there yet: try the next */ }
  }
  return null;
}

export const marks = (list) => list.map(() => '?').join(', ');
