"""Regras de negócio do Mini ERP."""
import datetime
import io
import math

from openpyxl import Workbook
from openpyxl.styles import Font

from db import HEADER_FILL, HEADER_FONT, SCHEMAS

MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

PARAMETROS_PADRAO = {
    'empresa_nome': 'Empresa XYZ Ltda', 'empresa_cnpj': '', 'empresa_endereco': '',
    'empresa_telefone': '', 'empresa_email': '', 'usuario': 'Administrador',
    'meta_vendas_mensal': '150000', 'saldo_inicial_caixa': '0',
    'dias_cobertura_reposicao': '30', 'markup_padrao': '40',
}

CADASTROS = {
    'clientes': dict(req=['nome'], nums=['limite_credito'], rotulo='Cliente'),
    'fornecedores': dict(req=['nome'], nums=['prazo_entrega_dias', 'avaliacao'], rotulo='Fornecedor'),
    'produtos': dict(req=['nome'], nums=['custo', 'preco', 'estoque_minimo'], rotulo='Produto'),
    'categorias': dict(req=['nome'], nums=[], rotulo='Categoria'),
}
REFERENCIAS = {
    'clientes': [('vendas', 'cliente_id'), ('contas_receber', 'cliente_id')],
    'fornecedores': [('compras', 'fornecedor_id'), ('contas_pagar', 'fornecedor_id')],
    'produtos': [('itens_venda', 'produto_id'), ('itens_compra', 'produto_id'),
                 ('movimentos_estoque', 'produto_id')],
}


class Erro(Exception):
    pass


def hoje():
    return datetime.date.today()


def parse_data(s):
    if isinstance(s, datetime.date):
        return s
    s = str(s or '').strip()[:10]
    for fmt in ('%Y-%m-%d', '%d/%m/%Y'):
        try:
            return datetime.datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    raise Erro(f'Data inválida: "{s}". Use o formato AAAA-MM-DD.')


def iso(d):
    return d.isoformat()


def num(v, default=0.0):
    if v is None or v == '':
        return default
    if isinstance(v, str):
        v = v.strip().replace('R$', '').replace(' ', '')
        if ',' in v:
            v = v.replace('.', '').replace(',', '.')
    try:
        return float(v)
    except (TypeError, ValueError):
        raise Erro(f'Valor numérico inválido: "{v}".')


def r2(x):
    return round(float(x) + 1e-9, 2)


def chave_mes(d):
    return d.strftime('%Y-%m')


def rotulo_mes(chave):
    return f'{MESES[int(chave[5:7]) - 1]}/{chave[2:4]}'


def somar_meses(d, n):
    m = d.month - 1 + n
    return datetime.date(d.year + m // 12, m % 12 + 1, 1)


def sim(v):
    return str(v or 'Sim').strip().lower() in ('sim', 's', '1', 'true', 'ativo')


class ERP:
    def __init__(self, store):
        self.s = store

    # ---------- utilitários ----------
    def rows(self, t):
        return self.s.all(t)

    def get(self, t, id):
        try:
            id = int(id)
        except (TypeError, ValueError):
            return None
        return next((r for r in self.rows(t) if r['id'] == id), None)

    def insert(self, t, data):
        row = {c: data.get(c) for c in SCHEMAS[t][1]}
        row['id'] = self.s.next_id(t)
        self.rows(t).append(row)
        self.s.save(t)
        return row

    def params(self):
        p = dict(PARAMETROS_PADRAO)
        p.update({r['chave']: r['valor'] for r in self.rows('parametros') if r['chave']})
        return p

    def salvar_params(self, dados):
        with self.s.batch():
            for k, v in dados.items():
                if k not in PARAMETROS_PADRAO:
                    continue
                row = next((r for r in self.rows('parametros') if r['chave'] == k), None)
                if row:
                    row['valor'] = str(v)
                else:
                    self.insert('parametros', {'chave': k, 'valor': str(v)})
            self.s.save('parametros')
        return self.params()

    def garantir_params(self):
        with self.s.batch():
            existentes = {r['chave'] for r in self.rows('parametros')}
            for k, v in PARAMETROS_PADRAO.items():
                if k not in existentes:
                    self.insert('parametros', {'chave': k, 'valor': v})

    # ---------- cadastros ----------
    def cad_listar(self, t):
        return self.rows(t)

    def _limpar_cad(self, t, body, novo):
        cfg = CADASTROS[t]
        cols = [c for c in SCHEMAS[t][1] if c != 'id']
        dados = {c: body[c] for c in cols if c in body}
        for c in cfg['req']:
            if not str(dados.get(c, '') if (novo or c in dados) else 'x').strip():
                raise Erro(f'O campo "{c}" é obrigatório.')
        for c in cfg['nums']:
            if c in dados:
                dados[c] = num(dados[c])
                if dados[c] < 0:
                    raise Erro(f'O campo "{c}" não pode ser negativo.')
        if 'avaliacao' in dados and not 0 <= dados['avaliacao'] <= 5:
            raise Erro('A avaliação deve estar entre 0 e 5.')
        if 'ativo' in dados:
            dados['ativo'] = 'Sim' if sim(dados['ativo']) else 'Não'
        return dados

    def cad_criar(self, t, body):
        dados = self._limpar_cad(t, body, True)
        with self.s.batch():
            if t == 'produtos':
                return self._criar_produto(dados)
            dados.setdefault('ativo', 'Sim')
            if t in ('clientes', 'fornecedores'):
                dados['criado_em'] = iso(hoje())
            if t == 'categorias' and any(
                    str(c['nome']).lower() == dados['nome'].lower() for c in self.rows(t)):
                raise Erro('Já existe uma categoria com este nome.')
            return self.insert(t, dados)

    def _criar_produto(self, dados):
        estoque = num(dados.get('estoque_atual', 0))
        dados['estoque_atual'] = 0
        dados.setdefault('ativo', 'Sim')
        dados['unidade'] = dados.get('unidade') or 'UN'
        dados['sku'] = str(dados.get('sku') or '').strip()
        if dados['sku'] and any(str(p['sku']).lower() == dados['sku'].lower() for p in self.rows('produtos')):
            raise Erro('Já existe um produto com este SKU.')
        if not dados['sku']:
            dados['sku'] = f"P{self.s.next_id('produtos'):04d}"
        row = self.insert('produtos', dados)
        if estoque > 0:
            self._mover(row, 'Entrada', estoque, 'Estoque inicial', iso(hoje()))
        return row

    def cad_atualizar(self, t, id, body):
        row = self.get(t, id)
        if not row:
            raise Erro('Registro não encontrado.')
        dados = self._limpar_cad(t, body, False)
        with self.s.batch():
            if t == 'produtos':
                if 'sku' in dados and any(p['id'] != row['id'] and str(p['sku']).lower() == str(
                        dados['sku']).lower() for p in self.rows('produtos')):
                    raise Erro('Já existe um produto com este SKU.')
                for c in ('estoque_atual',):
                    dados.pop(c, None)
            if t == 'categorias' and 'nome' in dados and dados['nome'] != row['nome']:
                for p in self.rows('produtos'):
                    if p['categoria'] == row['nome']:
                        p['categoria'] = dados['nome']
                self.s.save('produtos')
            row.update(dados)
            self.s.save(t)
        return row

    def cad_excluir(self, t, id):
        row = self.get(t, id)
        if not row:
            raise Erro('Registro não encontrado.')
        with self.s.batch():
            if t == 'categorias':
                if any(p['categoria'] == row['nome'] for p in self.rows('produtos')):
                    raise Erro('Categoria em uso por produtos. Altere os produtos antes de excluir.')
            usado = any(r.get(campo) == row['id'] for tab, campo in REFERENCIAS.get(t, []) for r in self.rows(tab))
            if usado:
                row['ativo'] = 'Não'
                self.s.save(t)
                return {'inativado': True}
            self.rows(t).remove(row)
            self.s.save(t)
        return {'excluido': True}

    # ---------- estoque ----------
    def _mover(self, produto, tipo, qtd, origem, data):
        if tipo == 'Saída':
            produto['estoque_atual'] = num(produto['estoque_atual']) - qtd
        else:
            produto['estoque_atual'] = num(produto['estoque_atual']) + qtd
        self.s.save('produtos')
        self.insert('movimentos_estoque', dict(
            data=data, produto_id=produto['id'], produto=produto['nome'], tipo=tipo,
            quantidade=qtd, origem=origem, saldo_apos=produto['estoque_atual']))

    def ajustar_estoque(self, body):
        p = self.get('produtos', body.get('produto_id'))
        if not p:
            raise Erro('Produto não encontrado.')
        tipo = body.get('tipo')
        qtd = num(body.get('quantidade'))
        motivo = (body.get('motivo') or '').strip() or 'Ajuste manual'
        with self.s.batch():
            if tipo == 'Inventário':
                if qtd < 0:
                    raise Erro('A contagem não pode ser negativa.')
                diff = qtd - num(p['estoque_atual'])
                if diff == 0:
                    raise Erro('A contagem informada é igual ao saldo atual.')
                self._mover(p, 'Entrada' if diff > 0 else 'Saída', abs(diff), f'Inventário: {motivo}',
                            iso(hoje()))
            elif tipo in ('Entrada', 'Saída'):
                if qtd <= 0:
                    raise Erro('Informe uma quantidade maior que zero.')
                if tipo == 'Saída' and qtd > num(p['estoque_atual']):
                    raise Erro('Saída maior que o saldo em estoque.')
                self._mover(p, tipo, qtd, motivo, iso(hoje()))
            else:
                raise Erro('Tipo de movimento inválido.')
        return p

    def estoque(self):
        d0 = hoje() - datetime.timedelta(days=90)
        d12 = hoje() - datetime.timedelta(days=365)
        itens = self._itens_confirmados()
        saida90, cmv12 = {}, {}
        for v, it in itens:
            dv = parse_data(v['data'])
            q = num(it['quantidade'])
            if dv >= d0:
                saida90[it['produto_id']] = saida90.get(it['produto_id'], 0) + q
            if dv >= d12:
                cmv12[it['produto_id']] = cmv12.get(it['produto_id'], 0) + q * num(it['custo_unitario'])
        dias_cob = num(self.params()['dias_cobertura_reposicao'], 30)
        saida = []
        for p in self.rows('produtos'):
            if not sim(p['ativo']):
                continue
            est, custo, minimo = num(p['estoque_atual']), num(p['custo']), num(p['estoque_minimo'])
            media = saida90.get(p['id'], 0) / 90
            cobertura = est / media if media > 0 else None
            valor = est * custo
            giro = cmv12.get(p['id'], 0) / valor if valor > 0 else 0
            status = 'Crítico' if est <= minimo else 'Atenção' if (
                cobertura is not None and cobertura < dias_cob) else 'Normal'
            sug = 0
            if status != 'Normal':
                sug = max(minimo * 2 - est, math.ceil(media * dias_cob - est), 0)
            saida.append(dict(id=p['id'], sku=p['sku'], nome=p['nome'], categoria=p['categoria'],
                              estoque=est, minimo=minimo, custo=custo, valor=r2(valor),
                              cobertura_dias=None if cobertura is None else round(cobertura),
                              giro=round(giro, 1), status=status, sugestao=math.ceil(sug)))
        return saida

    # ---------- vendas ----------
    def _itens_confirmados(self):
        conf = {v['id']: v for v in self.rows('vendas') if v['status'] == 'Confirmada'}
        return [(conf[i['venda_id']], i) for i in self.rows('itens_venda') if i['venda_id'] in conf]

    def _montar_itens(self, itens, campo_preco, campo_padrao):
        out = []
        for it in itens or []:
            p = self.get('produtos', it.get('produto_id'))
            if not p:
                raise Erro('Produto não encontrado em um dos itens.')
            q = num(it.get('quantidade'))
            if q <= 0:
                raise Erro(f'Informe a quantidade do produto "{p["nome"]}".')
            preco = num(it.get(campo_preco), num(p[campo_padrao]))
            if preco < 0:
                raise Erro('Preço/custo não pode ser negativo.')
            out.append({'produto_id': p['id'], 'produto': p['nome'], 'quantidade': q, campo_preco: preco,
                        '_p': p})
        if not out:
            raise Erro('Inclua pelo menos um item.')
        return out

    def _checar_venda(self, cliente, itens, total, prazo, ignorar_venda=None):
        if not sim(cliente['ativo']):
            raise Erro('Cliente inativo.')
        acumulado = {}
        for it in itens:
            acumulado[it['produto_id']] = acumulado.get(it['produto_id'], 0) + it['quantidade']
        for pid, q in acumulado.items():
            p = self.get('produtos', pid)
            if q > num(p['estoque_atual']):
                raise Erro(f'Estoque insuficiente para "{p["nome"]}": disponível {num(p["estoque_atual"]):g}, '
                           f'solicitado {q:g}.')
        limite = num(cliente['limite_credito'])
        if prazo > 0 and limite > 0:
            aberto = sum(num(c['valor']) for c in self.rows('contas_receber')
                         if c['cliente_id'] == cliente['id'] and c['status'] == 'Aberta')
            if aberto + total > limite + 0.001:
                raise Erro(f'Limite de crédito excedido: em aberto R$ {aberto:,.2f} + esta venda R$ '
                           f'{total:,.2f} > limite R$ {limite:,.2f}.')

    def salvar_venda(self, body, id=None):
        cliente = self.get('clientes', body.get('cliente_id'))
        if not cliente:
            raise Erro('Selecione o cliente.')
        status = body.get('status') or 'Orçamento'
        if status not in ('Orçamento', 'Confirmada'):
            raise Erro('Status inválido.')
        data = iso(parse_data(body.get('data') or hoje()))
        desconto = min(max(num(body.get('desconto')), 0), 100)
        forma = body.get('forma_pagamento') or 'À vista'
        prazo = 0 if forma == 'À vista' else int(num(body.get('prazo_dias'), 30))
        itens = self._montar_itens(body.get('itens'), 'preco_unitario', 'preco')
        bruto = sum(i['quantidade'] * i['preco_unitario'] for i in itens)
        total = r2(bruto * (1 - desconto / 100))
        custo_total = r2(sum(i['quantidade'] * num(i['_p']['custo']) for i in itens))
        with self.s.batch():
            if id:
                venda = self.get('vendas', id)
                if not venda or venda['status'] != 'Orçamento':
                    raise Erro('Somente orçamentos podem ser editados.')
            if status == 'Confirmada':
                self._checar_venda(cliente, itens, total, prazo)
            dados = dict(data=data, cliente_id=cliente['id'], cliente=cliente['nome'], status=status,
                         desconto=desconto, total=total, custo_total=custo_total, forma_pagamento=forma,
                         prazo_dias=prazo, observacoes=body.get('observacoes') or '')
            if id:
                venda.update(dados)
                self.s.save('vendas')
                antigos = [i for i in self.rows('itens_venda') if i['venda_id'] == venda['id']]
                for i in antigos:
                    self.rows('itens_venda').remove(i)
            else:
                venda = self.insert('vendas', dados)
            for i in itens:
                self.insert('itens_venda', dict(venda_id=venda['id'], produto_id=i['produto_id'],
                                                produto=i['produto'], quantidade=i['quantidade'],
                                                preco_unitario=i['preco_unitario'],
                                                custo_unitario=num(i['_p']['custo'])))
            self.s.save('itens_venda')
            if status == 'Confirmada':
                self._efetivar_venda(venda)
        return venda

    def _efetivar_venda(self, venda):
        itens = [i for i in self.rows('itens_venda') if i['venda_id'] == venda['id']]
        custo = 0
        for i in itens:
            p = self.get('produtos', i['produto_id'])
            i['custo_unitario'] = num(p['custo'])
            custo += num(i['quantidade']) * i['custo_unitario']
            self._mover(p, 'Saída', num(i['quantidade']), f"Venda #{venda['id']}", venda['data'])
        venda['custo_total'] = r2(custo)
        self.s.save('itens_venda')
        self.s.save('vendas')
        vencimento = iso(parse_data(venda['data']) + datetime.timedelta(days=int(venda['prazo_dias'])))
        a_vista = int(venda['prazo_dias']) == 0
        self.insert('contas_receber', dict(
            venda_id=venda['id'], cliente_id=venda['cliente_id'], cliente=venda['cliente'],
            descricao=f"Venda #{venda['id']} ({venda['forma_pagamento']})", emissao=venda['data'],
            vencimento=vencimento, valor=venda['total'], status='Paga' if a_vista else 'Aberta',
            data_pagamento=venda['data'] if a_vista else None))

    def confirmar_venda(self, id):
        venda = self.get('vendas', id)
        if not venda or venda['status'] != 'Orçamento':
            raise Erro('Somente orçamentos podem ser confirmados.')
        cliente = self.get('clientes', venda['cliente_id'])
        itens = [dict(produto_id=i['produto_id'], quantidade=num(i['quantidade']))
                 for i in self.rows('itens_venda') if i['venda_id'] == venda['id']]
        with self.s.batch():
            venda['data'] = iso(hoje())
            self._checar_venda(cliente, itens, num(venda['total']), int(num(venda['prazo_dias'])))
            venda['status'] = 'Confirmada'
            self._efetivar_venda(venda)
        return venda

    def cancelar_venda(self, id):
        venda = self.get('vendas', id)
        if not venda or venda['status'] == 'Cancelada':
            raise Erro('Venda não encontrada ou já cancelada.')
        with self.s.batch():
            if venda['status'] == 'Confirmada':
                for i in [i for i in self.rows('itens_venda') if i['venda_id'] == venda['id']]:
                    p = self.get('produtos', i['produto_id'])
                    if p:
                        self._mover(p, 'Entrada', num(i['quantidade']), f"Cancelamento venda #{venda['id']}",
                                    iso(hoje()))
                for c in self.rows('contas_receber'):
                    if c['venda_id'] == venda['id']:
                        c['status'] = 'Cancelada'
                self.s.save('contas_receber')
            venda['status'] = 'Cancelada'
            self.s.save('vendas')
        return venda

    def detalhe(self, tabela, itens_tabela, campo, id):
        doc = self.get(tabela, id)
        if not doc:
            raise Erro('Documento não encontrado.')
        out = dict(doc)
        out['itens'] = [i for i in self.rows(itens_tabela) if i[campo] == doc['id']]
        return out

    # ---------- compras ----------
    def salvar_compra(self, body, id=None):
        forn = self.get('fornecedores', body.get('fornecedor_id'))
        if not forn:
            raise Erro('Selecione o fornecedor.')
        status = body.get('status') or 'Pedido'
        if status not in ('Pedido', 'Recebida'):
            raise Erro('Status inválido.')
        data = iso(parse_data(body.get('data') or hoje()))
        itens = self._montar_itens(body.get('itens'), 'custo_unitario', 'custo')
        total = r2(sum(i['quantidade'] * i['custo_unitario'] for i in itens))
        with self.s.batch():
            if id:
                compra = self.get('compras', id)
                if not compra or compra['status'] != 'Pedido':
                    raise Erro('Somente pedidos em aberto podem ser editados.')
            dados = dict(data=data, fornecedor_id=forn['id'], fornecedor=forn['nome'],
                         nota_fiscal=body.get('nota_fiscal') or '', status='Pedido', total=total,
                         prazo_dias=int(num(body.get('prazo_dias'), 30)), data_recebimento=None)
            if id:
                compra.update(dados)
                self.s.save('compras')
                for i in [i for i in self.rows('itens_compra') if i['compra_id'] == compra['id']]:
                    self.rows('itens_compra').remove(i)
            else:
                compra = self.insert('compras', dados)
            for i in itens:
                self.insert('itens_compra', dict(compra_id=compra['id'], produto_id=i['produto_id'],
                                                 produto=i['produto'], quantidade=i['quantidade'],
                                                 custo_unitario=i['custo_unitario']))
            self.s.save('itens_compra')
            if status == 'Recebida':
                self._receber(compra, data)
        return compra

    def _receber(self, compra, data):
        for i in [i for i in self.rows('itens_compra') if i['compra_id'] == compra['id']]:
            p = self.get('produtos', i['produto_id'])
            q, c = num(i['quantidade']), num(i['custo_unitario'])
            est = max(num(p['estoque_atual']), 0)
            p['custo'] = r2((est * num(p['custo']) + q * c) / (est + q)) if est + q > 0 else c
            self._mover(p, 'Entrada', q, f"Compra #{compra['id']} NF {compra['nota_fiscal'] or '-'}", data)
        compra['status'] = 'Recebida'
        compra['data_recebimento'] = data
        self.s.save('compras')
        venc = iso(parse_data(data) + datetime.timedelta(days=int(num(compra['prazo_dias']))))
        self.insert('contas_pagar', dict(
            compra_id=compra['id'], fornecedor_id=compra['fornecedor_id'], fornecedor=compra['fornecedor'],
            descricao=f"Compra #{compra['id']} NF {compra['nota_fiscal'] or '-'}", emissao=data,
            vencimento=venc, valor=compra['total'], status='Aberta', data_pagamento=None))

    def receber_compra(self, id, data=None):
        compra = self.get('compras', id)
        if not compra or compra['status'] != 'Pedido':
            raise Erro('Somente pedidos em aberto podem ser recebidos.')
        with self.s.batch():
            self._receber(compra, iso(parse_data(data or hoje())))
        return compra

    def cancelar_compra(self, id):
        compra = self.get('compras', id)
        if not compra or compra['status'] != 'Pedido':
            raise Erro('Somente pedidos em aberto podem ser cancelados.')
        with self.s.batch():
            compra['status'] = 'Cancelada'
            self.s.save('compras')
        return compra

    # ---------- financeiro ----------
    def lancar_conta(self, tabela, body):
        valor = num(body.get('valor'))
        if valor <= 0:
            raise Erro('Informe um valor maior que zero.')
        desc = (body.get('descricao') or '').strip()
        if not desc:
            raise Erro('Informe a descrição.')
        dados = dict(descricao=desc, emissao=iso(parse_data(body.get('emissao') or hoje())),
                     vencimento=iso(parse_data(body.get('vencimento') or hoje())), valor=r2(valor),
                     status='Aberta')
        with self.s.batch():
            if tabela == 'contas_receber':
                c = self.get('clientes', body.get('cliente_id'))
                dados.update(cliente_id=c['id'] if c else None,
                             cliente=c['nome'] if c else (body.get('cliente') or 'Avulso'))
            else:
                f = self.get('fornecedores', body.get('fornecedor_id'))
                dados.update(fornecedor_id=f['id'] if f else None,
                             fornecedor=f['nome'] if f else (body.get('fornecedor') or 'Avulso'))
            return self.insert(tabela, dados)

    def baixar_conta(self, tabela, id, data=None):
        c = self.get(tabela, id)
        if not c or c['status'] != 'Aberta':
            raise Erro('Somente contas em aberto podem ser baixadas.')
        with self.s.batch():
            c['status'] = 'Paga'
            c['data_pagamento'] = iso(parse_data(data or hoje()))
            self.s.save(tabela)
        return c

    def estornar_conta(self, tabela, id):
        c = self.get(tabela, id)
        if not c or c['status'] != 'Paga':
            raise Erro('Somente contas pagas podem ser estornadas.')
        with self.s.batch():
            c['status'] = 'Aberta'
            c['data_pagamento'] = None
            self.s.save(tabela)
        return c

    def excluir_conta(self, tabela, id):
        c = self.get(tabela, id)
        if not c:
            raise Erro('Lançamento não encontrado.')
        if c.get('venda_id') or c.get('compra_id'):
            raise Erro('Contas geradas por vendas/compras não podem ser excluídas (cancele o documento).')
        with self.s.batch():
            self.rows(tabela).remove(c)
            self.s.save(tabela)

    def caixa_atual(self):
        saldo = num(self.params()['saldo_inicial_caixa'])
        saldo += sum(num(c['valor']) for c in self.rows('contas_receber') if c['status'] == 'Paga')
        saldo -= sum(num(c['valor']) for c in self.rows('contas_pagar') if c['status'] == 'Paga')
        return r2(saldo)

    # ---------- fichas ----------
    def ficha_cliente(self, id):
        c = self.get('clientes', id)
        if not c:
            raise Erro('Cliente não encontrado.')
        vendas = [v for v in self.rows('vendas') if v['cliente_id'] == c['id'] and v['status'] == 'Confirmada']
        total = sum(num(v['total']) for v in vendas)
        aberto = sum(num(x['valor']) for x in self.rows('contas_receber')
                     if x['cliente_id'] == c['id'] and x['status'] == 'Aberta')
        vencido = sum(num(x['valor']) for x in self.rows('contas_receber')
                      if x['cliente_id'] == c['id'] and x['status'] == 'Aberta' and x['vencimento'] < iso(hoje()))
        limite = num(c['limite_credito'])
        return dict(cliente=c, faturamento=r2(total), qtd_vendas=len(vendas),
                    ticket_medio=r2(total / len(vendas)) if vendas else 0, em_aberto=r2(aberto),
                    vencido=r2(vencido), limite=limite,
                    limite_disponivel=r2(limite - aberto) if limite > 0 else None,
                    historico=sorted(vendas, key=lambda v: v['data'], reverse=True)[:30])

    def ficha_fornecedor(self, id):
        f = self.get('fornecedores', id)
        if not f:
            raise Erro('Fornecedor não encontrado.')
        compras = [c for c in self.rows('compras') if c['fornecedor_id'] == f['id'] and c['status'] == 'Recebida']
        total = sum(num(c['total']) for c in compras)
        prazos = [(parse_data(c['data_recebimento']) - parse_data(c['data'])).days for c in compras
                  if c['data_recebimento']]
        medio = sum(prazos) / len(prazos) if prazos else None
        combinado = num(f['prazo_entrega_dias'])
        no_prazo = round(100 * sum(1 for p in prazos if p <= combinado) / len(prazos)) if prazos else None
        return dict(fornecedor=f, total_compras=r2(total), qtd_compras=len(compras),
                    prazo_real_medio=None if medio is None else round(medio, 1),
                    entregas_no_prazo_pct=no_prazo,
                    historico=sorted(compras, key=lambda c: c['data'], reverse=True)[:30])

    # ---------- dashboard ----------
    def dashboard(self):
        h = hoje()
        mes, ant = chave_mes(h), chave_mes(somar_meses(h, -1))
        vendas = [v for v in self.rows('vendas') if v['status'] == 'Confirmada']

        def soma(lista, campo='total'):
            return r2(sum(num(v[campo]) for v in lista))
        vm = [v for v in vendas if v['data'][:7] == mes]
        va = [v for v in vendas if v['data'][:7] == ant]
        lucro = r2(soma(vm) - soma(vm, 'custo_total'))
        est = self.estoque()
        valor_est = sum(e['valor'] for e in est)
        d12 = iso(h - datetime.timedelta(days=365))
        cmv12 = sum(num(v['custo_total']) for v in vendas if v['data'] >= d12)
        receb = [c for c in self.rows('contas_receber') if c['status'] != 'Cancelada' and c['emissao'] >= d12]
        vencido = sum(num(c['valor']) for c in receb if c['status'] == 'Aberta' and c['vencimento'] < iso(h))
        total_rec = sum(num(c['valor']) for c in receb)
        meses = [chave_mes(somar_meses(h, n)) for n in range(-5, 1)]
        fat = [dict(mes=rotulo_mes(m), valor=soma([v for v in vendas if v['data'][:7] == m]),
                    lucro=r2(soma([v for v in vendas if v['data'][:7] == m]) -
                             soma([v for v in vendas if v['data'][:7] == m], 'custo_total')))
               for m in meses]
        # vendas por categoria nos últimos 6 meses
        cat = {}
        prod_cat = {p['id']: p['categoria'] or 'Sem categoria' for p in self.rows('produtos')}
        for v, i in self._itens_confirmados():
            if v['data'][:7] in meses:
                valor = num(i['quantidade']) * num(i['preco_unitario']) * (1 - num(v['desconto']) / 100)
                k = prod_cat.get(i['produto_id'], 'Sem categoria')
                cat[k] = cat.get(k, 0) + valor
        categorias = sorted(({'nome': k, 'valor': r2(v)} for k, v in cat.items()), key=lambda x: -x['valor'])
        # fluxo de caixa: 5 meses passados + atual + 1 futuro (previsto)
        fluxo = []
        for n in range(-5, 2):
            m = chave_mes(somar_meses(h, n))
            ent = sum(num(c['valor']) for c in self.rows('contas_receber') if (
                (c['status'] == 'Paga' and str(c['data_pagamento'])[:7] == m) or
                (c['status'] == 'Aberta' and n >= 0 and c['vencimento'][:7] == m)))
            sai = sum(num(c['valor']) for c in self.rows('contas_pagar') if (
                (c['status'] == 'Paga' and str(c['data_pagamento'])[:7] == m) or
                (c['status'] == 'Aberta' and n >= 0 and c['vencimento'][:7] == m)))
            fluxo.append(dict(mes=rotulo_mes(m) + (' (prev.)' if n > 0 else ''), entradas=r2(ent),
                              saidas=r2(sai)))
        meta = num(self.params()['meta_vendas_mensal'])
        criticos = [e for e in est if e['status'] == 'Crítico']
        pagar = [c for c in self.rows('contas_pagar') if c['status'] == 'Aberta']
        receber = [c for c in self.rows('contas_receber') if c['status'] == 'Aberta']
        em7 = iso(h + datetime.timedelta(days=7))
        alertas = []
        if criticos:
            alertas.append(dict(nivel='alto', texto=f'{len(criticos)} produto(s) em nível crítico de estoque',
                                rota='estoque'))
        n = sum(1 for c in pagar if c['vencimento'] < iso(h))
        if n:
            alertas.append(dict(nivel='alto', texto=f'{n} conta(s) a pagar vencida(s)', rota='financeiro'))
        n = sum(1 for c in pagar if iso(h) <= c['vencimento'] <= em7)
        if n:
            alertas.append(dict(nivel='medio', texto=f'{n} conta(s) a pagar vencem em 7 dias', rota='financeiro'))
        n = sum(1 for c in receber if c['vencimento'] < iso(h))
        if n:
            alertas.append(dict(nivel='alto', texto=f'{n} recebível(is) em atraso', rota='financeiro'))
        if meta > 0:
            pct = soma(vm) / meta * 100
            alertas.append(dict(nivel='ok' if pct >= 100 else 'info',
                                texto=f'Meta do mês: {pct:.0f}% atingida ({soma(vm):,.0f} de {meta:,.0f})'
                                .replace(',', '.'), rota='dashboard'))
        ultimas = sorted(vendas, key=lambda v: (v['data'], v['id']), reverse=True)[:6]
        return dict(
            kpis=dict(vendas_mes=soma(vm), vendas_mes_anterior=soma(va), lucro_bruto=lucro,
                      clientes_ativos=sum(1 for c in self.rows('clientes') if sim(c['ativo'])),
                      giro_estoque=round(cmv12 / valor_est, 1) if valor_est > 0 else 0,
                      caixa_atual=self.caixa_atual(),
                      inadimplencia=round(vencido / total_rec * 100, 1) if total_rec else 0,
                      itens_estoque=sum(e['estoque'] for e in est), valor_estoque=r2(valor_est),
                      pedidos_hoje=sum(1 for v in vendas if v['data'] == iso(h)),
                      a_receber=r2(sum(num(c['valor']) for c in receber)),
                      a_pagar=r2(sum(num(c['valor']) for c in pagar))),
            faturamento=fat, categorias=categorias, fluxo=fluxo, alertas=alertas,
            ultimas_vendas=ultimas, criticos=criticos[:6], meta=meta)

    # ---------- relatórios ----------
    def _periodo(self, q):
        ate = parse_data(q.get('ate') or hoje())
        de = parse_data(q.get('de') or (ate - datetime.timedelta(days=180)))
        return iso(de), iso(ate)

    def relatorio(self, nome, q):
        fn = getattr(self, f'rel_{nome}', None)
        if not fn:
            raise Erro('Relatório não encontrado.')
        return fn(q)

    def rel_vendas(self, q):
        de, ate = self._periodo(q)
        agrupar = q.get('agrupar') or 'venda'
        vendas = [v for v in self.rows('vendas') if v['status'] == 'Confirmada' and de <= v['data'] <= ate]
        total = r2(sum(num(v['total']) for v in vendas))
        custo = r2(sum(num(v['custo_total']) for v in vendas))
        if agrupar == 'venda':
            cols = [c('id', 'Venda', 'int'), c('data', 'Data', 'data'), c('cliente', 'Cliente'),
                    c('total', 'Total', 'moeda'), c('lucro', 'Lucro', 'moeda'), c('margem', 'Margem', 'pct')]
            linhas = [dict(id=v['id'], data=v['data'], cliente=v['cliente'], total=num(v['total']),
                           lucro=r2(num(v['total']) - num(v['custo_total'])),
                           margem=self._pct(num(v['total']) - num(v['custo_total']), num(v['total'])))
                      for v in sorted(vendas, key=lambda v: (v['data'], v['id']), reverse=True)]
        else:
            grupos = {}
            prod_cat = {p['id']: p['categoria'] or 'Sem categoria' for p in self.rows('produtos')}
            ids = {v['id']: v for v in vendas}
            if agrupar in ('produto', 'categoria'):
                for i in self.rows('itens_venda'):
                    v = ids.get(i['venda_id'])
                    if not v:
                        continue
                    chave = i['produto'] if agrupar == 'produto' else prod_cat.get(i['produto_id'], 'Sem categoria')
                    rec = num(i['quantidade']) * num(i['preco_unitario']) * (1 - num(v['desconto']) / 100)
                    cst = num(i['quantidade']) * num(i['custo_unitario'])
                    g = grupos.setdefault(chave, dict(qtd=0, total=0, custo=0, docs=set()))
                    g['qtd'] += num(i['quantidade'])
                    g['total'] += rec
                    g['custo'] += cst
                    g['docs'].add(v['id'])
            else:
                for v in vendas:
                    chave = v['cliente'] if agrupar == 'cliente' else rotulo_mes(v['data'][:7]) + '|' + v['data'][:7]
                    g = grupos.setdefault(chave, dict(qtd=0, total=0, custo=0, docs=set()))
                    g['total'] += num(v['total'])
                    g['custo'] += num(v['custo_total'])
                    g['docs'].add(v['id'])
            nome_col = dict(produto='Produto', categoria='Categoria', cliente='Cliente', mes='Mês')[agrupar]
            cols = [c('grupo', nome_col), c('vendas', 'Nº vendas', 'int')]
            if agrupar in ('produto', 'categoria'):
                cols.append(c('qtd', 'Quantidade', 'num'))
            cols += [c('total', 'Faturamento', 'moeda'), c('lucro', 'Lucro', 'moeda'), c('margem', 'Margem', 'pct')]
            itens = sorted(grupos.items(), key=(lambda kv: kv[0].split('|')[1]) if agrupar == 'mes'
                           else (lambda kv: -kv[1]['total']))
            linhas = [dict(grupo=k.split('|')[0], vendas=len(g['docs']), qtd=g['qtd'], total=r2(g['total']),
                           lucro=r2(g['total'] - g['custo']), margem=self._pct(g['total'] - g['custo'], g['total']))
                      for k, g in itens]
        totais = {'total': total, 'lucro': r2(total - custo), 'margem': self._pct(total - custo, total)}
        return dict(titulo='Relatório de vendas', periodo=[de, ate], colunas=cols, linhas=linhas, totais=totais,
                    resumo=[('Faturamento', total, 'moeda'), ('Lucro bruto', r2(total - custo), 'moeda'),
                            ('Vendas', len(vendas), 'int'),
                            ('Ticket médio', r2(total / len(vendas)) if vendas else 0, 'moeda')])

    @staticmethod
    def _pct(parte, total):
        return round(parte / total * 100, 1) if total else 0

    def rel_financeiro(self, q):
        de, ate = self._periodo(q)
        meses, d = [], parse_data(de).replace(day=1)
        while d <= parse_data(ate):
            meses.append(chave_mes(d))
            d = somar_meses(d, 1)
        vendas = [v for v in self.rows('vendas') if v['status'] == 'Confirmada']
        linhas, acumulado = [], 0
        for m in meses:
            fat = sum(num(v['total']) for v in vendas if v['data'][:7] == m)
            cst = sum(num(v['custo_total']) for v in vendas if v['data'][:7] == m)
            rec = sum(num(x['valor']) for x in self.rows('contas_receber')
                      if x['status'] == 'Paga' and str(x['data_pagamento'])[:7] == m)
            pag = sum(num(x['valor']) for x in self.rows('contas_pagar')
                      if x['status'] == 'Paga' and str(x['data_pagamento'])[:7] == m)
            acumulado += rec - pag
            linhas.append(dict(mes=rotulo_mes(m), faturamento=r2(fat), custo=r2(cst), lucro=r2(fat - cst),
                               recebido=r2(rec), pago=r2(pag), saldo=r2(rec - pag), acumulado=r2(acumulado)))
        cols = [c('mes', 'Mês'), c('faturamento', 'Faturamento', 'moeda'), c('custo', 'Custo (CMV)', 'moeda'),
                c('lucro', 'Lucro bruto', 'moeda'), c('recebido', 'Recebido', 'moeda'), c('pago', 'Pago', 'moeda'),
                c('saldo', 'Saldo do mês', 'moeda'), c('acumulado', 'Acumulado', 'moeda')]
        totais = {k: r2(sum(l[k] for l in linhas)) for k in ('faturamento', 'custo', 'lucro', 'recebido', 'pago',
                                                              'saldo')}
        return dict(titulo='Relatório financeiro (resultado e caixa por mês)', periodo=[de, ate],
                    colunas=cols, linhas=linhas, totais=totais)

    def rel_curva_abc(self, q):
        de, ate = self._periodo(q)
        ids = {v['id'] for v in self.rows('vendas') if v['status'] == 'Confirmada' and de <= v['data'] <= ate}
        desc = {v['id']: num(v['desconto']) for v in self.rows('vendas')}
        g = {}
        for i in self.rows('itens_venda'):
            if i['venda_id'] in ids:
                rec = num(i['quantidade']) * num(i['preco_unitario']) * (1 - desc[i['venda_id']] / 100)
                x = g.setdefault(i['produto'], dict(qtd=0, total=0))
                x['qtd'] += num(i['quantidade'])
                x['total'] += rec
        total = sum(x['total'] for x in g.values()) or 1
        linhas, acum = [], 0
        for k, x in sorted(g.items(), key=lambda kv: -kv[1]['total']):
            part = x['total'] / total * 100
            acum += part
            classe = 'A' if acum - part < 80 else 'B' if acum - part < 95 else 'C'
            linhas.append(dict(produto=k, qtd=x['qtd'], total=r2(x['total']), part=round(part, 1),
                               acumulado=round(acum, 1), classe=classe))
        cols = [c('produto', 'Produto'), c('qtd', 'Quantidade', 'num'), c('total', 'Faturamento', 'moeda'),
                c('part', '% part.', 'pct'), c('acumulado', '% acumulado', 'pct'), c('classe', 'Classe', 'badge')]
        return dict(titulo='Curva ABC de produtos', periodo=[de, ate], colunas=cols, linhas=linhas,
                    totais={'total': r2(sum(x['total'] for x in g.values()))})

    def rel_aging(self, q):
        h = hoje()
        g = {}
        for cr in self.rows('contas_receber'):
            if cr['status'] != 'Aberta':
                continue
            atraso = (h - parse_data(cr['vencimento'])).days
            b = 'a_vencer' if atraso <= 0 else 'd30' if atraso <= 30 else 'd60' if atraso <= 60 else \
                'd90' if atraso <= 90 else 'd90p'
            x = g.setdefault(cr['cliente'], dict(a_vencer=0, d30=0, d60=0, d90=0, d90p=0))
            x[b] += num(cr['valor'])
        linhas = []
        for k, x in sorted(g.items(), key=lambda kv: -sum(kv[1].values())):
            linhas.append(dict(cliente=k, **{b: r2(v) for b, v in x.items()}, total=r2(sum(x.values()))))
        cols = [c('cliente', 'Cliente'), c('a_vencer', 'A vencer', 'moeda'), c('d30', '1-30 dias', 'moeda'),
                c('d60', '31-60 dias', 'moeda'), c('d90', '61-90 dias', 'moeda'), c('d90p', '> 90 dias', 'moeda'),
                c('total', 'Total', 'moeda')]
        totais = {k: r2(sum(l[k] for l in linhas)) for k in ('a_vencer', 'd30', 'd60', 'd90', 'd90p', 'total')}
        return dict(titulo='Aging de clientes (contas a receber em aberto)', colunas=cols, linhas=linhas,
                    totais=totais)

    def rel_fluxo_caixa(self, q):
        h = hoje()
        n_ant, n_pos = 2, int(num(q.get('meses'), 6))
        linhas, acum = [], self.caixa_atual()
        for n in range(-n_ant, n_pos + 1):
            m = chave_mes(somar_meses(h, n))
            ent_r = sum(num(x['valor']) for x in self.rows('contas_receber')
                        if x['status'] == 'Paga' and str(x['data_pagamento'])[:7] == m)
            sai_r = sum(num(x['valor']) for x in self.rows('contas_pagar')
                        if x['status'] == 'Paga' and str(x['data_pagamento'])[:7] == m)
            ent_p = sum(num(x['valor']) for x in self.rows('contas_receber')
                        if x['status'] == 'Aberta' and (x['vencimento'][:7] == m or (n == 0 and x['vencimento'][:7] < m)))
            sai_p = sum(num(x['valor']) for x in self.rows('contas_pagar')
                        if x['status'] == 'Aberta' and (x['vencimento'][:7] == m or (n == 0 and x['vencimento'][:7] < m)))
            linhas.append(dict(mes=rotulo_mes(m), ent_real=r2(ent_r), sai_real=r2(sai_r), ent_prev=r2(ent_p),
                               sai_prev=r2(sai_p)))
        # saldo projetado parte do caixa atual e soma apenas o previsto (mês atual em diante)
        saldo = acum
        for l, n in zip(linhas, range(-n_ant, n_pos + 1)):
            if n >= 0:
                saldo += l['ent_prev'] - l['sai_prev']
                l['saldo'] = r2(saldo)
            else:
                l['saldo'] = None
        cols = [c('mes', 'Mês'), c('ent_real', 'Entradas realizadas', 'moeda'),
                c('sai_real', 'Saídas realizadas', 'moeda'), c('ent_prev', 'Entradas previstas', 'moeda'),
                c('sai_prev', 'Saídas previstas', 'moeda'), c('saldo', 'Saldo projetado', 'moeda')]
        return dict(titulo='Fluxo de caixa (realizado e projetado)', colunas=cols, linhas=linhas,
                    totais={}, resumo=[('Caixa atual', acum, 'moeda')])

    def rel_abaixo_minimo(self, q):
        linhas = [e for e in self.estoque() if e['status'] != 'Normal']
        cols = [c('sku', 'SKU'), c('nome', 'Produto'), c('estoque', 'Estoque', 'num'), c('minimo', 'Mínimo', 'num'),
                c('sugestao', 'Repor', 'num'), c('status', 'Status', 'badge')]
        return dict(titulo='Produtos abaixo do mínimo / cobertura baixa', colunas=cols, linhas=linhas, totais={})

    def rel_vencidas(self, q):
        h = iso(hoje())
        linhas = []
        for tab, tipo in (('contas_receber', 'A receber'), ('contas_pagar', 'A pagar')):
            for x in self.rows(tab):
                if x['status'] == 'Aberta' and x['vencimento'] < h:
                    linhas.append(dict(tipo=tipo, parte=x.get('cliente') or x.get('fornecedor'),
                                       descricao=x['descricao'], vencimento=x['vencimento'], valor=num(x['valor']),
                                       dias=(hoje() - parse_data(x['vencimento'])).days))
        cols = [c('tipo', 'Tipo'), c('parte', 'Cliente/Fornecedor'), c('descricao', 'Descrição'),
                c('vencimento', 'Vencimento', 'data'), c('dias', 'Dias de atraso', 'int'), c('valor', 'Valor', 'moeda')]
        return dict(titulo='Contas vencidas em aberto', colunas=cols,
                    linhas=sorted(linhas, key=lambda l: -l['dias']), totais={})

    def rel_top_clientes(self, q):
        de, ate = self._periodo(q)
        r = self.rel_vendas(dict(q, de=de, ate=ate, agrupar='cliente'))
        r['titulo'] = 'Top clientes por faturamento'
        r['linhas'] = r['linhas'][:10]
        return r

    def rel_vendas_hoje(self, q):
        d = iso(hoje())
        return self.rel_vendas(dict(q, de=d, ate=d, agrupar='venda'))

    def busca(self, termo):
        t = (termo or '').strip().lower()
        if len(t) < 2:
            return []
        achou = []
        for p in self.rows('produtos'):
            if t in str(p['nome']).lower() or t in str(p['sku']).lower():
                achou.append(dict(tipo='Produto', rota='produtos', rotulo=f"{p['sku']} - {p['nome']}",
                                  detalhe=f"Estoque {num(p['estoque_atual']):g} | Preço {num(p['preco']):.2f}"))
        for c_ in self.rows('clientes'):
            if t in str(c_['nome']).lower() or t in str(c_['documento'] or '').lower():
                achou.append(dict(tipo='Cliente', rota='clientes', rotulo=c_['nome'],
                                  detalhe=f"{c_['cidade'] or ''} {c_['telefone'] or ''}".strip()))
        for f in self.rows('fornecedores'):
            if t in str(f['nome']).lower() or t in str(f['documento'] or '').lower():
                achou.append(dict(tipo='Fornecedor', rota='fornecedores', rotulo=f['nome'],
                                  detalhe=f"{f['cidade'] or ''} {f['telefone'] or ''}".strip()))
        for v in self.rows('vendas'):
            if t.lstrip('#') == str(v['id']) or t in str(v['cliente']).lower():
                achou.append(dict(tipo='Venda', rota='vendas', rotulo=f"Venda #{v['id']} - {v['cliente']}",
                                  detalhe=f"{v['data']} | {v['status']} | R$ {num(v['total']):.2f}"))
        return achou[:60]

    # ---------- exportação ----------
    def relatorio_xlsx(self, rel):
        wb = Workbook()
        ws = wb.active
        ws.title = 'Relatório'
        ws.append([rel['titulo']])
        ws['A1'].font = Font(bold=True, size=14)
        if rel.get('periodo'):
            ws.append([f"Período: {rel['periodo'][0]} a {rel['periodo'][1]}"])
        ws.append([])
        cab = len(ws['A']) + 1
        ws.append([col['label'] for col in rel['colunas']])
        for cell in ws[cab]:
            cell.fill, cell.font = HEADER_FILL, HEADER_FONT
        for l in rel['linhas']:
            ws.append([l.get(col['key']) for col in rel['colunas']])
        if rel.get('totais'):
            ws.append([('TOTAL' if i == 0 else rel['totais'].get(col['key'])) for i, col in enumerate(rel['colunas'])])
            for cell in ws[ws.max_row]:
                cell.font = Font(bold=True)
        for i, col in enumerate(rel['colunas'], 1):
            ws.column_dimensions[ws.cell(row=cab, column=i).column_letter].width = max(14, len(col['label']) + 4)
            if col.get('tipo') == 'moeda':
                for r in range(cab + 1, ws.max_row + 1):
                    ws.cell(row=r, column=i).number_format = '#,##0.00'
        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()


def c(key, label, tipo='texto'):
    return {'key': key, 'label': label, 'tipo': tipo}
