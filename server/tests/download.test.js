import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

test('downloads spreadsheets with the refreshed bearer token', async () => {
  const source = await readFile(new URL('../../static/js/core.js', import.meta.url), 'utf8');
  const calls = [];
  let token = 'expired';
  let clicked = false;
  let revoked = false;
  const link = { click() { clicked = true; }, remove() {} };
  const context = {
    Auth: { accessToken: () => token, enabled: () => true, refresh: async () => { token = 'fresh'; }, expire: () => assert.fail('session expired') },
    window: {},
    document: { createElement: () => link, body: { appendChild() {} } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => { revoked = true; } },
    setTimeout: fn => fn(),
    fetch: async (_url, options) => {
      calls.push(options.headers.Authorization);
      return calls.length === 1 ? new Response('{}', { status: 401 }) : new Response('spreadsheet');
    },
    Response,
  };
  vm.createContext(context);
  await vm.runInContext(`${source}\nbaixarArquivo('/api/relatorios/vendas?formato=xlsx', 'vendas.xlsx')`, context);
  assert.deepEqual(calls, ['Bearer expired', 'Bearer fresh']);
  assert.equal(link.href, 'blob:test');
  assert.equal(link.download, 'vendas.xlsx');
  assert.equal(clicked, true);
  assert.equal(revoked, true);
});
