/* Módulos de cadastro: Clientes, Fornecedores, Produtos */
const statusAtivo = r => r.ativo === 'Sim' ? '<span class="badge ok">Ativo</span>' : '<span class="badge">Inativo</span>';
const SIMNAO = [{v: 'Sim', t: 'Sim'}, {v: 'Não', t: 'Não'}];

const CAD = {
  clientes: {
    titulo: 'Clientes', icone: '👥', novo: 'Novo cliente',
    sub: 'Cadastro completo, limite de crédito, histórico de compras e faturamento por cliente.',
    campos: () => [
      {k: 'nome', rot: 'Nome / Razão social', req: true, full: true}, {k: 'documento', rot: 'CPF / CNPJ'},
      {k: 'telefone', rot: 'Telefone'}, {k: 'email', rot: 'E-mail', tipo: 'email'}, {k: 'cidade', rot: 'Cidade'},
      {k: 'limite_credito', rot: 'Limite de crédito (R$)', tipo: 'dinheiro', padrao: 0, ajuda: '0 = sem limite'},
      {k: 'ativo', rot: 'Ativo', tipo: 'select', opts: SIMNAO, padrao: 'Sim'},
      {k: 'observacoes', rot: 'Observações', tipo: 'textarea', full: true}],
    colunas: [{k: 'nome', key: 'nome', label: 'Cliente'}, {key: 'cidade', label: 'Cidade'}, {key: 'telefone', label: 'Telefone'},
      {key: 'limite_credito', label: 'Limite de crédito', tipo: 'moeda'},
      {key: 'ativo', label: 'Status', render: statusAtivo}],
    ficha: fichaCliente,
  },
  fornecedores: {
    titulo: 'Fornecedores', icone: '🚚', novo: 'Novo fornecedor',
    sub: 'Cadastro de fornecedores, prazo médio de entrega, histórico de compras e avaliação de desempenho.',
    campos: () => [
      {k: 'nome', rot: 'Nome / Razão social', req: true, full: true}, {k: 'documento', rot: 'CNPJ'},
      {k: 'telefone', rot: 'Telefone'}, {k: 'email', rot: 'E-mail', tipo: 'email'}, {k: 'cidade', rot: 'Cidade'},
      {k: 'prazo_entrega_dias', rot: 'Prazo de entrega combinado (dias)', tipo: 'numero', padrao: 7},
      {k: 'avaliacao', rot: 'Avaliação (0 a 5)', tipo: 'numero', padrao: 3, passo: 1},
      {k: 'ativo', rot: 'Ativo', tipo: 'select', opts: SIMNAO, padrao: 'Sim'}],
    colunas: [{key: 'nome', label: 'Fornecedor'}, {key: 'cidade', label: 'Cidade'}, {key: 'telefone', label: 'Telefone'},
      {key: 'prazo_entrega_dias', label: 'Prazo (dias)', tipo: 'int'},
      {key: 'avaliacao', label: 'Avaliação', render: r => estrelas(r.avaliacao)},
      {key: 'ativo', label: 'Status', render: statusAtivo}],
    ficha: fichaFornecedor,
  },
  produtos: {
    titulo: 'Produtos', icone: '📦', novo: 'Novo produto',
    sub: 'Catálogo, formação de preços, margem automática e estoque mínimo.',
    campos: (reg, extra) => [
      {k: 'sku', rot: 'Código (SKU)', ajuda: 'Deixe em branco para gerar automaticamente'},
      {k: 'nome', rot: 'Descrição do produto', req: true},
      {k: 'categoria', rot: 'Categoria', tipo: 'select', opts: [{v: '', t: '— sem categoria —'}, ...extra.categorias.map(c => ({v: c.nome, t: c.nome}))]},
      {k: 'unidade', rot: 'Unidade', padrao: 'UN'},
      {k: 'custo', rot: 'Custo (R$)', tipo: 'dinheiro', padrao: 0},
      {k: 'markup', rot: 'Markup sobre o custo (%)', tipo: 'numero', passo: 0.1, padrao: extra.params.markup_padrao, ajuda: 'Altera o preço sugerido'},
      {k: 'preco', rot: 'Preço de venda (R$)', tipo: 'dinheiro', padrao: 0},
      {k: 'margem', rot: 'Margem automática (%)', somenteLeitura: true},
      {k: 'estoque_atual', rot: reg ? 'Estoque atual (use o módulo Estoque para ajustar)' : 'Estoque inicial', tipo: 'numero', padrao: 0, somenteLeitura: !!reg},
      {k: 'estoque_minimo', rot: 'Estoque mínimo', tipo: 'numero', padrao: 0},
      {k: 'ativo', rot: 'Ativo', tipo: 'select', opts: SIMNAO, padrao: 'Sim'}],
    colunas: [{key: 'sku', label: 'SKU'}, {key: 'nome', label: 'Produto'}, {key: 'categoria', label: 'Categoria'},
      {key: 'custo', label: 'Custo', tipo: 'moeda'}, {key: 'preco', label: 'Preço', tipo: 'moeda'},
      {key: 'margem', label: 'Margem', tipo: 'pct', render: r => r.preco > 0 ? fnum((r.preco - r.custo) / r.preco * 100, 1) + '%' : '-'},
      {key: 'estoque_atual', label: 'Estoque', tipo: 'num', render: r => `<span class="${N(r.estoque_atual) <= N(r.estoque_minimo) ? 'down' : ''}"><b>${fnum(r.estoque_atual, 2).replace(/,00$/, '')}</b></span> <span class="muted">/ mín. ${fnum(r.estoque_minimo)}</span>`},
      {key: 'ativo', label: 'Status', render: statusAtivo}],
    aoAbrir: (ctl, reg, extra) => {
      const q = id => $('#f_' + id, ctl.body);
      const margem = () => { const p = N(q('preco').value); q('margem').value = p > 0 ? fnum((p - N(q('custo').value)) / p * 100, 1) : '-'; };
      if (!reg) q('preco').value = (N(q('custo').value) * (1 + N(q('markup').value) / 100)).toFixed(2);
      else q('markup').value = N(reg.custo) > 0 ? ((N(reg.preco) / N(reg.custo) - 1) * 100).toFixed(1) : extra.params.markup_padrao;
      const porMarkup = () => { q('preco').value = (N(q('custo').value) * (1 + N(q('markup').value) / 100)).toFixed(2); margem(); };
      q('markup').addEventListener('input', porMarkup);
      q('custo').addEventListener('input', porMarkup);
      q('preco').addEventListener('input', () => { const c = N(q('custo').value); if (c > 0) q('markup').value = ((N(q('preco').value) / c - 1) * 100).toFixed(1); margem(); });
      margem();
    },
  },
};

async function viewCadastro(root, nome) {
  const cfg = CAD[nome];
  let dados = await GET('/api/' + nome);
  const extra = {params: App.params};
  if (nome === 'produtos') extra.categorias = await GET('/api/categorias');
  let filtro = '', mostrar = 'Sim';
  root.innerHTML = `<div class="pagehead"><div><h1>${cfg.icone} ${cfg.titulo}</h1><p class="sub" style="margin:0">${cfg.sub}</p></div>
    <button class="btn primary" id="novo">＋ ${cfg.novo}</button></div>
    <div class="toolbar"><input id="q" type="search" placeholder="Buscar..." style="min-width:280px">
    <select id="st"><option value="Sim">Somente ativos</option><option value="">Todos</option></select>
    <span class="muted" id="cont"></span></div><div id="lista"></div>`;
  const desenhar = () => {
    const f = dados.filter(r => (!mostrar || r.ativo === mostrar) &&
      Object.values(r).some(v => String(v ?? '').toLowerCase().includes(filtro)));
    $('#cont', root).textContent = `${f.length} registro(s)`;
    const cols = [...cfg.colunas, {key: 'acoes', label: '', render: r => (cfg.ficha ? `<button class="btn sm" data-a="ficha" data-id="${r.id}">Ficha</button> ` : '') + `<button class="btn sm" data-a="edit" data-id="${r.id}">Editar</button>`}];
    $('#lista', root).innerHTML = tabela(cols, f, {clique: true});
    ligarLinhas($('#lista', root), f, r => editar(r));
    $$('#lista button[data-a]', root).forEach(b => b.onclick = () => {
      const r = dados.find(x => x.id === +b.dataset.id);
      b.dataset.a === 'ficha' ? cfg.ficha(r) : editar(r);
    });
  };
  const recarregar = async () => { dados = await GET('/api/' + nome); if (nome === 'produtos') extra.categorias = await GET('/api/categorias'); desenhar(); };
  const editar = reg => {
    const campos = cfg.campos(reg, extra);
    const gravar = async ctl => {
      const body = lerForm(ctl.body, campos);
      for (const c of campos) if (c.req && !String(body[c.k] || '').trim()) { toast(`Preencha: ${c.rot}`, 'err'); return false; }
      delete body.markup; delete body.margem;
      if (reg) await PUT(`/api/${nome}/${reg.id}`, body); else await POST('/api/' + nome, body);
      toast('Salvo com sucesso!', 'ok'); await recarregar();
    };
    const botoes = [{texto: 'Cancelar'}];
    if (reg) botoes.unshift({texto: 'Excluir', classe: 'danger', acao: async () => {
      if (!await confirmar(`Excluir "${reg.nome}"? Se houver movimentações, o cadastro será apenas inativado.`, 'Excluir')) return false;
      const r = await DEL(`/api/${nome}/${reg.id}`);
      toast(r.inativado ? 'Cadastro com movimentações: foi inativado.' : 'Excluído.', 'ok'); await recarregar();
    }});
    botoes.push({texto: 'Salvar', classe: 'primary', acao: gravar});
    modal({titulo: reg ? `Editar ${cfg.novo.split(' ').pop()}` : cfg.novo, corpo: formHtml(campos, reg || {}), botoes,
      onOpen: ctl => cfg.aoAbrir && cfg.aoAbrir(ctl, reg, extra)});
  };
  $('#novo', root).onclick = () => editar(null);
  $('#q', root).oninput = e => { filtro = e.target.value.toLowerCase(); desenhar(); };
  $('#st', root).onchange = e => { mostrar = e.target.value; desenhar(); };
  desenhar();
}

async function fichaCliente(cli) {
  const f = await GET(`/api/clientes/${cli.id}/ficha`);
  const kpi = (l, v, c = '') => `<div class="kpi ${c}"><div class="l">${l}</div><div class="v" style="font-size:18px">${v}</div></div>`;
  const cols = [{key: 'id', label: 'Venda', tipo: 'int'}, {key: 'data', label: 'Data', tipo: 'data'}, {key: 'forma_pagamento', label: 'Pagamento'},
    {key: 'total', label: 'Total', tipo: 'moeda'}];
  modal({titulo: `Ficha do cliente — ${f.cliente.nome}`, largo: true, corpo: `
    <div class="grid g4" style="margin-bottom:16px">${kpi('Faturamento', brl(f.faturamento), 'green')}${kpi('Nº de compras', f.qtd_vendas)}
    ${kpi('Ticket médio', brl(f.ticket_medio))}${kpi('Em aberto', brl(f.em_aberto), f.vencido > 0 ? 'red' : 'amber')}</div>
    <div class="hint ${f.vencido > 0 ? 'warn' : ''}">Limite de crédito: <b>${f.limite > 0 ? brl(f.limite) : 'sem limite'}</b>
    ${f.limite_disponivel !== null ? ` · Disponível: <b>${brl(f.limite_disponivel)}</b>` : ''}${f.vencido > 0 ? ` · Vencido: <b>${brl(f.vencido)}</b>` : ''}</div>
    <h2>Histórico de compras</h2>${tabela(cols, f.historico, {vazio: 'Este cliente ainda não comprou.'})}`});
}

async function fichaFornecedor(forn) {
  const f = await GET(`/api/fornecedores/${forn.id}/ficha`);
  const kpi = (l, v, c = '') => `<div class="kpi ${c}"><div class="l">${l}</div><div class="v" style="font-size:18px">${v}</div></div>`;
  const cols = [{key: 'id', label: 'Pedido', tipo: 'int'}, {key: 'data', label: 'Pedido em', tipo: 'data'},
    {key: 'data_recebimento', label: 'Recebido em', tipo: 'data'}, {key: 'nota_fiscal', label: 'NF'}, {key: 'total', label: 'Total', tipo: 'moeda'}];
  modal({titulo: `Ficha do fornecedor — ${f.fornecedor.nome}`, largo: true, corpo: `
    <div class="grid g4" style="margin-bottom:16px">${kpi('Total comprado', brl(f.total_compras), 'navy')}${kpi('Nº de compras', f.qtd_compras)}
    ${kpi('Prazo real médio', f.prazo_real_medio === null ? '-' : fnum(f.prazo_real_medio, 1) + ' dias')}
    ${kpi('Entregas no prazo', f.entregas_no_prazo_pct === null ? '-' : f.entregas_no_prazo_pct + '%', f.entregas_no_prazo_pct >= 80 ? 'green' : 'amber')}</div>
    <div class="hint">Prazo combinado: <b>${fnum(f.fornecedor.prazo_entrega_dias)} dias</b> · Avaliação: ${estrelas(f.fornecedor.avaliacao)}</div>
    <h2>Histórico de compras</h2>${tabela(cols, f.historico, {vazio: 'Nenhuma compra recebida deste fornecedor.'})}`});
}
