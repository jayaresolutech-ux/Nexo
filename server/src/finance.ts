import type { PoolClient } from 'pg';
import { inTransaction, lockWrites, type ConnectionPool } from './database.js';

export class BusinessError extends Error {}

export type AccountTable = 'contas_receber' | 'contas_pagar';
export type Input = Record<string, unknown>;

const columns: Record<AccountTable, string> = {
  contas_receber: 'id, venda_id, cliente_id, cliente, descricao, emissao::text, vencimento::text, valor::float8, status, data_pagamento::text',
  contas_pagar: 'id, compra_id, fornecedor_id, fornecedor, descricao, emissao::text, vencimento::text, valor::float8, status, data_pagamento::text',
};

export function number(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'string' && typeof value !== 'number') throw new BusinessError('Valor numérico inválido.');
  let text = String(value).trim().replace('R$', '').replaceAll(' ', '');
  if (text.includes(',')) text = text.replaceAll('.', '').replace(',', '.');
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new BusinessError('Valor numérico inválido.');
  const result = Number(text);
  if (!Number.isFinite(result)) throw new BusinessError('Valor numérico inválido.');
  return result;
}

export function date(value: unknown): string {
  if (value === undefined || value === null || value === '') return new Date().toISOString().slice(0, 10);
  if (typeof value !== 'string') throw new BusinessError('Data inválida. Use o formato AAAA-MM-DD.');
  const text = value.trim().slice(0, 10);
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new BusinessError('Data inválida. Use o formato AAAA-MM-DD.');
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new BusinessError('Data inválida. Use o formato AAAA-MM-DD.');
  }
  return iso;
}

function id(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (!/^\d+$/.test(String(value))) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

export function normalize(row: Record<string, unknown>): Record<string, unknown> {
  const result = { ...row };
  for (const key of ['id', 'venda_id', 'compra_id', 'cliente_id', 'fornecedor_id', 'produto_id']) {
    if (result[key] != null) {
      const value = Number(result[key]);
      if (!Number.isSafeInteger(value)) throw new Error('ID do banco fora da faixa suportada.');
      result[key] = value;
    }
  }
  return result;
}

async function find(client: PoolClient, table: AccountTable, accountId: number) {
  const result = await client.query(`SELECT ${columns[table]} FROM public.${table} WHERE id = $1 FOR UPDATE`, [accountId]);
  return result.rows[0] ? normalize(result.rows[0]) : null;
}

export class FinanceService {
  constructor(private readonly pool: ConnectionPool) {}

  async list(table: AccountTable): Promise<Record<string, unknown>[]> {
    return inTransaction(this.pool, async client => {
      const result = await client.query(`SELECT ${columns[table]} FROM public.${table} ORDER BY id`);
      return result.rows.map(normalize);
    });
  }

  async create(table: AccountTable, body: Input): Promise<Record<string, unknown>> {
    const value = number(body.valor);
    if (value <= 0) throw new BusinessError('Informe um valor maior que zero.');
    if (typeof body.descricao !== 'string' || !body.descricao.trim()) throw new BusinessError('Informe a descrição.');
    const description = body.descricao.trim();
    const issued = date(body.emissao);
    const due = date(body.vencimento);
    const receivable = table === 'contas_receber';
    const partyTable = receivable ? 'clientes' : 'fornecedores';
    const partyKey = receivable ? 'cliente' : 'fornecedor';
    const partyId = id(body[`${partyKey}_id`]);
    const partyName = body[partyKey];
    if (partyName !== undefined && partyName !== null && typeof partyName !== 'string') {
      throw new BusinessError('Nome inválido.');
    }
    return inTransaction(this.pool, async client => {
      await lockWrites(client);
      const party = partyId === null ? null : (await client.query(
        `SELECT id, nome FROM public.${partyTable} WHERE id = $1`, [partyId],
      )).rows[0];
      const result = await client.query(
        `INSERT INTO public.${table} (${partyKey}_id, ${partyKey}, descricao, emissao, vencimento, valor, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'Aberta') RETURNING ${columns[table]}`,
        [party?.id ?? null, party?.nome ?? (partyName || 'Avulso'), description, issued, due, Math.round((value + 1e-9) * 100) / 100],
      );
      return normalize(result.rows[0]);
    });
  }

  async settle(table: AccountTable, accountId: number, paymentDate?: unknown): Promise<Record<string, unknown>> {
    const paid = date(paymentDate);
    return inTransaction(this.pool, async client => {
      await lockWrites(client);
      const row = await find(client, table, accountId);
      if (!row || row.status !== 'Aberta') throw new BusinessError('Somente contas em aberto podem ser baixadas.');
      const result = await client.query(
        `UPDATE public.${table} SET status = 'Paga', data_pagamento = $1 WHERE id = $2 RETURNING ${columns[table]}`,
        [paid, accountId],
      );
      return normalize(result.rows[0]);
    });
  }

  async reverse(table: AccountTable, accountId: number): Promise<Record<string, unknown>> {
    return inTransaction(this.pool, async client => {
      await lockWrites(client);
      const row = await find(client, table, accountId);
      if (!row || row.status !== 'Paga') throw new BusinessError('Somente contas pagas podem ser estornadas.');
      const result = await client.query(
        `UPDATE public.${table} SET status = 'Aberta', data_pagamento = NULL WHERE id = $1 RETURNING ${columns[table]}`,
        [accountId],
      );
      return normalize(result.rows[0]);
    });
  }

  async remove(table: AccountTable, accountId: number): Promise<{ ok: true }> {
    return inTransaction(this.pool, async client => {
      await lockWrites(client);
      const row = await find(client, table, accountId);
      if (!row) throw new BusinessError('Lançamento não encontrado.');
      if (row.venda_id || row.compra_id) {
        throw new BusinessError('Contas geradas por vendas/compras não podem ser excluídas (cancele o documento).');
      }
      await client.query(`DELETE FROM public.${table} WHERE id = $1`, [accountId]);
      return { ok: true };
    });
  }
}
