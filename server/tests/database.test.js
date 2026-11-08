import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabasePool, databaseConfig, inTransaction, transactionPool } from '../../dist-server/database.js';

test('requires a PostgreSQL connection URI and validates pool size without leaking credentials', () => {
  for (const url of ['', 'https://example.com', 'postgres://host', 'not a URL']) {
    assert.throws(() => databaseConfig({ DATABASE_URL: url }), /DATABASE_URL/);
  }
  for (const settings of [
    { DB_POOL_SIZE: '0' }, { DB_POOL_SIZE: 'five' },
    { DB_MAX_OVERFLOW: '-1' }, { DB_POOL_SIZE: '1001' },
  ]) {
    assert.throws(() => databaseConfig({ DATABASE_URL: 'postgresql://user:secret@example.com/db', ...settings }));
  }
  assert.throws(() => databaseConfig({ DATABASE_URL: 'https://user:secret@example.com/db' }), error => {
    assert.ok(!error.message.includes('secret'));
    return true;
  });
  assert.equal(databaseConfig({ DATABASE_URL: 'postgresql://user:secret@example.com/db' }).max, 10);
  assert.equal(databaseConfig({
    DATABASE_URL: 'postgresql://user:secret@example.com/db', DB_POOL_SIZE: '3', DB_MAX_OVERFLOW: '2',
  }).max, 5);
});

test('creates a pool without connecting eagerly', async () => {
  const pool = createDatabasePool({ DATABASE_URL: 'postgresql://user:secret@example.com/db' });
  assert.equal(pool.totalCount, 0);
  await pool.end();
});

function fakePool(failures = {}) {
  const statements = [];
  const releases = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (failures[sql]) throw failures[sql];
      return { rows: [] };
    },
    release(error) { releases.push(error); },
  };
  return { pool: { connect: async () => client }, statements, releases };
}

test('commits completed work and releases its connection', async () => {
  const { pool, statements, releases } = fakePool();
  const result = await inTransaction(pool, async client => {
    await client.query('operation');
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(statements, ['BEGIN', 'operation', 'COMMIT']);
  assert.deepEqual(releases, [undefined]);
});

test('explicit transaction scope reuses the connection without committing or releasing it', async () => {
  const { pool, statements, releases } = fakePool();
  await inTransaction(pool, async client => {
    const scoped = transactionPool(client);
    await inTransaction(scoped, nested => nested.query('nested operation'));
    assert.deepEqual(releases, []);
  });
  assert.deepEqual(statements, ['BEGIN', 'nested operation', 'COMMIT']);
  assert.deepEqual(releases, [undefined]);
});

test('rolls back failed operations and commit failures', async () => {
  for (const stage of ['operation', 'COMMIT']) {
    const failure = new Error(stage);
    const { pool, statements, releases } = fakePool({ [stage]: failure });
    await assert.rejects(inTransaction(pool, client => client.query('operation')), error => error === failure);
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.deepEqual(releases, [undefined]);
  }
});

test('discards the connection if BEGIN or ROLLBACK fails', async () => {
  const startFailure = new Error('start');
  const start = fakePool({ BEGIN: startFailure });
  await assert.rejects(inTransaction(start.pool, async () => {}), error => error === startFailure);
  assert.deepEqual(start.statements, ['BEGIN']);
  assert.equal(start.releases[0], startFailure);

  const failure = new Error('operation');
  const rollbackFailure = new Error('rollback');
  const rollback = fakePool({ operation: failure, ROLLBACK: rollbackFailure });
  await assert.rejects(inTransaction(rollback.pool, client => client.query('operation')), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure, rollbackFailure]);
    return true;
  });
  assert.ok(rollback.releases[0] instanceof Error);
});
