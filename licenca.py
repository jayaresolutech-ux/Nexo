"""Licenciamento do Mini ERP: chave derivada do CNPJ, vinculada à máquina e registrada na planilha online."""
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import urllib.request
import uuid
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
ARQUIVO = os.path.join(BASE, 'licenca.dat')

# URL do Web App do Google Apps Script (ver licenca/apps_script.gs). Também aceita a variável MINIERP_LICENCA_URL.
WEBHOOK_URL = os.environ.get('MINIERP_LICENCA_URL', '').strip()
ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'


def _segredo():
    valor = os.environ.get('MINIERP_LICENCA_SECRET', '').strip()
    try:
        segredo = bytes.fromhex(valor)
    except ValueError as ex:
        raise LicencaErro('MINIERP_LICENCA_SECRET deve conter pelo menos 64 caracteres hexadecimais.') from ex
    if len(segredo) < 32:
        raise LicencaErro('Configure MINIERP_LICENCA_SECRET com pelo menos 32 bytes aleatórios em hexadecimal.')
    return segredo


def so_digitos(txt):
    return re.sub(r'\D', '', txt or '')


def cnpj_valido(cnpj):
    d = so_digitos(cnpj)
    if len(d) != 14 or d == d[0] * 14:
        return False
    for n in (12, 13):
        pesos = list(range(n - 7, 1, -1)) + list(range(9, 1, -1))
        dv = sum(int(x) * p for x, p in zip(d[:n], pesos)) % 11
        dv = 0 if dv < 2 else 11 - dv
        if int(d[n]) != dv:
            return False
    return True


def formatar_cnpj(cnpj):
    d = so_digitos(cnpj)
    return f'{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}'


def chave_para(cnpj):
    d = so_digitos(cnpj)
    h = hmac.new(_segredo(), d.encode(), hashlib.sha256).digest()
    return f'ERP-{d}-' + ''.join(ALFABETO[b % len(ALFABETO)] for b in h[:4])


def chave_valida(cnpj, chave):
    return hmac.compare_digest(chave_para(cnpj), (chave or '').strip().upper())


def id_maquina():
    bruto = ''
    try:
        if sys.platform.startswith('win'):
            out = subprocess.run(['reg', 'query', r'HKLM\SOFTWARE\Microsoft\Cryptography', '/v', 'MachineGuid'],
                                 capture_output=True, text=True, timeout=5).stdout
            bruto = out.split()[-1] if out else ''
        elif sys.platform == 'darwin':
            out = subprocess.run(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'], capture_output=True,
                                 text=True, timeout=5).stdout
            m = re.search(r'IOPlatformUUID" = "([^"]+)"', out)
            bruto = m.group(1) if m else ''
        else:
            for p in ('/etc/machine-id', '/var/lib/dbus/machine-id'):
                if os.path.exists(p):
                    bruto = open(p).read().strip()
                    break
    except Exception:  # noqa: BLE001
        pass
    bruto = bruto or str(uuid.getnode())
    return hashlib.sha256(b'miniERP|' + bruto.encode()).hexdigest()[:16].upper()


def _assinar(nome, cnpj, chave, maquina):
    msg = '|'.join([nome, so_digitos(cnpj), chave, maquina]).encode()
    return hmac.new(_segredo(), msg, hashlib.sha256).hexdigest()


def status():
    """Licença válida = arquivo íntegro, chave correspondente ao CNPJ e gravado NESTA máquina."""
    try:
        with open(ARQUIVO, encoding='utf-8') as f:
            d = json.load(f)
        ok = (hmac.compare_digest(d['assinatura'], _assinar(d['nome'], d['cnpj'], d['chave'], d['maquina']))
              and d['maquina'] == id_maquina() and chave_valida(d['cnpj'], d['chave']))
    except Exception:  # noqa: BLE001
        return {'licenciado': False}
    if not ok:
        return {'licenciado': False, 'copia': True}
    return {'licenciado': True, 'nome': d['nome'], 'cnpj': formatar_cnpj(d['cnpj']), 'chave': d['chave']}


class LicencaErro(Exception):
    pass


def _registrar_online(nome, cnpj, chave, maquina):
    url = os.environ.get('MINIERP_LICENCA_URL') or WEBHOOK_URL
    if not url:
        return
    dados = json.dumps({'nome': nome, 'cnpj': formatar_cnpj(cnpj), 'chave': chave, 'maquina': maquina,
                        'data': datetime.now().strftime('%d/%m/%Y %H:%M:%S')}).encode()
    req = urllib.request.Request(url, data=dados, headers={'Content-Type': 'text/plain;charset=utf-8'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            resp = json.loads(r.read().decode('utf-8'))
    except Exception as ex:  # noqa: BLE001
        raise LicencaErro('Não foi possível registrar a licença online. Verifique a conexão com a internet e '
                          'tente novamente.') from ex
    if not resp.get('ok'):
        raise LicencaErro(resp.get('erro') or 'Licença recusada pelo servidor.')


def ativar(nome, cnpj, chave):
    nome = (nome or '').strip()
    chave = (chave or '').strip().upper()
    if len(nome) < 3:
        raise LicencaErro('Informe o nome da empresa.')
    if not cnpj_valido(cnpj):
        raise LicencaErro('CNPJ inválido.')
    if not chave_valida(cnpj, chave):
        raise LicencaErro('Chave de licença inválida para este CNPJ.')
    maquina = id_maquina()
    _registrar_online(nome, cnpj, chave, maquina)
    reg = {'nome': nome, 'cnpj': so_digitos(cnpj), 'chave': chave, 'maquina': maquina}
    reg['assinatura'] = _assinar(nome, cnpj, chave, maquina)
    with open(ARQUIVO, 'w', encoding='utf-8') as f:
        json.dump(reg, f)
    return status()
