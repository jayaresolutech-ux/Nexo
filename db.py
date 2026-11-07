"""Camada de dados: cada tabela do Mini ERP é uma planilha .xlsx na pasta 'dados'."""
import datetime
import os
import threading
from contextlib import contextmanager

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

SCHEMAS = {
    'clientes': ('Clientes.xlsx', ['id', 'nome', 'documento', 'email', 'telefone', 'cidade',
                                   'limite_credito', 'ativo', 'criado_em', 'observacoes']),
    'fornecedores': ('Fornecedores.xlsx', ['id', 'nome', 'documento', 'email', 'telefone', 'cidade',
                                           'prazo_entrega_dias', 'avaliacao', 'ativo', 'criado_em']),
    'produtos': ('Produtos.xlsx', ['id', 'sku', 'nome', 'categoria', 'unidade', 'custo', 'preco',
                                   'estoque_atual', 'estoque_minimo', 'ativo']),
    'categorias': ('Categorias.xlsx', ['id', 'nome']),
    'vendas': ('Vendas.xlsx', ['id', 'data', 'cliente_id', 'cliente', 'status', 'desconto', 'total',
                               'custo_total', 'forma_pagamento', 'prazo_dias', 'observacoes']),
    'itens_venda': ('Itens_Venda.xlsx', ['id', 'venda_id', 'produto_id', 'produto', 'quantidade',
                                         'preco_unitario', 'custo_unitario']),
    'compras': ('Compras.xlsx', ['id', 'data', 'fornecedor_id', 'fornecedor', 'nota_fiscal', 'status',
                                 'total', 'prazo_dias', 'data_recebimento']),
    'itens_compra': ('Itens_Compra.xlsx', ['id', 'compra_id', 'produto_id', 'produto', 'quantidade',
                                           'custo_unitario']),
    'movimentos_estoque': ('Movimentos_Estoque.xlsx', ['id', 'data', 'produto_id', 'produto', 'tipo',
                                                       'quantidade', 'origem', 'saldo_apos']),
    'contas_receber': ('Contas_Receber.xlsx', ['id', 'venda_id', 'cliente_id', 'cliente', 'descricao',
                                               'emissao', 'vencimento', 'valor', 'status',
                                               'data_pagamento']),
    'contas_pagar': ('Contas_Pagar.xlsx', ['id', 'compra_id', 'fornecedor_id', 'fornecedor', 'descricao',
                                           'emissao', 'vencimento', 'valor', 'status', 'data_pagamento']),
    'parametros': ('Parametros.xlsx', ['id', 'chave', 'valor']),
}

HEADER_FILL = PatternFill('solid', fgColor='0B1B3A')
HEADER_FONT = Font(bold=True, color='FFFFFF')


class Store:
    def __init__(self, folder):
        self.folder = folder
        os.makedirs(folder, exist_ok=True)
        self.lock = threading.RLock()
        self._cache = {}
        self._dirty = set()
        self._depth = 0

    def path(self, name):
        return os.path.join(self.folder, SCHEMAS[name][0])

    def is_empty(self):
        return not any(os.path.exists(self.path(n)) for n in SCHEMAS)

    def all(self, name):
        """Lista de dicts da tabela (recarregada se a planilha foi alterada por fora)."""
        with self.lock:
            path = self.path(name)
            mtime = os.path.getmtime(path) if os.path.exists(path) else None
            cached = self._cache.get(name)
            if cached and (cached[0] == mtime or name in self._dirty):
                return cached[1]
            rows = self._read(name, path) if mtime else []
            self._cache[name] = (mtime, rows)
            return rows

    def _read(self, name, path):
        cols = SCHEMAS[name][1]
        wb = load_workbook(path, data_only=True)
        ws = wb.active
        it = ws.iter_rows(values_only=True)
        header = next(it, None) or []
        idx = {str(h).strip(): i for i, h in enumerate(header) if h is not None}
        rows = []
        for raw in it:
            if all(v is None or v == '' for v in raw):
                continue
            row = {}
            for c in cols:
                v = raw[idx[c]] if c in idx and idx[c] < len(raw) else None
                if isinstance(v, datetime.datetime):
                    v = v.date().isoformat()
                elif isinstance(v, datetime.date):
                    v = v.isoformat()
                row[c] = v
            rows.append(row)
        wb.close()
        top = max([r['id'] for r in rows if isinstance(r['id'], (int, float))] or [0])
        for r in rows:
            if not isinstance(r['id'], (int, float)):
                top += 1
                r['id'] = top
            else:
                r['id'] = int(r['id'])
        return rows

    def next_id(self, name):
        return max([r['id'] for r in self.all(name)] or [0]) + 1

    def save(self, name):
        with self.lock:
            self._dirty.add(name)
            if self._depth == 0:
                self._flush()

    @contextmanager
    def batch(self):
        """Agrupa gravações: só escreve nas planilhas se tudo der certo."""
        with self.lock:
            self._depth += 1
            try:
                yield
            except BaseException:
                if self._depth == 1:
                    for n in self._dirty:
                        self._cache.pop(n, None)
                    self._dirty.clear()
                raise
            finally:
                self._depth -= 1
            if self._depth == 0:
                self._flush()

    def _flush(self):
        for name in list(self._dirty):
            self._write(name)
            path = self.path(name)
            self._cache[name] = (os.path.getmtime(path), self._cache[name][1])
        self._dirty.clear()

    def _write(self, name):
        cols = SCHEMAS[name][1]
        wb = Workbook()
        ws = wb.active
        ws.title = name.replace('_', ' ').title()[:31]
        ws.append(cols)
        for r in self._cache[name][1]:
            ws.append([r.get(c) for c in cols])
        for i, c in enumerate(cols, 1):
            cell = ws.cell(row=1, column=i)
            cell.fill, cell.font = HEADER_FILL, HEADER_FONT
            cell.alignment = Alignment(horizontal='center')
            width = max([len(str(c))] + [len(str(r.get(c) or '')) for r in self._cache[name][1][:300]])
            ws.column_dimensions[get_column_letter(i)].width = min(max(width + 2, 10), 45)
        ws.freeze_panes = 'A2'
        if self._cache[name][1]:
            ws.auto_filter.ref = ws.dimensions
        tmp = self.path(name) + '.tmp'
        wb.save(tmp)
        os.replace(tmp, self.path(name))

    def clear_all(self, keep=('parametros',)):
        with self.lock:
            for name in SCHEMAS:
                if name in keep:
                    continue
                self._cache[name] = (None, [])
                self._dirty.add(name)
            self._flush()
