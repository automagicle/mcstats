// Each server's database (src/tenant/schema.js) has the same tables and columns as the old D1 database got
// from migrations/0001-0023, without the first server's rows those migrations put in, and running the
// migrations again changes nothing.
import { applyD1Migrations, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DATA_TABLES, migrate, MIGRATIONS, SCHEMA_VERSION } from '../src/tenant/schema.js';

const tenant = () => env.TENANT.get(env.TENANT.idFromName('00000000000000aa'));
const shape = (cols) => cols.map((c) => [c.name, String(c.type).toUpperCase(), !!c.notnull, c.dflt_value ?? null, c.pk]).sort();

describe('server schema', () => {
  it('matches the D1 migrations, table by table and column by column', async () => {
    await applyD1Migrations(env.DB, env.TEST_LEGACY_MIGRATIONS);
    const d1Tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'").all()).results.map((r) => r.name).sort();
    const d1Indexes = (await env.DB.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all()).results.map((r) => `${r.tbl_name}.${r.name}`).sort();
    expect(d1Tables.length).toBeGreaterThan(20);
    const d1Cols = {};
    for (const t of d1Tables) d1Cols[t] = shape((await env.DB.prepare(`PRAGMA table_info(${t})`).all()).results);

    await runInDurableObject(tenant(), async (_o, state) => {
      const sql = state.storage.sql;
      const mine = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray().map((r) => r.name);
      for (const t of d1Tables) {
        expect(mine, `table ${t}`).toContain(t);
        const cols = shape(sql.exec(`PRAGMA table_info(${t})`).toArray());
        // user_perms gains a role and a chat_admin column here; everything else is identical
        const want = t === 'user_perms' ? [...d1Cols[t], ['role', 'TEXT', true, "'member'", 0], ['chat_admin', 'INTEGER', true, '0', 0]].sort() : d1Cols[t];
        expect(cols, `columns of ${t}`).toEqual(want);
      }
      const idx = sql.exec("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").toArray().map((r) => `${r.tbl_name}.${r.name}`);
      for (const i of d1Indexes) expect(idx, `index ${i}`).toContain(i);
      expect(DATA_TABLES.every((t) => d1Tables.includes(t))).toBe(true);
    });
  });

  it('gives a new server none of the first server’s rows', async () => {
    await runInDurableObject(tenant(), async (_o, state) => {
      const sql = state.storage.sql;
      expect(sql.exec('SELECT COUNT(*) AS n FROM hidden_players').one().n).toBe(0);
      expect(sql.exec('SELECT COUNT(*) AS n FROM player_aliases').one().n).toBe(0);
      expect(sql.exec("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe(String(SCHEMA_VERSION));
    });
  });

  it('is idempotent: running the migrations again, or any one of them twice, changes nothing', async () => {
    await runInDurableObject(tenant(), async (_o, state) => {
      const sql = state.storage.sql;
      const before = sql.exec("SELECT type, name, sql FROM sqlite_master ORDER BY name").toArray();
      expect(migrate(state.storage)).toBe(SCHEMA_VERSION);
      for (const m of MIGRATIONS) state.storage.transactionSync(() => m.up(sql));
      expect(sql.exec("SELECT type, name, sql FROM sqlite_master ORDER BY name").toArray()).toEqual(before);
    });
  });
});
