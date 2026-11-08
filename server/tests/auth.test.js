import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AuthUnavailableError, InactiveUserError, InvalidSessionError, SupabaseAuth } from '../../dist-server/auth.js';

const config = {
  supabaseUrl: 'https://project.supabase.co',
  jwksUrl: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
  secretKey: 'server-secret',
};
let privateKey;
let keys;

before(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), alg: 'ES256', kid: 'test-key' }] });
});

async function token({ issuer = `${config.supabaseUrl}/auth/v1`, audience = 'authenticated',
  role = 'authenticated', expires = '1h' } = {}) {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('user-123')
    .setExpirationTime(expires)
    .sign(privateKey);
}

function authWithUser(user, status = 200) {
  return new SupabaseAuth(config, keys, async () =>
    new Response(status === 404 ? null : JSON.stringify(user), { status }));
}

test('valid signed session and active account are accepted on every request', async () => {
  let calls = 0;
  const auth = new SupabaseAuth(config, keys, async (url, options) => {
    calls++;
    assert.equal(url, 'https://project.supabase.co/auth/v1/admin/users/user-123');
    assert.equal(options.headers.apikey, config.secretKey);
    assert.equal(options.headers.Authorization, `Bearer ${config.secretKey}`);
    return Response.json({ id: 'user-123' });
  });
  const jwt = await token();
  assert.equal((await auth.authorize(jwt)).sub, 'user-123');
  assert.equal((await auth.authorize(jwt)).sub, 'user-123');
  assert.equal(calls, 2);
});

test('rejects invalid issuer, audience, role, expiry and malformed tokens', async () => {
  const auth = authWithUser({ id: 'user-123' });
  for (const jwt of [
    await token({ issuer: 'https://other.example/auth/v1' }),
    await token({ audience: 'anon' }),
    await token({ role: 'anon' }),
    await token({ expires: '0s' }),
    'not-a-token',
  ]) await assert.rejects(auth.authorize(jwt), InvalidSessionError);
});

test('rejects suspended, deleted and absent accounts', async () => {
  const jwt = await token();
  for (const auth of [
    authWithUser({ id: 'user-123', banned_until: '2999-01-01T00:00:00Z' }),
    authWithUser({ id: 'user-123', deleted_at: '2026-01-01T00:00:00Z' }),
    authWithUser(null, 404),
  ]) await assert.rejects(auth.authorize(jwt), InactiveUserError);
  assert.equal(await authWithUser({ id: 'user-123', banned_until: '2000-01-01T00:00:00Z' })
    .isUserActive('user-123'), true);
});

test('fails closed for unavailable or malformed account status', async () => {
  const jwt = await token();
  const offline = new SupabaseAuth(config, keys, async () => { throw new Error('offline'); });
  const brokenJson = new SupabaseAuth(config, keys, async () => new Response('not json'));
  for (const auth of [
    offline, brokenJson, authWithUser({}, 503),
    authWithUser({ id: 'other-user' }),
    authWithUser({ id: 'user-123', banned_until: 'invalid' }),
  ]) await assert.rejects(auth.authorize(jwt), AuthUnavailableError);
});

test('reports unavailable signing keys separately from invalid sessions', async () => {
  const jwt = await token();
  for (const failure of [new errors.JWKSTimeout(), new errors.JOSEError('HTTP failure'),
    new errors.JWKSInvalid(), new TypeError('network failure')]) {
    const auth = new SupabaseAuth(config, async () => { throw failure; });
    await assert.rejects(auth.authorize(jwt), AuthUnavailableError);
  }
});

test('requires HTTPS URLs and a server secret', () => {
  assert.throws(() => new SupabaseAuth({ ...config, supabaseUrl: 'http://example.com' }));
  assert.throws(() => new SupabaseAuth({ ...config, jwksUrl: 'not-a-url' }));
  assert.throws(() => new SupabaseAuth({ ...config, secretKey: '' }));
});
