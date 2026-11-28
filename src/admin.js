// The admin page: who may use it, and what it can change. Admins are this server's members with the
// "admin" permission (src/roles.js); being one on another server counts for nothing here.
//   GET  /api/me     { email, admin, super, role, perms } for the page
//   GET  /api/admin  the lists the admin page edits
//   POST /api/admin  { action, ... } one change (see ACTIONS). The page's settings (teams, roster,
//                    each player's teams over time, hidden players, merged accounts) are saved
//                    together by config.save, when the page's Save button is pressed; the rest
//                    (restoring a message, counting a death again, …) happen at once.
import { json } from './util.js';
import { canManage } from './roles.js';
import { fillGaps } from './gapfill.js';
import { clearCache } from './cache.js';
import { tellPresence } from './presence.js';
import { linkProbe, linkStatus } from './link.js';
import { modJar, modUpdate } from './modupdate.js';
import { MOD } from './modinfo.gen.js';
import { teamRows } from './teams.js';
import { applyRules, cleanRule, MAX_RULES, rulesState } from './chatrules.js';
import { rewordDeaths } from './chat.js';
import { EMAIL_RE } from './session.js';
import { connectedList, disconnectPlayer } from './connect.js';
import { COMMANDS_MOD, commandsOf, commandsSupported } from './commands.js';
import { tellDeleted } from './discord/relay.js';

const IGN_RE = /^[A-Za-z0-9_]{1,32}$/;
const TEAM_RE = /^[a-z][a-z0-9-]{0,19}$/;
const EGG_RE = /^[a-z][a-z0-9_]{0,23}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_TEAMS = 12;
const MAX_ROSTER = 500;
const MAX_PERIODS = 2000;
const MAX_BODY = 4096, MAX_CONFIG_BODY = 512 * 1024;
const MAX_EMAILS = 1000;
const ADMIN_IGN = '@admin'; // roster_email's stand-in IGN for an admin chatting from the website (src/link.js)

// Whether this sign-in may use this server's admin page: its "admin" permission here (src/roles.js, loaded
// by every /api/ request first). Nobody without an email, and nobody whose permissions weren't loaded.
export const isAdmin = (env, who) => !!who?.email && !!who?.perms?.admin;

// GET /api/me: who's signed in and what they may do (the page shows or hides things by it).
//   super  may use the Roles tab and the owner-and-admin things (src/roles.js canManage)
//   owner  may make owners (this server's owners, and the site's super admins)
export async function me(env, who) {
  const admin = isAdmin(env, who);
  // admins are told on every page when the server's mod has a newer version (the admin page has the details)
  const status = admin ? await linkStatus(env) : null;
  const u = admin ? modUpdate(status?.last_version, undefined, status?.minecraft) : null;
  return json({
    email: who.email, admin, super: canManage(who.perms), owner: !!(who.perms?.super || who.perms?.owner),
    role: who.perms?.role ?? null, perms: who.perms ?? null,
    server: env.TENANT ? { slug: env.TENANT.slug, name: env.TENANT.name } : null,
    mod_update: u && { current: u.current, latest: u.latest, urgent: u.urgent, behind: u.behind, jar: u.jar, jar_url: u.jar_url },
  });
}

export async function adminState(env, season) {
  if (!season.n) return json({ error: 'pick a season' }, 400);
  const db = env.DB;
  const [roster, hidden, aliases, players, uncounted, deleted, history, emails] = await db.batch([
    db.prepare('SELECT ign, name, team, egg FROM roster WHERE season = ? ORDER BY team, ign COLLATE NOCASE').bind(season.n),
    db.prepare('SELECT name, note FROM hidden_players ORDER BY name COLLATE NOCASE'),
    db.prepare('SELECT alias, name FROM player_aliases ORDER BY name COLLATE NOCASE, alias COLLATE NOCASE'),
    db.prepare('SELECT name FROM players GROUP BY lower(name) ORDER BY name COLLATE NOCASE'),
    db.prepare(`SELECT d.id, d.ts_ms AS ts, c.text FROM deaths d JOIN chat c ON c.id = d.id
                WHERE d.uncounted = 1 ORDER BY d.ts_ms DESC LIMIT 500`),
    db.prepare(`SELECT event_id, ts_ms AS ts, deleted_at, json_extract(chat, '$.kind') AS kind,
                json_extract(chat, '$.name') AS name, json_extract(chat, '$.text') AS text, death IS NOT NULL AS death
                FROM deleted_chat ORDER BY deleted_at DESC LIMIT 500`),
    db.prepare('SELECT ign, until, team FROM team_history WHERE season = ? ORDER BY ign COLLATE NOCASE, until').bind(season.n),
    // the sign-in emails that chat from the website as each player (an admin's own stand-in, @admin, isn't edited here)
    db.prepare("SELECT email, ign FROM roster_email WHERE season = ? AND ign != ? ORDER BY ign COLLATE NOCASE, email").bind(season.n, ADMIN_IGN),
  ]);
  const link = await linkStatus(env); // the server mod's web chat connection (src/link.js)
  return json({
    // emails players connected from in game (/mcstats connect, src/connect.js): confirmed_at null while waiting
    connected: await connectedList(db),
    season: season.n,
    // a name the same as the IGN is no real name (that's what a new player gets until one is given)
    roster: roster.results.map((r) => ({ ...r, name: r.name && r.name.toLowerCase() !== r.ign.toLowerCase() ? r.name : '' })),
    emails: emails.results,
    lo: season.lo, // when the season's data begins (unix seconds), for the teams-over-time bars
    teams: await teamRows(db, season.n),
    history: history.results,
    hidden: hidden.results,
    aliases: aliases.results,
    players: players.results.map((r) => r.name),
    uncounted: uncounted.results,
    deleted: deleted.results,
    link,
    mod_update: modUpdate(link?.last_version, undefined, link?.minecraft), // a newer mod to install, with what changed (src/modupdate.js)
    // every jar the site has, for the Mod and commands page's download picker
    // suggested: the newest jar for the Minecraft version the server's mod last said it runs on
    mod: { version: MOD.version, minecraft_built: MOD.minecraft_built, downloads: MOD.downloads, server_minecraft: link?.minecraft ?? null, suggested: modJar(link?.minecraft).file },
    // which /mcstats commands are switched off and whether the Activity page's box starts closed (src/commands.js);
    // supported: whether the server's mod is new enough to take them away (null: it has never connected)
    commands: { ...commandsOf(env), needs: COMMANDS_MOD, supported: commandsSupported(link?.last_version) },
    chat_rules: await rulesState(db), // which chat log lines are left out (src/chatrules.js)
  });
}

const bad = (msg) => json({ error: msg }, 400);
const ign = (v) => (typeof v === 'string' && IGN_RE.test(v.trim()) ? v.trim() : null);
const chatId = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

// Each returns a Response on bad input, or nothing once it's done.
const ACTIONS = {
  // Everything the admin page's Save button saves, at once (all of it or none of it). Each part is
  // the whole of what it should be from now on, and a part that's left out isn't touched:
  //   teams:   [{ id, name, short, color, bar, middle, chart, activity, activity_with }] in their order
  //   roster:  [{ ign, team, egg, name? }] this season's players. name: their real name ('' for none: their IGN
  //            stands in); left out, it stays as it is (a new player gets their IGN)
  //   emails:  [{ email, ign }] the sign-in emails that chat from the website as each player (not @admin's)
  //   history: [{ ign, team, until }] players' earlier teams: on `team` (or '' for none) before `until` (unix seconds)
  //   hidden:  [{ name, note }]       aliases: [{ alias, name }]
  async 'config.save'(db, b, season) {
    const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const list = (v, max) => (Array.isArray(v) && v.length <= max && v.every((x) => x && typeof x === 'object') ? v : null);
    const lower = (v) => v.toLowerCase();
    const stmts = [];
    const [haveTeams, haveRoster, haveHidden, haveAliases] = await db.batch([
      db.prepare('SELECT id FROM teams WHERE season = ?').bind(season.n),
      db.prepare('SELECT ign, team FROM roster WHERE season = ?').bind(season.n),
      db.prepare('SELECT name FROM hidden_players'),
      db.prepare('SELECT alias FROM player_aliases'),
    ]);

    let roster = haveRoster.results; // as it will be, for checking the teams against
    if (b.roster !== undefined) {
      const rows = list(b.roster, MAX_ROSTER);
      if (!rows) return bad('bad roster');
      const seen = new Set();
      roster = [];
      for (const r of rows) {
        const name = ign(r.ign);
        if (!name) return bad(`bad IGN: ${String(r.ign).slice(0, 40)}`);
        if (seen.has(lower(name))) return bad(`${name} is on the roster twice`);
        seen.add(lower(name));
        if (typeof r.team !== 'string' || !TEAM_RE.test(r.team)) return bad(`bad team for ${name}`);
        const egg = r.egg == null || r.egg === '' ? null : r.egg;
        if (egg != null && (typeof egg !== 'string' || !EGG_RE.test(egg))) return bad(`bad egg for ${name}`);
        roster.push({ ign: name, team: r.team });
        // undefined: leave the real name alone; '' or null: none (the IGN stands in)
        const real = r.name === undefined ? null : text(r.name, 60) || name;
        stmts.push(db.prepare(
          `INSERT INTO roster (season, ign, name, team, egg) VALUES (?1, ?2, COALESCE(?5, ?2), ?3, ?4)
           ON CONFLICT(season, ign) DO UPDATE SET team = excluded.team, egg = excluded.egg,
             name = CASE WHEN ?5 IS NULL THEN roster.name ELSE excluded.name END`
        ).bind(season.n, name, r.team, egg, real));
      }
      for (const r of haveRoster.results) {
        if (!seen.has(lower(r.ign))) stmts.push(db.prepare('DELETE FROM roster WHERE season = ? AND ign = ?').bind(season.n, r.ign));
      }
    }

    if (b.teams !== undefined) {
      const rows = list(b.teams, MAX_TEAMS);
      if (!rows) return bad(`bad teams (at most ${MAX_TEAMS})`);
      const ids = new Set();
      for (const t of rows) {
        if (typeof t.id !== 'string' || !TEAM_RE.test(t.id)) return bad('a team needs an id: lowercase letters, digits and dashes, starting with a letter');
        if (ids.has(t.id)) return bad(`two teams are called ${t.id}`);
        ids.add(t.id);
        if (typeof t.color !== 'string' || !COLOR_RE.test(t.color)) return bad(`bad color for ${t.id}`);
      }
      // a team's playtime can count with another team that has a series of its own (not with one that's itself counted elsewhere)
      const ownSeries = (id) => { const t = rows.find((x) => x.id === id); return !!t && t.activity !== false && !t.activity_with; };
      rows.forEach((t, i) => {
        const name = text(t.name, 40) || t.id[0].toUpperCase() + t.id.slice(1);
        const withTeam = typeof t.activity_with === 'string' && t.activity_with !== t.id && ownSeries(t.activity_with) ? t.activity_with : null;
        stmts.push(db.prepare(
          `INSERT INTO teams (season, id, name, short, color, sort, show_bar, show_chart, show_activity, activity_with)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT(season, id) DO UPDATE SET name = excluded.name, short = excluded.short,
             color_dark = CASE WHEN teams.color = excluded.color THEN teams.color_dark ELSE NULL END, color = excluded.color,
             sort = excluded.sort, show_bar = excluded.show_bar, show_chart = excluded.show_chart,
             show_activity = excluded.show_activity, activity_with = excluded.activity_with`
        ).bind(season.n, t.id, name, text(t.short, 16) || name.split(/\s+/)[0].slice(0, 16), t.color.toLowerCase(), i,
          t.bar === false ? 0 : t.middle === true ? 2 : 1, t.chart === false ? 0 : 1, withTeam || t.activity === false ? 0 : 1, withTeam));
      });
      for (const { id } of haveTeams.results) {
        if (ids.has(id)) continue;
        const on = roster.filter((r) => r.team === id).length;
        if (on) return bad(`${on} player${on === 1 ? ' is' : 's are'} still on ${id}; move them first`);
        stmts.push(db.prepare('DELETE FROM teams WHERE season = ? AND id = ?').bind(season.n, id));
      }
    }

    if (b.history !== undefined) {
      const rows = list(b.history, MAX_PERIODS);
      if (!rows) return bad('bad team history');
      const seen = new Set();
      stmts.push(db.prepare('DELETE FROM team_history WHERE season = ?').bind(season.n));
      for (const h of rows) {
        const name = ign(h.ign);
        if (!name) return bad('bad IGN in the team history');
        if (h.team !== '' && (typeof h.team !== 'string' || !TEAM_RE.test(h.team))) return bad(`bad earlier team for ${name}`);
        if (!Number.isSafeInteger(h.until) || h.until <= 0 || h.until > 4102444800) return bad(`bad time for ${name}’s earlier team`);
        const key = `${lower(name)}:${h.until}`;
        if (seen.has(key)) return bad(`two of ${name}’s earlier teams end at the same time`);
        seen.add(key);
        stmts.push(db.prepare('INSERT INTO team_history (season, ign, until, team) VALUES (?, ?, ?, ?)').bind(season.n, name, h.until, h.team));
      }
    }

    if (b.hidden !== undefined) {
      const rows = list(b.hidden, MAX_ROSTER);
      if (!rows) return bad('bad hidden players');
      const seen = new Set();
      for (const h of rows) {
        const name = ign(h.name);
        if (!name) return bad('bad name among the hidden players');
        seen.add(lower(name));
        const note = typeof h.note === 'string' ? h.note.trim().slice(0, 200) || null : null;
        stmts.push(db.prepare('INSERT INTO hidden_players (name, note) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET note = excluded.note').bind(name, note));
      }
      for (const h of haveHidden.results) {
        if (!seen.has(lower(h.name))) stmts.push(db.prepare('DELETE FROM hidden_players WHERE name = ?').bind(h.name));
      }
    }

    if (b.aliases !== undefined) {
      const rows = list(b.aliases, MAX_ROSTER);
      if (!rows) return bad('bad merged accounts');
      const pairs = [];
      for (const a of rows) {
        const alias = ign(a.alias), name = ign(a.name);
        if (!alias || !name) return bad('bad name among the merged accounts');
        if (lower(alias) === lower(name)) return bad('an account can’t be its own alias');
        if (pairs.some((p) => lower(p.alias) === lower(alias))) return bad(`${alias} is merged twice`);
        pairs.push({ alias, name });
      }
      const others = new Set(pairs.map((p) => lower(p.alias)));
      const chained = pairs.find((p) => others.has(lower(p.name)));
      if (chained) return bad(`${chained.name} is itself merged into another account; merge ${chained.alias} into the main one`);
      for (const p of pairs) {
        stmts.push(db.prepare('INSERT INTO player_aliases (alias, name) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET name = excluded.name').bind(p.alias, p.name));
      }
      for (const a of haveAliases.results) {
        if (!others.has(lower(a.alias))) stmts.push(db.prepare('DELETE FROM player_aliases WHERE alias = ?').bind(a.alias));
      }
    }

    if (b.emails !== undefined) {
      const rows = list(b.emails, MAX_EMAILS);
      if (!rows) return bad('bad sign-in emails');
      const seen = new Set();
      stmts.push(db.prepare('DELETE FROM roster_email WHERE season = ? AND ign != ?').bind(season.n, ADMIN_IGN));
      for (const r of rows) {
        const email = typeof r.email === 'string' ? r.email.trim().toLowerCase() : '';
        const name = ign(r.ign);
        if (!EMAIL_RE.test(email) || email.length > 254) return bad(`bad email: ${String(r.email).slice(0, 60)}`);
        if (!name) return bad(`bad IGN for ${email}`);
        if (seen.has(email)) return bad(`${email} is given to two players`);
        seen.add(email);
        // an email an admin chats with as Admin stays theirs
        stmts.push(db.prepare('INSERT OR IGNORE INTO roster_email (season, email, ign) VALUES (?, ?, ?)').bind(season.n, email, name));
      }
    }

    if (stmts.length) await db.batch(stmts);
  },
  // out of the chat log (and Combat, for a death), kept in deleted_chat so it can be put back
  // { uuid }: the player's in-game account connection ends (src/connect.js)
  async 'account.disconnect'(db, b) {
    if (!(await disconnectPlayer(db, b.uuid))) return bad('bad uuid');
  },
  async 'chat.delete'(db, b) {
    const id = chatId(b.id);
    if (!id) return bad('bad id');
    const row = await db.prepare('SELECT * FROM chat WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'already gone' }, 404);
    const death = await db.prepare('SELECT * FROM deaths WHERE id = ?').bind(id).first();
    await db.batch([
      db.prepare('INSERT OR REPLACE INTO deleted_chat (event_id, id, ts_ms, deleted_at, chat, death) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(row.event_id, id, row.ts_ms, Date.now(), JSON.stringify(row), death ? JSON.stringify(death) : null),
      db.prepare('DELETE FROM deaths WHERE id = ?').bind(id),
      db.prepare('DELETE FROM chat WHERE id = ?').bind(id),
    ]);
  },
  async 'chat.restore'(db, b) {
    if (typeof b.event_id !== 'string') return bad('bad id');
    const saved = await db.prepare('SELECT chat, death FROM deleted_chat WHERE event_id = ?').bind(b.event_id).first();
    if (!saved) return json({ error: 'not found' }, 404);
    const insert = (table, row) => {
      const cols = Object.keys(row);
      if (!cols.every((c) => /^[a-z_]+$/.test(c))) throw new Error('bad saved row');
      return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .bind(...cols.map((c) => row[c]));
    };
    const chatRow = JSON.parse(saved.chat);
    // a newer line may have taken its row number since; then it gets a new one (its time keeps its place)
    if (await db.prepare('SELECT 1 FROM chat WHERE id = ?').bind(chatRow.id).first()) delete chatRow.id;
    if (await db.prepare('SELECT 1 FROM chat WHERE event_id = ?').bind(chatRow.event_id).first()) {
      await db.prepare('DELETE FROM deleted_chat WHERE event_id = ?').bind(b.event_id).run();
      return;
    }
    const res = await insert('chat', chatRow).run();
    const stmts = [];
    if (saved.death) stmts.push(insert('deaths', { ...JSON.parse(saved.death), id: chatRow.id ?? res.meta.last_row_id }));
    stmts.push(db.prepare('DELETE FROM deleted_chat WHERE event_id = ?').bind(b.event_id));
    await db.batch(stmts);
  },
  // Chat log rules (src/chatrules.js): each change is applied to the whole log at once.
  //   rule.add     { rule: { action, kind, match, text, from_ms, to_ms } }
  //   rule.update  { id, rule? (the same, to replace it), enabled? }
  //   rule.delete  { id }
  // Each answers { changed } (lines whose hidden state changed) and the rules as they are now.
  async 'rule.add'(db, b) {
    const r = cleanRule(b.rule);
    if (typeof r === 'string') return bad(r);
    const { n } = await db.prepare('SELECT COUNT(*) AS n FROM chat_rules').first();
    if (n >= MAX_RULES) return bad(`at most ${MAX_RULES} rules`);
    await db.prepare('INSERT INTO chat_rules (action, kind, match, text, from_ms, to_ms, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .bind(r.action, r.kind, r.match, r.text, r.from_ms, r.to_ms, Date.now()).run();
    return json({ ok: true, changed: await applyRules(db), chat_rules: await rulesState(db) });
  },
  async 'rule.update'(db, b) {
    const id = chatId(b.id);
    if (!id) return bad('bad id');
    if (b.rule !== undefined) {
      const r = cleanRule(b.rule);
      if (typeof r === 'string') return bad(r);
      await db.prepare('UPDATE chat_rules SET action = ?, kind = ?, match = ?, text = ?, from_ms = ?, to_ms = ? WHERE id = ?')
        .bind(r.action, r.kind, r.match, r.text, r.from_ms, r.to_ms, id).run();
    }
    if (b.enabled !== undefined) await db.prepare('UPDATE chat_rules SET enabled = ? WHERE id = ?').bind(b.enabled ? 1 : 0, id).run();
    return json({ ok: true, changed: await applyRules(db), chat_rules: await rulesState(db) });
  },
  async 'rule.delete'(db, b) {
    const id = chatId(b.id);
    if (!id) return bad('bad id');
    await db.prepare('DELETE FROM chat_rules WHERE id = ?').bind(id).run();
    return json({ ok: true, changed: await applyRules(db), chat_rules: await rulesState(db) });
  },
  // death lines that arrived without wording, or were worded plainly, written again (src/chat.js wordDeath)
  async 'deaths.reword'(db) {
    return json({ ok: true, changed: await rewordDeaths(db) });
  },
  // a death left out of (or back in) the Combat page; it stays in the chat log either way
  async 'death.uncount'(db, b) {
    const id = chatId(b.id);
    if (!id) return bad('bad id');
    await db.prepare('UPDATE deaths SET uncounted = 1 WHERE id = ?').bind(id).run();
  },
  // fill in minutes an outage kept from being recorded now, instead of at the next :07 (src/gapfill.js)
  async 'gaps.fill'(db, b, season, env) {
    return json({ ok: true, gaps: await fillGaps(env, Math.floor(Date.now() / 1000)) });
  },
  // a round trip to the server mod that shows nothing in game (src/link.js)
  async 'link.test'(db, b, season, env) {
    return json({ ok: true, probe: await linkProbe(env), link: await linkStatus(env) });
  },
  // credit a death to a player (it then counts as their kill), or to no one with killer: null
  async 'death.attribute'(db, b) {
    const id = chatId(b.id);
    if (!id) return bad('bad id');
    const killer = b.killer == null || b.killer === '' ? null : b.killer;
    if (killer !== null && (typeof killer !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(killer))) return bad('bad name');
    const d = await db.prepare('SELECT victim FROM deaths WHERE id = ?').bind(id).first();
    if (!d) return bad('not a death');
    if (killer && killer.toLowerCase() === d.victim.toLowerCase()) return bad('they can’t be credited with their own death');
    const note = killer && b.note ? 1 : 0;
    await db.prepare(
      `UPDATE deaths SET killer = ?2, attr_note = ?3,
              killer_uuid = (SELECT uuid FROM players WHERE name = ?2 COLLATE NOCASE ORDER BY first_seen DESC LIMIT 1),
              mob = CASE WHEN ?2 IS NULL THEN mob ELSE NULL END
       WHERE id = ?1`
    ).bind(id, killer, note).run();
    return json({ ok: true, killer, victim: d.victim });
  },
  async 'death.count'(db, b) {
    const id = chatId(b.id);
    if (!id) return bad('bad id');
    await db.prepare('UPDATE deaths SET uncounted = 0 WHERE id = ?').bind(id).run();
  },
};

export async function adminAction(request, env, url, season) {
  // Only this page may post here (a JSON body also can't be sent cross-site without CORS allowing it).
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_CONFIG_BODY) return json({ error: 'too large' }, 413);
    body = JSON.parse(raw);
    if (raw.length > MAX_BODY && body?.action !== 'config.save') return json({ error: 'too large' }, 413);
  } catch {
    return bad('bad json');
  }
  const run = body && Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
  if (!run) return bad('unknown action');
  if (body.action === 'config.save' && !season.n) return bad('pick a season');
  // a chat line deleted, or a death left out of Combat, comes off Discord too (src/discord/relay.js)
  const gone = body.action === 'chat.delete' || body.action === 'death.uncount'
    ? await env.DB.prepare('SELECT event_id FROM chat WHERE id = ?').bind(chatId(body.id) ?? -1).first('event_id').catch(() => null) : null;
  const out = (await run(env.DB, body, season, env)) || json({ ok: true });
  if (out.ok && gone) await tellDeleted(env, [gone]);
  if (out.ok) await clearCache(env.DB); // season totals may have changed
  if (out.ok && body.action === 'config.save' && (body.hidden !== undefined || body.aliases !== undefined)) await tellPresence(env, '/invalidate'); // the live badges
  return out;
}
