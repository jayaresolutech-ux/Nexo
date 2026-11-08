import { createServer } from 'node:http';
import { createRuntime } from './runtime.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? '8765');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida.');
  const { application, pool } = await createRuntime();
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 1024 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ erro: 'Requisição muito grande.' }));
          req.resume();
          return;
        }
        chunks.push(buffer);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else if (value !== undefined) headers.set(key, value);
      }
      const method = req.method ?? 'GET';
      const init: RequestInit = { method, headers };
      if (method !== 'GET' && method !== 'HEAD') init.body = Buffer.concat(chunks);
      const result = await application(new Request(new URL(req.url ?? '/', 'http://localhost'), init));
      result.headers.forEach((value, key) => res.setHeader(key, value));
      res.writeHead(result.status);
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      console.error('Erro ao processar requisição HTTP:', error);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ erro: 'Erro interno ao processar a requisição.' }));
    }
  });
  server.listen(port, '0.0.0.0', () => console.log(`API Node escutando na porta ${port}.`));
  const stop = (): void => {
    server.close(() => { void pool.end().catch(error => { console.error('Erro ao fechar conexões:', error); process.exitCode = 1; }); });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(error => {
  console.error('Falha ao iniciar a API Node:', error.message);
  process.exitCode = 1;
});
