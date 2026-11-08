import type { PoolClient } from 'pg';
import { inTransaction, lockWrites, type ConnectionPool } from './database.js';
import { BusinessError, date, normalize, number, type Input } from './finance.js';

export type DocumentKind = 'vendas' | 'compras';
type Row = Record<string, unknown>;

const selections = {
  vendas: 'id, data::text, cliente_id, cliente, status, desconto::float8, total::float8, custo_total::float8, forma_pagamento, prazo_dias, observacoes',
  compras: 'id, data::text, fornecedor_id, fornecedor, nota_fiscal, status, total::float8, prazo_dias, data_recebimento::text',
};
export function documentSelection(kind: DocumentKind): string {
  return selections[kind];
}
const itemSelections = {
  vendas: 'id, venda_id, produto_id, produto, quantidade::float8, preco_unitario::float8, custo_unitario::float8',
  compras: 'id, compra_id, produto_id, produto, quantidade::float8, custo_unitario::float8',
};
const itemTables = { vendas: 'itens_venda', compras: 'itens_compra' };
const foreignKeys = { vendas: 'venda_id', compras: 'compra_id' };

function identifier(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) {
    throw new BusinessError('Identificador inválido.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new BusinessError('Identificador inválido.');
  return parsed;
}

function rounded(value: number): number {
  return Math.round((value + 1e-9) * 100) / 100;
}

function addDays(value: string, days: number): string {
  const result = new Date(`${value}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  if (!Number.isFinite(result.getTime())) throw new BusinessError('Prazo inválido.');
  return result.toISOString().slice(0, 10);
}

function days(value: unknown): number {
  const n = value === undefined || value === null || value === '' ? 30 : number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 365000) throw new BusinessError('Prazo inválido.');
  return n;
}

async function getDocument(client: PoolClient, kind: DocumentKind, id: number, lock = false): Promise<Row> {
  const result = await client.query(`SELECT ${selections[kind]} FROM public.${kind} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!result.rows[0]) throw new BusinessError('Documento não encontrado.');
  return normalize(result.rows[0]);
}

async function getItems(client: PoolClient, kind: DocumentKind, id: number): Promise<Row[]> {
  const result = await client.query(`SELECT ${itemSelections[kind]} FROM public.${itemTables[kind]} WHERE ${foreignKeys[kind]} = $1 ORDER BY id`, [id]);
  return result.rows.map(normalize);
}

async function product(client: PoolClient, id: number): Promise<Row> {
  const result = await client.query('SELECT id, nome, custo::float8, preco::float8, estoque_atual::float8 FROM public.produtos WHERE id = $1 FOR UPDATE', [id]);
  if (!result.rows[0]) throw new BusinessError('Produto não encontrado em um dos itens.');
  return normalize(result.rows[0]);
}

async function move(client: PoolClient, p: Row, type: 'Entrada' | 'Saída', quantity: number, origin: string, day: string, cost?: number): Promise<void> {
  const next = number(p.estoque_atual) + (type === 'Entrada' ? quantity : -quantity);
  const updatedCost = cost ?? number(p.custo);
  await client.query('UPDATE public.produtos SET estoque_atual = $1, custo = $2 WHERE id = $3', [next, updatedCost, p.id]);
  await client.query('INSERT INTO public.movimentos_estoque (data, produto_id, produto, tipo, quantidade, origem, saldo_apos) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [day, p.id, p.nome, type, quantity, origin, next]);
  p.estoque_atual = next;
  p.custo = updatedCost;
}

async function validateSale(client: PoolClient, sale: Row, items: Row[]): Promise<Map<number, Row>> {
  const result = await client.query('SELECT id, ativo, limite_credito::float8 FROM public.clientes WHERE id = $1 FOR UPDATE', [sale.cliente_id]);
  const customer = result.rows[0];
  if (!customer) throw new BusinessError('Selecione o cliente.');
  if (!['sim', 's', '1', 'true', 'ativo'].includes(String(customer.ativo || 'Sim').toLowerCase().trim())) throw new BusinessError('Cliente inativo.');
  if (number(sale.prazo_dias) > 0 && number(customer.limite_credito) > 0) {
    const balance = await client.query("SELECT coalesce(sum(valor),0)::float8 AS total FROM public.contas_receber WHERE cliente_id = $1 AND status = 'Aberta'", [customer.id]);
    if (number(balance.rows[0].total) + number(sale.total) > number(customer.limite_credito) + 0.001) throw new BusinessError('Limite de crédito excedido.');
  }
  const quantities = new Map<number, number>();
  for (const item of items) {
    const id = identifier(item.produto_id);
    quantities.set(id, (quantities.get(id) ?? 0) + number(item.quantidade));
  }
  if (!quantities.size) throw new BusinessError('Inclua pelo menos um item.');
  const products = new Map<number, Row>();
  for (const [id, quantity] of [...quantities].sort(([a], [b]) => a - b)) {
    const p = await product(client, id);
    if (quantity > number(p.estoque_atual)) throw new BusinessError(`Estoque insuficiente para "${p.nome}".`);
    products.set(id, p);
  }
  return products;
}

async function completeSale(client: PoolClient, sale: Row, items: Row[]): Promise<void> {
  const products = await validateSale(client, sale, items);
  let cost = 0;
  for (const item of items) {
    const p = products.get(identifier(item.produto_id));
    if (!p) throw new BusinessError('Produto não encontrado.');
    const quantity = number(item.quantidade);
    cost += quantity * number(p.custo);
    await client.query('UPDATE public.itens_venda SET custo_unitario = $1 WHERE id = $2', [number(p.custo), item.id]);
    await move(client, p, 'Saída', quantity, `Venda #${sale.id}`, String(sale.data));
  }
  await client.query("UPDATE public.vendas SET status = 'Confirmada', custo_total = $1 WHERE id = $2", [rounded(cost), sale.id]);
  const term = number(sale.prazo_dias);
  await client.query(`INSERT INTO public.contas_receber
    (venda_id, cliente_id, cliente, descricao, emissao, vencimento, valor, status, data_pagamento)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [sale.id, sale.cliente_id, sale.cliente, `Venda #${sale.id} (${sale.forma_pagamento})`, sale.data,
    addDays(String(sale.data), term), sale.total, term === 0 ? 'Paga' : 'Aberta', term === 0 ? sale.data : null]);
}

async function receivePurchase(client: PoolClient, purchase: Row, items: Row[], day: string): Promise<void> {
  for (const item of items) {
    const p = await product(client, identifier(item.produto_id));
    const quantity = number(item.quantidade);
    const oldStock = Math.max(number(p.estoque_atual), 0);
    const cost = rounded((oldStock * number(p.custo) + quantity * number(item.custo_unitario)) / (oldStock + quantity));
    await move(client, p, 'Entrada', quantity, `Compra #${purchase.id} NF ${purchase.nota_fiscal || '-'}`, day, cost);
  }
  await client.query("UPDATE public.compras SET status = 'Recebida', data_recebimento = $1 WHERE id = $2", [day, purchase.id]);
  await client.query(`INSERT INTO public.contas_pagar
    (compra_id, fornecedor_id, fornecedor, descricao, emissao, vencimento, valor, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'Aberta')`,
  [purchase.id, purchase.fornecedor_id, purchase.fornecedor, `Compra #${purchase.id} NF ${purchase.nota_fiscal || '-'}`,
    day, addDays(day, number(purchase.prazo_dias)), purchase.total]);
}

export class DocumentService {
  constructor(private readonly pool: ConnectionPool) {}

  async list(kind: DocumentKind): Promise<Row[]> {
    return inTransaction(this.pool, async client => (await client.query(`SELECT ${selections[kind]} FROM public.${kind} ORDER BY id`)).rows.map(normalize));
  }

  async detail(kind: DocumentKind, id: number): Promise<Row> {
    return inTransaction(this.pool, async client => ({ ...await getDocument(client, kind, id), itens: await getItems(client, kind, id) }));
  }

  async save(kind: DocumentKind, body: Input, id?: number): Promise<Row> {
    const sale = kind === 'vendas';
    const partyId = identifier(body[sale ? 'cliente_id' : 'fornecedor_id']);
    const status = body.status || (sale ? 'Orçamento' : 'Pedido');
    if (!(sale ? ['Orçamento', 'Confirmada'] : ['Pedido', 'Recebida']).includes(String(status))) throw new BusinessError('Status inválido.');
    const day = date(body.data);
    const discount = sale ? Math.min(Math.max(number(body.desconto), 0), 100) : 0;
    const payment = body.forma_pagamento || 'À vista';
    if (typeof payment !== 'string' || (body.nota_fiscal != null && typeof body.nota_fiscal !== 'string') ||
        (body.observacoes != null && typeof body.observacoes !== 'string')) throw new BusinessError('Dados do documento inválidos.');
    const term = sale && payment === 'À vista' ? 0 : days(body.prazo_dias);
    if (!Array.isArray(body.itens) || !body.itens.length) throw new BusinessError('Inclua pelo menos um item.');
    return inTransaction(this.pool, async client => {
      await lockWrites(client);
      if (id !== undefined) {
        const existing = await getDocument(client, kind, id, true);
        if (existing.status !== (sale ? 'Orçamento' : 'Pedido')) throw new BusinessError(sale ? 'Somente orçamentos podem ser editados.' : 'Somente pedidos em aberto podem ser editados.');
      }
      const party = await client.query(`SELECT id, nome FROM public.${sale ? 'clientes' : 'fornecedores'} WHERE id = $1 FOR UPDATE`, [partyId]);
      if (!party.rows[0]) throw new BusinessError(sale ? 'Selecione o cliente.' : 'Selecione o fornecedor.');
      const items: Row[] = [];
      for (const value of body.itens as unknown[]) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BusinessError('Item inválido.');
        const input = value as Input;
        const p = await product(client, identifier(input.produto_id));
        const quantity = number(input.quantidade);
        if (quantity <= 0) throw new BusinessError(`Informe a quantidade do produto "${p.nome}".`);
        const priceKey = sale ? 'preco_unitario' : 'custo_unitario';
        const supplied = input[priceKey];
        const price = supplied === undefined || supplied === null || supplied === '' ? number(p[sale ? 'preco' : 'custo']) : number(supplied);
        if (price < 0) throw new BusinessError('Preço/custo não pode ser negativo.');
        items.push({ produto_id: p.id, produto: p.nome, quantidade: quantity, preco_unitario: price, custo_unitario: sale ? number(p.custo) : price });
      }
      const total = rounded(items.reduce((sum, item) => sum + number(item.quantidade) * number(item.preco_unitario), 0) * (1 - discount / 100));
      const cost = rounded(items.reduce((sum, item) => sum + number(item.quantidade) * number(item.custo_unitario), 0));
      const values = sale
        ? [day, partyId, party.rows[0].nome, 'Orçamento', discount, total, cost, payment, term, body.observacoes || '']
        : [day, partyId, party.rows[0].nome, body.nota_fiscal || '', 'Pedido', total, term, null];
      const fields = sale
        ? ['data', 'cliente_id', 'cliente', 'status', 'desconto', 'total', 'custo_total', 'forma_pagamento', 'prazo_dias', 'observacoes']
        : ['data', 'fornecedor_id', 'fornecedor', 'nota_fiscal', 'status', 'total', 'prazo_dias', 'data_recebimento'];
      let documentId: number;
      if (id === undefined) {
        const inserted = await client.query(`INSERT INTO public.${kind} (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, values);
        documentId = identifier(inserted.rows[0].id);
      } else {
        await client.query(`UPDATE public.${kind} SET ${fields.map((field, i) => `${field}=$${i + 1}`).join(',')} WHERE id=$${fields.length + 1}`, [...values, id]);
        await client.query(`DELETE FROM public.${itemTables[kind]} WHERE ${foreignKeys[kind]} = $1`, [id]);
        documentId = id;
      }
      for (const item of items) {
        const columns = sale ? 'venda_id, produto_id, produto, quantidade, preco_unitario, custo_unitario' : 'compra_id, produto_id, produto, quantidade, custo_unitario';
        const args = sale ? [documentId, item.produto_id, item.produto, item.quantidade, item.preco_unitario, item.custo_unitario] : [documentId, item.produto_id, item.produto, item.quantidade, item.custo_unitario];
        await client.query(`INSERT INTO public.${itemTables[kind]} (${columns}) VALUES (${args.map((_, i) => `$${i + 1}`).join(',')})`, args);
      }
      const doc = await getDocument(client, kind, documentId);
      const storedItems = await getItems(client, kind, documentId);
      if (status === 'Confirmada') await completeSale(client, doc, storedItems);
      if (status === 'Recebida') await receivePurchase(client, doc, storedItems, day);
      return getDocument(client, kind, documentId);
    });
  }

  async act(kind: DocumentKind, id: number, action: 'confirmar' | 'cancelar' | 'receber', body: Input): Promise<Row> {
    return inTransaction(this.pool, async client => {
      await lockWrites(client);
      const doc = await getDocument(client, kind, id, true);
      if (kind === 'vendas' && action === 'confirmar') {
        if (doc.status !== 'Orçamento') throw new BusinessError('Somente orçamentos podem ser confirmados.');
        doc.data = date(undefined);
        await client.query('UPDATE public.vendas SET data = $1 WHERE id = $2', [doc.data, id]);
        await completeSale(client, doc, await getItems(client, kind, id));
      } else if (kind === 'compras' && action === 'receber') {
        if (doc.status !== 'Pedido') throw new BusinessError('Somente pedidos em aberto podem ser recebidos.');
        await receivePurchase(client, doc, await getItems(client, kind, id), date(body.data));
      } else if (action === 'cancelar' && kind === 'vendas') {
        if (doc.status === 'Cancelada') throw new BusinessError('Venda não encontrada ou já cancelada.');
        if (doc.status === 'Confirmada') {
          for (const item of await getItems(client, kind, id)) {
            const p = await product(client, identifier(item.produto_id));
            await move(client, p, 'Entrada', number(item.quantidade), `Cancelamento venda #${id}`, date(undefined));
          }
          await client.query("UPDATE public.contas_receber SET status = 'Cancelada' WHERE venda_id = $1", [id]);
        }
        await client.query("UPDATE public.vendas SET status = 'Cancelada' WHERE id = $1", [id]);
      } else if (action === 'cancelar' && kind === 'compras') {
        if (doc.status !== 'Pedido') throw new BusinessError('Somente pedidos em aberto podem ser cancelados.');
        await client.query("UPDATE public.compras SET status = 'Cancelada' WHERE id = $1", [id]);
      } else throw new BusinessError('Operação inválida.');
      return getDocument(client, kind, id);
    });
  }
}
