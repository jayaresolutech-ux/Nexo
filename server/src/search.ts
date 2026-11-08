import { inTransaction, type ConnectionPool } from './database.js';

export interface SearchResult {
  tipo: string;
  rota: string;
  rotulo: string;
  detalhe: string;
}

export class SearchService {
  constructor(private readonly pool: ConnectionPool) {}

  async search(value: string): Promise<SearchResult[]> {
    const term = value.trim().toLowerCase();
    if (term.length < 2) return [];
    return inTransaction(this.pool, async client => {
      const results: SearchResult[] = [];
      const products = await client.query(`
        SELECT sku, nome, estoque_atual::float8, preco::float8 FROM public.produtos
        WHERE position($1 IN lower(coalesce(nome, ''))) > 0 OR position($1 IN lower(coalesce(sku, ''))) > 0
        ORDER BY id LIMIT 60`, [term]);
      for (const product of products.rows) {
        results.push({
          tipo: 'Produto', rota: 'produtos', rotulo: `${product.sku} - ${product.nome}`,
          detalhe: `Estoque ${Number(product.estoque_atual || 0)} | Preço ${Number(product.preco || 0).toFixed(2)}`,
        });
      }
      for (const [table, label, route] of [
        ['clientes', 'Cliente', 'clientes'], ['fornecedores', 'Fornecedor', 'fornecedores'],
      ]) {
        if (results.length >= 60) break;
        const parties = await client.query(`
          SELECT nome, cidade, telefone FROM public.${table}
          WHERE position($1 IN lower(coalesce(nome, ''))) > 0 OR position($1 IN lower(coalesce(documento, ''))) > 0
          ORDER BY id LIMIT $2`, [term, 60 - results.length]);
        for (const party of parties.rows) {
          results.push({ tipo: label!, rota: route!, rotulo: party.nome, detalhe: `${party.cidade || ''} ${party.telefone || ''}`.trim() });
        }
      }
      if (results.length < 60) {
        const sales = await client.query(`
          SELECT id::text, data::text, cliente, status, total::float8 FROM public.vendas
          WHERE id::text = $2 OR position($1 IN lower(coalesce(cliente, ''))) > 0
          ORDER BY id LIMIT $3`, [term, term.replace(/^#+/, ''), 60 - results.length]);
        for (const sale of sales.rows) {
          results.push({
            tipo: 'Venda', rota: 'vendas', rotulo: `Venda #${sale.id} - ${sale.cliente}`,
            detalhe: `${sale.data} | ${sale.status} | R$ ${Number(sale.total || 0).toFixed(2)}`,
          });
        }
      }
      return results;
    });
  }
}
