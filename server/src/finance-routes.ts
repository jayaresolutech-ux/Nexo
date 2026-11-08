import { BusinessError, FinanceService, type AccountTable } from './finance.js';
import { authorized, readBody, response, type Authorizer } from './http.js';

export function financeRoutes(finance: FinanceService, auth: Authorizer) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const match = /^\/api\/(contas_receber|contas_pagar)(?:\/(\d+)(?:\/(baixar|estornar))?)?$/.exec(url.pathname);
    if (!match) return response({ erro: 'Rota não encontrada.' }, 404);
    return authorized(request, auth, async () => {
      const table = match[1] as AccountTable;
      const accountId = match[2] === undefined ? undefined : Number(match[2]);
      const action = match[3];
      if (accountId !== undefined && (!Number.isSafeInteger(accountId) || accountId <= 0)) {
        throw new BusinessError('ID inválido.');
      }
      const body = request.method === 'POST' ? await readBody(request) : {};
      if (request.method === 'GET' && accountId === undefined) return response(await finance.list(table));
      if (request.method === 'POST' && accountId === undefined) return response(await finance.create(table, body));
      if (request.method === 'POST' && accountId !== undefined && action === 'baixar') {
        return response(await finance.settle(table, accountId, body.data));
      }
      if (request.method === 'POST' && accountId !== undefined && action === 'estornar') {
        return response(await finance.reverse(table, accountId));
      }
      if (request.method === 'DELETE' && accountId !== undefined && !action) return response(await finance.remove(table, accountId));
      return response({ erro: 'Rota não encontrada.' }, 404);
    });
  };
}
