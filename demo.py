"""Gera dados de demonstração usando as próprias regras do ERP."""
import datetime
import random

from erp import Erro, iso, hoje, somar_meses

CATEGORIAS = ['Informática', 'Periféricos', 'Monitores', 'Áudio', 'Redes', 'Acessórios', 'Energia']

PRODUTOS = [
    ('Notebook 14" i5 8GB', 'Informática', 2450, 3290, 8), ('Notebook 15" i7 16GB', 'Informática', 3900, 5190, 5),
    ('Desktop Office i3', 'Informática', 1800, 2490, 6), ('Monitor 24" Full HD', 'Monitores', 520, 790, 10),
    ('Monitor 27" QHD', 'Monitores', 980, 1450, 6), ('Monitor UltraWide 29" IPS', 'Monitores', 1100, 1590, 6),
    ('Teclado Mecânico ABNT2', 'Periféricos', 140, 249, 15), ('Mouse Sem Fio', 'Periféricos', 38, 79, 25),
    ('Webcam Full HD 1080p', 'Periféricos', 95, 169, 12), ('Headset USB com Microfone', 'Áudio', 85, 159, 15),
    ('Caixa de Som Bluetooth 40W', 'Áudio', 210, 359, 10), ('Roteador Wi-Fi 6 AX1800', 'Redes', 190, 329, 10),
    ('Switch 8 Portas Gigabit', 'Redes', 120, 209, 8), ('Cabo de Rede Cat6 305m', 'Redes', 480, 690, 4),
    ('Hub USB-C 7 em 1', 'Acessórios', 85, 159, 15), ('Suporte Monitor Articulado', 'Acessórios', 70, 139, 12),
    ('Mochila Antifurto para Notebook', 'Acessórios', 65, 129, 12), ('Nobreak Senoidal 1500VA', 'Energia', 980, 1390, 5),
    ('Estabilizador 1000VA', 'Energia', 180, 289, 8), ('Filtro de Linha 6 Tomadas', 'Energia', 18, 39, 30),
]

CLIENTES = [
    ('Varejo Alfa S.A.', 'Campinas', 80000), ('TechSolutions Ltda', 'São Paulo', 60000),
    ('Distribuidora Gama', 'Santos', 50000), ('Consultoria Delta ME', 'Curitiba', 30000),
    ('Ponto Sigma Comércio', 'Belo Horizonte', 70000), ('Escola Horizonte', 'Sorocaba', 25000),
    ('Clínica Vida Plena', 'Ribeirão Preto', 20000), ('Construtora Pilar', 'Goiânia', 90000),
    ('Mercado Bom Preço', 'Niterói', 35000), ('Agência Pixel', 'Florianópolis', 18000),
]

FORNECEDORES = [
    ('TechImport Brasil', 'São Paulo', 7, 5), ('Global Eletrônicos', 'Manaus', 15, 4),
    ('Distribuidora Norte Tech', 'Recife', 10, 3), ('InfoParts Atacado', 'Curitiba', 5, 4),
    ('Energia Total Ltda', 'Joinville', 12, 5),
]


def carregar(erp):
    rnd = random.Random(2026)
    with erp.s.batch():
        erp.s.clear_all()
        erp.garantir_params()
        for nome in CATEGORIAS:
            erp.cad_criar('categorias', {'nome': nome})
        clientes = [erp.cad_criar('clientes', dict(
            nome=n, cidade=cid, limite_credito=lim * 4, documento=f'{rnd.randint(10, 99)}.{rnd.randint(100, 999)}.'
            f'{rnd.randint(100, 999)}/0001-{rnd.randint(10, 99)}', telefone=f'(11) 9{rnd.randint(1000, 9999)}-'
            f'{rnd.randint(1000, 9999)}', email=f'contato@{n.split()[0].lower()}.com.br'))
            for n, cid, lim in CLIENTES]
        forns = [erp.cad_criar('fornecedores', dict(
            nome=n, cidade=cid, prazo_entrega_dias=prazo, avaliacao=aval, telefone='(11) 4000-1000',
            email=f'vendas@{n.split()[0].lower()}.com.br')) for n, cid, prazo, aval in FORNECEDORES]
        produtos = [erp.cad_criar('produtos', dict(nome=n, categoria=cat, custo=custo, preco=preco,
                                                     estoque_minimo=minimo, unidade='UN'))
                    for n, cat, custo, preco, minimo in PRODUTOS]
        h = hoje()
        inicio = somar_meses(h, -9)
        eventos = []
        # reposição mensal de estoque e vendas ao longo de 10 meses
        d = inicio
        while d <= h:
            eventos.append((d, 'compra_inicial' if d == inicio else 'compra', None))
            d += datetime.timedelta(days=7 if d != inicio else 1)
        d = inicio + datetime.timedelta(days=3)
        while d <= h:
            for _ in range(rnd.choice([1, 2, 2, 3, 4])):
                eventos.append((d, 'venda', None))
            d += datetime.timedelta(days=1)
        eventos.sort(key=lambda e: (e[0], e[1] != 'compra_inicial', e[1] != 'compra'))
        for dia, tipo, _ in eventos:
            data = iso(dia)
            if tipo.startswith('compra'):
                forn = rnd.choice(forns)
                alvo = produtos
                itens = []
                for p in alvo:
                    p = erp.get('produtos', p['id'])
                    if tipo == 'compra' and p['estoque_atual'] > p['estoque_minimo'] * 3:
                        continue
                    base = max(p['estoque_minimo'], 4)
                    qtd = round(base * rnd.uniform(2.5, 3.5)) if tipo == 'compra_inicial' else round(
                        base * rnd.uniform(2, 3.5))
                    itens.append(dict(produto_id=p['id'], quantidade=qtd,
                                      custo_unitario=round(p['custo'] * rnd.uniform(0.97, 1.04), 2)))
                if not itens:
                    continue
                pedido = erp.salvar_compra(dict(fornecedor_id=forn['id'], data=data, status='Pedido',
                                                prazo_dias=rnd.choice([15, 30, 30, 45]), itens=itens,
                                                nota_fiscal=str(rnd.randint(1000, 9999))))
                pedido['data_recebimento'] = None
                recebimento = dia + datetime.timedelta(days=max(1, forn['prazo_entrega_dias'] + rnd.choice(
                    [-1, 0, 0, 1, 3])))
                if recebimento <= h:
                    erp.receber_compra(pedido['id'], iso(recebimento))
            else:
                cli = rnd.choice(clientes)
                itens = []
                for p in rnd.sample(produtos, rnd.randint(1, 4)):
                    p = erp.get('produtos', p['id'])
                    q = rnd.randint(1, 5)
                    if p['estoque_atual'] >= q + p['estoque_minimo'] * 0.4:
                        itens.append(dict(produto_id=p['id'], quantidade=q,
                                          preco_unitario=round(p['preco'] * rnd.uniform(0.95, 1.02), 2)))
                if not itens:
                    continue
                prazo = rnd.choice([0, 15, 30, 30, 45])
                try:
                    erp.salvar_venda(dict(cliente_id=cli['id'], data=data, status='Confirmada',
                                          desconto=rnd.choice([0, 0, 0, 3, 5]),
                                          forma_pagamento='À vista' if prazo == 0 else 'A prazo',
                                          prazo_dias=prazo, itens=itens))
                except Erro:
                    pass
        # baixas: a maioria dos títulos vencidos é paga; alguns ficam em atraso
        for tab in ('contas_receber', 'contas_pagar'):
            for conta in erp.rows(tab):
                if conta['status'] != 'Aberta':
                    continue
                venc = datetime.date.fromisoformat(conta['vencimento'])
                if venc < h - datetime.timedelta(days=20) and (rnd.random() > 0.08 or tab == 'contas_pagar'):
                    erp.baixar_conta(tab, conta['id'], iso(venc + datetime.timedelta(days=rnd.randint(-3, 6))
                                                           if venc + datetime.timedelta(days=6) <= h else venc))
                elif venc < h and tab == 'contas_pagar' and rnd.random() > 0.15:
                    erp.baixar_conta(tab, conta['id'], iso(venc))
        erp.salvar_params(dict(saldo_inicial_caixa='250000'))
        # um orçamento em aberto
        erp.salvar_venda(dict(cliente_id=clientes[0]['id'], status='Orçamento', forma_pagamento='A prazo',
                              prazo_dias=30, itens=[dict(produto_id=produtos[3]['id'], quantidade=3)]))
