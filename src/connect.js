// Players connecting their mcstats account from in game (mod 2.3.0).
//
// In game, /mcstats connect (or Connect Account in the /mcstats menu) opens an anvil: the player types the
// email of their mcstats account and clicks the result. The mod sends it here over its web chat connection
// (src/link.js) as { type: 'account', id, action: 'connect', uuid, name, email }, and this side keeps it as a
// request (player_accounts, src/tenant/schema.js v5) and emails that address to say so.
//
// Typing an email proves nothing about it, so a request alone does nothing. It counts once someone signed in
// to the website with that email says yes, on the Chat log (POST /api/chat/connect): both sides have then
// shown who they are, the player in game and the account with its emailed code. From then on that account
// sends chat from the website as the player (src/link.js playerFor), and the admin page shows it on the
// player's profile. Either side can undo it: the player in game (action 'disconnect'), the account by saying
// no, an admin on Admin → Players.
//
//   action 'status'      -> { ok, email, confirmed }   what the player has (email null: nothing)
//   action 'connect'     -> { ok, email, confirmed: false, emailed } or { ok: false, error }
//   action 'disconnect'  -> { ok }
import { cleanEmail, EMAIL_RE } from './session.js';
import { sendEmail } from './email.js';
import { UUID_RE } from './util.js';

const IGN_RE = /^[A-Za-z0-9_.]{1,20}$/;
// a request waits this long for its yes
export const REQUEST_HOURS = 48;
// requests a player can make in a day (each one sends an email)
const TRIES_PER_DAY = 5;
const now = () => Math.floor(Date.now() / 1000);
const today = () => Math.floor(Date.now() / 86_400_000);

// The player with this email confirmed, as { uuid, name } (their newest name on record), or null.
export async function connectedPlayer(db, email) {
  const e = cleanEmail(email);
  if (!e) return null;
  try {
    return await db.prepare(
      `SELECT a.uuid, COALESCE(p.name, a.name) AS name FROM player_accounts a LEFT JOIN players p ON p.uuid = a.uuid
       WHERE a.email = ? AND a.confirmed_at IS NOT NULL ORDER BY a.confirmed_at DESC LIMIT 1`
    ).bind(e).first();
  } catch {
    return null; // a database from before the table
  }
}

// A request waiting for this email's yes, as { uuid, name, requested_at }, or null.
export async function pendingFor(db, email) {
  const e = cleanEmail(email);
  if (!e) return null;
  try {
    return await db.prepare(
      `SELECT uuid, name, requested_at FROM player_accounts
       WHERE email = ? AND confirmed_at IS NULL AND requested_at > ? ORDER BY requested_at DESC LIMIT 1`
    ).bind(e, now() - REQUEST_HOURS * 3600).first();
  } catch {
    return null;
  }
}

// Every player's connected (or asked-for) email, for the admin page: [{ uuid, name, email, requested_at, confirmed_at }].
export async function connectedList(db) {
  try {
    return (await db.prepare(
      `SELECT a.uuid, COALESCE(p.name, a.name) AS name, a.email, a.requested_at, a.confirmed_at
       FROM player_accounts a LEFT JOIN players p ON p.uuid = a.uuid
       WHERE a.confirmed_at IS NOT NULL OR a.requested_at > ? ORDER BY name COLLATE NOCASE`
    ).bind(now() - REQUEST_HOURS * 3600).all()).results;
  } catch {
    return [];
  }
}

// One message from the mod. page: this server's pages ("https://…/s/<slug>/"), for the email's link.
export async function accountRequest(env, m, page) {
  const db = env.DB;
  const uuid = typeof m.uuid === 'string' && UUID_RE.test(m.uuid) ? m.uuid.toLowerCase() : null;
  const name = typeof m.name === 'string' && IGN_RE.test(m.name) ? m.name : null;
  if (!uuid || !name) return { ok: false, error: 'bad message' };
  const row = await db.prepare('SELECT email, confirmed_at, requested_at, tries, tries_day FROM player_accounts WHERE uuid = ?').bind(uuid).first();
  const live = row && (row.confirmed_at || row.requested_at > now() - REQUEST_HOURS * 3600) ? row : null;

  if (m.action === 'status') return { ok: true, email: live?.email ?? null, confirmed: !!live?.confirmed_at };

  if (m.action === 'disconnect') {
    await db.prepare('DELETE FROM player_accounts WHERE uuid = ?').bind(uuid).run();
    return { ok: true, had: live?.email ?? null };
  }

  if (m.action !== 'connect') return { ok: false, error: 'bad message' };
  const email = cleanEmail(m.email);
  if (!EMAIL_RE.test(email) || email.length > 120) return { ok: false, error: `${String(m.email).slice(0, 60)} isn't an email address` };
  if (live?.confirmed_at && live.email.toLowerCase() === email) return { ok: false, error: `You're already connected to ${email}.` };
  const tries = row && row.tries_day === today() ? row.tries : 0;
  if (tries >= TRIES_PER_DAY) return { ok: false, error: 'You have asked too many times today. Try again tomorrow.' };

  // a new request replaces what the player had, a connected email too: the new one counts once it's confirmed
  await db.prepare(
    `INSERT INTO player_accounts (uuid, name, email, requested_at, confirmed_at, tries, tries_day) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)
     ON CONFLICT(uuid) DO UPDATE SET name = ?2, email = ?3, requested_at = ?4, confirmed_at = NULL, tries = ?5, tries_day = ?6`
  ).bind(uuid, name, email, now(), tries + 1, today()).run();

  const server = env.TENANT?.name || 'the Minecraft server';
  const where = page ? `${page}#/chat` : null;
  const emailed = await sendEmail(env, {
    to: email,
    subject: `${name} wants to connect your mcstats account`,
    text: `${name} asked on ${server} to connect this email to their Minecraft player.\n\n`
      + (where ? `To say yes, sign in to mcstats with this email and open\n\n    ${where}\n\nthen click Connect above the chat box. ` : 'To say yes, sign in to mcstats with this email, open the server’s Chat log and click Connect. ')
      + `Once connected, chat you send from the website shows in game as ${name}.\n\n`
      + `If that wasn't you, ignore this email: nothing is connected unless you say yes, and the request ends in ${REQUEST_HOURS} hours.\n`,
  }).catch(() => false);
  return { ok: true, email, confirmed: false, emailed: !!emailed, page: where };
}

// POST /api/chat/connect { accept: true | false }: the signed-in account answers the request made for its email.
export async function answerConnect(env, who, accept) {
  const db = env.DB;
  const pending = await pendingFor(db, who.email);
  if (!pending) return { status: 404, body: { error: 'No player has asked to connect this account (or the request has ended).' } };
  if (!accept) {
    await db.prepare('DELETE FROM player_accounts WHERE uuid = ? AND confirmed_at IS NULL').bind(pending.uuid).run();
    return { status: 200, body: { ok: true, connected: null } };
  }
  // one player per email: connecting this one lets go of any other
  await db.batch([
    db.prepare('DELETE FROM player_accounts WHERE email = ? AND uuid != ?').bind(cleanEmail(who.email), pending.uuid),
    db.prepare('UPDATE player_accounts SET confirmed_at = ? WHERE uuid = ?').bind(now(), pending.uuid),
  ]);
  return { status: 200, body: { ok: true, connected: pending.name } };
}

// Admin → Players: an admin takes a player's connection away.
export async function disconnectPlayer(db, uuid) {
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return false;
  await db.prepare('DELETE FROM player_accounts WHERE uuid = ?').bind(uuid.toLowerCase()).run();
  return true;
}
