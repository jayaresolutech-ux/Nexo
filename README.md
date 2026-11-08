# Mini ERP

ERP web em migração para uma arquitetura de navegador e backend escalável. A versão hospedada usa
React, TypeScript e Vite no cliente, Node.js/TypeScript no servidor (função serverless da Vercel) e PostgreSQL do Supabase como fonte de
verdade. As telas existentes são servidas por um adaptador de compatibilidade enquanto são portadas
para componentes React, preservando os módulos durante a transição.

## Migração Node.js em andamento

### Publicação Vercel em validação

O frontend e uma função Node compartilhada em `api/[...path].ts` podem ser publicados juntos na Vercel,
sem proxy para outro serviço. Configure no projeto Vercel, nos ambientes **Preview** e **Production**,
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` e `DATABASE_URL`; opcionalmente
configure `SUPABASE_JWKS_URL`. A URL do banco deve usar o pooler PostgreSQL de sessão do Supabase
e TLS. Guarde senha e chave secret apenas nas variáveis protegidas da Vercel; nunca no código.
Configure `DB_POOL_SIZE=1` e `DB_MAX_OVERFLOW=1` para reduzir conexões por instância e dimensione
o banco para a concorrência total. Faça um novo deploy após alterar variáveis e valide primeiro em
Preview: `/api/health`, `/api/config`, login, escrita e relatórios. Não carregue demonstração nem
apague dados reais durante essa verificação.

A Vercel limita o tamanho das requisições e respostas das funções e o tempo de execução; backups
grandes e cargas de demonstração podem ultrapassar esses limites. Use também os backups próprios do
Supabase. A versão Vercel permanece em validação até a verificação autenticada e de persistência.

Os módulos de autenticação, conexões PostgreSQL e rotas de contas a pagar e a receber, cadastros,
estoque, busca, vendas, compras, fichas, dashboard, relatórios, parâmetros, backup, limpeza e carga de demonstração em TypeScript estão em
`server/`; valide-os com `npm ci` e `npm run test:server`. Os testes de integração
exigem `TEST_DATABASE_URL` para um banco PostgreSQL **vazio e descartável** chamado `nexo_finance_test`;
sem essa variável, o teste é ignorado. O CI cria um banco isolado para executá-lo.

O servidor Node pode ser compilado com `npm run build:server` e iniciado com
`npm run start:server`, com as variáveis Supabase e `DATABASE_URL` configuradas. Sua API não serve o
frontend; para experimentos locais use o cliente Vite com proxy para a porta da API. Na Vercel, a mesma
lógica roda em `api/[...path].ts`. Valide a conexão Supabase e os fluxos autenticados após cada deploy.
Backup, limpeza e carga de demonstração estão disponíveis para **todos os usuários ativos**, conforme
a opção escolhida; a limpeza apaga todos os dados e parâmetros, e a demonstração os substitui
atomicamente por dados fictícios. No backup, valores numéricos com mais
de 15 dígitos são exportados como texto para evitar perda de precisão no Excel. Preserve os dados do Supabase.

## Desenvolvimento local

- Backend: `npm run build:server` e `npm run start:server` (requer as variáveis Supabase e `DATABASE_URL`).
- Cliente Web: rode `npm ci --prefix web` e `npm run dev --prefix web`; o Vite atende `http://127.0.0.1:5173`.
- Verificações: `npm run test:server`, `npm run typecheck --prefix web` e `npm run build --prefix web`.

## Supabase e publicação

1. No SQL Editor do Supabase, execute [`supabase/schema.sql`](supabase/schema.sql), inclusive ao atualizar
   uma instalação existente, para habilitar IDs gerados pelo banco.
2. Crie os usuários autorizados no Supabase Auth e desative o cadastro público. Todas as contas deste
   projeto compartilham os dados da mesma empresa.
3. Configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL` e
   `DATABASE_URL` nas variáveis protegidas do projeto Vercel. Use uma chave `secret` Supabase recém-rotacionada para
   `SUPABASE_SECRET_KEY`; ela permite ao backend confirmar o estado atual da conta. Nunca a inclua no
   frontend nem em arquivos públicos. `DATABASE_URL` deve ser a URI PostgreSQL do Supabase (preferencialmente
   o pooler de sessão), com a senha protegida como segredo. A chave publishable pode estar no cliente; a
   senha do banco nunca.
4. O repositório [`jayaresolutech-ux/Nexo`](https://github.com/jayaresolutech-ux/Nexo) está conectado ao
   projeto Vercel `nexo`, com framework Vite e diretório raiz do repositório. Instalação, build, publicação
   de `dist/` e a função `api/[...path].ts` estão definidos em [`vercel.json`](vercel.json) e na pasta `api/`.
   Depois do deploy, configure Site URL e Redirect URLs no Supabase Auth com o domínio Vercel.
   O cliente estático não precisa receber segredos do Supabase nem do banco.

Para cada requisição protegida, o backend valida o JWT e consulta o Supabase Auth Admin API sem cache. Usuários
banidos/suspensos ou removidos têm acesso negado imediatamente; se o Supabase não puder confirmar o estado,
a requisição falha de forma fechada. Gerencie a ativação dos usuários pelo banimento/desbanimento no Supabase
Auth. Os endpoints de configuração pública e health check continuam sem autenticação.

`DB_POOL_SIZE` e `DB_MAX_OVERFLOW` controlam as conexões por instância (padrão: 5 + 5). Dimensione o total
de conexões considerando todas as instâncias e o limite do pooler Supabase. Para produção, use instâncias
que não suspendam o serviço e um plano de banco de dados com backups e capacidade apropriados.

O banco importa planilhas locais existentes apenas quando está vazio; sem planilhas, inicializa os dados de
demonstração. Após a importação, PostgreSQL é a fonte de verdade. Cada requisição web usa uma transação e
conexão próprias, e alterações concorrentes no mesmo registro são rejeitadas com conflito em vez de
sobrescrever silenciosamente os dados de outro usuário.

A store PostgreSQL ainda carrega tabelas completas para manter compatibilidade com as telas atuais; isso
não é adequado para grandes volumes. A próxima etapa da migração deve substituir esses carregamentos por
consultas paginadas e filtros no banco.

