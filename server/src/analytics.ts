import type { PoolClient } from 'pg';
import { stock } from './cadastros.js';
import { documentSelection } from './documents.js';
import { inTransaction, type ConnectionPool } from './database.js';
import { BusinessError, date, normalize, number } from './finance.js';

type Row = Record<string, unknown>;
type Column = { key: string; label: string; tipo: string };
type Report = { titulo: string; colunas: Column[]; linhas: Row[]; totais: Row; periodo?: string[]; resumo?: (string | number)[][] };
const column = (key: string, label: string, tipo = 'texto'): Column => ({ key, label, tipo });
const money = (n: number): number => Math.round((n + 1e-9) * 100) / 100;
const pct = (n: number, d: number): number => d ? Math.round(n / d * 1000) / 10 : 0;
const monthNames = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function label(month: string): string {
  return `${monthNames[Number(month.slice(5, 7)) - 1]}/${month.slice(2, 4)}`;
}
function shiftMonth(today: string, offset: number): string {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 7);
}
function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
async function today(client: PoolClient): Promise<string> {
  return (await client.query('SELECT CURRENT_DATE::text AS today')).rows[0].today;
}
async function parameter(client: PoolClient, key: string, fallback: string): Promise<number> {
  const result = await client.query('SELECT valor FROM public.parametros WHERE chave = $1 ORDER BY id DESC LIMIT 1', [key]);
  return number(result.rows.length ? result.rows[0].valor : fallback);
}
async function cash(client: PoolClient): Promise<number> {
  const initial = await parameter(client, 'saldo_inicial_caixa', '0');
  const result = await client.query(`SELECT
    (SELECT coalesce(sum(valor),0) FROM public.contas_receber WHERE status='Paga')::float8 AS recebido,
    (SELECT coalesce(sum(valor),0) FROM public.contas_pagar WHERE status='Paga')::float8 AS pago`);
  return money(initial + result.rows[0].recebido - result.rows[0].pago);
}
async function snapshot<T>(pool: ConnectionPool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(pool, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return work(client);
  });
}

async function financialReport(client: PoolClient, name: string, query: URLSearchParams, day: string, start: string, end: string): Promise<Report> {
  const first = name === 'financeiro' ? start.slice(0, 7) : shiftMonth(day, -2);
  let last: string;
  if (name === 'financeiro') last = end.slice(0, 7);
  else {
    const raw = query.get('meses');
    const count = raw === null || raw === '' ? 6 : number(raw);
    if (!Number.isInteger(count) || count < 0 || count > 120) throw new BusinessError('O número de meses deve estar entre 0 e 120.');
    last = shiftMonth(day, count);
  }
  const months: string[] = [];
  let cursor = first;
  while (cursor <= last) {
    if (months.length >= 1200) throw new BusinessError('O período não pode ultrapassar 100 anos.');
    months.push(cursor);
    cursor = shiftMonth(`${cursor}-01`, 1);
  }
  const sales = (await client.query(`SELECT to_char(data,'YYYY-MM') AS mes, coalesce(sum(total),0)::float8 AS total,
    coalesce(sum(custo_total),0)::float8 AS custo FROM public.vendas WHERE status='Confirmada'
    AND data >= $1::date AND data < $2::date GROUP BY 1`, [`${first}-01`, `${shiftMonth(`${last}-01`, 1)}-01`])).rows;
  const accounts = (await client.query(`SELECT 'receber' AS tipo, status, to_char(vencimento,'YYYY-MM') AS vencimento,
    to_char(data_pagamento,'YYYY-MM') AS pagamento, coalesce(sum(valor),0)::float8 AS valor FROM public.contas_receber
    WHERE status IN ('Aberta','Paga') GROUP BY 1,2,3,4
    UNION ALL SELECT 'pagar', status, to_char(vencimento,'YYYY-MM'), to_char(data_pagamento,'YYYY-MM'),
    coalesce(sum(valor),0)::float8 FROM public.contas_pagar WHERE status IN ('Aberta','Paga') GROUP BY 1,2,3,4`)).rows;
  const value = (type: string, status: string, month: string, includeOverdue = false): number =>
    accounts.filter(row => row.tipo === type && row.status === status &&
      (status === 'Paga' ? row.pagamento === month : row.vencimento === month || (includeOverdue && row.vencimento && row.vencimento < month)))
      .reduce((n, row) => n + row.valor, 0);
  if (name === 'financeiro') {
    let accumulated = 0;
    const rows = months.map(month => {
      const salesMonth = sales.find(row => row.mes === month);
      const revenue = salesMonth?.total ?? 0, cost = salesMonth?.custo ?? 0;
      const received = value('receber','Paga',month), paid = value('pagar','Paga',month);
      accumulated += received - paid;
      return { mes: label(month), faturamento: money(revenue), custo: money(cost), lucro: money(revenue-cost),
        recebido: money(received), pago: money(paid), saldo: money(received-paid), acumulado: money(accumulated) };
    });
    const totals: Row = {};
    for (const key of ['faturamento','custo','lucro','recebido','pago','saldo']) totals[key] = money(rows.reduce((n, row) => n + number(row[key as keyof typeof row]), 0));
    return { titulo: 'Relatório financeiro (resultado e caixa por mês)', periodo: [start,end],
      colunas: [column('mes','Mês'),column('faturamento','Faturamento','moeda'),column('custo','Custo (CMV)','moeda'),column('lucro','Lucro bruto','moeda'),column('recebido','Recebido','moeda'),column('pago','Pago','moeda'),column('saldo','Saldo do mês','moeda'),column('acumulado','Acumulado','moeda')],
      linhas: rows, totais: totals };
  }
  const balance = await cash(client);
  let projected = balance;
  const current = day.slice(0,7);
  const rows = months.map(month => {
    const incoming = money(value('receber','Aberta',month, month === current));
    const outgoing = money(value('pagar','Aberta',month, month === current));
    if (month >= current) projected += incoming - outgoing;
    return { mes: label(month), ent_real: money(value('receber','Paga',month)), sai_real: money(value('pagar','Paga',month)),
      ent_prev: incoming, sai_prev: outgoing, saldo: month >= current ? money(projected) : null };
  });
  return { titulo: 'Fluxo de caixa (realizado e projetado)', colunas: [column('mes','Mês'),column('ent_real','Entradas realizadas','moeda'),column('sai_real','Saídas realizadas','moeda'),column('ent_prev','Entradas previstas','moeda'),column('sai_prev','Saídas previstas','moeda'),column('saldo','Saldo projetado','moeda')], linhas: rows, totais: {}, resumo: [['Caixa atual',balance,'moeda']] };
}

export class AnalyticsService {
  constructor(private readonly pool: ConnectionPool) {}

  async report(name: string, query: URLSearchParams): Promise<Report> {
    return snapshot(this.pool, async client => {
      const day = await today(client);
      const end = date(query.get('ate') || day);
      const start = date(query.get('de') || addDays(end, -180));
      const period = [start, end];
      if (name === 'vendas' || name === 'top_clientes' || name === 'vendas_hoje') {
        const from = name === 'vendas_hoje' ? day : start;
        const to = name === 'vendas_hoje' ? day : end;
        const group = name === 'top_clientes' ? 'cliente' : name === 'vendas_hoje' ? 'venda' : query.get('agrupar') || 'venda';
        const expressions: Record<string, string> = { produto: 'i.produto', categoria: "coalesce(nullif(p.categoria,''),'Sem categoria')", cliente: 'v.cliente', mes: "to_char(v.data,'YYYY-MM')" };
        if (group !== 'venda' && !Object.hasOwn(expressions, group)) throw new BusinessError('Agrupamento inválido.');
        const aggregate = (await client.query(`SELECT count(*)::int AS quantidade, coalesce(sum(total),0)::float8 AS total,
          coalesce(sum(custo_total),0)::float8 AS custo FROM public.vendas WHERE status='Confirmada' AND data BETWEEN $1 AND $2`, [from, to])).rows[0];
        const total = money(aggregate.total), profit = money(total - money(aggregate.custo));
        let rows: Row[];
        let columns: Column[];
        if (group === 'venda') {
          rows = (await client.query(`SELECT id, data::text, cliente, coalesce(total,0)::float8 AS total,
            coalesce(custo_total,0)::float8 AS custo FROM public.vendas
            WHERE status='Confirmada' AND data BETWEEN $1 AND $2 ORDER BY data DESC, id DESC`, [from, to])).rows.map(row => {
              const normalized = normalize(row);
              return { id: normalized.id, data: row.data, cliente: row.cliente, total: row.total,
                lucro: money(row.total - row.custo), margem: pct(row.total - row.custo, row.total) };
            });
          columns = [column('id','Venda','int'),column('data','Data','data'),column('cliente','Cliente'),column('total','Total','moeda'),column('lucro','Lucro','moeda'),column('margem','Margem','pct')];
        } else {
          const itemGroup = group === 'produto' || group === 'categoria';
          const expression = expressions[group];
          const result = await client.query(itemGroup
            ? `SELECT ${expression} AS grupo, count(DISTINCT v.id)::int AS vendas, coalesce(sum(i.quantidade),0)::float8 AS qtd,
                coalesce(sum(i.quantidade*i.preco_unitario*(1-coalesce(v.desconto,0)/100)),0)::float8 AS total,
                coalesce(sum(i.quantidade*i.custo_unitario),0)::float8 AS custo
               FROM public.vendas v JOIN public.itens_venda i ON i.venda_id=v.id LEFT JOIN public.produtos p ON p.id=i.produto_id
               WHERE v.status='Confirmada' AND v.data BETWEEN $1 AND $2 GROUP BY 1 ORDER BY total DESC`
            : `SELECT ${expression} AS grupo, count(DISTINCT v.id)::int AS vendas, 0::float8 AS qtd,
                coalesce(sum(v.total),0)::float8 AS total, coalesce(sum(v.custo_total),0)::float8 AS custo
               FROM public.vendas v WHERE v.status='Confirmada' AND v.data BETWEEN $1 AND $2 GROUP BY 1 ORDER BY ${group === 'mes' ? '1' : 'total DESC'}`, [from, to]);
          rows = result.rows.map(row => ({ grupo: group === 'mes' ? label(row.grupo) : row.grupo, vendas: row.vendas, qtd: row.qtd,
            total: money(row.total), lucro: money(row.total - row.custo), margem: pct(row.total - row.custo, row.total) }));
          if (name === 'top_clientes') rows = rows.slice(0, 10);
          const labels: Record<string, string> = { produto: 'Produto', categoria: 'Categoria', cliente: 'Cliente', mes: 'Mês' };
          columns = [column('grupo', labels[group] ?? ''), column('vendas','Nº vendas','int')];
          if (itemGroup) columns.push(column('qtd','Quantidade','num'));
          columns.push(column('total','Faturamento','moeda'),column('lucro','Lucro','moeda'),column('margem','Margem','pct'));
        }
        return { titulo: name === 'top_clientes' ? 'Top clientes por faturamento' : 'Relatório de vendas', periodo: [from,to], colunas: columns, linhas: rows,
          totais: { total, lucro: profit, margem: pct(total - money(aggregate.custo), total) },
          resumo: [['Faturamento',total,'moeda'],['Lucro bruto',profit,'moeda'],['Vendas',aggregate.quantidade,'int'],['Ticket médio',aggregate.quantidade ? money(total / aggregate.quantidade) : 0,'moeda']] };
      }
      if (name === 'abaixo_minimo') return { titulo: 'Produtos abaixo do mínimo / cobertura baixa',
        colunas: [column('sku','SKU'),column('nome','Produto'),column('estoque','Estoque','num'),column('minimo','Mínimo','num'),column('sugestao','Repor','num'),column('status','Status','badge')],
        linhas: (await stock(client)).filter(row => row.status !== 'Normal'), totais: {} };
      if (name === 'vencidas') {
        const rows = (await client.query(`SELECT 'A receber' AS tipo, cliente AS parte, descricao, vencimento::text, valor::float8, ($1::date-vencimento)::int AS dias
          FROM public.contas_receber WHERE status='Aberta' AND vencimento < $1::date
          UNION ALL SELECT 'A pagar', fornecedor, descricao, vencimento::text, valor::float8, ($1::date-vencimento)::int
          FROM public.contas_pagar WHERE status='Aberta' AND vencimento < $1::date ORDER BY dias DESC`, [day])).rows;
        return { titulo: 'Contas vencidas em aberto', colunas: [column('tipo','Tipo'),column('parte','Cliente/Fornecedor'),column('descricao','Descrição'),column('vencimento','Vencimento','data'),column('dias','Dias de atraso','int'),column('valor','Valor','moeda')], linhas: rows, totais: {} };
      }
      if (name === 'aging') {
        const rows = (await client.query(`SELECT cliente,
          coalesce(sum(valor) FILTER (WHERE $1::date-vencimento <= 0),0)::float8 AS a_vencer,
          coalesce(sum(valor) FILTER (WHERE $1::date-vencimento BETWEEN 1 AND 30),0)::float8 AS d30,
          coalesce(sum(valor) FILTER (WHERE $1::date-vencimento BETWEEN 31 AND 60),0)::float8 AS d60,
          coalesce(sum(valor) FILTER (WHERE $1::date-vencimento BETWEEN 61 AND 90),0)::float8 AS d90,
          coalesce(sum(valor) FILTER (WHERE $1::date-vencimento > 90),0)::float8 AS d90p,
          coalesce(sum(valor),0)::float8 AS total FROM public.contas_receber WHERE status='Aberta'
          GROUP BY cliente ORDER BY total DESC`, [day])).rows.map(row => {
            for (const key of ['a_vencer','d30','d60','d90','d90p','total']) row[key] = money(number(row[key]));
            return row;
          });
        const totals: Row = {};
        for (const key of ['a_vencer','d30','d60','d90','d90p','total']) totals[key] = money(rows.reduce((n, row) => n + number(row[key]), 0));
        return { titulo: 'Aging de clientes (contas a receber em aberto)', colunas: [column('cliente','Cliente'),column('a_vencer','A vencer','moeda'),column('d30','1-30 dias','moeda'),column('d60','31-60 dias','moeda'),column('d90','61-90 dias','moeda'),column('d90p','> 90 dias','moeda'),column('total','Total','moeda')], linhas: rows, totais: totals };
      }
      if (name === 'curva_abc') {
        const groups = (await client.query(`SELECT i.produto, coalesce(sum(i.quantidade),0)::float8 AS qtd,
          coalesce(sum(i.quantidade*i.preco_unitario*(1-coalesce(v.desconto,0)/100)),0)::float8 AS total
          FROM public.itens_venda i JOIN public.vendas v ON v.id=i.venda_id
          WHERE v.status='Confirmada' AND v.data BETWEEN $1 AND $2 GROUP BY i.produto ORDER BY total DESC`, [start,end])).rows;
        const total = groups.reduce((n, row) => n + row.total, 0);
        let cumulative = 0;
        const rows = groups.map(row => {
          const part = total ? row.total / total * 100 : 0;
          const previous = cumulative;
          cumulative += part;
          return { produto: row.produto, qtd: row.qtd, total: money(row.total), part: Math.round(part*10)/10,
            acumulado: Math.round(cumulative*10)/10, classe: previous < 80 ? 'A' : previous < 95 ? 'B' : 'C' };
        });
        return { titulo: 'Curva ABC de produtos', periodo: period, colunas: [column('produto','Produto'),column('qtd','Quantidade','num'),column('total','Faturamento','moeda'),column('part','% part.','pct'),column('acumulado','% acumulado','pct'),column('classe','Classe','badge')], linhas: rows, totais: { total: money(total) } };
      }
      if (name === 'financeiro' || name === 'fluxo_caixa') return financialReport(client, name, query, day, start, end);
      throw new BusinessError('Relatório não encontrado.');
    });
  }

  async dashboard(): Promise<Row> {
    return snapshot(this.pool, async client => {
      const day = await today(client);
      const inventory = await stock(client);
      const meta = await parameter(client, 'meta_vendas_mensal', '150000');
      const months = Array.from({ length: 7 }, (_, i) => shiftMonth(day, i - 5));
      const sales = (await client.query(`SELECT to_char(data,'YYYY-MM') AS mes,
        coalesce(sum(total),0)::float8 AS total, coalesce(sum(custo_total),0)::float8 AS custo
        FROM public.vendas WHERE status='Confirmada' AND data >= $1::date - interval '1 year'
        GROUP BY 1`, [day])).rows;
      const aggregates = (await client.query(`SELECT
        count(*) FILTER (WHERE data = $1::date)::int AS pedidos,
        coalesce(sum(custo_total) FILTER (WHERE data >= $1::date - 365),0)::float8 AS cmv
        FROM public.vendas WHERE status='Confirmada'`, [day])).rows[0];
      const active = (await client.query(`SELECT count(*)::int AS n FROM public.clientes
        WHERE lower(trim(coalesce(nullif(ativo,''),'Sim'))) IN ('sim','s','1','true','ativo')`)).rows[0].n;
      const accounts = (await client.query(`SELECT 'receber' AS tipo, emissao::text, vencimento::text, data_pagamento::text, status, valor::float8 FROM public.contas_receber
        UNION ALL SELECT 'pagar', emissao::text, vencimento::text, data_pagamento::text, status, valor::float8 FROM public.contas_pagar`)).rows;
      const categories = (await client.query(`SELECT coalesce(nullif(p.categoria,''),'Sem categoria') AS nome,
        coalesce(sum(i.quantidade * i.preco_unitario * (1 - coalesce(v.desconto,0)/100)),0)::float8 AS valor
        FROM public.vendas v JOIN public.itens_venda i ON i.venda_id=v.id
        LEFT JOIN public.produtos p ON p.id=i.produto_id
        WHERE v.status='Confirmada' AND v.data >= $1::date AND v.data < $2::date
        GROUP BY 1 ORDER BY valor DESC`, [`${months[0]}-01`, `${shiftMonth(day, 1)}-01`])).rows;
      const latest = (await client.query(`SELECT ${documentSelection('vendas')} FROM public.vendas
        WHERE status='Confirmada' ORDER BY data DESC NULLS LAST, id DESC LIMIT 6`)).rows.map(normalize);
      const sale = (m: string): { total: number; custo: number } => sales.find(row => row.mes === m) ?? { total: 0, custo: 0 };
      const current = sale(shiftMonth(day, 0));
      const previous = sale(shiftMonth(day, -1));
      const sum = (rows: Row[]): number => rows.reduce((acc, row) => acc + number(row.valor), 0);
      const open = (kind: string): Row[] => accounts.filter(row => row.tipo === kind && row.status === 'Aberta');
      const receivable = open('receber'), payable = open('pagar');
      const issued = accounts.filter(row => row.tipo === 'receber' && row.status !== 'Cancelada' && typeof row.emissao === 'string' && row.emissao >= addDays(day, -365));
      const overdue = (rows: Row[]): Row[] => rows.filter(row => typeof row.vencimento === 'string' && row.vencimento < day);
      const critical = inventory.filter(row => row.status === 'Crítico');
      const inventoryValue = sum(inventory);
      const alertas: Row[] = [];
      const alert = (n: number, nivel: string, text: string, rota: string): void => { if (n) alertas.push({ nivel, texto: `${n} ${text}`, rota }); };
      alert(critical.length, 'alto', 'produto(s) em nível crítico de estoque', 'estoque');
      alert(overdue(payable).length, 'alto', 'conta(s) a pagar vencida(s)', 'financeiro');
      alert(payable.filter(row => typeof row.vencimento === 'string' && row.vencimento >= day && row.vencimento <= addDays(day, 7)).length, 'medio', 'conta(s) a pagar vencem em 7 dias', 'financeiro');
      alert(overdue(receivable).length, 'alto', 'recebível(is) em atraso', 'financeiro');
      if (meta > 0) alertas.push({ nivel: current.total >= meta ? 'ok' : 'info', texto: `Meta do mês: ${Math.round(current.total / meta * 100)}% atingida (${Math.round(current.total).toLocaleString('pt-BR')} de ${Math.round(meta).toLocaleString('pt-BR')})`, rota: 'dashboard' });
      return {
        kpis: { vendas_mes: money(current.total), vendas_mes_anterior: money(previous.total), lucro_bruto: money(current.total - current.custo),
          clientes_ativos: active, giro_estoque: inventoryValue > 0 ? Math.round(aggregates.cmv / inventoryValue * 10) / 10 : 0,
          caixa_atual: await cash(client), inadimplencia: pct(sum(overdue(issued.filter(row => row.status === 'Aberta'))), sum(issued)),
          itens_estoque: inventory.reduce((n, row) => n + number(row.estoque), 0), valor_estoque: money(inventoryValue),
          pedidos_hoje: aggregates.pedidos, a_receber: money(sum(receivable)), a_pagar: money(sum(payable)) },
        faturamento: months.slice(0, 6).map(m => ({ mes: label(m), valor: money(sale(m).total), lucro: money(sale(m).total - sale(m).custo) })),
        categorias: categories.map(row => ({ nome: row.nome, valor: money(row.valor) })),
        fluxo: months.map((m, i) => {
          const value = (type: string): number => money(sum(accounts.filter(row => row.tipo === type &&
            ((row.status === 'Paga' && typeof row.data_pagamento === 'string' && row.data_pagamento.slice(0, 7) === m) ||
             (row.status === 'Aberta' && i >= 5 && typeof row.vencimento === 'string' && row.vencimento.slice(0, 7) === m)))));
          return { mes: label(m) + (i > 5 ? ' (prev.)' : ''), entradas: value('receber'), saidas: value('pagar') };
        }),
        alertas, ultimas_vendas: latest, criticos: critical.slice(0, 6), meta,
      };
    });
  }
}
