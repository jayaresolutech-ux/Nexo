import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { AuthUnavailableError, InactiveUserError, InvalidSessionError } from '../../dist-server/auth.js';
import { FinanceService } from '../../dist-server/finance.js';
import { financeRoutes } from '../../dist-server/finance-routes.js';
import { CadastroService } from '../../dist-server/cadastros.js';
import { cadastroRoutes } from '../../dist-server/cadastro-routes.js';
import { SearchService } from '../../dist-server/search.js';
import { searchRoutes } from '../../dist-server/search-routes.js';
import { DocumentService } from '../../dist-server/documents.js';
import { documentRoutes } from '../../dist-server/document-routes.js';
import { PartyProfileService } from '../../dist-server/party-profiles.js';
import { AnalyticsService } from '../../dist-server/analytics.js';
import { analyticsRoutes } from '../../dist-server/analytics-routes.js';
import ExcelJS from 'exceljs';
import { createApplication } from '../../dist-server/application.js';
import JSZip from 'jszip';

const connectionString = process.env.TEST_DATABASE_URL;

test('financial routes preserve rules and transaction safety on PostgreSQL', { skip: !connectionString }, async () => {
  const url = new URL(connectionString);
  assert.equal(url.pathname, '/nexo_finance_test', 'Use an isolated, disposable nexo_finance_test database.');
  const pool = new pg.Pool({ connectionString });
  try {
    const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    assert.equal(tables.rowCount, 0, 'The test database must be empty.');
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF; END $$");
    await pool.query(await readFile(new URL('../../supabase/schema.sql', import.meta.url), 'utf8'));
    await pool.query("INSERT INTO public.clientes (nome) VALUES ('Cliente de teste')");
    await pool.query("INSERT INTO public.fornecedores (nome) VALUES ('Fornecedor de teste')");
    let authCalls = 0;
    const auth = {
      async authorize(token) {
        authCalls++;
        if (token === 'invalid') throw new InvalidSessionError();
        if (token === 'inactive') throw new InactiveUserError('Conta inativa.');
        if (token === 'offline') throw new AuthUnavailableError('offline');
      },
    };
    const routes = financeRoutes(new FinanceService(pool), auth);
    async function call(path, { method = 'GET', token = 'valid', body } = {}) {
      const request = new Request(`http://localhost${path}`, {
        method, headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await routes(request);
      return { status: result.status, body: await result.json() };
    }

    assert.equal((await call('/api/contas_receber', { token: '' })).status, 401);
    assert.equal((await call('/api/contas_receber', { token: 'invalid' })).status, 401);
    assert.equal((await call('/api/contas_receber', { token: 'inactive' })).status, 403);
    assert.equal((await call('/api/contas_receber', { token: 'offline' })).status, 503);

    for (const [table, party] of [['contas_receber', 'cliente'], ['contas_pagar', 'fornecedor']]) {
      const endpoint = `/api/${table}`;
      const create = await call(endpoint, {
        method: 'POST',
        body: { [`${party}_id`]: 1, descricao: '  Teste  ', valor: '1.234,56', emissao: '01/11/2026', vencimento: '2026-11-30' },
      });
      assert.equal(create.status, 200);
      assert.equal(create.body[party], party === 'cliente' ? 'Cliente de teste' : 'Fornecedor de teste');
      assert.equal(create.body[`${party}_id`], 1);
      assert.equal(create.body.descricao, 'Teste');
      assert.equal(create.body.valor, 1234.56);
      assert.equal(create.body.emissao, '2026-11-01');
      assert.equal(create.body.status, 'Aberta');
      const path = `${endpoint}/${create.body.id}`;
      const listed = await call(endpoint);
      assert.deepEqual(listed.body, [create.body]);
      const concurrent = await Promise.all([
        call(`${path}/baixar`, { method: 'POST', body: { data: '2026-11-10' } }),
        call(`${path}/baixar`, { method: 'POST', body: { data: '2026-11-10' } }),
      ]);
      assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 400]);
      assert.equal(concurrent.find(result => result.status === 200).body.data_pagamento, '2026-11-10');
      assert.equal((await call(`${path}/estornar`, { method: 'POST' })).body.status, 'Aberta');
      assert.equal((await call(`${path}/estornar`, { method: 'POST' })).status, 400);
      assert.deepEqual((await call(path, { method: 'DELETE' })).body, { ok: true });
      assert.equal((await call(path, { method: 'DELETE' })).status, 400);
      const badValues = [
        { descricao: '', valor: 5 }, { descricao: 'Teste', valor: -1 },
        { descricao: 'Teste', valor: '12x' }, { descricao: 'Teste', valor: 1, vencimento: '2026-02-30' },
      ];
      for (const body of badValues) assert.equal((await call(endpoint, { method: 'POST', body })).status, 400);
      assert.deepEqual((await call(endpoint)).body, []);
      const reference = table === 'contas_receber' ? 'venda_id' : 'compra_id';
      const generated = await pool.query(`INSERT INTO public.${table} (${reference}, descricao, status) VALUES (9, 'Gerada', 'Aberta') RETURNING id`);
      assert.equal((await call(`${endpoint}/${generated.rows[0].id}`, { method: 'DELETE' })).status, 400);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n, 1);
    }
    assert.ok(authCalls > 20);
    assert.equal((await call('/api/contas_receber', { method: 'POST', body: [] })).status, 400);
    assert.equal((await call('/api/contas_receber/0/baixar', { method: 'POST' })).status, 400);
    assert.equal((await call('/api/contas_receber/1/baixar', { method: 'DELETE' })).status, 404);

    const cadastros = cadastroRoutes(new CadastroService(pool), auth, new PartyProfileService(pool));
    async function cadastro(path, { method = 'GET', token = 'valid', body } = {}) {
      const request = new Request(`http://localhost${path}`, {
        method, headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await cadastros(request);
      return { status: result.status, body: await result.json() };
    }

    assert.equal((await cadastro('/api/clientes', { token: '' })).status, 401);
    assert.equal((await cadastro('/api/clientes', { token: 'inactive' })).status, 403);
    assert.equal((await cadastro('/api/clientes', { token: 'offline' })).status, 503);
    assert.equal((await cadastro('/api/clientes', { method: 'POST', body: { nome: '' } })).status, 400);
    assert.equal((await cadastro('/api/fornecedores', { method: 'POST', body: { nome: 'X', avaliacao: 6 } })).status, 400);

    const category = await cadastro('/api/categorias', { method: 'POST', body: { nome: 'Diversos' } });
    assert.equal(category.status, 200);
    assert.equal((await cadastro('/api/categorias', { method: 'POST', body: { nome: 'DIVERSOS' } })).status, 400);
    const product = await cadastro('/api/produtos', {
      method: 'POST',
      body: { nome: 'Produto', categoria: 'Diversos', estoque_atual: 10, preco: '12,50', custo: 4, estoque_minimo: 2 },
    });
    assert.equal(product.status, 200);
    assert.match(product.body.sku, /^P\d{4,}$/);
    assert.equal(product.body.estoque_atual, 10);
    assert.equal(product.body.preco, 12.5);
    const productPath = `/api/produtos/${product.body.id}`;
    assert.equal((await cadastro('/api/produtos', { method: 'POST', body: { nome: 'Outro', sku: product.body.sku.toLowerCase() } })).status, 400);
    assert.equal((await cadastro(`/api/categorias/${category.body.id}`, { method: 'DELETE' })).status, 400);
    assert.equal((await cadastro(`/api/categorias/${category.body.id}`, { method: 'PUT', body: { nome: 'Renomeada' } })).status, 200);
    assert.equal((await cadastro('/api/produtos')).body.find(row => row.id === product.body.id).categoria, 'Renomeada');
    assert.equal((await cadastro(productPath, { method: 'PUT', body: { estoque_atual: 999 } })).body.estoque_atual, 10);
    await pool.query("INSERT INTO public.vendas (id, data, status) VALUES (10, CURRENT_DATE, 'Confirmada'), (11, CURRENT_DATE, 'Orçamento')");
    await pool.query("INSERT INTO public.itens_venda (venda_id, produto_id, quantidade, custo_unitario) VALUES (10, $1, 90, 2), (11, $1, 900, 2)", [product.body.id]);
    const stock = (await cadastro('/api/estoque')).body.find(row => row.id === product.body.id);
    assert.equal(stock.status, 'Atenção');
    assert.equal(stock.valor, 40);
    assert.equal(stock.cobertura_dias, 10);
    assert.equal(stock.giro, 4.5);
    assert.equal(stock.sugestao, 20);
    const adjust = body => cadastro('/api/estoque/ajuste', { method: 'POST', body: { produto_id: product.body.id, ...body } });
    const withdrawals = await Promise.all([
      adjust({ tipo: 'Saída', quantidade: 7 }), adjust({ tipo: 'Saída', quantidade: 7 }),
    ]);
    assert.deepEqual(withdrawals.map(result => result.status).sort(), [200, 400]);
    assert.equal((await adjust({ tipo: 'Inventário', quantidade: 5, motivo: 'Contagem' })).body.estoque_atual, 5);
    assert.equal((await adjust({ tipo: 'Inventário', quantidade: 5 })).status, 400);
    const movements = await cadastro('/api/movimentos');
    assert.deepEqual(movements.body.map(row => row.saldo_apos), [5, 3, 10]);
    assert.equal(movements.body[0].origem, 'Inventário: Contagem');
    assert.deepEqual((await cadastro(productPath, { method: 'DELETE' })).body, { inativado: true });
    assert.equal((await cadastro('/api/produtos')).body.find(row => row.id === product.body.id).ativo, 'Não');
    assert.deepEqual((await cadastro('/api/estoque')).body, []);
    const search = searchRoutes(new SearchService(pool), auth);
    async function find(q, token = 'valid') {
      const request = new Request(`http://localhost/api/busca?q=${encodeURIComponent(q)}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const result = await search(request);
      return { status: result.status, body: await result.json() };
    }
    assert.equal((await find('produto', '')).status, 401);
    assert.deepEqual((await find('x')).body, []);
    assert.equal((await find('PRODUTO')).body[0].rota, 'produtos');
    assert.equal((await find('cliente')).body[0].tipo, 'Cliente');
    assert.equal((await find('#10')).body[0].tipo, 'Venda');
    assert.deepEqual((await find('%_')).body, []);
    await pool.query("INSERT INTO public.clientes (nome) SELECT 'Busca limite' FROM generate_series(1, 65)");
    assert.equal((await find('busca limite')).body.length, 60);

    const docs = documentRoutes(new DocumentService(pool), auth);
    async function document(path, { method = 'GET', token = 'valid', body } = {}) {
      const request = new Request(`http://localhost${path}`, {
        method, headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await docs(request);
      return { status: result.status, body: await result.json() };
    }
    const saleProduct = (await cadastro('/api/produtos', {
      method: 'POST', body: { nome: 'Venda', estoque_atual: 10, preco: 10, custo: 4 },
    })).body;
    await pool.query("UPDATE public.clientes SET ativo='Sim', limite_credito=100 WHERE id=1");
    const saleBody = { cliente_id: 1, data: '2026-11-08', status: 'Confirmada', forma_pagamento: 'A prazo', prazo_dias: 30,
      itens: [{ produto_id: saleProduct.id, quantidade: 6, preco_unitario: 10 }] };
    assert.equal((await document('/api/vendas', { token: '' })).status, 401);
    const competing = await Promise.all([
      document('/api/vendas', { method: 'POST', body: saleBody }),
      document('/api/vendas', { method: 'POST', body: saleBody }),
    ]);
    assert.deepEqual(competing.map(result => result.status).sort(), [200, 400]);
    const sold = competing.find(result => result.status === 200).body;
    assert.equal(sold.total, 60);
    assert.equal(sold.custo_total, 24);
    assert.equal((await document(`/api/vendas/${sold.id}`)).body.itens.length, 1);
    assert.equal((await pool.query('SELECT estoque_atual::float8 AS stock FROM public.produtos WHERE id=$1', [saleProduct.id])).rows[0].stock, 4);
    const receivable = await pool.query('SELECT status, vencimento::text, valor::float8 FROM public.contas_receber WHERE venda_id=$1', [sold.id]);
    assert.deepEqual(receivable.rows, [{ status: 'Aberta', vencimento: '2026-12-08', valor: 60 }]);
    assert.equal((await document(`/api/vendas/${sold.id}/cancelar`, { method: 'POST' })).body.status, 'Cancelada');
    assert.equal((await pool.query('SELECT estoque_atual::float8 AS stock FROM public.produtos WHERE id=$1', [saleProduct.id])).rows[0].stock, 10);
    assert.equal((await pool.query('SELECT status FROM public.contas_receber WHERE venda_id=$1', [sold.id])).rows[0].status, 'Cancelada');
    assert.equal((await document(`/api/vendas/${sold.id}/cancelar`, { method: 'POST' })).status, 400);
    const duplicate = await document('/api/vendas', { method: 'POST', body: {
      ...saleBody, itens: [{ produto_id: saleProduct.id, quantidade: 6 }, { produto_id: saleProduct.id, quantidade: 6 }],
    } });
    assert.equal(duplicate.status, 400);
    const quote = await document('/api/vendas', { method: 'POST', body: { ...saleBody, status: 'Orçamento', itens: [{ produto_id: saleProduct.id, quantidade: 1 }] } });
    assert.equal(quote.body.status, 'Orçamento');
    assert.equal((await document(`/api/vendas/${quote.body.id}/confirmar`, { method: 'POST' })).body.status, 'Confirmada');
    assert.equal((await document(`/api/vendas/${quote.body.id}/confirmar`, { method: 'POST' })).status, 400);
    const creditExceeded = await document('/api/vendas', { method: 'POST', body: {
      ...saleBody, itens: [{ produto_id: saleProduct.id, quantidade: 9, preco_unitario: 11 }],
    } });
    assert.equal(creditExceeded.status, 400);
    assert.match(creditExceeded.body.erro, /crédito/i);
    assert.equal((await pool.query('SELECT estoque_atual::float8 AS stock FROM public.produtos WHERE id=$1', [saleProduct.id])).rows[0].stock, 9);
    const cashSale = await document('/api/vendas', { method: 'POST', body: {
      ...saleBody, forma_pagamento: 'À vista', itens: [{ produto_id: saleProduct.id, quantidade: 1, preco_unitario: 10 }],
    } });
    assert.equal(cashSale.status, 200);
    assert.equal((await pool.query('SELECT status FROM public.contas_receber WHERE venda_id=$1', [cashSale.body.id])).rows[0].status, 'Paga');
    assert.equal((await document(`/api/vendas/${cashSale.body.id}/cancelar`, { method: 'POST' })).status, 200);

    const purchase = await document('/api/compras', { method: 'POST', body: {
      fornecedor_id: 1, status: 'Pedido', data: '2026-11-08', nota_fiscal: '123', prazo_dias: 5,
      itens: [{ produto_id: saleProduct.id, quantidade: 3, custo_unitario: 8 }],
    } });
    assert.equal(purchase.body.status, 'Pedido');
    const receipt = await document(`/api/compras/${purchase.body.id}/receber`, { method: 'POST', body: { data: '2026-11-09' } });
    assert.equal(receipt.body.status, 'Recebida');
    const productAfterReceipt = await pool.query('SELECT estoque_atual::float8, custo::float8 FROM public.produtos WHERE id=$1', [saleProduct.id]);
    assert.deepEqual(productAfterReceipt.rows[0], { estoque_atual: 12, custo: 5 });
    const payable = await pool.query('SELECT status, vencimento::text, valor::float8 FROM public.contas_pagar WHERE compra_id=$1', [purchase.body.id]);
    assert.deepEqual(payable.rows, [{ status: 'Aberta', vencimento: '2026-11-14', valor: 24 }]);
    assert.equal((await document(`/api/compras/${purchase.body.id}/receber`, { method: 'POST' })).status, 400);
    assert.equal((await document(`/api/compras/${purchase.body.id}/cancelar`, { method: 'POST' })).status, 400);

    await pool.query("INSERT INTO public.contas_receber (cliente_id, valor, status, vencimento) VALUES (1, 7, 'Aberta', CURRENT_DATE - 1)");
    const profile = await cadastro('/api/clientes/1/ficha');
    assert.equal(profile.status, 200);
    assert.equal(profile.body.faturamento, 10);
    assert.equal(profile.body.qtd_vendas, 1);
    assert.equal(profile.body.ticket_medio, 10);
    assert.equal(profile.body.em_aberto, 17);
    assert.equal(profile.body.vencido, 7);
    assert.equal(profile.body.limite_disponivel, 83);
    assert.equal(profile.body.historico[0].id, quote.body.id);
    assert.equal((await cadastro('/api/clientes/1/ficha', { token: 'inactive' })).status, 403);
    assert.equal((await cadastro('/api/clientes/99999/ficha')).status, 400);
    assert.equal((await cadastro('/api/produtos/1/ficha')).status, 404);
    await pool.query('UPDATE public.fornecedores SET prazo_entrega_dias = 3 WHERE id = 1');
    const supplier = (await cadastro('/api/fornecedores/1/ficha')).body;
    assert.equal(supplier.total_compras, 24);
    assert.equal(supplier.qtd_compras, 1);
    assert.equal(supplier.prazo_real_medio, 1);
    assert.equal(supplier.entregas_no_prazo_pct, 100);
    assert.equal(supplier.historico[0].id, purchase.body.id);
    await pool.query("INSERT INTO public.vendas (id, cliente_id, cliente, data, status, total) SELECT 1000 + n, 1, 'Cliente de teste', CURRENT_DATE, 'Confirmada', 1 FROM generate_series(1, 35) AS n");
    const many = (await cadastro('/api/clientes/1/ficha')).body;
    assert.equal(many.qtd_vendas, 36);
    assert.equal(many.faturamento, 45);
    assert.equal(many.historico.length, 30);

    const analytics = analyticsRoutes(new AnalyticsService(pool), auth);
    async function analytic(path, token = 'valid') {
      return analytics(new Request(`http://localhost${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }));
    }
    assert.equal((await analytic('/api/dashboard', '')).status, 401);
    assert.equal((await analytic('/api/dashboard', 'inactive')).status, 403);
    const dashboard = await (await analytic('/api/dashboard')).json();
    assert.equal(dashboard.kpis.clientes_ativos, 66);
    assert.equal(dashboard.kpis.pedidos_hoje, 37);
    assert.equal(dashboard.faturamento.length, 6);
    assert.equal(dashboard.fluxo.length, 7);
    assert.equal(dashboard.ultimas_vendas.length, 6);
    assert.equal(dashboard.kpis.a_receber, 17);
    assert.equal(dashboard.kpis.a_pagar, 24);
    const today = (await pool.query('SELECT CURRENT_DATE::text AS day')).rows[0].day;
    const range = `de=${today}&ate=${today}`;
    for (const grouping of ['venda', 'cliente', 'produto', 'categoria', 'mes']) {
      const result = await analytic(`/api/relatorios/vendas?${range}&agrupar=${grouping}`);
      assert.equal(result.status, 200);
      const report = await result.json();
      assert.equal(report.titulo, 'Relatório de vendas');
      assert.equal(report.totais.total, 45);
      assert.equal(report.resumo[2][1], 37);
      assert.deepEqual(report.periodo, [today, today]);
    }
    const group = await (await analytic(`/api/relatorios/vendas?${range}&agrupar=cliente`)).json();
    assert.equal(group.linhas[0].grupo, 'Cliente de teste');
    assert.equal(group.linhas[0].total, 45);
    const abc = await (await analytic(`/api/relatorios/curva_abc?${range}`)).json();
    assert.equal(abc.linhas[0].classe, 'A');
    assert.equal(abc.totais.total, 10);
    const aging = await (await analytic('/api/relatorios/aging')).json();
    assert.equal(aging.totais.total, 17);
    assert.equal(aging.totais.d30, 7);
    const expired = await (await analytic('/api/relatorios/vencidas')).json();
    assert.ok(expired.linhas.some(row => row.tipo === 'A receber' && row.valor === 7 && row.dias === 1));
    const flow = await (await analytic('/api/relatorios/fluxo_caixa?meses=2')).json();
    assert.equal(flow.linhas.length, 5);
    assert.equal(flow.linhas[2].ent_prev, 7);
    const financial = await (await analytic(`/api/relatorios/financeiro?${range}`)).json();
    assert.equal(financial.linhas.length, 1);
    assert.equal(financial.totais.faturamento, 45);
    for (const name of ['abaixo_minimo', 'top_clientes', 'vendas_hoje']) {
      const result = await analytic(`/api/relatorios/${name}`);
      assert.equal(result.status, 200, name);
      const report = await result.json();
      assert.ok(Array.isArray(report.linhas));
      assert.ok(Array.isArray(report.colunas));
    }
    assert.equal((await analytic('/api/relatorios/inexistente')).status, 400);
    assert.equal((await analytic('/api/relatorios/vendas?agrupar=errado')).status, 400);
    assert.equal((await analytic('/api/relatorios/fluxo_caixa?meses=999')).status, 400);
    const excel = await analytic(`/api/relatorios/vendas?${range}&formato=xlsx`);
    assert.equal(excel.status, 200);
    assert.match(excel.headers.get('content-type'), /spreadsheetml/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await excel.arrayBuffer());
    const sheet = workbook.getWorksheet('Relatório');
    assert.equal(sheet.getCell('A1').value, 'Relatório de vendas');
    assert.equal(sheet.getCell('A4').value, 'Venda');
    assert.equal(sheet.getCell(`A${sheet.rowCount}`).value, 'TOTAL');

    const app = createApplication(pool, auth, { supabaseUrl: 'https://example.supabase.co', publishableKey: 'public-key' });
    const appCall = async (path, method = 'GET', body, token = 'valid') => app(new Request(`http://localhost${path}`, {
      method, headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    assert.deepEqual(await (await appCall('/api/health')).json(), { ok: true });
    assert.deepEqual(await (await appCall('/api/config')).json(), { auth_enabled: true, supabase_url: 'https://example.supabase.co', publishable_key: 'public-key' });
    assert.equal((await appCall('/api/bootstrap', 'GET', undefined, '')).status, 401);
    const bootstrap = await (await appCall('/api/bootstrap')).json();
    assert.equal(bootstrap.licenciado, true);
    assert.equal(bootstrap.params.meta_vendas_mensal, '150000');
    const saved = await appCall('/api/parametros', 'POST', { empresa_nome: 'Empresa teste', saldo_inicial_caixa: '1.234,56', meta_vendas_mensal: 200 });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).saldo_inicial_caixa, '1234.56');
    assert.equal((await (await appCall('/api/bootstrap')).json()).empresa, 'Empresa teste');
    assert.equal((await (await appCall('/api/dashboard')).json()).kpis.caixa_atual, 1234.56);
    assert.equal((await appCall('/api/parametros', 'POST', { dias_cobertura_reposicao: -1 })).status, 400);
    assert.equal((await appCall('/api/relatorios/vendas', 'GET', undefined, '')).status, 401);
    assert.equal((await appCall('/api/produtos')).status, 200);
    assert.equal((await appCall('/api/vendas')).status, 200);
    assert.equal((await appCall('/api/contas_receber')).status, 200);
    assert.equal((await appCall('/api/busca?q=cliente')).status, 200);
    assert.equal((await appCall('/api/admin/limpar', 'POST', {}, 'inactive')).status, 403);
    assert.equal((await appCall('/api/admin/backup', 'GET', undefined, '')).status, 401);
    const listing = await (await appCall('/api/admin/arquivos')).json();
    assert.equal(listing.armazenamento, 'postgresql');
    assert.equal(listing.arquivos.length, 12);
    assert.equal(listing.arquivos.find(row => row.tabela === 'clientes').linhas, 66);
    await pool.query("INSERT INTO public.produtos (nome,custo) VALUES ('Alta precisão', 123456789012345.6789)");
    const backup = await appCall('/api/admin/backup');
    assert.equal(backup.status, 200);
    assert.match(backup.headers.get('content-type'), /application\/zip/);
    const zip = await JSZip.loadAsync(await backup.arrayBuffer());
    assert.equal(Object.keys(zip.files).length, 12);
    const productBook = new ExcelJS.Workbook();
    await productBook.xlsx.load(await zip.file('Produtos.xlsx').async('nodebuffer'));
    const productsSheet = productBook.worksheets[0];
    assert.equal(productsSheet.getCell('C1').value, 'nome');
    const preciseRow = productsSheet.getRows(2, productsSheet.rowCount - 1).find(row => row.getCell(3).value === 'Alta precisão');
    assert.equal(preciseRow.getCell(6).value, '123456789012345.6789');
    await pool.query("CREATE FUNCTION public.test_reject_clear() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$");
    await pool.query('CREATE TRIGGER test_reject_clear BEFORE DELETE ON public.vendas FOR EACH ROW EXECUTE FUNCTION public.test_reject_clear()');
    assert.equal((await appCall('/api/admin/limpar', 'POST')).status, 500);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.itens_venda')).rows[0].n > 0, true);
    await pool.query('DROP TRIGGER test_reject_clear ON public.vendas');
    await pool.query('DROP FUNCTION public.test_reject_clear()');
    assert.deepEqual(await (await appCall('/api/admin/limpar', 'POST')).json(), { ok: true });
    const empty = await (await appCall('/api/admin/arquivos')).json();
    assert.ok(empty.arquivos.every(row => row.linhas === 0));
    assert.equal((await (await appCall('/api/bootstrap')).json()).params.empresa_nome, 'Empresa XYZ Ltda');
    assert.equal((await appCall('/api/admin/demo', 'POST', {}, 'inactive')).status, 403);
    assert.equal((await appCall('/api/admin/demo', 'POST', {}, '')).status, 401);
    await pool.query("INSERT INTO public.clientes (nome) VALUES ('Dado preservado')");
    await pool.query("CREATE FUNCTION public.test_reject_demo() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test demo rollback'; END $$");
    await pool.query('CREATE TRIGGER test_reject_demo BEFORE INSERT ON public.produtos FOR EACH ROW EXECUTE FUNCTION public.test_reject_demo()');
    assert.equal((await appCall('/api/admin/demo', 'POST')).status, 500);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.clientes WHERE nome='Dado preservado'")).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.categorias')).rows[0].n, 0);
    await pool.query('DROP TRIGGER test_reject_demo ON public.produtos');
    await pool.query('DROP FUNCTION public.test_reject_demo()');
    assert.deepEqual(await (await appCall('/api/admin/demo', 'POST')).json(), { ok: true });
    const demoCounts = (await pool.query(`SELECT
      (SELECT count(*)::int FROM public.clientes) AS clientes,
      (SELECT count(*)::int FROM public.fornecedores) AS fornecedores,
      (SELECT count(*)::int FROM public.produtos) AS produtos,
      (SELECT count(*)::int FROM public.categorias) AS categorias,
      (SELECT count(*)::int FROM public.vendas WHERE status='Confirmada') AS vendas,
      (SELECT count(*)::int FROM public.vendas WHERE status='Orçamento') AS orcamentos,
      (SELECT count(*)::int FROM public.compras WHERE status='Recebida') AS compras,
      (SELECT count(*)::int FROM public.compras WHERE status='Pedido') AS pedidos,
      (SELECT count(*)::int FROM public.contas_receber WHERE status='Paga') AS recebidas,
      (SELECT count(*)::int FROM public.contas_receber WHERE status='Aberta') AS abertas,
      (SELECT count(*)::int FROM public.contas_pagar WHERE status='Paga') AS pagas`)).rows[0];
    assert.deepEqual([demoCounts.clientes, demoCounts.fornecedores, demoCounts.produtos, demoCounts.categorias], [10, 5, 20, 7]);
    assert.deepEqual([demoCounts.vendas, demoCounts.orcamentos, demoCounts.compras, demoCounts.pedidos], [100, 1, 10, 1]);
    assert.ok(demoCounts.recebidas > 0 && demoCounts.abertas > 0 && demoCounts.pagas > 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.clientes WHERE nome='Dado preservado'")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.produtos WHERE estoque_atual < 0")).rows[0].n, 0);
    const discrepancies = (await pool.query(`SELECT count(*)::int AS n FROM public.produtos p WHERE
      p.estoque_atual <> coalesce((SELECT sum(CASE WHEN m.tipo='Entrada' THEN m.quantidade ELSE -m.quantidade END)
      FROM public.movimentos_estoque m WHERE m.produto_id=p.id),0)`)).rows[0].n;
    assert.equal(discrepancies, 0);
    const orphans = (await pool.query(`SELECT
      (SELECT count(*)::int FROM public.vendas v WHERE v.status='Confirmada'
        AND NOT EXISTS (SELECT 1 FROM public.contas_receber r WHERE r.venda_id=v.id)) +
      (SELECT count(*)::int FROM public.compras c WHERE c.status='Recebida'
        AND NOT EXISTS (SELECT 1 FROM public.contas_pagar p WHERE p.compra_id=c.id)) AS n`)).rows[0].n;
    assert.equal(orphans, 0);
    assert.equal((await pool.query("SELECT count(DISTINCT date_trunc('month',data))::int AS n FROM public.vendas WHERE status='Confirmada'")).rows[0].n, 10);
    assert.equal((await (await appCall('/api/bootstrap')).json()).params.saldo_inicial_caixa, '250000');
    assert.equal((await appCall('/api/dashboard')).status, 200);
    assert.equal((await appCall('/api/relatorios/vendas')).status, 200);
  } finally {
    await pool.end();
  }
});
