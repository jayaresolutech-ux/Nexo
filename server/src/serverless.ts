import { response } from './http.js';
import { createRuntime, RuntimeInitializationError } from './runtime.js';

type Application = (request: Request) => Promise<Response>;
type RuntimeFactory = () => Promise<{ application: Application }>;
const maxBody = 1024 * 1024;

export function createServerlessHandler(factory: RuntimeFactory = createRuntime) {
  let runtime: Promise<{ application: Application }> | undefined;
  return async (request: Request): Promise<Response> => {
    if (request.body) {
      const reader = request.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBody) {
          await reader.cancel();
          return response({ erro: 'Requisição muito grande.' }, 413);
        }
        parts.push(value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        body.set(part, offset);
        offset += part.byteLength;
      }
      request = new Request(request.url, { method: request.method, headers: request.headers, body });
    }
    try {
      if (!runtime) {
        runtime = factory().catch(error => {
          runtime = undefined;
          throw error;
        });
      }
      return await (await runtime).application(request);
    } catch (error) {
      const cause = error instanceof RuntimeInitializationError ? error.cause : error;
      const code = typeof cause === 'object' && cause !== null && 'code' in cause &&
        typeof cause.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(cause.code) ? cause.code : 'não informado';
      const safeConfigErrors = [
        'Configure DATABASE_URL com a conexão PostgreSQL.',
        'DATABASE_URL deve ser uma URI PostgreSQL válida.',
        'DB_POOL_SIZE deve ser positivo e DB_MAX_OVERFLOW não pode ser negativo.',
        'O tamanho do pool de conexões é inválido.',
      ];
      const detail = error instanceof RuntimeInitializationError && error.stage === 'database-config' &&
        cause instanceof Error && safeConfigErrors.includes(cause.message) ? cause.message : 'não informado';
      console.error('Falha ao iniciar ou executar a API:', error instanceof Error ? error.name : 'erro desconhecido',
        `etapa: ${error instanceof RuntimeInitializationError ? error.stage : 'execução'}`, `código: ${code}`, `diagnóstico: ${detail}`);
      return response({ erro: 'Serviço indisponível. Tente novamente.' }, 503);
    }
  };
}
