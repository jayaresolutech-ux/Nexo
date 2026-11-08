import { createApplication } from './application.js';
import { SupabaseAuth } from './auth.js';
import { createDatabasePool } from './database.js';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Configure ${name}.`);
  return value;
}

export class RuntimeInitializationError extends Error {
  constructor(readonly stage: 'supabase' | 'database-config' | 'database-connect', cause: unknown) {
    super('Falha ao inicializar a API.', { cause });
  }
}

export async function createRuntime(env: NodeJS.ProcessEnv = process.env) {
  let supabaseUrl: string;
  let auth: SupabaseAuth;
  let publishableKey: string;
  try {
    supabaseUrl = required(env, 'SUPABASE_URL').replace(/\/+$/, '');
    auth = new SupabaseAuth({
      supabaseUrl,
      jwksUrl: env.SUPABASE_JWKS_URL?.trim() || `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
      secretKey: required(env, 'SUPABASE_SECRET_KEY'),
    });
    publishableKey = required(env, 'SUPABASE_PUBLISHABLE_KEY');
  } catch (error) {
    throw new RuntimeInitializationError('supabase', error);
  }
  let pool;
  try {
    pool = createDatabasePool(env);
  } catch (error) {
    throw new RuntimeInitializationError('database-config', error);
  }
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end();
    throw new RuntimeInitializationError('database-connect', error);
  }
  return { application: createApplication(pool, auth, { supabaseUrl, publishableKey }), pool };
}
