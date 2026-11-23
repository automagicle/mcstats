// A D1-shaped database over a Durable Object's own SQLite, so the query code written for D1
// (db.prepare(sql).bind(...).first() / .all() / .raw() / .run(), db.batch([...])) runs unchanged inside
// a server's Tenant object (localDb), or from elsewhere through that object (remoteDb).
//
// The differences from D1 that matter here: everything is synchronous underneath, so a batch is one
// transactionSync (all or nothing, as in D1); booleans are bound as 1/0 and undefined as NULL (D1 refuses
// undefined); and meta.changes counts rows written, which for a plain insert or update is the same.

const bindable = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

// One statement run against SqlStorage, in D1's result shape.
function execute(sql, q, params, mode) {
  const cursor = sql.exec(q, ...params.map(bindable));
  if (mode === 'raw') return { rows: [...cursor.raw()], columns: cursor.columnNames };
  const results = cursor.toArray();
  const changes = cursor.rowsWritten;
  let last = null;
  if (changes) {
    try { last = sql.exec('SELECT last_insert_rowid() AS id').one().id; } catch { /* not an insert */ }
  }
  return { results, success: true, meta: { changes, last_row_id: last, rows_read: cursor.rowsRead, rows_written: cursor.rowsWritten } };
}

// Shapes a finished statement's result the way the D1 method that asked for it returns it.
function shape(out, mode, col) {
  if (mode === 'raw') return out.rows;
  if (mode === 'rawcols') return [out.columns, ...out.rows];
  if (mode === 'first') {
    const row = out.results[0] ?? null;
    if (row == null) return null;
    return col === undefined ? row : (row[col] ?? null);
  }
  return out;
}

class Statement {
  constructor(runner, q, params = []) {
    this.runner = runner;
    this.q = q;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.runner, this.q, params);
  }
  first(col) {
    return this.runner.one(this, 'first', col);
  }
  all() {
    return this.runner.one(this, 'all');
  }
  run() {
    return this.runner.one(this, 'all');
  }
  raw(options) {
    return this.runner.one(this, options?.columnNames ? 'rawcols' : 'raw');
  }
}

const rawMode = (mode) => (mode === 'raw' || mode === 'rawcols' ? 'raw' : 'all');

// The database inside the Durable Object that owns `storage`.
export function localDb(storage) {
  const sql = storage.sql;
  const runner = {
    async one(stmt, mode, col) {
      return shape(execute(sql, stmt.q, stmt.params, rawMode(mode)), mode, col);
    },
  };
  return {
    prepare: (q) => new Statement(runner, q),
    async batch(stmts) {
      return storage.transactionSync(() => stmts.map((s) => execute(sql, s.q, s.params, 'all')));
    },
    async exec(q) {
      sql.exec(q);
      return { count: 1 };
    },
    // For the Tenant object's RPC (remoteDb's other end): [{ q, p, mode }] run in one transaction.
    run(ops) {
      return storage.transactionSync(() => ops.map((o) => execute(sql, o.q, o.p || [], rawMode(o.mode))));
    },
  };
}

// The same database, reached from another object or the Worker through the server's Tenant stub
// (its query() method). Each call is one round trip; a batch is one round trip and one transaction.
export function remoteDb(stub) {
  const runner = {
    async one(stmt, mode, col) {
      const [out] = await stub.query([{ q: stmt.q, p: stmt.params.map(bindable), mode: rawMode(mode) }]);
      return shape(out, mode, col);
    },
  };
  return {
    prepare: (q) => new Statement(runner, q),
    async batch(stmts) {
      return stub.query(stmts.map((s) => ({ q: s.q, p: s.params.map(bindable), mode: 'all' })));
    },
    async exec() {
      throw new Error('exec is not available from outside the server object');
    },
  };
}
