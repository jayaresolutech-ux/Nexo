import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';

const algorithms = ['ES256', 'ES384', 'ES512', 'RS256', 'RS384', 'RS512', 'EdDSA'];

export class InvalidSessionError extends Error {}
export class AuthUnavailableError extends Error {}
export class InactiveUserError extends Error {}

export interface AuthConfig {
  supabaseUrl: string;
  jwksUrl: string;
  secretKey: string;
}

function httpsUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} deve ser uma URL HTTPS válida.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} deve ser uma URL HTTPS válida.`);
  }
  return url;
}

export class SupabaseAuth {
  private readonly projectUrl: string;
  private readonly issuer: string;
  private readonly secretKey: string;
  private readonly keys: JWTVerifyGetKey;
  private readonly fetcher: typeof fetch;

  constructor(config: AuthConfig, keys?: JWTVerifyGetKey, fetcher: typeof fetch = fetch) {
    const project = httpsUrl(config.supabaseUrl, 'SUPABASE_URL');
    const jwks = httpsUrl(config.jwksUrl, 'SUPABASE_JWKS_URL');
    if (!config.secretKey.trim()) throw new Error('SUPABASE_SECRET_KEY é necessária.');
    this.projectUrl = project.toString().replace(/\/+$/, '');
    this.issuer = `${this.projectUrl}/auth/v1`;
    this.secretKey = config.secretKey;
    this.keys = keys ?? createRemoteJWKSet(jwks, { timeoutDuration: 5000 });
    this.fetcher = fetcher;
  }

  async validate(token: string): Promise<JWTPayload & { sub: string }> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        algorithms,
        audience: 'authenticated',
        issuer: this.issuer,
      }));
    } catch (error) {
      if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid ||
          error instanceof TypeError || (error instanceof errors.JOSEError && error.constructor === errors.JOSEError)) {
        throw new AuthUnavailableError('Não foi possível validar a sessão no Supabase.', { cause: error });
      }
      if (error instanceof errors.JOSEError) {
        throw new InvalidSessionError('Sessão inválida ou expirada.', { cause: error });
      }
      throw error;
    }
    if (typeof payload.sub !== 'string' || !payload.sub || payload.role !== 'authenticated') {
      throw new InvalidSessionError('Sessão sem identidade de usuário autenticado.');
    }
    return { ...payload, sub: payload.sub };
  }

  async isUserActive(userId: string): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.projectUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        headers: {
          apikey: this.secretKey,
          Authorization: `Bearer ${this.secretKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new AuthUnavailableError('Não foi possível consultar o estado da conta no Supabase Auth.', { cause: error });
    }
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new AuthUnavailableError(`O Supabase Auth retornou HTTP ${response.status} ao verificar a conta.`);
    }
    let user: unknown;
    try {
      user = await response.json();
    } catch (error) {
      throw new AuthUnavailableError('O Supabase Auth retornou um estado de conta inválido.', { cause: error });
    }
    if (typeof user !== 'object' || user === null || Array.isArray(user) || !('id' in user) || user.id !== userId) {
      throw new AuthUnavailableError('O Supabase Auth retornou um usuário inválido.');
    }
    if ('deleted_at' in user && user.deleted_at) return false;
    if (!('banned_until' in user) || user.banned_until === null || user.banned_until === '') return true;
    if (typeof user.banned_until !== 'string') throw new AuthUnavailableError('Suspensão inválida.');
    const expiry = Date.parse(user.banned_until);
    if (!Number.isFinite(expiry)) throw new AuthUnavailableError('Suspensão inválida.');
    return expiry <= Date.now();
  }

  async authorize(token: string): Promise<JWTPayload & { sub: string }> {
    const claims = await this.validate(token);
    if (!await this.isUserActive(claims.sub)) {
      throw new InactiveUserError('Sua conta está inativa ou suspensa. Contate o administrador.');
    }
    return claims;
  }
}
