#!/usr/bin/env python3
"""Mini ERP - servidor local. Execute:  python3 app.py   (ou use iniciar.sh / iniciar.bat)"""
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE)
sys.path.insert(0, BASE)
_LIBS = os.path.join(BASE, 'libs')  # dependências embutidas no pacote (instalação offline)
if os.path.isdir(_LIBS):
    sys.path.insert(0, _LIBS)


def carregar_env():
    """Carrega variáveis locais sem substituir as configuradas pelo sistema."""
    caminho = os.path.join(BASE, '.env')
    if not os.path.isfile(caminho):
        return
    with open(caminho, encoding='utf-8') as arquivo:
        for linha in arquivo:
            linha = linha.strip()
            if not linha or linha.startswith('#') or '=' not in linha:
                continue
            chave, valor = linha.split('=', 1)
            os.environ.setdefault(chave.strip(), valor.strip().strip('"\''))


carregar_env()


def garantir_dependencias():
    """Instala as dependências Python automaticamente (em .venv) na primeira execução."""
    try:
        import openpyxl  # noqa: F401
        import jwt  # noqa: F401
        import fastapi  # noqa: F401
        import psycopg  # noqa: F401
        import sqlalchemy  # noqa: F401
        import uvicorn  # noqa: F401
        return
    except ImportError:
        pass
    venv = os.path.join(BASE, '.venv')
    py = os.path.join(venv, 'Scripts' if os.name == 'nt' else 'bin', 'python')
    if os.path.abspath(sys.executable) == os.path.abspath(py):
        sys.exit('Não foi possível instalar as dependências. Rode: pip install -r requirements.txt')
    if not os.path.exists(py):
        print('Primeira execução: preparando ambiente (isso leva alguns segundos)...')
        subprocess.check_call([sys.executable, '-m', 'venv', venv])
    subprocess.check_call([py, '-m', 'pip', 'install', '--quiet', '-r', os.path.join(BASE, 'requirements.txt')])
    os.execv(py, [py] + sys.argv)


garantir_dependencias()

import argparse  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import threading  # noqa: E402
import urllib.parse  # noqa: E402
import webbrowser  # noqa: E402
import zipfile  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402
from contextvars import ContextVar  # noqa: E402

import demo  # noqa: E402
import licenca  # noqa: E402
from db import SCHEMAS, Store  # noqa: E402
from erp import ERP, Erro, hoje  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from jwt.exceptions import PyJWKClientConnectionError  # noqa: E402
from openpyxl import Workbook  # noqa: E402
from postgres_store import ConcurrentUpdateError, PostgresStore  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402
from supabase_auth import AuthStatusUnavailable, SupabaseAuth  # noqa: E402
import uvicorn  # noqa: E402

DIST = os.path.join(BASE, 'dist')
STATIC = DIST if os.path.isfile(os.path.join(DIST, 'index.html')) else os.path.join(BASE, 'static')
ERP_INSTANCE = None
SERVIDOR = None
SUPABASE_AUTH = None
SUPABASE_CONFIG = None
DATABASE_ENGINE = None
API_ROUTES = []
REQUEST_ERP = ContextVar('request_erp', default=None)


class ERPProxy:
    def __getattr__(self, name):
        erp = REQUEST_ERP.get() or ERP_INSTANCE
        if erp is None:
            raise RuntimeError('O contexto da requisição ainda não foi inicializado.')
        return getattr(erp, name)


class StoreProxy:
    def __getattr__(self, name):
        erp = REQUEST_ERP.get() or ERP_INSTANCE
        if erp is None:
            raise RuntimeError('O contexto da requisição ainda não foi inicializado.')
        return getattr(erp.s, name)


ERP_PROXY = ERPProxy()
STORE_PROXY = StoreProxy()


def encerrar_servidor():
    if SERVIDOR:
        SERVIDOR.should_exit = True


def rotas():
    e = ERP_PROXY
    S = STORE_PROXY
    R = []

    def rota(metodo, padrao):
        def deco(fn):
            R.append((metodo, re.compile('^' + padrao + '$'), fn))
            return fn
        return deco

    @rota('GET', '/api/config')
    def _(m, q, b):
        return SUPABASE_CONFIG

    @rota('GET', '/api/health')
    def _(m, q, b):
        return {'ok': True}

    @rota('GET', '/api/bootstrap')
    def _(m, q, b):
        if SUPABASE_AUTH:
            p = e.params()
            return dict(licenciado=True, empresa=p['empresa_nome'], usuario=p['usuario'],
                        hoje=hoje().isoformat(), pasta=os.path.abspath(S.folder), params=p)
        lic = licenca.status()
        if not lic['licenciado']:
            return dict(licenciado=False, copia=lic.get('copia', False), maquina=licenca.id_maquina())
        p = e.params()
        return dict(licenciado=True, licenca=lic, empresa=p['empresa_nome'], usuario=p['usuario'],
                    hoje=hoje().isoformat(), pasta=os.path.abspath(S.folder), params=p)

    @rota('POST', '/api/licenca/ativar')
    def _(m, q, b):
        try:
            lic = licenca.ativar(b.get('nome'), b.get('cnpj'), b.get('chave'))
        except licenca.LicencaErro as ex:
            raise Erro(str(ex))
        e.salvar_params({'empresa_nome': lic['nome'], 'empresa_cnpj': lic['cnpj']})
        return {'ok': True}

    @rota('GET', '/api/dashboard')
    def _(m, q, b):
        return e.dashboard()

    @rota('GET', r'/api/(clientes|fornecedores|produtos|categorias)')
    def _(m, q, b):
        return e.cad_listar(m[1])

    @rota('POST', r'/api/(clientes|fornecedores|produtos|categorias)')
    def _(m, q, b):
        return e.cad_criar(m[1], b)

    @rota('PUT', r'/api/(clientes|fornecedores|produtos|categorias)/(\d+)')
    def _(m, q, b):
        return e.cad_atualizar(m[1], m[2], b)

    @rota('DELETE', r'/api/(clientes|fornecedores|produtos|categorias)/(\d+)')
    def _(m, q, b):
        return e.cad_excluir(m[1], m[2])

    @rota('GET', r'/api/clientes/(\d+)/ficha')
    def _(m, q, b):
        return e.ficha_cliente(m[1])

    @rota('GET', r'/api/fornecedores/(\d+)/ficha')
    def _(m, q, b):
        return e.ficha_fornecedor(m[1])

    @rota('GET', '/api/vendas')
    def _(m, q, b):
        return e.rows('vendas')

    @rota('GET', r'/api/vendas/(\d+)')
    def _(m, q, b):
        return e.detalhe('vendas', 'itens_venda', 'venda_id', m[1])

    @rota('POST', '/api/vendas')
    def _(m, q, b):
        return e.salvar_venda(b)

    @rota('PUT', r'/api/vendas/(\d+)')
    def _(m, q, b):
        return e.salvar_venda(b, int(m[1]))

    @rota('POST', r'/api/vendas/(\d+)/confirmar')
    def _(m, q, b):
        return e.confirmar_venda(m[1])

    @rota('POST', r'/api/vendas/(\d+)/cancelar')
    def _(m, q, b):
        return e.cancelar_venda(m[1])

    @rota('GET', '/api/compras')
    def _(m, q, b):
        return e.rows('compras')

    @rota('GET', r'/api/compras/(\d+)')
    def _(m, q, b):
        return e.detalhe('compras', 'itens_compra', 'compra_id', m[1])

    @rota('POST', '/api/compras')
    def _(m, q, b):
        return e.salvar_compra(b)

    @rota('PUT', r'/api/compras/(\d+)')
    def _(m, q, b):
        return e.salvar_compra(b, int(m[1]))

    @rota('POST', r'/api/compras/(\d+)/receber')
    def _(m, q, b):
        return e.receber_compra(m[1], b.get('data'))

    @rota('POST', r'/api/compras/(\d+)/cancelar')
    def _(m, q, b):
        return e.cancelar_compra(m[1])

    @rota('GET', '/api/estoque')
    def _(m, q, b):
        return e.estoque()

    @rota('GET', '/api/movimentos')
    def _(m, q, b):
        return sorted(e.rows('movimentos_estoque'), key=lambda x: -x['id'])[:500]

    @rota('POST', '/api/estoque/ajuste')
    def _(m, q, b):
        return e.ajustar_estoque(b)

    @rota('GET', '/api/(contas_receber|contas_pagar)')
    def _(m, q, b):
        return e.rows(m[1])

    @rota('POST', '/api/(contas_receber|contas_pagar)')
    def _(m, q, b):
        return e.lancar_conta(m[1], b)

    @rota('POST', r'/api/(contas_receber|contas_pagar)/(\d+)/baixar')
    def _(m, q, b):
        return e.baixar_conta(m[1], m[2], b.get('data'))

    @rota('POST', r'/api/(contas_receber|contas_pagar)/(\d+)/estornar')
    def _(m, q, b):
        return e.estornar_conta(m[1], m[2])

    @rota('DELETE', r'/api/(contas_receber|contas_pagar)/(\d+)')
    def _(m, q, b):
        e.excluir_conta(m[1], m[2])
        return {'ok': True}

    @rota('GET', r'/api/relatorios/(\w+)')
    def _(m, q, b):
        rel = e.relatorio(m[1], q)
        if q.get('formato') == 'xlsx':
            return ('arquivo', f'{m[1]}.xlsx', e.relatorio_xlsx(rel),
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        return rel

    @rota('GET', '/api/busca')
    def _(m, q, b):
        return e.busca(q.get('q'))

    @rota('POST', '/api/parametros')
    def _(m, q, b):
        lic = licenca.status()
        b = dict(b, empresa_nome=lic['nome'], empresa_cnpj=lic['cnpj'])
        return e.salvar_params(b)

    @rota('GET', '/api/admin/arquivos')
    def _(m, q, b):
        out = []
        for nome, (arq, _) in SCHEMAS.items():
            p = S.path(nome)
            out.append(dict(tabela=nome, arquivo=arq, linhas=len(e.rows(nome)),
                            tamanho=os.path.getsize(p) if os.path.exists(p) else 0))
        return dict(pasta=os.path.abspath(S.folder), arquivos=out)

    @rota('POST', '/api/admin/demo')
    def _(m, q, b):
        demo.carregar(e)
        return {'ok': True}

    @rota('POST', '/api/admin/limpar')
    def _(m, q, b):
        with S.batch():
            S.clear_all()
        return {'ok': True}

    @rota('GET', '/api/admin/backup')
    def _(m, q, b):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
            for nome in SCHEMAS:
                if DATABASE_ENGINE:
                    wb = Workbook()
                    ws = wb.active
                    ws.title = nome.replace('_', ' ').title()[:31]
                    ws.append(SCHEMAS[nome][1])
                    for row in e.rows(nome):
                        ws.append([row.get(column) for column in SCHEMAS[nome][1]])
                    xlsx = io.BytesIO()
                    wb.save(xlsx)
                    z.writestr(SCHEMAS[nome][0], xlsx.getvalue())
                elif os.path.exists(S.path(nome)):
                    z.write(S.path(nome), SCHEMAS[nome][0])
        return ('arquivo', f'backup_miniERP_{hoje().isoformat()}.zip', buf.getvalue(), 'application/zip')

    @rota('POST', '/api/sair')
    def _(m, q, b):
        threading.Timer(0.5, encerrar_servidor).start()
        return {'ok': True}

    return R


def _database_url():
    url = os.environ.get('DATABASE_URL', '').strip()
    if url.startswith('postgres://'):
        return 'postgresql+psycopg://' + url[len('postgres://'):]
    if url.startswith('postgresql://'):
        return 'postgresql+psycopg://' + url[len('postgresql://'):]
    return url


def _initialize_runtime(folder, vazio=False):
    global ERP_INSTANCE, SUPABASE_AUTH, SUPABASE_CONFIG, DATABASE_ENGINE, API_ROUTES
    supabase_url = os.environ.get('SUPABASE_URL', '').strip()
    publishable_key = os.environ.get('SUPABASE_PUBLISHABLE_KEY', '').strip()
    secret_key = os.environ.get('SUPABASE_SECRET_KEY', '').strip()
    database_url = _database_url()
    if bool(supabase_url) != bool(publishable_key):
        raise RuntimeError('Configure SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY juntos.')
    if supabase_url and not secret_key:
        raise RuntimeError('Configure SUPABASE_SECRET_KEY no ambiente seguro do servidor.')
    if supabase_url and not database_url:
        raise RuntimeError('Configure DATABASE_URL com a conexão PostgreSQL do Supabase.')
    if database_url and not supabase_url:
        raise RuntimeError('DATABASE_URL requer SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY.')

    jwks_url = os.environ.get(
        'SUPABASE_JWKS_URL',
        f'{supabase_url.rstrip("/")}/auth/v1/.well-known/jwks.json' if supabase_url else '',
    ).strip()
    SUPABASE_AUTH = SupabaseAuth(supabase_url, jwks_url, secret_key) if supabase_url else None
    SUPABASE_CONFIG = {
        'auth_enabled': bool(SUPABASE_AUTH),
        'supabase_url': supabase_url if SUPABASE_AUTH else '',
        'publishable_key': publishable_key if SUPABASE_AUTH else '',
    }

    if database_url:
        pool_size = int(os.environ.get('DB_POOL_SIZE', '5'))
        max_overflow = int(os.environ.get('DB_MAX_OVERFLOW', '5'))
        DATABASE_ENGINE = create_engine(
            database_url,
            pool_pre_ping=True,
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_timeout=30,
            pool_recycle=1800,
        )
        with DATABASE_ENGINE.begin() as connection:
            connection.execute(text(
                "SELECT pg_advisory_xact_lock(hashtext('minierp:bootstrap'))"
            ))
            store = PostgresStore(connection, folder)
            primeira = store.is_empty()
            local_importado = primeira and not vazio and store.import_local_if_empty()
            ERP_INSTANCE = ERP(store)
            ERP_INSTANCE.garantir_params()
            if primeira and not vazio and not local_importado:
                demo.carregar(ERP_INSTANCE)
            store.flush()
    else:
        DATABASE_ENGINE = None
        store = Store(folder)
        ERP_INSTANCE = ERP(store)
        primeira = store.is_empty()
        ERP_INSTANCE.garantir_params()
        if primeira and not vazio:
            print('Primeira execução: gerando planilhas com dados de demonstração...')
            demo.carregar(ERP_INSTANCE)

    API_ROUTES = rotas()


def _dispatch_api(method, path, query, body, authorization):
    if SUPABASE_AUTH and path not in ('/api/config', '/api/health'):
        token = authorization[7:].strip() if authorization.lower().startswith('bearer ') else ''
        if not token:
            return JSONResponse({'erro': 'Entre na sua conta para continuar.'}, status_code=401,
                                headers={'Cache-Control': 'no-store'})
        try:
            claims = SUPABASE_AUTH.validate(token)
        except ValueError:
            return JSONResponse({'erro': 'Sessão inválida ou expirada. Entre novamente.'}, status_code=401,
                                headers={'Cache-Control': 'no-store'})
        except PyJWKClientConnectionError as ex:
            print(f'Não foi possível validar a sessão Supabase: {ex}', file=sys.stderr)
            return JSONResponse({'erro': 'Autenticação indisponível. Tente novamente.'}, status_code=503,
                                headers={'Cache-Control': 'no-store'})
        try:
            if not SUPABASE_AUTH.is_user_active(claims['sub']):
                return JSONResponse(
                    {'erro': 'Sua conta está inativa ou suspensa. Contate o administrador.'},
                    status_code=403, headers={'Cache-Control': 'no-store'},
                )
        except AuthStatusUnavailable as ex:
            print(f'Não foi possível confirmar o status da conta Supabase: {ex}', file=sys.stderr)
            return JSONResponse({'erro': 'Não foi possível verificar sua conta. Tente novamente.'},
                                status_code=503, headers={'Cache-Control': 'no-store'})
    elif path not in ('/api/config', '/api/health', '/api/bootstrap', '/api/licenca/ativar', '/api/sair') and not licenca.status()['licenciado']:
        return JSONResponse({'erro': 'Licença não ativada.', 'licenca': False}, status_code=403,
                            headers={'Cache-Control': 'no-store'})

    if path == '/api/health':
        if DATABASE_ENGINE:
            with DATABASE_ENGINE.connect() as connection:
                connection.execute(text('SELECT 1'))
        return JSONResponse({'ok': True}, headers={'Cache-Control': 'no-store'})

    q = {key: values[0] for key, values in urllib.parse.parse_qs(query).items()}
    for route_method, pattern, function in API_ROUTES:
        match = pattern.match(path)
        if route_method != method or not match:
            continue

        def execute():
            result = function(match, q, body)
            store = ERP_PROXY.s
            flush = getattr(store, 'flush', None)
            if flush:
                flush()
            if isinstance(result, tuple) and result[0] == 'arquivo':
                return Response(
                    content=result[2],
                    media_type=result[3],
                    headers={
                        'Content-Disposition': f'attachment; filename="{result[1]}"',
                        'Cache-Control': 'no-store',
                    },
                )
            content = json.dumps(result, ensure_ascii=False, default=str).encode('utf-8')
            return Response(content, media_type='application/json; charset=utf-8',
                            headers={'Cache-Control': 'no-store'})

        try:
            if DATABASE_ENGINE:
                with DATABASE_ENGINE.begin() as connection:
                    token = REQUEST_ERP.set(ERP(PostgresStore(connection, BASE)))
                    try:
                        return execute()
                    finally:
                        REQUEST_ERP.reset(token)
            with ERP_INSTANCE.s.lock:
                token = REQUEST_ERP.set(ERP_INSTANCE)
                try:
                    return execute()
                finally:
                    REQUEST_ERP.reset(token)
        except Erro as ex:
            return JSONResponse({'erro': str(ex)}, status_code=400,
                                headers={'Cache-Control': 'no-store'})
        except ConcurrentUpdateError as ex:
            return JSONResponse({'erro': str(ex)}, status_code=409,
                                headers={'Cache-Control': 'no-store'})
        except PermissionError:
            return JSONResponse(
                {'erro': 'Não foi possível gravar os dados. Tente novamente.'},
                status_code=500, headers={'Cache-Control': 'no-store'},
            )
        except Exception:
            import traceback
            traceback.print_exc()
            return JSONResponse({'erro': 'Erro interno ao processar a requisição.'}, status_code=500,
                                headers={'Cache-Control': 'no-store'})

    return JSONResponse({'erro': 'Rota não encontrada.'}, status_code=404,
                        headers={'Cache-Control': 'no-store'})


@asynccontextmanager
async def lifespan(application):
    try:
        _initialize_runtime(
            application.state.data_folder,
            application.state.skip_demo_data,
        )
        yield
    finally:
        if DATABASE_ENGINE:
            DATABASE_ENGINE.dispose()


app = FastAPI(title='Mini ERP API', version='2.0.0', lifespan=lifespan)
app.state.data_folder = os.environ.get('DATA_DIR', os.path.join(BASE, 'dados'))
app.state.skip_demo_data = os.environ.get('MINIERP_EMPTY', '').lower() in ('1', 'true', 'yes')


@app.api_route('/api/{path:path}', methods=['GET', 'POST', 'PUT', 'DELETE'], include_in_schema=False)
async def api_dispatch(path: str, request: Request):
    try:
        raw_body = await request.body()
        body = json.loads(raw_body or b'{}')
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse({'erro': 'Requisição inválida.'}, status_code=400,
                            headers={'Cache-Control': 'no-store'})
    if not isinstance(body, dict):
        return JSONResponse({'erro': 'O corpo da requisição deve ser um objeto JSON.'}, status_code=400,
                            headers={'Cache-Control': 'no-store'})
    from starlette.concurrency import run_in_threadpool
    return await run_in_threadpool(
        _dispatch_api,
        request.method,
        request.url.path,
        request.url.query,
        body,
        request.headers.get('Authorization', ''),
    )


app.mount('/', StaticFiles(directory=STATIC, html=True), name='static')


def main():
    global SERVIDOR
    parser = argparse.ArgumentParser(description='Mini ERP Web')
    parser.add_argument('--dados', default=os.environ.get('DATA_DIR', os.path.join(BASE, 'dados')),
                        help='pasta do banco de dados local')
    parser.add_argument('--host', default=os.environ.get('HOST', '127.0.0.1'))
    parser.add_argument('--porta', type=int, default=int(os.environ.get('PORT', '8765')))
    parser.add_argument('--sem-navegador', action='store_true')
    parser.add_argument('--vazio', action='store_true', help='não carregar dados de demonstração no primeiro uso')
    args = parser.parse_args()
    app.state.data_folder = args.dados
    app.state.skip_demo_data = args.vazio

    url = f'http://{args.host}:{args.porta}/'
    if not args.sem_navegador:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    SERVIDOR = uvicorn.Server(uvicorn.Config(
        app,
        host=args.host,
        port=args.porta,
        proxy_headers=True,
    ))
    SERVIDOR.run()


if __name__ == '__main__':
    main()
