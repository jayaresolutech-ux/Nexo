import { authorized, readBody, response, type Authorizer } from './http.js';
import { SettingsService } from './settings.js';

export function settingsRoutes(service: SettingsService, auth: Authorizer) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (!((path === '/api/bootstrap' && request.method === 'GET') || (path === '/api/parametros' && request.method === 'POST'))) {
      return response({ erro: 'Rota não encontrada.' }, 404);
    }
    return authorized(request, auth, async () => response(path === '/api/bootstrap' ? await service.bootstrap() : await service.save(await readBody(request))));
  };
}
