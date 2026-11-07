# Mini ERP

ERP web em migração para uma arquitetura de navegador e backend escalável. A versão hospedada usa
React, TypeScript e Vite no cliente, FastAPI/ASGI no servidor e PostgreSQL do Supabase como fonte de
verdade. As telas existentes são servidas por um adaptador de compatibilidade enquanto são portadas
para componentes React, preservando os módulos durante a transição.

## Desenvolvimento local

- Aplicação legada: `python3 app.py` (ou `./iniciar.sh` / `iniciar.bat`), abre em `http://127.0.0.1:8765`.
- Cliente Web: inicie o backend em um terminal (`python3 app.py --sem-navegador`) e rode
  `npm ci --prefix web` e `npm run dev --prefix web` em outro; Vite atende `http://127.0.0.1:5173`
  e encaminha `/api` ao backend.
- Verificações frontend: `npm run typecheck --prefix web` e `npm run build --prefix web`.

Sem configuração Supabase, o modo local continua usando uma planilha `.xlsx` por tabela em `dados/`.
Para começar sem dados de demonstração: `python3 app.py --vazio`.

## Supabase e publicação

1. No SQL Editor do Supabase, execute [`supabase/schema.sql`](supabase/schema.sql), inclusive ao atualizar
   uma instalação existente, para habilitar IDs gerados pelo banco.
2. Crie os usuários autorizados no Supabase Auth e desative o cadastro público. Todas as contas deste
   projeto compartilham os dados da mesma empresa.
3. Configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL` e
   `DATABASE_URL` no ambiente do backend Render. Use uma chave `secret` Supabase recém-rotacionada para
   `SUPABASE_SECRET_KEY`; ela permite ao backend confirmar o estado atual da conta. Nunca a inclua no
   frontend nem em arquivos públicos. `DATABASE_URL` deve ser a URI PostgreSQL do Supabase (preferencialmente
   o pooler de sessão), com a senha protegida como segredo. A chave publishable pode estar no cliente; a
   senha do banco nunca.
4. O repositório [`jayaresolutech-ux/Nexo`](https://github.com/jayaresolutech-ux/Nexo) está conectado ao
   projeto Vercel `nexo`, com framework Vite e diretório raiz do repositório. Instalação, build, publicação
   de `dist/` e proxy `/api/*` para o serviço `mini-erp.onrender.com` estão definidos em
   [`vercel.json`](vercel.json). Se o Render atribuir outro domínio ao serviço, atualize o destino do proxy.
5. Publique o backend pelo Blueprint [`render.yaml`](render.yaml) e configure `DATABASE_URL`,
   `SUPABASE_PUBLISHABLE_KEY` e `SUPABASE_SECRET_KEY` nos segredos do serviço. Gere uma nova chave secreta
   Supabase e mantenha-a apenas no ambiente seguro do backend. Não use chaves copiadas de arquivos de
   configuração antigos. Depois do deploy, configure Site URL e Redirect URLs no Supabase Auth com o domínio
   Vercel. O cliente estático da Vercel não precisa receber segredos do Supabase nem do banco.

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
consultas paginadas e filtros no banco. O Blueprint Render está no plano gratuito para avaliação; escolha
um plano com disponibilidade contínua antes de usar em produção.

## Licença e ferramentas do fornecedor

O modo local mantém licenciamento opcional separado do login Supabase. O segredo de assinatura e o URL de
registro agora são lidos de `MINIERP_LICENCA_SECRET` e `MINIERP_LICENCA_URL`; crie um novo segredo aleatório
para uso local e não o armazene no Git. A mudança invalida licenças locais criadas com a chave embutida
anteriormente; gere novamente as chaves que ainda forem necessárias. A ferramenta interna `gerar_licenca.py`
é ignorada pelo Git e não deve ser distribuída.
