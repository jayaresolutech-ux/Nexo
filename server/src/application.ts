import { AnalyticsService } from './analytics.js';
import { analyticsRoutes } from './analytics-routes.js';
import { CadastroService } from './cadastros.js';
import { cadastroRoutes } from './cadastro-routes.js';
import type { ConnectionPool } from './database.js';
import { DocumentService } from './documents.js';
import { documentRoutes } from './document-routes.js';
import { FinanceService } from './finance.js';
import { financeRoutes } from './finance-routes.js';
import { response, type Authorizer } from './http.js';
import { PartyProfileService } from './party-profiles.js';
import { SearchService } from './search.js';
import { searchRoutes } from './search-routes.js';
import { SettingsService } from './settings.js';
import { settingsRoutes } from './settings-routes.js';
import { AdminService } from './admin.js';
import { adminRoutes } from './admin-routes.js';

export function createApplication(pool: ConnectionPool, auth: Authorizer, publicConfig: { supabaseUrl: string; publishableKey: string }) {
  const cadastro = cadastroRoutes(new CadastroService(pool), auth, new PartyProfileService(pool));
  const documents = documentRoutes(new DocumentService(pool), auth);
  const finance = financeRoutes(new FinanceService(pool), auth);
  const analytics = analyticsRoutes(new AnalyticsService(pool), auth);
  const search = searchRoutes(new SearchService(pool), auth);
  const settings = settingsRoutes(new SettingsService(pool), auth);
  const admin = adminRoutes(new AdminService(pool), auth);
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === '/api/health' && request.method === 'GET') return response({ ok: true });
    if (path === '/api/config' && request.method === 'GET') return response({ auth_enabled: true, supabase_url: publicConfig.supabaseUrl, publishable_key: publicConfig.publishableKey });
    if (/^\/api\/(clientes|fornecedores|produtos|categorias|estoque|movimentos)(\/|$)/.test(path)) return cadastro(request);
    if (/^\/api\/(vendas|compras)(\/|$)/.test(path)) return documents(request);
    if (/^\/api\/(contas_receber|contas_pagar)(\/|$)/.test(path)) return finance(request);
    if (path === '/api/dashboard' || path.startsWith('/api/relatorios/')) return analytics(request);
    if (path === '/api/busca') return search(request);
    if (path === '/api/bootstrap' || path === '/api/parametros') return settings(request);
    if (path.startsWith('/api/admin/')) return admin(request);
    return response({ erro: 'Rota não encontrada.' }, 404);
  };
}
