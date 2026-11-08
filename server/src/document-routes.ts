import { DocumentService, type DocumentKind } from './documents.js';
import { BusinessError } from './finance.js';
import { authorized, readBody, response, type Authorizer } from './http.js';

export function documentRoutes(documents: DocumentService, auth: Authorizer) {
  return async (request: Request): Promise<Response> => {
    const match = /^\/api\/(vendas|compras)(?:\/(\d+)(?:\/(confirmar|cancelar|receber))?)?$/.exec(new URL(request.url).pathname);
    if (!match) return response({ erro: 'Rota não encontrada.' }, 404);
    return authorized(request, auth, async () => {
      const kind = match[1] as DocumentKind;
      const id = match[2] === undefined ? undefined : Number(match[2]);
      if (id !== undefined && (!Number.isSafeInteger(id) || id <= 0)) throw new BusinessError('ID inválido.');
      const action = match[3];
      if (request.method === 'GET' && id === undefined) return response(await documents.list(kind));
      if (request.method === 'GET' && id !== undefined && !action) return response(await documents.detail(kind, id));
      if ((request.method === 'POST' && id === undefined) || (request.method === 'PUT' && id !== undefined && !action)) {
        return response(await documents.save(kind, await readBody(request), id));
      }
      if (request.method === 'POST' && id !== undefined && (action === 'confirmar' || action === 'cancelar' || action === 'receber')) {
        return response(await documents.act(kind, id, action, await readBody(request)));
      }
      return response({ erro: 'Rota não encontrada.' }, 404);
    });
  };
}
