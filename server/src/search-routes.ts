import { authorized, response, type Authorizer } from './http.js';
import { SearchService } from './search.js';

export function searchRoutes(search: SearchService, auth: Authorizer) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== '/api/busca' || request.method !== 'GET') return response({ erro: 'Rota não encontrada.' }, 404);
    return authorized(request, auth, async () => response(await search.search(url.searchParams.get('q') ?? '')));
  };
}
