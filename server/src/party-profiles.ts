import { cadastroSelection } from './cadastros.js';
import { documentSelection } from './documents.js';
import { inTransaction, type ConnectionPool } from './database.js';
import { BusinessError, date, normalize, number } from './finance.js';

type Party = 'clientes' | 'fornecedores';

function rounded(value: number): number {
  return Math.round((value + 1e-9) * 100) / 100;
}

export class PartyProfileService {
  constructor(private readonly pool: ConnectionPool) {}

  async profile(kind: Party, id: number): Promise<Record<string, unknown>> {
    return inTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const partyResult = await client.query(`SELECT ${cadastroSelection(kind)} FROM public.${kind} WHERE id = $1`, [id]);
      if (!partyResult.rows[0]) throw new BusinessError(kind === 'clientes' ? 'Cliente não encontrado.' : 'Fornecedor não encontrado.');
      const party = normalize(partyResult.rows[0]);
      if (kind === 'clientes') {
        const totals = (await client.query(
          `SELECT count(*)::int AS quantidade, coalesce(sum(total), 0)::float8 AS total
           FROM public.vendas WHERE cliente_id = $1 AND status = 'Confirmada'`, [id],
        )).rows[0];
        const accounts = (await client.query(
          `SELECT coalesce(sum(valor), 0)::float8 AS aberto,
                  coalesce(sum(valor) FILTER (WHERE vencimento < $2::date), 0)::float8 AS vencido
           FROM public.contas_receber WHERE cliente_id = $1 AND status = 'Aberta'`, [id, date(undefined)],
        )).rows[0];
        const history = await client.query(
          `SELECT ${documentSelection('vendas')} FROM public.vendas
           WHERE cliente_id = $1 AND status = 'Confirmada' ORDER BY data DESC NULLS LAST, id ASC LIMIT 30`, [id],
        );
        const total = number(totals.total);
        const open = number(accounts.aberto);
        const limit = number(party.limite_credito);
        return {
          cliente: party, faturamento: rounded(total), qtd_vendas: totals.quantidade,
          ticket_medio: totals.quantidade ? rounded(total / totals.quantidade) : 0,
          em_aberto: rounded(open), vencido: rounded(number(accounts.vencido)), limite: limit,
          limite_disponivel: limit > 0 ? rounded(limit - open) : null,
          historico: history.rows.map(normalize),
        };
      }

      const totals = (await client.query(
        `SELECT count(*)::int AS quantidade, coalesce(sum(total), 0)::float8 AS total,
                avg(data_recebimento - data)::float8 AS prazo,
                count(*) FILTER (WHERE data_recebimento IS NOT NULL AND data_recebimento - data <= $2)::int AS no_prazo,
                count(*) FILTER (WHERE data_recebimento IS NOT NULL)::int AS com_prazo
         FROM public.compras WHERE fornecedor_id = $1 AND status = 'Recebida'`, [id, number(party.prazo_entrega_dias)],
      )).rows[0];
      const history = await client.query(
        `SELECT ${documentSelection('compras')} FROM public.compras
         WHERE fornecedor_id = $1 AND status = 'Recebida' ORDER BY data DESC NULLS LAST, id ASC LIMIT 30`, [id],
      );
      return {
        fornecedor: party, total_compras: rounded(number(totals.total)), qtd_compras: totals.quantidade,
        prazo_real_medio: totals.prazo === null ? null : Math.round(totals.prazo * 10) / 10,
        entregas_no_prazo_pct: totals.com_prazo ? Math.round(100 * totals.no_prazo / totals.com_prazo) : null,
        historico: history.rows.map(normalize),
      };
    });
  }
}
