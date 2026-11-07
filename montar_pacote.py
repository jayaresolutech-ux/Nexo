#!/usr/bin/env python3
"""Ferramenta do FORNECEDOR: monta o pacote de entrega ao cliente em ../entrega/MiniERP (e .zip).
Os .py são compilados para .pyc (sem código-fonte legível) e arquivos internos são omitidos."""
import compileall
import os
import shutil
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
SAIDA = os.path.join(os.path.dirname(BASE), 'entrega')
DEST = os.path.join(SAIDA, 'MiniERP')
FONTES = ['app.py', 'db.py', 'erp.py', 'demo.py', 'licenca.py']
COPIAR = ['requirements.txt', 'iniciar.sh', 'Iniciar Mini ERP.bat', 'Criar atalho (Windows).bat', 'Criar atalho (Linux).sh']

shutil.rmtree(SAIDA, ignore_errors=True)
os.makedirs(DEST)
shutil.copytree(os.path.join(BASE, 'static'), os.path.join(DEST, 'static'))
inst = os.path.join(BASE, 'instalador')
if os.path.isdir(inst) and any(f.endswith('.exe') for f in os.listdir(inst)):
    shutil.copytree(inst, os.path.join(DEST, 'instalador'))
else:
    print('AVISO: coloque python-3.12.x-amd64.exe em MiniERP/instalador/ para incluí-lo no pacote.')
for f in COPIAR:
    shutil.copy2(os.path.join(BASE, f), DEST)
SP = os.path.join(BASE, '.venv', 'lib', 'python3.%d' % sys.version_info.minor, 'site-packages')
if not os.path.isdir(SP):
    SP = os.path.join(BASE, '.venv', 'Lib', 'site-packages')
for pkg in ('openpyxl', 'et_xmlfile'):
    origem = os.path.join(SP, pkg)
    if not os.path.isdir(origem):
        sys.exit(f'Dependência {pkg} não encontrada em .venv. Rode o app uma vez para criá-la.')
    shutil.copytree(origem, os.path.join(DEST, 'libs', pkg), ignore=shutil.ignore_patterns('__pycache__'))
for f in FONTES:
    shutil.copy2(os.path.join(BASE, f), DEST)
compileall.compile_dir(DEST, maxlevels=0, legacy=True, quiet=1, force=True)
for f in FONTES:
    os.remove(os.path.join(DEST, f))
shutil.rmtree(os.path.join(DEST, '__pycache__'), ignore_errors=True)
with open(os.path.join(DEST, 'LEIA-ME.txt'), 'w', encoding='utf-8') as f:
    f.write('MINI ERP\n\n1. Python 3.%d: no Windows, o "Iniciar Mini ERP.bat" instala automaticamente (pasta "instalador") se faltar.\n'
            '2. Windows: abra "Iniciar Mini ERP.bat". Para criar o atalho na Área de Trabalho, '
            'execute "Criar atalho (Windows).bat".\n   Linux: ./iniciar.sh  e  "Criar atalho (Linux).sh".\n'
            '3. Na primeira abertura, informe nome da empresa, CNPJ e a chave de licença recebida.\n'
            % sys.version_info.minor)
zip_path = shutil.make_archive(os.path.join(SAIDA, 'MiniERP'), 'zip', SAIDA, 'MiniERP')
print('Pacote pronto:', zip_path)
print(f'Obs.: o cliente precisa de Python 3.{sys.version_info.minor} (mesma versão usada aqui).')
