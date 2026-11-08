import type { PoolClient } from 'pg';
import { inTransaction, lockWrites, type ConnectionPool } from './database.js';
import { BusinessError, normalize, number, type Input } from './finance.js';

export type Cadastro = 'clientes' | 'fornecedores' | 'produtos' | 'categorias';

const configs: Record<Cadastro, { fields: string[]; numeric: string[]; select: string }> = {
  clientes: {
    fields: ['nome', 'documento', 'email', 'telefone', 'cidade', 'limite_credito', 'ativo', 'criado_em', 'observacoes'],
    numeric: ['limite_credito'],
    select: 'id, nome, documento, email, telefone, cidade, limite_credito::float8, ativo, criado_em::text, observacoes',
  },
  fornecedores: {
    fields: ['nome', 'documento', 'email', 'telefone', 'cidade', 'prazo_entrega_dias', 'avaliacao', 'ativo', 'criado_em'],
    numeric: ['prazo_entrega_dias', 'avaliacao'],
    select: 'id, nome, documento, email, telefone, cidade, prazo_entrega_dias, avaliacao::float8, ativo, criado_em::text',
  },
  produtos: {
    fields: ['sku', 'nome', 'categoria', 'unidade', 'custo', 'preco', 'estoque_atual', 'estoque_minimo', 'ativo'],
    numeric: ['custo', 'preco', 'estoque_atual', 'estoque_minimo'],
    select: 'id, sku, nome, categoria, unidade, custo::float8, preco::float8, estoque_atual::float8, estoque_minimo::float8, ativo',
  },
  categorias: { fields: ['nome'], numeric: [], select: 'id, nome' },
};

export function cadastroSelection(table: Cadastro): string {
  return configs[table].select;
}

const references: Record<Exclude<Cadastro, 'categorias'>, [string, string][]> = {
  clientes: [['vendas', 'cliente_id'], ['contas_receber', 'cliente_id']],
  fornecedores: [['compras', 'fornecedor_id'], ['contas_pagar', 'fornecedor_id']],
  produtos: [['itens_venda', 'produto_id'], ['itens_compra', 'produto_id'], ['movimentos_estoque', 'produto_id']],
};

export function isCadastro(value: string): value is Cadastro {
  return Object.hasOwn(configs, value);
}

function clean(table: Cadastro, body: Input, creating: boolean): Input {
  const config = configs[table];
  const result: Input = {};
  for (const field of config.fields) if (Object.hasOwn(body, field)) result[field] = body[field];
  if ((creating || Object.hasOwn(result, 'nome')) && (typeof result.nome !== 'string' || !result.nome.trim())) {
    throw new BusinessError('O campo "nome" é obrigatório.');
  }
  for (const field of config.numeric) {
    if (Object.hasOwn(result, field)) {
      const value = number(result[field]);
      if (value < 0) throw new BusinessError(`O campo "${field}" não pode ser negativo.`);
      if (field === 'prazo_entrega_dias' && !Number.isInteger(value)) throw new BusinessError('Prazo de entrega deve ser inteiro.');
      result[field] = value;
    }
  }
  if (typeof result.avaliacao === 'number' && result.avaliacao > 5) throw new BusinessError('A avaliação deve estar entre 0 e 5.');
  if (Object.hasOwn(result, 'ativo')) {
    result.ativo = ['sim', 's', '1', 'true', 'ativo'].includes(String(result.ativo || 'Sim').trim().toLowerCase()) ? 'Sim' : 'Não';
  }
  return result;
}

async function ensureUnique(client: PoolClient, table: 'produtos' | 'categorias', field: 'sku' | 'nome', value: string, id = 0): Promise<void> {
  const result = await client.query(`SELECT id FROM public.${table} WHERE lower(${field}) = lower($1) AND id <> $2 LIMIT 1`, [value, id]);
  if (result.rowCount) throw new BusinessError(table === 'produtos' ? 'Já existe um produto com este SKU.' : 'Já existe uma categoria com este nome.');
}

async function productMovement(client: PoolClient, product: Record<string, unknown>, kind: 'Entrada' | 'Saída', amount: number, origin: string): Promise<Record<string, unknown>> {
  const next = number(product.estoque_atual) + (kind === 'Entrada' ? amount : -amount);
  const updated = await client.query(`UPDATE public.produtos SET estoque_atual = $1 WHERE id = $2 RETURNING ${configs.produtos.select}`, [next, product.id]);
  await client.query(
    'INSERT INTO public.movimentos_estoque (data, produto_id, produto, tipo, quantidade, origem, saldo_apos) VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6)',
    [product.id, product.nome, kind, amount, origin, next],
  );
  return normalize(updated.rows[0]);
}

export class CadastroService {
  constructor(private readonly pool: ConnectionPool) {}

  async list(table: Cadastro): Promise<Record<string, unknown>[]> {
    return inTransaction(this.pool, async client => {
      const result = await client.query(`SELECT ${configs[table].select} FROM public.${table} ORDER BY id`);
      return result.rows.map(normalize);
    });
  }

  async create(table: Cadastro, body: Input): Promise<Record<string, unknown>> {
    const data = clean(table, body, true);
    return inTransaction(this.pool, async client => {
      await lockWrites(client);
      if (table === 'categorias') await ensureUnique(client, 'categorias', 'nome', String(data.nome));
      if (table !== 'categorias') data.ativo ??= 'Sim';
      if (table === 'clientes' || table === 'fornecedores') {
        data.criado_em = new Date().toISOString().slice(0, 10);
      }
      let initialStock = 0;
      if (table === 'produtos') {
        initialStock = number(data.estoque_atual);
        data.estoque_atual = 0;
        data.unidade ||= 'UN';
        if (data.sku != null && typeof data.sku !== 'string') throw new BusinessError('SKU inválido.');
        data.sku = String(data.sku || '').trim();
        if (!data.sku) {
          const sequence = await client.query("SELECT nextval(pg_get_serial_sequence('public.produtos', 'id')) AS id");
          const productId = Number(sequence.rows[0].id);
          if (!Number.isSafeInteger(productId)) throw new Error('ID do banco fora da faixa suportada.');
          data.id = productId;
          data.sku = `P${String(productId).padStart(4, '0')}`;
        }
        await ensureUnique(client, 'produtos', 'sku', String(data.sku));
      }
      const fields = Object.keys(data);
      const placeholders = fields.map((_, index) => `$${index + 1}`).join(', ');
      const result = await client.query(`INSERT INTO public.${table} (${fields.join(', ')}) VALUES (${placeholders}) RETURNING ${configs[table].select}`, fields.map(field => data[field]));
      const row = normalize(result.rows[0]);
      return table === 'produtos' && initialStock > 0
        ? productMovement(client, row, 'Entrada', initialStock, 'Estoque inicial')
        : row;
    });
  }

  async update(table: Cadastro, id: number, body: Input): Promise<Record<string, unknown>> {
    const data = clean(table, body, false);
    return inTransaction(this.pool, async client => {
      await lockWrites(client);
      const result = await client.query(`SELECT ${configs[table].select} FROM public.${table} WHERE id = $1 FOR UPDATE`, [id]);
      if (!result.rows[0]) throw new BusinessError('Registro não encontrado.');
      const current = normalize(result.rows[0]);
      if (table === 'produtos') {
        delete data.estoque_atual;
        if (Object.hasOwn(data, 'sku')) {
          if (typeof data.sku !== 'string') throw new BusinessError('SKU inválido.');
          await ensureUnique(client, 'produtos', 'sku', data.sku, id);
        }
      }
      if (table === 'categorias' && typeof data.nome === 'string' && data.nome !== current.nome) {
        await ensureUnique(client, 'categorias', 'nome', data.nome, id);
        await client.query('UPDATE public.produtos SET categoria = $1 WHERE categoria = $2', [data.nome, current.nome]);
      }
      const fields = Object.keys(data);
      if (!fields.length) return current;
      const changes = fields.map((field, index) => `${field} = $${index + 1}`).join(', ');
      const updated = await client.query(`UPDATE public.${table} SET ${changes} WHERE id = $${fields.length + 1} RETURNING ${configs[table].select}`, [...fields.map(field => data[field]), id]);
      return normalize(updated.rows[0]);
    });
  }

  async remove(table: Cadastro, id: number): Promise<{ inativado: true } | { excluido: true }> {
    return inTransaction(this.pool, async client => {
      await lockWrites(client);
      const found = await client.query(`SELECT ${configs[table].select} FROM public.${table} WHERE id = $1 FOR UPDATE`, [id]);
      const row = found.rows[0];
      if (!row) throw new BusinessError('Registro não encontrado.');
      if (table === 'categorias') {
        const used = await client.query('SELECT 1 FROM public.produtos WHERE categoria = $1 LIMIT 1', [row.nome]);
        if (used.rowCount) throw new BusinessError('Categoria em uso por produtos. Altere os produtos antes de excluir.');
      } else {
        for (const [related, field] of references[table]) {
          const used = await client.query(`SELECT 1 FROM public.${related} WHERE ${field} = $1 LIMIT 1`, [id]);
          if (used.rowCount) {
            await client.query(`UPDATE public.${table} SET ativo = 'Não' WHERE id = $1`, [id]);
            return { inativado: true };
          }
        }
      }
      await client.query(`DELETE FROM public.${table} WHERE id = $1`, [id]);
      return { excluido: true };
    });
  }

  async adjust(body: Input): Promise<Record<string, unknown>> {
    const productId = Number(body.produto_id);
    if (!Number.isSafeInteger(productId) || productId <= 0) throw new BusinessError('Produto não encontrado.');
    const quantity = number(body.quantidade);
    if (body.motivo != null && typeof body.motivo !== 'string') throw new BusinessError('Motivo inválido.');
    const reason = typeof body.motivo === 'string' ? body.motivo.trim() || 'Ajuste manual' : 'Ajuste manual';
    return inTransaction(this.pool, async client => {
      await lockWrites(client);
      const result = await client.query(`SELECT ${configs.produtos.select} FROM public.produtos WHERE id = $1 FOR UPDATE`, [productId]);
      const product = result.rows[0];
      if (!product) throw new BusinessError('Produto não encontrado.');
      if (body.tipo === 'Inventário') {
        if (quantity < 0) throw new BusinessError('A contagem não pode ser negativa.');
        const difference = quantity - number(product.estoque_atual);
        if (!difference) throw new BusinessError('A contagem informada é igual ao saldo atual.');
        return productMovement(client, product, difference > 0 ? 'Entrada' : 'Saída', Math.abs(difference), `Inventário: ${reason}`);
      }
      if (body.tipo !== 'Entrada' && body.tipo !== 'Saída') throw new BusinessError('Tipo de movimento inválido.');
      if (quantity <= 0) throw new BusinessError('Informe uma quantidade maior que zero.');
      if (body.tipo === 'Saída' && quantity > number(product.estoque_atual)) throw new BusinessError('Saída maior que o saldo em estoque.');
      return productMovement(client, product, body.tipo, quantity, reason);
    });
  }

  async movements(): Promise<Record<string, unknown>[]> {
    return inTransaction(this.pool, async client => {
      const result = await client.query('SELECT id, data::text, produto_id, produto, tipo, quantidade::float8, origem, saldo_apos::float8 FROM public.movimentos_estoque ORDER BY id DESC LIMIT 500');
      return result.rows.map(normalize);
    });
  }

  async stock(): Promise<Record<string, unknown>[]> {
    return inTransaction(this.pool, stock);
  }
}

export async function stock(client: PoolClient): Promise<Record<string, unknown>[]> {
      const coverage = await client.query("SELECT valor FROM public.parametros WHERE chave = 'dias_cobertura_reposicao' ORDER BY id DESC LIMIT 1");
      const days = coverage.rows.length ? number(coverage.rows[0].valor) : 30;
      const result = await client.query(`
        SELECT p.id, p.sku, p.nome, p.categoria, p.ativo,
          COALESCE(p.estoque_atual, 0)::float8 AS estoque,
          COALESCE(p.estoque_minimo, 0)::float8 AS minimo,
          COALESCE(p.custo, 0)::float8 AS custo,
          COALESCE(sum(CASE WHEN v.data >= CURRENT_DATE - 90 THEN i.quantidade ELSE 0 END), 0)::float8 AS saida90,
          COALESCE(sum(CASE WHEN v.data >= CURRENT_DATE - 365 THEN i.quantidade * i.custo_unitario ELSE 0 END), 0)::float8 AS cmv12
        FROM public.produtos p
        LEFT JOIN public.itens_venda i ON i.produto_id = p.id
        LEFT JOIN public.vendas v ON v.id = i.venda_id AND v.status = 'Confirmada'
        GROUP BY p.id ORDER BY p.id
      `);
      return result.rows.filter(row => ['sim', 's', '1', 'true', 'ativo'].includes(String(row.ativo || 'Sim').trim().toLowerCase())).map(row => {
        const estoque = number(row.estoque);
        const minimo = number(row.minimo);
        const custo = number(row.custo);
        const media = number(row.saida90) / 90;
        const cobertura = media > 0 ? estoque / media : null;
        const valor = estoque * custo;
        const giro = valor > 0 ? number(row.cmv12) / valor : 0;
        const status = estoque <= minimo ? 'Crítico' : cobertura !== null && cobertura < days ? 'Atenção' : 'Normal';
        const sugestao = status === 'Normal' ? 0 : Math.ceil(Math.max(minimo * 2 - estoque, Math.ceil(media * days - estoque), 0));
        return {
          id: normalize(row).id, sku: row.sku, nome: row.nome, categoria: row.categoria,
          estoque, minimo, custo, valor: Math.round((valor + 1e-9) * 100) / 100,
          cobertura_dias: cobertura === null ? null : Math.round(cobertura),
          giro: Math.round(giro * 10) / 10, status, sugestao,
        };
      });
}
