// Which chat log lines are left out: the admin page's hide and show rules (migrations/0021_chat_rules.sql).
// A line is hidden when an enabled "hide" rule matches it and no enabled "show" rule does. The answer
// is kept on each line (chat.hidden): worked out here for lines as they arrive, and for the whole log
// by one UPDATE whenever the rules change, so rules reach back over old lines too.
export const RULE_KINDS = ['chat', 'emote', 'say', 'join', 'leave', 'death', 'advancement', 'server', 'system'];
export const RULE_MATCHES = ['any', 'exact', 'starts', 'contains', 'ends'];
export const MAX_RULES = 60; // each uses one bound value in the UPDATE (the database allows 100)
export const MAX_RULE_TEXT = 300;

// Case is ignored for plain English letters only, the same as the database's lower().
const low = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const int = (v) => (Number.isSafeInteger(v) ? v : null);

// A rule from the admin page, checked: { action, kind, match, text, from_ms, to_ms }, or an error string.
export function cleanRule(r) {
  if (!r || typeof r !== 'object') return 'bad rule';
  if (r.action !== 'hide' && r.action !== 'show') return 'a rule hides or shows';
  const kind = r.kind == null || r.kind === '' ? null : r.kind;
  if (kind !== null && !RULE_KINDS.includes(kind)) return 'unknown kind of message';
  if (!RULE_MATCHES.includes(r.match)) return 'unknown way to match';
  const text = r.match === 'any' ? '' : typeof r.text === 'string' ? r.text.trim().slice(0, MAX_RULE_TEXT) : '';
  if (r.match !== 'any' && !text) return 'say what text to match';
  const from = r.from_ms == null ? null : int(r.from_ms), to = r.to_ms == null ? null : int(r.to_ms);
  if ((r.from_ms != null && from === null) || (r.to_ms != null && to === null)) return 'bad time';
  if (from !== null && to !== null && to <= from) return 'the end must be after the start';
  if (r.action === 'hide' && kind === null && r.match === 'any' && from === null && to === null) return 'that would hide every message';
  return { action: r.action, kind, match: r.match, text, from_ms: from, to_ms: to };
}

export const loadRules = async (db) => (await db.prepare('SELECT * FROM chat_rules ORDER BY id').all()).results;

// Does a rule match a line ({ kind, text, ts } with ts in unix ms)?
export function ruleMatches(r, m) {
  if (r.kind && r.kind !== m.kind) return false;
  if (r.from_ms != null && m.ts < r.from_ms) return false;
  if (r.to_ms != null && m.ts >= r.to_ms) return false;
  if (r.match === 'any') return true;
  const text = low(m.text), want = low(r.text);
  return r.match === 'exact' ? text === want
    : r.match === 'starts' ? text.startsWith(want)
    : r.match === 'ends' ? text.endsWith(want)
    : text.includes(want);
}

export function hiddenByRules(rules, m) {
  const on = rules.filter((r) => r.enabled);
  return on.some((r) => r.action === 'hide' && ruleMatches(r, m)) && !on.some((r) => r.action === 'show' && ruleMatches(r, m));
}

// The same test as ruleMatches, as SQL over the chat table. The rule's text is bound as ?n (and may be
// used more than once); kinds and times are checked values, written in. (No LIKE: the database limits
// how long its patterns can be, and adverts are long.)
function ruleSql(r, n) {
  const parts = [];
  if (r.kind && RULE_KINDS.includes(r.kind)) parts.push(`kind = '${r.kind}'`);
  if (int(r.from_ms) !== null) parts.push(`ts_ms >= ${r.from_ms}`);
  if (int(r.to_ms) !== null) parts.push(`ts_ms < ${r.to_ms}`);
  if (r.match === 'exact') parts.push(`lower(text) = ?${n}`);
  else if (r.match === 'starts') parts.push(`substr(lower(text), 1, length(?${n})) = ?${n}`);
  else if (r.match === 'ends') parts.push(`substr(lower(text), -length(?${n})) = ?${n}`);
  else if (r.match === 'contains') parts.push(`instr(lower(text), ?${n}) > 0`);
  return parts.length ? `(${parts.join(' AND ')})` : '1';
}
const anyOf = (list) => (list.length ? `(${list.join(' OR ')})` : '0');

// Sets chat.hidden on every line to what the rules say now. Returns how many lines changed.
export async function applyRules(db) {
  const rules = (await loadRules(db)).filter((r) => r.enabled).slice(0, MAX_RULES);
  const sql = rules.map((r, i) => [r.action, ruleSql(r, i + 1)]);
  const want = `(${anyOf(sql.filter(([a]) => a === 'hide').map(([, s]) => s))} AND NOT ${anyOf(sql.filter(([a]) => a === 'show').map(([, s]) => s))})`;
  // every rule's text is bound, used or not, so the numbers line up
  const res = await db.prepare(`UPDATE chat SET hidden = ${want} WHERE hidden != ${want} OR ?${rules.length + 1} IS NULL`)
    .bind(...rules.map((r) => low(r.text)), 1).run();
  return res.meta.changes ?? 0;
}

// For the admin page: every rule with how many lines it matches, and how many lines are hidden in all.
export async function rulesState(db) {
  const rules = await loadRules(db);
  const shown = rules.slice(0, MAX_RULES);
  const cols = shown.map((r, i) => `SUM(${ruleSql(r, i + 1)}) AS r${i}`);
  const row = await db.prepare(`SELECT ${[...cols, 'SUM(hidden) AS hidden', `?${shown.length + 1} AS x`].join(', ')} FROM chat`)
    .bind(...shown.map((r) => low(r.text)), 1).first();
  return {
    rules: rules.map((r, i) => ({ ...r, enabled: !!r.enabled, matches: row?.[`r${i}`] ?? 0 })),
    hidden: row?.hidden ?? 0,
  };
}
