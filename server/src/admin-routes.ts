import { AdminService } from './admin.js';
import { authorized, response, type Authorizer } from './http.js';

export function adminRoutes(service: AdminService, auth: Authorizer) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (!((request.method === 'GET' && (path === '/api/admin/arquivos' || path === '/api/admin/backup')) ||
          (request.method === 'POST' && (path === '/api/admin/limpar' || path === '/api/admin/demo')))) return response({ erro: 'Rota não encontrada.' }, 404);
    return authorized(request, auth, async () => {
      if (path === '/api/admin/arquivos') return response(await service.list());
      if (path === '/api/admin/limpar') return response(await service.clear());
      if (path === '/api/admin/demo') return response(await service.demo());
      const backup = await service.backup();
      return new Response(new Uint8Array(backup.data), { headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="backup_miniERP_${backup.day}.zip"`,
        'Cache-Control': 'no-store',
      } });
    });
  };
}
