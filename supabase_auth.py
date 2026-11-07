"""Validação de sessões Supabase Auth usando as chaves públicas JWKS do projeto."""
import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from urllib.parse import urlparse

import jwt
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError


ALGORITHMS = ['ES256', 'ES384', 'ES512', 'RS256', 'RS384', 'RS512', 'EdDSA']


class AuthStatusUnavailable(RuntimeError):
    """O estado atual da conta não pôde ser confirmado com o Supabase."""


class SupabaseAuth:
    def __init__(self, project_url, jwks_url, secret_key):
        project = urlparse(project_url)
        jwks = urlparse(jwks_url)
        if project.scheme != 'https' or not project.netloc:
            raise ValueError('SUPABASE_URL deve ser uma URL HTTPS válida.')
        if jwks.scheme != 'https' or not jwks.netloc:
            raise ValueError('SUPABASE_JWKS_URL deve ser uma URL HTTPS válida.')
        if not secret_key:
            raise ValueError('SUPABASE_SECRET_KEY é necessária para verificar o status das contas.')

        self.issuer = project_url.rstrip('/') + '/auth/v1'
        self.project_url = project_url.rstrip('/')
        self.secret_key = secret_key
        self.jwks = PyJWKClient(jwks_url)

    def validate(self, token):
        try:
            header = jwt.get_unverified_header(token)
            if header.get('alg') not in ALGORITHMS:
                raise jwt.InvalidTokenError('Algoritmo de assinatura não permitido.')
            signing_key = self.jwks.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=ALGORITHMS,
                audience='authenticated',
                issuer=self.issuer,
            )
        except PyJWKClientConnectionError:
            raise
        except PyJWKClientError as ex:
            raise ValueError('Token sem uma chave de assinatura válida.') from ex
        except jwt.InvalidTokenError as ex:
            raise ValueError('Sessão inválida ou expirada.') from ex

        if not claims.get('sub') or claims.get('role') != 'authenticated':
            raise ValueError('Sessão sem identidade de usuário autenticado.')
        return claims

    def is_user_active(self, user_id):
        user_path = urllib.parse.quote(user_id, safe='')
        request = urllib.request.Request(
            f'{self.project_url}/auth/v1/admin/users/{user_path}',
            headers={
                'apikey': self.secret_key,
                'Authorization': f'Bearer {self.secret_key}',
                'Accept': 'application/json',
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                user = json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as ex:
            if ex.code == 404:
                return False
            raise AuthStatusUnavailable(
                f'O Supabase Auth retornou HTTP {ex.code} ao verificar a conta.'
            ) from ex
        except (urllib.error.URLError, TimeoutError, OSError) as ex:
            raise AuthStatusUnavailable('Não foi possível consultar o estado da conta no Supabase Auth.') from ex
        except (UnicodeDecodeError, json.JSONDecodeError) as ex:
            raise AuthStatusUnavailable('O Supabase Auth retornou um estado de conta inválido.') from ex

        if not isinstance(user, dict) or user.get('id') != user_id:
            raise AuthStatusUnavailable('O Supabase Auth retornou um usuário inválido.')
        if user.get('deleted_at'):
            return False

        banned_until = user.get('banned_until')
        if not banned_until:
            return True
        try:
            ban_expiry = datetime.fromisoformat(banned_until.replace('Z', '+00:00'))
            if ban_expiry.tzinfo is None:
                ban_expiry = ban_expiry.replace(tzinfo=timezone.utc)
        except (AttributeError, TypeError, ValueError) as ex:
            raise AuthStatusUnavailable('O Supabase Auth retornou uma suspensão inválida.') from ex
        return ban_expiry <= datetime.now(timezone.utc)
