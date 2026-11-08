import pg from 'pg';
import type { PoolClient, PoolConfig } from 'pg';

export interface ConnectionPool {
  connect(): Promise<PoolClient>;
  readonly transactionClient?: PoolClient;
}

export function transactionPool(client: PoolClient): ConnectionPool {
  return { transactionClient: client, connect: async () => client };
}

export async function lockWrites(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('minierp:cadastros'))");
}

export function databaseConfig(env: NodeJS.ProcessEnv): PoolConfig {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('Configure DATABASE_URL com a conexão PostgreSQL.');
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL deve ser uma URI PostgreSQL válida.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw new Error('DATABASE_URL deve ser uma URI PostgreSQL válida.');
  }

  const poolSize = env.DB_POOL_SIZE ?? '5';
  const overflow = env.DB_MAX_OVERFLOW ?? '5';
  if (!/^[1-9]\d*$/.test(poolSize) || !/^\d+$/.test(overflow)) {
    throw new Error('DB_POOL_SIZE deve ser positivo e DB_MAX_OVERFLOW não pode ser negativo.');
  }
  const max = Number(poolSize) + Number(overflow);
  if (!Number.isSafeInteger(max) || max > 1000) {
    throw new Error('O tamanho do pool de conexões é inválido.');
  }
  return { connectionString, max, connectionTimeoutMillis: 30000, idleTimeoutMillis: 30000 };
}

export function createDatabasePool(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  return new pg.Pool(databaseConfig(env));
}

export async function inTransaction<T>(pool: ConnectionPool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (pool.transactionClient) return work(pool.transactionClient);
  const client = await pool.connect();
  let began = false;
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN');
    began = true;
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = new Error('Não foi possível reverter a transação.', { cause: rollbackError });
        throw new AggregateError([error, rollbackError], 'Falha na operação e na reversão da transação.');
      }
    } else {
      releaseError = error instanceof Error ? error : new Error('Não foi possível iniciar a transação.');
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
