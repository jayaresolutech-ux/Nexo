import { CadastroService, isCadastro } from './cadastros.js';
import { BusinessError } from './finance.js';
import { authorized, readBody, response, type Authorizer } from './http.js';
import { PartyProfileService } from './party-profiles.js';

export function cadastroRoutes(service: CadastroService, auth: Authorizer, profiles: PartyProfileService) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const match = /^\/api\/(clientes|fornecedores|produtos|categorias)(?:\/(\d+)(\/ficha)?)?$/.exec(path);
    if (!match && path !== '/api/estoque' && path !== '/api/estoque/ajuste' && path !== '/api/movimentos') return response({ erro: 'Rota não encontrada.' }, 404);
    return authorized(request, auth, async () => {
      if (path === '/api/estoque' && request.method === 'GET') return response(await service.stock());
      if (path === '/api/movimentos' && request.method === 'GET') return response(await service.movements());
      if (path === '/api/estoque/ajuste' && request.method === 'POST') return response(await service.adjust(await readBody(request)));
      const table = match?.[1];
      if (!table || !isCadastro(table)) return response({ erro: 'Rota não encontrada.' }, 404);
      const id = match?.[2] === undefined ? undefined : Number(match[2]);
      if (id !== undefined && (!Number.isSafeInteger(id) || id <= 0)) throw new BusinessError('ID inválido.');
      if (match?.[3]) {
        if (request.method !== 'GET' || id === undefined || (table !== 'clientes' && table !== 'fornecedores')) return response({ erro: 'Rota não encontrada.' }, 404);
        return response(await profiles.profile(table, id));
      }
      if (request.method === 'GET' && id === undefined) return response(await service.list(table));
      if (request.method === 'POST' && id === undefined) return response(await service.create(table, await readBody(request)));
      if (request.method === 'PUT' && id !== undefined) return response(await service.update(table, id, await readBody(request)));
      if (request.method === 'DELETE' && id !== undefined) return response(await service.remove(table, id));
      return response({ erro: 'Rota não encontrada.' }, 404);
    });
  };
}
