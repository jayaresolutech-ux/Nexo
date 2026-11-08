/* Estoque, Financeiro, Relatórios, Dashboard, Parâmetros e Visão Geral */

/* ================= ESTOQUE ================= */
async function viewEstoque(root) {
  let aba = 'inv';
  const carregar = async () => {
    const [inv, mov] = await Promise.all([GET('/api/estoque'), GET('/api/movimentos')]);
    const valor = inv.reduce((a, i) => a + i.valor, 0), crit = inv.filter(i => i.status === 'Crítico').length;
    const giroMed = valor > 0 ? inv.reduce((a, i) => a + i.giro * i.valor, 0) / valor : 0;
    const kpi = (l, v, c = '') => `<div class="kpi ${c}"><div class="l">${l}</div><div class="v">${v}</div></div>`;
    root.innerHTML = `<div class="pagehead"><div><h1>📊 Estoque</h1><p class="sub" style="margin:0">Inventário valorizado, cobertura, giro de estoque e sugestão de reposição.</p></div>
      <button class="btn primary" id="ajuste">⇄ Ajustar / dar entrada</button></div>
      <div class="grid g4" style="margin-bottom:18px">${kpi('Valor em estoque (custo)', brl(valor, 0), 'navy')}${kpi('Itens em estoque', fnum(inv.reduce((a, i) => a + i.estoque, 0)), '')}
      ${kpi('Produtos críticos', crit, crit ? 'red' : 'green')}${kpi('Giro médio (12 meses)', fnum(giroMed, 1) + 'x', 'amber')}</div>
      <div class="tabs">${[['inv', 'Inventário valorizado'], ['rep', 'Sugestão de reposição'], ['mov', 'Movimentações']].map(([k, t]) => `<button data-t="${k}" class="${aba === k ? 'on' : ''}">${t}</button>`).join('')}</div><div id="aba"></div>`;
    $$('.tabs button', root).forEach(b => b.onclick = () => { aba = b.dataset.t; carregar(); });
    $('#ajuste', root).onclick = () => ajusteEstoque(inv, carregar);
    const alvo = $('#aba', root);
    if (aba === 'inv') {
      const cols = [{key: 'sku', label: 'SKU'}, {key: 'nome', label: 'Produto'}, {key: 'categoria', label: 'Categoria'}, {key: 'estoque', label: 'Estoque', tipo: 'num'},
        {key: 'minimo', label: 'Mínimo', tipo: 'num'}, {key: 'custo', label: 'Custo unit.', tipo: 'moeda'}, {key: 'valor', label: 'Valor total', tipo: 'moeda'},
        {key: 'cobertura_dias', label: 'Cobertura', render: r => r.cobertura_dias === null ? '<span class="muted">sem giro</span>' : r.cobertura_dias + ' dias'},
        {key: 'giro', label: 'Giro/ano', render: r => fnum(r.giro, 1) + 'x'}, {key: 'status', label: 'Status', tipo: 'badge'}];
      alvo.innerHTML = tabela(cols, inv, {totais: {valor: valor}});
    } else if (aba === 'rep') {
      const rep = inv.filter(i => i.sugestao > 0);
      const cols = [{key: 'sku', label: 'SKU'}, {key: 'nome', label: 'Produto'}, {key: 'estoque', label: 'Estoque', tipo: 'num'}, {key: 'minimo', label: 'Mínimo', tipo: 'num'},
        {key: 'cobertura_dias', label: 'Cobertura', render: r => r.cobertura_dias === null ? '-' : r.cobertura_dias + ' dias'},
        {key: 'sugestao', label: 'Repor (qtd)', tipo: 'int'}, {key: 'est', label: 'Custo estimado', tipo: 'moeda', render: r => brl(r.sugestao * r.custo)}, {key: 'status', label: 'Status', tipo: 'badge'}];
      alvo.innerHTML = `<div class="toolbar"><span class="hint grow" style="margin:0">A sugestão considera o estoque mínimo e a cobertura configurada em Parâmetros (média de saídas dos últimos 90 dias).</span>
        ${rep.length ? '<button class="btn primary" id="gerar">🛒 Gerar pedido de compra</button>' : ''}</div>` + tabela(cols, rep, {vazio: '✔ Nenhum produto precisa de reposição no momento.'});
      const g = $('#gerar', alvo);
      if (g) g.onclick = () => { App.prefillCompra = rep.map(r => ({produto_id: r.id, quantidade: r.sugestao, preco: ''})); location.hash = '#/compras'; };
    } else {
      const cols = [{key: 'data', label: 'Data', tipo: 'data'}, {key: 'produto', label: 'Produto'}, {key: 'tipo', label: 'Tipo', render: r => `<span class="${r.tipo === 'Entrada' ? 'up' : 'down'}">${r.tipo}</span>`},
        {key: 'quantidade', label: 'Qtd', tipo: 'num'}, {key: 'saldo_apos', label: 'Saldo após', tipo: 'num'}, {key: 'origem', label: 'Origem'}];
      alvo.innerHTML = tabela(cols, mov);
    }
  };
  await carregar();
}

async function ajusteEstoque(inv, onDone) {
  const campos = [
    {k: 'produto_id', rot: 'Produto', tipo: 'select', full: true, opts: inv.map(i => ({v: i.id, t: `${i.sku} · ${i.nome} (saldo ${fnum(i.estoque, 2).replace(/,00$/, '')})`}))},
    {k: 'tipo', rot: 'Operação', tipo: 'select', opts: [{v: 'Entrada', t: 'Entrada (soma ao estoque)'}, {v: 'Saída', t: 'Saída / perda (subtrai)'}, {v: 'Inventário', t: 'Inventário (define o saldo contado)'}]},
    {k: 'quantidade', rot: 'Quantidade', tipo: 'numero', passo: 'any', padrao: 1}, {k: 'motivo', rot: 'Motivo', full: true}];
  modal({titulo: 'Movimentação de estoque', corpo: formHtml(campos), botoes: [{texto: 'Cancelar'}, {texto: 'Registrar', classe: 'primary', acao: async ctl => {
    await POST('/api/estoque/ajuste', lerForm(ctl.body, campos)); toast('Movimentação registrada.', 'ok'); onDone(); }}]});
}

/* ================= FINANCEIRO ================= */
async function viewFinanceiro(root) {
  let aba = 'receber', filtro = 'Aberta', busca = '';
  const render = async () => {
    const [rec, pag] = await Promise.all([GET('/api/contas_receber'), GET('/api/contas_pagar')]);
    const h = hojeISO(), aberto = l => l.filter(c => c.status === 'Aberta');
    const venc = l => aberto(l).filter(c => c.vencimento < h);
    const soma = l => l.reduce((a, c) => a + N(c.valor), 0);
    const kpi = (l, v, c = '') => `<div class="kpi ${c}"><div class="l">${l}</div><div class="v">${v}</div></div>`;
    root.innerHTML = `<div class="pagehead"><div><h1>💵 Financeiro</h1><p class="sub" style="margin:0">Contas a receber, contas a pagar, aging de clientes e fluxo de caixa.</p></div>
      <button class="btn primary" id="novo" ${['aging', 'fluxo'].includes(aba) ? 'style="display:none"' : ''}>＋ Novo lançamento</button></div>
      <div class="grid g4" style="margin-bottom:18px">${kpi('A receber (em aberto)', brl(soma(aberto(rec)), 0), 'green')}${kpi('Recebíveis vencidos', brl(soma(venc(rec)), 0), venc(rec).length ? 'red' : 'green')}
      ${kpi('A pagar (em aberto)', brl(soma(aberto(pag)), 0), 'amber')}${kpi('Pagamentos vencidos', brl(soma(venc(pag)), 0), venc(pag).length ? 'red' : 'green')}</div>
      <div class="tabs">${[['receber', 'Contas a receber'], ['pagar', 'Contas a pagar'], ['aging', 'Aging de clientes'], ['fluxo', 'Fluxo de caixa']].map(([k, t]) => `<button data-t="${k}" class="${aba === k ? 'on' : ''}">${t}</button>`).join('')}</div><div id="aba"></div>`;
    $$('.tabs button', root).forEach(b => b.onclick = () => { aba = b.dataset.t; render(); });
    const alvo = $('#aba', root);
    if (aba === 'aging' || aba === 'fluxo') {
      const r = await GET('/api/relatorios/' + (aba === 'aging' ? 'aging' : 'fluxo_caixa'));
      alvo.innerHTML = renderRelatorio(r) + `<div class="hint mt">${aba === 'aging' ? 'Mostra o quanto cada cliente deve e há quanto tempo está vencido.' : 'O saldo projetado parte do caixa atual e soma as entradas/saídas previstas (títulos em aberto por vencimento). Títulos vencidos entram no mês atual.'}</div>`;
      return;
    }
    const R = aba === 'receber', lista = R ? rec : pag, parte = R ? 'cliente' : 'fornecedor';
    $('#novo', root).onclick = () => lancamento(aba, render);
    const efetivo = c => c.status === 'Aberta' && c.vencimento < h ? 'Vencida' : c.status;
    const f = lista.filter(c => c.status !== 'Cancelada' && (!filtro || (filtro === 'Vencida' ? efetivo(c) === 'Vencida' : c.status === filtro)) &&
      `${c[parte]} ${c.descricao}`.toLowerCase().includes(busca)).sort((a, b) => a.vencimento.localeCompare(b.vencimento));
    const cols = [{key: 'vencimento', label: 'Vencimento', tipo: 'data'}, {key: parte, label: R ? 'Cliente' : 'Fornecedor'}, {key: 'descricao', label: 'Descrição'},
      {key: 'valor', label: 'Valor', tipo: 'moeda'}, {key: 'status', label: 'Situação', render: c => badge(efetivo(c))},
      {key: 'data_pagamento', label: R ? 'Recebido em' : 'Pago em', tipo: 'data'},
      {key: 'a', label: '', render: c => c.status === 'Aberta' ? `<button class="btn sm primary" data-a="baixa" data-id="${c.id}">${R ? 'Receber' : 'Pagar'}</button>` +
        (!c.venda_id && !c.compra_id ? ` <button class="btn sm danger" data-a="del" data-id="${c.id}">✕</button>` : '') : `<button class="btn sm" data-a="est" data-id="${c.id}">Estornar</button>`}];
    alvo.innerHTML = `<div class="toolbar"><input id="q" type="search" placeholder="Buscar..." value="${esc(busca)}" style="min-width:260px">
      <select id="fl">${[['Aberta', 'Em aberto'], ['Vencida', 'Vencidas'], ['Paga', R ? 'Recebidas' : 'Pagas'], ['', 'Todas']].map(([v, t]) => `<option value="${v}" ${filtro === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <span class="muted">${f.length} título(s) · ${brl(soma(f))}</span></div>` + tabela(cols, f);
    $('#q', alvo).oninput = e => { busca = e.target.value.toLowerCase(); render().then(() => { const q = $('#q', root); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); };
    $('#fl', alvo).onchange = e => { filtro = e.target.value; render(); };
    $$('button[data-a]', alvo).forEach(b => b.onclick = async () => {
      const id = b.dataset.id, base = `/api/${R ? 'contas_receber' : 'contas_pagar'}/${id}`;
      try {
        if (b.dataset.a === 'baixa') {
          const c = lista.find(x => x.id === +id);
          modal({titulo: R ? 'Registrar recebimento' : 'Registrar pagamento', corpo: `<p>${esc(c[parte])} — ${esc(c.descricao)}<br><b>${brl(c.valor)}</b></p>${formHtml([{k: 'data', rot: 'Data', tipo: 'data', padrao: h}])}`,
            botoes: [{texto: 'Cancelar'}, {texto: 'Confirmar', classe: 'primary', acao: async ctl => { await POST(base + '/baixar', {data: $('#f_data', ctl.body).value}); toast('Baixa registrada.', 'ok'); render(); }}]});
        } else if (b.dataset.a === 'est') { if (await confirmar('Estornar esta baixa? O título volta para "em aberto".')) { await POST(base + '/estornar'); render(); } }
        else if (await confirmar('Excluir este lançamento?', 'Excluir')) { await DEL(base); render(); }
      } catch (e) { erro(e); }
    });
  };
  await render();
}

async function lancamento(aba, onDone) {
  const R = aba === 'receber';
  const partes = await GET('/api/' + (R ? 'clientes' : 'fornecedores'));
  const campos = [{k: R ? 'cliente_id' : 'fornecedor_id', rot: R ? 'Cliente' : 'Fornecedor', tipo: 'select', full: true, opts: [{v: '', t: '— avulso —'}, ...partes.filter(p => p.ativo === 'Sim').map(p => ({v: p.id, t: p.nome}))]},
    {k: 'descricao', rot: 'Descrição', req: true, full: true}, {k: 'valor', rot: 'Valor (R$)', tipo: 'dinheiro', req: true}, {k: 'vencimento', rot: 'Vencimento', tipo: 'data', padrao: hojeISO()}];
  modal({titulo: R ? 'Novo lançamento a receber' : 'Nova despesa / conta a pagar', corpo: formHtml(campos), botoes: [{texto: 'Cancelar'}, {texto: 'Salvar', classe: 'primary', acao: async ctl => {
    await POST('/api/' + (R ? 'contas_receber' : 'contas_pagar'), lerForm(ctl.body, campos)); toast('Lançamento criado.', 'ok'); onDone(); }}]});
}

/* ================= RELATÓRIOS ================= */
function renderRelatorio(r) {
  const resumo = r.resumo ? `<div class="grid g4" style="margin-bottom:14px">${r.resumo.map(([l, v, t]) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v" style="font-size:19px">${celula({tipo: t}, {[t]: v, undefined: v})}</div></div>`).join('')}</div>` : '';
  return resumo + tabela(r.colunas, r.linhas, {totais: r.totais, vazio: 'Sem dados para o período.'});
}

async function viewRelatorios(root) {
  const ABAS = [['vendas', 'Relatório de vendas'], ['financeiro', 'Relatório financeiro'], ['curva_abc', 'Curva ABC'], ['aging', 'Aging de clientes'], ['consultas', 'Consultas rápidas']];
  let aba = App.abaRel || 'vendas';
  const hoje = new Date(), ini = new Date(hoje.getTime() - 180 * 864e5).toISOString().slice(0, 10);
  const estado = {de: ini, ate: hojeISO(), agrupar: 'venda'};
  root.innerHTML = `<div class="pagehead"><div><h1>📋 Relatórios</h1><p class="sub" style="margin:0">Relatório de vendas, financeiro, curva ABC, aging e consultas rápidas. Exporte para Excel quando precisar.</p></div></div>
    <div class="tabs">${ABAS.map(([k, t]) => `<button data-t="${k}" class="${aba === k ? 'on' : ''}">${t}</button>`).join('')}</div><div id="painel"></div>`;
  $$('.tabs button', root).forEach(b => b.onclick = () => { App.abaRel = b.dataset.t; viewRelatorios(root); });
  const painel = $('#painel', root);
  const qs = (nome, extra = {}) => '/api/relatorios/' + nome + '?' + new URLSearchParams({...(['aging'].includes(nome) ? {} : {de: estado.de, ate: estado.ate}), ...extra});
  if (aba === 'consultas') return consultas(painel);
  const comPeriodo = aba !== 'aging';
  painel.innerHTML = `<div class="toolbar">${comPeriodo ? `<label style="margin:0">De</label><input type="date" id="de" value="${estado.de}"><label style="margin:0">Até</label><input type="date" id="ate" value="${estado.ate}">` : ''}
    ${aba === 'vendas' ? `<label style="margin:0">Agrupar por</label><select id="agr">${[['venda', 'Venda'], ['cliente', 'Cliente'], ['produto', 'Produto'], ['categoria', 'Categoria'], ['mes', 'Mês']].map(([v, t]) => `<option value="${v}" ${estado.agrupar === v ? 'selected' : ''}>${t}</option>`).join('')}</select>` : ''}
    <button class="btn primary" id="ok">Atualizar</button><span class="grow"></span><a class="btn" id="xls">⬇ Exportar Excel</a><button class="btn" id="prt">🖨 Imprimir</button></div><div id="res"></div>`;
  const rodar = async () => {
    if (comPeriodo) { estado.de = $('#de', painel).value; estado.ate = $('#ate', painel).value; }
    if (aba === 'vendas') estado.agrupar = $('#agr', painel).value;
    const extra = aba === 'vendas' ? {agrupar: estado.agrupar} : {};
    try { $('#res', painel).innerHTML = renderRelatorio(await GET(qs(aba, extra))); } catch (e) { erro(e); }
    $('#xls', painel).onclick = async e => {
      e.preventDefault();
      try { await baixarArquivo(qs(aba, {...extra, formato: 'xlsx'}), `${aba}.xlsx`); } catch (e) { erro(e); }
    };
  };
  $('#ok', painel).onclick = rodar; $('#prt', painel).onclick = () => window.print();
  $$('select,input', painel).forEach(el => el.onchange = rodar);
  rodar();
}

async function consultas(painel) {
  const PRE = [['abaixo_minimo', '⚠ Estoque abaixo do mínimo'], ['vencidas', '⏰ Contas vencidas'], ['top_clientes', '🏆 Top 10 clientes'], ['vendas_hoje', '📅 Vendas de hoje']];
  painel.innerHTML = `<div class="card"><h2>Pesquisa geral</h2><input id="cq" type="search" placeholder="Digite o nome do cliente, produto, fornecedor ou nº da venda..." style="font-size:15px;padding:12px">
    <div id="cres" class="mt"></div></div><div class="section">Consultas prontas</div><div class="toolbar">${PRE.map(([k, t]) => `<button class="btn" data-k="${k}">${t}</button>`).join('')}</div><div id="pre"></div>`;
  const busca = async () => {
    const q = $('#cq', painel).value;
    if (q.trim().length < 2) { $('#cres', painel).innerHTML = '<span class="muted">Digite ao menos 2 letras.</span>'; return; }
    const r = await GET('/api/busca?q=' + encodeURIComponent(q));
    $('#cres', painel).innerHTML = r.length ? tabela([{key: 'tipo', label: 'Tipo', render: x => badge(x.tipo)}, {key: 'rotulo', label: 'Resultado'}, {key: 'detalhe', label: 'Detalhe'}], r, {clique: true}) : '<span class="muted">Nada encontrado.</span>';
    ligarLinhas($('#cres', painel), r, x => { location.hash = '#/' + x.rota; });
  };
  $('#cq', painel).oninput = busca; busca();
  $$('button[data-k]', painel).forEach(b => b.onclick = async () => {
    try { const r = await GET('/api/relatorios/' + b.dataset.k); $('#pre', painel).innerHTML = `<h2>${esc(r.titulo)}</h2>` + renderRelatorio(r); } catch (e) { erro(e); }
  });
}

/* ================= DASHBOARD ================= */
async function viewDashboard(root) {
  const d = await GET('/api/dashboard'), k = d.kpis;
  const varMes = k.vendas_mes_anterior > 0 ? (k.vendas_mes / k.vendas_mes_anterior - 1) * 100 : null;
  const kpi = (l, v, sub, cls = '') => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${sub || '&nbsp;'}</div></div>`;
  const sev = {alto: '⚠️', medio: '🕒', ok: '✅', info: '🎯'};
  const colsV = [{key: 'id', label: 'Nº', tipo: 'int'}, {key: 'data', label: 'Data', tipo: 'data'}, {key: 'cliente', label: 'Cliente'}, {key: 'total', label: 'Total', tipo: 'moeda'}];
  const colsC = [{key: 'nome', label: 'Produto'}, {key: 'estoque', label: 'Qtd', tipo: 'num'}, {key: 'minimo', label: 'Mín.', tipo: 'num'}, {key: 'status', label: 'Status', tipo: 'badge'}];
  root.innerHTML = `<div class="pagehead"><div><h1>📈 Dashboard Executivo</h1><p class="sub" style="margin:0">KPIs estratégicos, indicadores financeiros, alertas gerenciais e metas.</p></div></div>
    <div class="grid g6">
      ${kpi('Vendas do mês', brl(k.vendas_mes, 0), varMes === null ? '' : `<span class="${varMes >= 0 ? 'up' : 'down'}">${varMes >= 0 ? '▲' : '▼'} ${fnum(Math.abs(varMes), 1)}% vs. mês anterior</span>`)}
      ${kpi('Lucro bruto', brl(k.lucro_bruto, 0), k.vendas_mes > 0 ? `margem ${fnum(k.lucro_bruto / k.vendas_mes * 100, 1)}%` : '', 'green')}
      ${kpi('Clientes ativos', fnum(k.clientes_ativos), '', 'navy')}
      ${kpi('Giro de estoque', fnum(k.giro_estoque, 1) + 'x', 'últimos 12 meses', 'amber')}
      ${kpi('Caixa atual', brl(k.caixa_atual, 0), `a receber ${brl(k.a_receber, 0)}`, k.caixa_atual >= 0 ? 'green' : 'red')}
      ${kpi('Inadimplência', fnum(k.inadimplencia, 1) + '%', 'vencidos / faturado 12m', k.inadimplencia > 5 ? 'red' : 'green')}</div>
    <div class="grid g2 mt"><div class="card"><div class="chart-title">Faturamento mensal (R$)</div>${graficoBarras(d.faturamento.map(f => f.mes), [{nome: 'Faturamento', cor: '#2563EB', valores: d.faturamento.map(f => f.valor)}, {nome: 'Lucro bruto', cor: '#16A34A', valores: d.faturamento.map(f => f.lucro)}])}</div>
    <div class="card"><div class="chart-title">Fluxo de caixa (R$) <span class="muted" style="font-weight:400">* previsto</span></div>${graficoLinhas(d.fluxo.map(f => f.mes), [{nome: 'Entradas', cor: '#16A34A', valores: d.fluxo.map(f => f.entradas)}, {nome: 'Saídas', cor: '#c0392b', valores: d.fluxo.map(f => f.saidas)}])}</div></div>
    <div class="grid g2 mt"><div class="card"><div class="chart-title">Vendas por categoria <span class="muted" style="font-weight:400">(últimos 6 meses)</span></div>${d.categorias.length ? graficoRosca(d.categorias) : '<div class="empty">Sem vendas no período.</div>'}</div>
    <div class="card"><div class="chart-title">Alertas gerenciais e metas</div>${d.alertas.map(a => `<div class="alert ${a.nivel}" data-r="${a.rota}">${sev[a.nivel]} <span>${esc(a.texto)}</span></div>`).join('') || '<div class="empty">Tudo em ordem. ✅</div>'}
    ${d.meta > 0 ? `<div class="mt"><label>Meta mensal de vendas</label><div style="background:#DCE4F2;border-radius:8px;height:14px;overflow:hidden"><div style="width:${Math.min(100, k.vendas_mes / d.meta * 100)}%;background:var(--blue);height:100%"></div></div></div>` : ''}</div></div>
    <div class="grid g2 mt"><div><h2>Últimas vendas</h2>${tabela(colsV, d.ultimas_vendas)}</div><div><h2>Produtos críticos</h2>${tabela(colsC, d.criticos, {vazio: '✔ Nenhum produto crítico.'})}</div></div>`;
  $$('.alert', root).forEach(a => a.onclick = () => { location.hash = '#/' + a.dataset.r; });
}

/* ================= PARÂMETROS ================= */
async function viewParametros(root) {
  let aba = 'empresa';
  const render = async () => {
    root.innerHTML = `<div class="pagehead"><div><h1>⚙️ Parâmetros</h1><p class="sub" style="margin:0">Dados da empresa, configurações, tabelas auxiliares, metas e orientações.</p></div></div>
      <div class="tabs">${[['empresa', 'Dados da empresa'], ['metas', 'Metas e configurações'], ['categorias', 'Tabelas auxiliares'], ['dados', 'Banco de dados'], ['ajuda', 'Orientações']].map(([k, t]) => `<button data-t="${k}" class="${aba === k ? 'on' : ''}">${t}</button>`).join('')}</div><div id="aba"></div>`;
    $$('.tabs button', root).forEach(b => b.onclick = () => { aba = b.dataset.t; render(); });
    const alvo = $('#aba', root), p = App.params;
    const salvar = campos => async () => { const r = await POST('/api/parametros', lerForm(alvo, campos)); App.params = r; App.cabecalho(); toast('Parâmetros salvos.', 'ok'); };
    if (aba === 'empresa' || aba === 'metas') {
      const campos = aba === 'empresa' ? [{k: 'empresa_nome', rot: 'Nome da empresa', full: true}, {k: 'empresa_cnpj', rot: 'CNPJ'}, {k: 'empresa_telefone', rot: 'Telefone'},
        {k: 'empresa_email', rot: 'E-mail'}, {k: 'empresa_endereco', rot: 'Endereço'}, {k: 'usuario', rot: 'Usuário exibido no topo'}] :
        [{k: 'meta_vendas_mensal', rot: 'Meta de vendas mensal (R$)', tipo: 'dinheiro'}, {k: 'saldo_inicial_caixa', rot: 'Saldo inicial de caixa (R$)', tipo: 'dinheiro', ajuda: 'Ponto de partida do "Caixa atual"'},
          {k: 'dias_cobertura_reposicao', rot: 'Cobertura desejada de estoque (dias)', tipo: 'numero', ajuda: 'Usada na sugestão de reposição'}, {k: 'markup_padrao', rot: 'Markup padrão para novos produtos (%)', tipo: 'numero', passo: 0.1}];
      alvo.innerHTML = `<div class="card" style="max-width:760px">${formHtml(campos, p)}<button class="btn primary" id="sv">Salvar</button></div>`;
      $('#sv', alvo).onclick = () => salvar(campos)().catch(erro);
    } else if (aba === 'categorias') {
      const cats = await GET('/api/categorias');
      alvo.innerHTML = `<div class="card" style="max-width:640px"><h2>Categorias de produtos</h2><div class="toolbar"><input id="nc" placeholder="Nova categoria"><button class="btn primary" id="add">Adicionar</button></div>
        ${tabela([{key: 'nome', label: 'Categoria'}, {key: 'a', label: '', render: c => `<button class="btn sm" data-a="ren" data-id="${c.id}">Renomear</button> <button class="btn sm danger" data-a="del" data-id="${c.id}">Excluir</button>`}], cats)}</div>`;
      $('#add', alvo).onclick = async () => { try { await POST('/api/categorias', {nome: $('#nc', alvo).value}); render(); } catch (e) { erro(e); } };
      $$('button[data-a]', alvo).forEach(b => b.onclick = async () => {
        const c = cats.find(x => x.id === +b.dataset.id);
        try {
          if (b.dataset.a === 'del') { if (await confirmar(`Excluir a categoria "${c.nome}"?`, 'Excluir')) { await DEL('/api/categorias/' + c.id); render(); } }
          else modal({titulo: 'Renomear categoria', corpo: formHtml([{k: 'nome', rot: 'Nome', full: true}], c), botoes: [{texto: 'Cancelar'}, {texto: 'Salvar', classe: 'primary', acao: async ctl => { await PUT('/api/categorias/' + c.id, {nome: $('#f_nome', ctl.body).value}); render(); }}]});
        } catch (e) { erro(e); }
      });
    } else if (aba === 'dados') {
      const r = await GET('/api/admin/arquivos');
      const postgres = r.armazenamento === 'postgresql';
      alvo.innerHTML = `<div class="hint">${postgres ? 'Os dados estão no PostgreSQL. O backup exporta as tabelas em planilhas; alterar as planilhas exportadas não altera o banco. Todos os usuários ativos podem baixar o backup e apagar os dados.' : `As planilhas abaixo são o banco de dados do Nexo. Pasta: <b>${esc(r.pasta)}</b><br>Você pode abri-las no Excel/LibreOffice para consultar (feche-as antes de salvar no sistema). Alterações feitas nas planilhas são lidas automaticamente.`}</div>
        ${tabela([{key: 'arquivo', label: 'Planilha'}, {key: 'tabela', label: 'Conteúdo'}, {key: 'linhas', label: 'Registros', tipo: 'int'}, ...(!postgres ? [{key: 'tamanho', label: 'Tamanho', render: x => fnum(x.tamanho / 1024, 1) + ' KB'}] : [])], r.arquivos)}
        <div class="toolbar mt"><button class="btn" id="backup">⬇ Baixar backup (.zip)</button><button class="btn" id="demo">Carregar dados de demonstração</button><button class="btn danger" id="limpar">Apagar todos os dados</button></div>`;
      $('#backup', alvo).onclick = async () => { try { await baixarArquivo('/api/admin/backup', `backup_miniERP_${hojeISO()}.zip`); } catch (e) { erro(e); } };
      $('#demo', alvo).onclick = async () => { if (await confirmar('Isso SUBSTITUI todos os dados atuais por dados de demonstração. Faça um backup antes. Continuar?', 'Substituir')) { try { await POST('/api/admin/demo'); App.params = (await GET('/api/bootstrap')).params; App.cabecalho(); toast('Dados de demonstração carregados.', 'ok'); render(); } catch (e) { erro(e); } } };
      $('#limpar', alvo).onclick = async () => { if (await confirmar('Apagar TODOS os cadastros e movimentos? Faça um backup antes. Esta ação não pode ser desfeita.', 'Apagar tudo')) { try { await POST('/api/admin/limpar'); App.params = (await GET('/api/bootstrap')).params; App.cabecalho(); toast('Banco de dados limpo.', 'ok'); render(); } catch (e) { erro(e); } } };
    } else {
      alvo.innerHTML = `<div class="card" style="max-width:820px;line-height:1.7"><h2>Como usar o Nexo</h2><ol>
        <li><b>Parâmetros:</b> informe os dados da empresa, metas e o saldo inicial de caixa.</li>
        <li><b>Cadastros:</b> cadastre Clientes, Fornecedores e Produtos (o preço pode ser calculado pelo markup sobre o custo).</li>
        <li><b>Compras:</b> crie o pedido e, ao chegar a mercadoria, use <i>Receber</i> (entrada de NF-e): o estoque aumenta, o custo médio é atualizado e a conta a pagar é gerada.</li>
        <li><b>Vendas (PDV):</b> monte o pedido; veja disponibilidade e margem na hora. <i>Salvar orçamento</i> não mexe no estoque; <i>Confirmar venda</i> baixa o estoque e gera a conta a receber (respeitando o limite de crédito).</li>
        <li><b>Financeiro:</b> registre recebimentos e pagamentos (baixas), acompanhe aging e fluxo de caixa.</li>
        <li><b>Estoque:</b> acompanhe cobertura, giro e sugestão de reposição; faça ajustes e inventário.</li>
        <li><b>Relatórios / Dashboard:</b> analise resultados e exporte para Excel.</li></ol>
        <p class="muted">Dica: faça backup periodicamente em Parâmetros → Banco de dados. As planilhas ficam na pasta <b>dados/</b>.</p></div>`;
    }
  };
  await render();
}

/* ================= VISÃO GERAL ================= */
async function viewHome(root) {
  const d = await GET('/api/dashboard'), k = d.kpis;
  const mod = (r, ico, t, itens) => `<a class="module" href="#/${r}"><span class="go">→</span><h3>${ico} ${t}</h3><ul>${itens.map(i => `<li>${i}</li>`).join('')}</ul></a>`;
  const kpi = (l, v, c = '') => `<div class="kpi ${c}"><div class="l">${l}</div><div class="v">${v}</div></div>`;
  root.innerHTML = `<div class="pagehead"><div><h1>🏠 Visão Geral</h1><p class="sub" style="margin:0">Bem-vindo! Escolha um módulo para começar.</p></div></div>
    <div class="grid g4">${kpi('Vendas hoje', k.pedidos_hoje)}${kpi('Itens em estoque', fnum(k.itens_estoque), 'navy')}${kpi('Vendas do mês', brl(k.vendas_mes, 0), 'green')}${kpi('Caixa atual', brl(k.caixa_atual, 0), k.caixa_atual >= 0 ? 'green' : 'red')}</div>
    <div class="section">Módulos operacionais — onde são realizados os cadastros e movimentos</div>
    <div class="grid g2">
      ${mod('clientes', '👥', 'Clientes', ['Cadastro completo', 'Limite de crédito', 'Histórico de compras', 'Faturamento por cliente'])}
      ${mod('fornecedores', '🚚', 'Fornecedores', ['Cadastro de fornecedores', 'Prazo médio de entrega', 'Histórico de compras', 'Avaliação de desempenho'])}
      ${mod('produtos', '📦', 'Produtos', ['Cadastro de produtos', 'Formação de preços', 'Margem automática', 'Estoque mínimo'])}
      ${mod('vendas', '💰', 'Vendas (PDV)', ['Pedido de venda', 'Consulta de estoque', 'Margem da venda', 'Emissão de orçamento'])}
      ${mod('compras', '🛒', 'Compras', ['Pedido de compra', 'Entrada de NF-e', 'Custos', 'Contas a pagar'])}
      ${mod('estoque', '📊', 'Estoque', ['Inventário valorizado', 'Cobertura de estoque', 'Giro de estoque', 'Sugestão de reposição'])}
      ${mod('financeiro', '💵', 'Financeiro', ['Contas a pagar', 'Contas a receber', 'Aging de clientes', 'Fluxo de caixa'])}
      ${mod('relatorios', '📋', 'Relatórios', ['Relatório de vendas', 'Relatório financeiro', 'Curva ABC', 'Consultas rápidas'])}</div>
    <div class="section">Gestão e configuração</div>
    <div class="grid g2">${mod('dashboard', '📈', 'Dashboard', ['KPIs estratégicos', 'Indicadores financeiros', 'Alertas gerenciais', 'Metas e desempenho'])}
      ${mod('parametros', '⚙️', 'Parâmetros', ['Dados da empresa', 'Configurações', 'Tabelas auxiliares', 'Orientações'])}</div>`;
}
