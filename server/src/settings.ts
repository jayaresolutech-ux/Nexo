import { inTransaction, lockWrites, type ConnectionPool } from './database.js';
import { BusinessError, number, type Input } from './finance.js';
import type { PoolClient } from 'pg';

const defaults: Record<string, string> = {
  empresa_nome: 'Empresa XYZ Ltda', empresa_cnpj: '', empresa_endereco: '', empresa_telefone: '',
  empresa_email: '', usuario: 'Administrador', meta_vendas_mensal: '150000', saldo_inicial_caixa: '0',
  dias_cobertura_reposicao: '30', markup_padrao: '40',
};
const numeric = new Set(['meta_vendas_mensal', 'saldo_inicial_caixa', 'dias_cobertura_reposicao', 'markup_padrao']);

async function load(client: PoolClient): Promise<Record<string, string>> {
  const rows = await client.query('SELECT chave, valor FROM public.parametros ORDER BY id');
  const result = { ...defaults };
  for (const row of rows.rows) if (row.chave) result[row.chave] = row.valor;
  return result;
}

export class SettingsService {
  constructor(private readonly pool: ConnectionPool) {}

  async bootstrap(): Promise<Record<string, unknown>> {
    return inTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const params = await load(client);
      const day = (await client.query('SELECT CURRENT_DATE::text AS hoje')).rows[0].hoje;
      return { licenciado: true, empresa: params.empresa_nome, usuario: params.usuario, hoje: day, pasta: '', params };
    });
  }

  async save(body: Input): Promise<Record<string, string>> {
    const values: [string, string][] = [];
    for (const [key, value] of Object.entries(body)) {
      if (!Object.hasOwn(defaults, key)) continue;
      if (typeof value !== 'string' && typeof value !== 'number') throw new BusinessError(`Valor inválido para "${key}".`);
      if (numeric.has(key)) {
        const n = number(value);
        if (key !== 'saldo_inicial_caixa' && n < 0) throw new BusinessError(`O campo "${key}" não pode ser negativo.`);
        values.push([key, String(n)]);
      } else values.push([key, String(value)]);
    }
    return inTransaction(this.pool, async client => {
      await lockWrites(client);
      for (const [key, value] of values) {
        const updated = await client.query('UPDATE public.parametros SET valor=$2 WHERE id=(SELECT id FROM public.parametros WHERE chave=$1 ORDER BY id DESC LIMIT 1)', [key, value]);
        if (!updated.rowCount) await client.query('INSERT INTO public.parametros (chave,valor) VALUES ($1,$2)', [key, value]);
      }
      return load(client);
    });
  }
}
