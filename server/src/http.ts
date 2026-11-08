import { AuthUnavailableError, InactiveUserError, InvalidSessionError } from './auth.js';
import { BusinessError, type Input } from './finance.js';

export interface Authorizer {
  authorize(token: string): Promise<unknown>;
}

export function response(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function readBody(request: Request): Promise<Input> {
  let value: unknown;
  try {
    const text = await request.text();
    value = JSON.parse(text || '{}');
  } catch {
    throw new BusinessError('Requisição inválida.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BusinessError('O corpo da requisição deve ser um objeto JSON.');
  }
  return value as Input;
}

export async function authorized(request: Request, auth: Authorizer, action: () => Promise<Response>): Promise<Response> {
  try {
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return response({ erro: 'Entre na sua conta para continuar.' }, 401);
    await auth.authorize(token);
    return await action();
  } catch (error) {
    if (error instanceof BusinessError) return response({ erro: error.message }, 400);
    if (error instanceof InvalidSessionError) return response({ erro: 'Sessão inválida ou expirada. Entre novamente.' }, 401);
    if (error instanceof InactiveUserError) return response({ erro: error.message }, 403);
    if (error instanceof AuthUnavailableError) {
      console.error('Não foi possível confirmar a autenticação:', error.message);
      return response({ erro: 'Autenticação indisponível. Tente novamente.' }, 503);
    }
    console.error('Erro interno ao processar a requisição:', error);
    return response({ erro: 'Erro interno ao processar a requisição.' }, 500);
  }
}
