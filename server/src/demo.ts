import { CadastroService } from './cadastros.js';
import { inTransaction, lockWrites, transactionPool, type ConnectionPool } from './database.js';
import { DocumentService } from './documents.js';
import { FinanceService } from './finance.js';
import { SettingsService } from './settings.js';

const products = [
  ['Notebook 14" i5 8GB', 'Informática', 2450, 3290, 8],
  ['Notebook 15" i7 16GB', 'Informática', 3900, 5190, 5],
  ['Desktop Office i3', 'Informática', 1800, 2490, 6],
  ['Monitor 24" Full HD', 'Monitores', 520, 790, 10],
  ['Monitor 27" QHD', 'Monitores', 980, 1450, 6],
  ['Monitor UltraWide 29" IPS', 'Monitores', 1100, 1590, 6],
  ['Teclado Mecânico ABNT2', 'Periféricos', 140, 249, 15],
  ['Mouse Sem Fio', 'Periféricos', 38, 79, 25],
  ['Webcam Full HD 1080p', 'Periféricos', 95, 169, 12],
  ['Headset USB com Microfone', 'Áudio', 85, 159, 15],
  ['Caixa de Som Bluetooth 40W', 'Áudio', 210, 359, 10],
  ['Roteador Wi-Fi 6 AX1800', 'Redes', 190, 329, 10],
  ['Switch 8 Portas Gigabit', 'Redes', 120, 209, 8],
  ['Cabo de Rede Cat6 305m', 'Redes', 480, 690, 4],
  ['Hub USB-C 7 em 1', 'Acessórios', 85, 159, 15],
  ['Suporte Monitor Articulado', 'Acessórios', 70, 139, 12],
  ['Mochila Antifurto para Notebook', 'Acessórios', 65, 129, 12],
  ['Nobreak Senoidal 1500VA', 'Energia', 980, 1390, 5],
  ['Estabilizador 1000VA', 'Energia', 180, 289, 8],
  ['Filtro de Linha 6 Tomadas', 'Energia', 18, 39, 30],
] as const;
const customers = [
  ['Varejo Alfa S.A.', 'Campinas'], ['TechSolutions Ltda', 'São Paulo'], ['Distribuidora Gama', 'Santos'],
  ['Consultoria Delta ME', 'Curitiba'], ['Ponto Sigma Comércio', 'Belo Horizonte'], ['Escola Horizonte', 'Sorocaba'],
  ['Clínica Vida Plena', 'Ribeirão Preto'], ['Construtora Pilar', 'Goiânia'], ['Mercado Bom Preço', 'Niterói'],
  ['Agência Pixel', 'Florianópolis'],
] as const;
const suppliers = [
  ['TechImport Brasil', 'São Paulo', 7, 5], ['Global Eletrônicos', 'Manaus', 15, 4],
  ['Distribuidora Norte Tech', 'Recife', 10, 3], ['InfoParts Atacado', 'Curitiba', 5, 4],
  ['Energia Total Ltda', 'Joinville', 12, 5],
] as const;

function monthDay(today: string, offset: number): string {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 10);
}

export async function loadDemo(pool: ConnectionPool, clear: (pool: ConnectionPool) => Promise<unknown>): Promise<{ ok: true }> {
  return inTransaction(pool, async client => {
    await lockWrites(client);
    const scoped = transactionPool(client);
    await clear(scoped);
    const cad = new CadastroService(scoped);
    const docs = new DocumentService(scoped);
    const finance = new FinanceService(scoped);
    const settings = new SettingsService(scoped);
    const day: string = (await client.query('SELECT CURRENT_DATE::text AS day')).rows[0].day;
    for (const category of ['Informática', 'Periféricos', 'Monitores', 'Áudio', 'Redes', 'Acessórios', 'Energia']) {
      await cad.create('categorias', { nome: category });
    }
    const customerIds: number[] = [];
    for (const [nome, cidade] of customers) {
      const row = await cad.create('clientes', { nome, cidade, limite_credito: 1000000 });
      customerIds.push(Number(row.id));
    }
    const supplierIds: number[] = [];
    for (const [nome, cidade, prazo_entrega_dias, avaliacao] of suppliers) {
      const row = await cad.create('fornecedores', { nome, cidade, prazo_entrega_dias, avaliacao });
      supplierIds.push(Number(row.id));
    }
    const productIds: number[] = [];
    for (const [nome, categoria, custo, preco, estoque_minimo] of products) {
      const row = await cad.create('produtos', { nome, categoria, custo, preco, estoque_minimo, unidade: 'UN' });
      productIds.push(Number(row.id));
    }
    for (let month = -9; month <= 0; month++) {
      const when = monthDay(day, month);
      const purchase = await docs.save('compras', {
        fornecedor_id: supplierIds[(month + 9) % supplierIds.length], data: when, status: 'Recebida',
        nota_fiscal: String(1000 + month + 9), prazo_dias: 30,
        itens: products.map((product, i) => ({ produto_id: productIds[i], quantidade: 10, custo_unitario: product[2] })),
      });
      for (let i = 0; i < customerIds.length; i++) {
        const index = (i * 2 + month + 9) % products.length;
        const second = (index + 1) % products.length;
        await docs.save('vendas', {
          cliente_id: customerIds[i], data: when, status: 'Confirmada',
          forma_pagamento: i % 3 === 0 ? 'À vista' : 'A prazo', prazo_dias: 30,
          desconto: i % 5 === 0 ? 5 : 0,
          itens: [{ produto_id: productIds[index], quantidade: 1, preco_unitario: products[index]?.[3] },
            { produto_id: productIds[second], quantidade: 1, preco_unitario: products[second]?.[3] }],
        });
      }
      if (month <= -2) {
        const receivables = await client.query("SELECT id, vencimento::text FROM public.contas_receber WHERE status='Aberta' AND vencimento <= $1::date ORDER BY id", [day]);
        for (const account of receivables.rows) {
          if (Number(account.id) % 8 !== 0) await finance.settle('contas_receber', Number(account.id), account.vencimento);
        }
        const payables = await client.query("SELECT id, vencimento::text FROM public.contas_pagar WHERE compra_id=$1 AND status='Aberta' AND vencimento <= $2::date", [purchase.id, day]);
        for (const account of payables.rows) await finance.settle('contas_pagar', Number(account.id), account.vencimento);
      }
    }
    await docs.save('vendas', { cliente_id: customerIds[0], data: day, status: 'Orçamento', forma_pagamento: 'A prazo',
      prazo_dias: 30, itens: [{ produto_id: productIds[3], quantidade: 3 }] });
    await docs.save('compras', { fornecedor_id: supplierIds[0], data: day, status: 'Pedido', prazo_dias: 30,
      itens: [{ produto_id: productIds[0], quantidade: 5 }] });
    await settings.save({ saldo_inicial_caixa: 250000 });
    return { ok: true };
  });
}
