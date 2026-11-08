import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { inTransaction, lockWrites, type ConnectionPool } from './database.js';
import { loadDemo } from './demo.js';

const tables = [
  { name: 'clientes', file: 'Clientes.xlsx', columns: ['id','nome','documento','email','telefone','cidade','limite_credito','ativo','criado_em','observacoes'], dates: ['criado_em'], numeric: ['id','limite_credito'] },
  { name: 'fornecedores', file: 'Fornecedores.xlsx', columns: ['id','nome','documento','email','telefone','cidade','prazo_entrega_dias','avaliacao','ativo','criado_em'], dates: ['criado_em'], numeric: ['id','prazo_entrega_dias','avaliacao'] },
  { name: 'produtos', file: 'Produtos.xlsx', columns: ['id','sku','nome','categoria','unidade','custo','preco','estoque_atual','estoque_minimo','ativo'], dates: [], numeric: ['id','custo','preco','estoque_atual','estoque_minimo'] },
  { name: 'categorias', file: 'Categorias.xlsx', columns: ['id','nome'], dates: [], numeric: ['id'] },
  { name: 'vendas', file: 'Vendas.xlsx', columns: ['id','data','cliente_id','cliente','status','desconto','total','custo_total','forma_pagamento','prazo_dias','observacoes'], dates: ['data'], numeric: ['id','cliente_id','desconto','total','custo_total','prazo_dias'] },
  { name: 'itens_venda', file: 'Itens_Venda.xlsx', columns: ['id','venda_id','produto_id','produto','quantidade','preco_unitario','custo_unitario'], dates: [], numeric: ['id','venda_id','produto_id','quantidade','preco_unitario','custo_unitario'] },
  { name: 'compras', file: 'Compras.xlsx', columns: ['id','data','fornecedor_id','fornecedor','nota_fiscal','status','total','prazo_dias','data_recebimento'], dates: ['data','data_recebimento'], numeric: ['id','fornecedor_id','total','prazo_dias'] },
  { name: 'itens_compra', file: 'Itens_Compra.xlsx', columns: ['id','compra_id','produto_id','produto','quantidade','custo_unitario'], dates: [], numeric: ['id','compra_id','produto_id','quantidade','custo_unitario'] },
  { name: 'movimentos_estoque', file: 'Movimentos_Estoque.xlsx', columns: ['id','data','produto_id','produto','tipo','quantidade','origem','saldo_apos'], dates: ['data'], numeric: ['id','produto_id','quantidade','saldo_apos'] },
  { name: 'contas_receber', file: 'Contas_Receber.xlsx', columns: ['id','venda_id','cliente_id','cliente','descricao','emissao','vencimento','valor','status','data_pagamento'], dates: ['emissao','vencimento','data_pagamento'], numeric: ['id','venda_id','cliente_id','valor'] },
  { name: 'contas_pagar', file: 'Contas_Pagar.xlsx', columns: ['id','compra_id','fornecedor_id','fornecedor','descricao','emissao','vencimento','valor','status','data_pagamento'], dates: ['emissao','vencimento','data_pagamento'], numeric: ['id','compra_id','fornecedor_id','valor'] },
  { name: 'parametros', file: 'Parametros.xlsx', columns: ['id','chave','valor'], dates: [], numeric: ['id'] },
];
const deleteOrder = ['itens_venda','itens_compra','movimentos_estoque','contas_receber','contas_pagar','vendas','compras','produtos','categorias','clientes','fornecedores','parametros'];

export class AdminService {
  constructor(private readonly pool: ConnectionPool) {}

  async list(): Promise<Record<string, unknown>> {
    return inTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const arquivos = [];
      for (const table of tables) {
        const result = await client.query(`SELECT count(*)::int AS linhas FROM public.${table.name}`);
        arquivos.push({ tabela: table.name, arquivo: table.file, linhas: result.rows[0].linhas, tamanho: null });
      }
      return { armazenamento: 'postgresql', pasta: '', arquivos };
    });
  }

  async backup(): Promise<{ data: Uint8Array; day: string }> {
    return inTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const day = (await client.query('SELECT CURRENT_DATE::text AS day')).rows[0].day;
      const zip = new JSZip();
      for (const table of tables) {
        const selection = table.columns.map(col => table.dates.includes(col) ? `${col}::text AS ${col}` : col).join(',');
        const rows = await client.query(`SELECT ${selection} FROM public.${table.name} ORDER BY id`);
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet(table.name.replaceAll('_', ' ').slice(0, 31));
        sheet.addRow(table.columns);
        for (const row of rows.rows) sheet.addRow(table.columns.map(col => {
          const value = row[col];
          if (value === null || value === undefined) return null;
          if (table.numeric.includes(col)) {
            const text = String(value);
            if (text.replace(/[^0-9]/g, '').length > 15) return text;
            const n = Number(value);
            if (!Number.isFinite(n)) throw new Error('Valor numérico fora da faixa suportada no backup.');
            return n;
          }
          if (typeof value !== 'string') throw new Error('Valor incompatível com backup.');
          return value;
        }));
        zip.file(table.file, await workbook.xlsx.writeBuffer());
      }
      return { data: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), day };
    });
  }

  async clear(): Promise<{ ok: true }> {
    return inTransaction(this.pool, async client => {
      await lockWrites(client);
      for (const table of deleteOrder) await client.query(`DELETE FROM public.${table}`);
      return { ok: true };
    });
  }

  async demo(): Promise<{ ok: true }> {
    return loadDemo(this.pool, pool => new AdminService(pool).clear());
  }
}
