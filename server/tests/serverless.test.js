import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServerlessHandler } from '../../dist-server/serverless.js';

test('serverless handler reuses runtime and preserves request path, query, headers and body', async () => {
  let builds = 0;
  const handler = createServerlessHandler(async () => {
    builds++;
    return { application: async request => Response.json({
      path: new URL(request.url).pathname,
      query: new URL(request.url).search,
      authorization: request.headers.get('authorization'),
      body: await request.json(),
    }) };
  });
  const invoke = () => handler(new Request('https://example.test/api/vendas?x=1', {
    method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: '{"valor":12}',
  }));
  const results = await Promise.all([invoke(), invoke()]);
  assert.equal(builds, 1);
  assert.deepEqual(await results[0].json(), {
    path: '/api/vendas', query: '?x=1', authorization: 'Bearer test', body: { valor: 12 },
  });
  assert.equal(results[1].status, 200);
});

test('serverless handler rejects oversized request and retries failed initialization', async () => {
  let attempts = 0;
  const handler = createServerlessHandler(async () => {
    if (++attempts === 1) throw new Error('test initialization failure');
    return { application: async () => Response.json({ ok: true }) };
  });
  assert.equal((await handler(new Request('https://example.test/api/vendas', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }))).status, 413);
  assert.equal(attempts, 0);
  assert.equal((await handler(new Request('https://example.test/api/health'))).status, 503);
  assert.equal((await handler(new Request('https://example.test/api/health'))).status, 200);
  assert.equal(attempts, 2);
});
