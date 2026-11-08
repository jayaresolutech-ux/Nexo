/* Vendas (PDV) e Compras: listas e formulário de documento */
const DOC = {
  venda: {rot: 'venda', parte: 'Cliente', parteApi: 'clientes', campoParte: 'cliente_id', campoNome: 'cliente', campoPreco: 'preco_unitario', precoDe: 'preco', api: 'vendas', titulo: 'Pedido de venda'},
  compra: {rot: 'compra', parte: 'Fornecedor', parteApi: 'fornecedores', campoParte: 'fornecedor_id', campoNome: 'fornecedor', campoPreco: 'custo_unitario', precoDe: 'custo', api: 'compras', titulo: 'Pedido de compra'},
};

function imprimirDocumento(tipo, doc) {
  const D = DOC[tipo], p = App.params, V = tipo === 'venda';
  const linhas = doc.itens.map(i => {
    const pr = N(i[D.campoPreco]);
    return `<tr><td>${esc(i.produto)}</td><td style="text-align:right">${fnum(i.quantidade, 2).replace(/,00$/, '')}</td><td style="text-align:right">${brl(pr)}</td><td style="text-align:right">${brl(pr * N(i.quantidade))}</td></tr>`;
  }).join('');
  const w = window.open('', '_blank');
  if (!w) { toast('Permita pop-ups para imprimir.', 'err'); return; }
  w.document.write(`<html><head><meta charset="utf-8"><title>${D.titulo} #${doc.id}</title><style>body{font-family:Arial,sans-serif;margin:40px;color:#1c2740}table{width:100%;border-collapse:collapse;margin-top:18px}th{background:#0B1F4D;color:#fff;text-align:left;padding:8px}td{padding:8px;border-bottom:1px solid #ddd}h1{margin:0}.r{text-align:right}</style></head><body>
    <h1>${esc(p.empresa_nome)}</h1><div>${esc(p.empresa_cnpj)} ${esc(p.empresa_endereco)} ${esc(p.empresa_telefone)}</div>
    <h2>${V && doc.status === 'Orçamento' ? 'ORÇAMENTO' : D.titulo.toUpperCase()} Nº ${doc.id}</h2>
    <div><b>${D.parte}:</b> ${esc(doc[D.campoNome])} &nbsp; <b>Data:</b> ${fdata(doc.data)} &nbsp; <b>Status:</b> ${esc(doc.status)}</div>
    ${V ? `<div><b>Pagamento:</b> ${esc(doc.forma_pagamento)}${N(doc.prazo_dias) ? ` (${doc.prazo_dias} dias)` : ''}</div>` : ''}
    <table><thead><tr><th>Produto</th><th class="r">Qtd</th><th class="r">${V ? 'Preço' : 'Custo'} unit.</th><th class="r">Subtotal</th></tr></thead><tbody>${linhas}</tbody></table>
    ${V && N(doc.desconto) ? `<p class="r">Desconto: ${fnum(doc.desconto, 1)}%</p>` : ''}<h2 class="r">Total: ${brl(doc.total)}</h2>
    ${V && doc.status === 'Orçamento' ? '<p style="color:#666">Orçamento sujeito a confirmação de estoque e condições comerciais.</p>' : ''}
    <script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
}

async function abrirDocumento(tipo, doc, onDone, prefill) {
  const D = DOC[tipo], V = tipo === 'venda';
  const [partes, produtos, receber] = await Promise.all([GET('/api/' + D.parteApi), GET('/api/produtos'), V ? GET('/api/contas_receber') : []]);
  const prods = produtos.filter(p => p.ativo === 'Sim');
  const mapa = Object.fromEntries(produtos.map(p => [p.id, p]));
  let itens = doc ? doc.itens.map(i => ({produto_id: i.produto_id, quantidade: i.quantidade, preco: i[D.campoPreco]}))
    : (prefill && prefill.length ? prefill : [{produto_id: '', quantidade: 1, preco: ''}]);
  const optsParte = partes.filter(p => p.ativo === 'Sim' || (doc && p.id === doc[D.campoParte]))
    .map(p => `<option value="${p.id}" ${doc && doc[D.campoParte] === p.id ? 'selected' : ''}>${esc(p.nome)}</option>`).join('');
  const optsProd = sel => `<option value="">— selecione o produto —</option>` + prods.map(p =>
    `<option value="${p.id}" ${+sel === p.id ? 'selected' : ''}>${esc(p.sku)} · ${esc(p.nome)}</option>`).join('');
  const form = V ? `
    <div class="field"><label>Cliente *</label><select id="d_parte"><option value="">— selecione —</option>${optsParte}</select></div>
    <div class="field"><label>Data</label><input id="d_data" type="date" value="${esc(doc ? doc.data : hojeISO())}"></div>
    <div class="field"><label>Forma de pagamento</label><select id="d_forma"><option ${doc && doc.forma_pagamento !== 'À vista' ? '' : 'selected'}>À vista</option><option ${doc && doc.forma_pagamento === 'A prazo' ? 'selected' : ''}>A prazo</option></select></div>
    <div class="field"><label>Prazo (dias)</label><input id="d_prazo" type="number" min="0" value="${esc(doc ? doc.prazo_dias : 30)}"></div>
    <div class="field"><label>Desconto (%)</label><input id="d_desc" type="number" min="0" max="100" step="0.1" value="${esc(doc ? doc.desconto : 0)}"></div>
    <div class="field"><label>Observações</label><input id="d_obs" value="${esc(doc ? doc.observacoes : '')}"></div>` : `
    <div class="field"><label>Fornecedor *</label><select id="d_parte"><option value="">— selecione —</option>${optsParte}</select></div>
    <div class="field"><label>Data do pedido</label><input id="d_data" type="date" value="${esc(doc ? doc.data : hojeISO())}"></div>
    <div class="field"><label>Nota fiscal (NF-e)</label><input id="d_nf" value="${esc(doc ? doc.nota_fiscal : '')}"></div>
    <div class="field"><label>Prazo de pagamento (dias)</label><input id="d_prazo" type="number" min="0" value="${esc(doc ? doc.prazo_dias : 30)}"></div>`;
  const corpo = `<div class="form-grid">${form}</div><div id="d_aviso"></div>
    <div class="tablewrap lines"><table class="t"><thead><tr><th style="min-width:260px">Produto</th><th style="width:90px">Qtd</th><th style="width:120px">${V ? 'Preço unit.' : 'Custo unit.'}</th>
    <th class="r">${V ? 'Disponível' : 'Estoque atual'}</th><th class="r">Subtotal</th>${V ? '<th class="r">Margem</th>' : ''}<th></th></tr></thead><tbody id="d_linhas"></tbody></table></div>
    <button class="btn sm mt" id="d_add">＋ Adicionar item</button>
    <div class="totals mt" id="d_tot"></div>`;
  const ctl = modal({titulo: doc ? `${D.titulo} nº ${doc.id}` : `Novo ${D.titulo.toLowerCase()}`, corpo, largo: true,
    botoes: [{texto: 'Cancelar'},
      {texto: V ? 'Salvar orçamento' : 'Salvar pedido', acao: c => gravar('save')},
      {texto: V ? '✔ Confirmar venda' : '✔ Salvar e receber (entrada NF-e)', classe: 'primary', acao: c => gravar('ok')}]});
  const $d = s => $(s, ctl.body);
  const calc = () => {
    let sub = 0, custo = 0;
    itens.forEach(i => { const p = mapa[i.produto_id]; const q = N(i.quantidade), pr = N(i.preco); sub += q * pr; if (p) custo += q * N(p.custo); });
    const desc = V ? Math.min(Math.max(N($d('#d_desc').value), 0), 100) : 0;
    const total = sub * (1 - desc / 100);
    $d('#d_tot').innerHTML = `<div><span>Subtotal</span><b>${brl(sub)}</b></div>` + (V ? `<div><span>Desconto (${fnum(desc, 1)}%)</span><b>- ${brl(sub - total)}</b></div>
      <div><span>Custo dos produtos</span><span>${brl(custo)}</span></div><div><span>Lucro / Margem da venda</span><b class="${total - custo >= 0 ? 'up' : 'down'}">${brl(total - custo)} · ${total > 0 ? fnum((total - custo) / total * 100, 1) : '0'}%</b></div>` : '') +
      `<div class="big"><span>TOTAL</span><span>${brl(total)}</span></div>`;
    if (V) {
      const cli = partes.find(c => c.id === +$d('#d_parte').value);
      let aviso = '';
      if (cli) {
        const aberto = receber.filter(r => r.cliente_id === cli.id && r.status === 'Aberta').reduce((a, r) => a + N(r.valor), 0);
        const lim = N(cli.limite_credito);
        const prazo = $d('#d_forma').value !== 'À vista';
        const excede = prazo && lim > 0 && aberto + total > lim;
        aviso = `<div class="hint ${excede ? 'warn' : ''}">Crédito de <b>${esc(cli.nome)}</b>: limite ${lim > 0 ? brl(lim) : 'sem limite'} · em aberto ${brl(aberto)}${lim > 0 ? ` · disponível ${brl(lim - aberto)}` : ''}${excede ? ' — <b>esta venda a prazo excede o limite</b>' : ''}</div>`;
      }
      $d('#d_aviso').innerHTML = aviso;
    }
    return total;
  };
  const linhas = () => {
    $d('#d_linhas').innerHTML = itens.map((i, n) => {
      const p = mapa[i.produto_id];
      const sub = N(i.quantidade) * N(i.preco);
      const m = p && sub > 0 && V ? (sub - N(i.quantidade) * N(p.custo)) / sub * 100 : null;
      const falta = V && p && N(i.quantidade) > N(p.estoque_atual);
      return `<tr data-n="${n}"><td><select data-c="produto_id">${optsProd(i.produto_id)}</select></td>
        <td><input data-c="quantidade" type="number" min="0" step="any" value="${esc(i.quantidade)}"></td>
        <td><input data-c="preco" type="number" min="0" step="0.01" value="${esc(i.preco)}"></td>
        <td class="r ${falta ? 'down' : ''}">${p ? fnum(p.estoque_atual, 2).replace(/,00$/, '') : '-'}${falta ? ' ⚠' : ''}</td>
        <td class="r" data-sub>${brl(sub)}</td>${V ? `<td class="r" data-mar>${m === null ? '-' : fnum(m, 1) + '%'}</td>` : ''}
        <td><button class="btn sm danger" data-del>✕</button></td></tr>`;
    }).join('');
    calc();
  };
  ctl.body.addEventListener('input', e => {
    const tr = e.target.closest('tr[data-n]');
    if (!tr) { calc(); return; }
    const it = itens[+tr.dataset.n], c = e.target.dataset.c;
    if (c === 'produto_id') return;
    it[c] = e.target.value;
    const p = mapa[it.produto_id], sub = N(it.quantidade) * N(it.preco);
    $('[data-sub]', tr).textContent = brl(sub);
    if (V) $('[data-mar]', tr).textContent = p && sub > 0 ? fnum((sub - N(it.quantidade) * N(p.custo)) / sub * 100, 1) + '%' : '-';
    calc();
  });
  ctl.body.addEventListener('change', e => {
    const tr = e.target.closest('tr[data-n]');
    if (tr && e.target.dataset.c === 'produto_id') {
      const it = itens[+tr.dataset.n]; it.produto_id = e.target.value;
      if (mapa[it.produto_id]) it.preco = N(mapa[it.produto_id][D.precoDe]);
      linhas();
    } else if (!tr) calc();
  });
  ctl.body.addEventListener('click', e => {
    if (e.target.id === 'd_add') { itens.push({produto_id: '', quantidade: 1, preco: ''}); linhas(); }
    if (e.target.matches('[data-del]')) { itens.splice(+e.target.closest('tr').dataset.n, 1); if (!itens.length) itens.push({produto_id: '', quantidade: 1, preco: ''}); linhas(); }
  });
  itens.forEach(i => { if (i.preco === '' && mapa[i.produto_id]) i.preco = N(mapa[i.produto_id][D.precoDe]); });
  linhas();
  async function gravar(modo) {
    const corpo = {[D.campoParte]: $d('#d_parte').value, data: $d('#d_data').value, prazo_dias: $d('#d_prazo').value,
      itens: itens.filter(i => i.produto_id).map(i => ({produto_id: +i.produto_id, quantidade: i.quantidade, [D.campoPreco]: i.preco}))};
    if (V) Object.assign(corpo, {forma_pagamento: $d('#d_forma').value, desconto: $d('#d_desc').value, observacoes: $d('#d_obs').value,
      status: modo === 'ok' ? 'Confirmada' : 'Orçamento'});
    else Object.assign(corpo, {nota_fiscal: $d('#d_nf').value, status: modo === 'ok' ? 'Recebida' : 'Pedido'});
    if (!corpo[D.campoParte]) { toast(`Selecione o ${D.parte.toLowerCase()}.`, 'err'); return false; }
    if (!corpo.itens.length) { toast('Inclua ao menos um produto.', 'err'); return false; }
    if (doc) await PUT(`/api/${D.api}/${doc.id}`, corpo); else await POST(`/api/${D.api}`, corpo);
    toast(modo === 'ok' ? (V ? 'Venda confirmada! Estoque e contas a receber atualizados.' : 'Entrada registrada! Estoque, custo médio e contas a pagar atualizados.') : 'Documento salvo.', 'ok');
    onDone && onDone();
  }
}

async function verDocumento(tipo, id, onDone) {
  const D = DOC[tipo], V = tipo === 'venda';
  const doc = await GET(`/api/${D.api}/${id}`);
  if ((V && doc.status === 'Orçamento') || (!V && doc.status === 'Pedido')) return abrirDocumento(tipo, doc, onDone);
  const cols = [{key: 'produto', label: 'Produto'}, {key: 'quantidade', label: 'Qtd', tipo: 'num'}, {key: D.campoPreco, label: V ? 'Preço' : 'Custo', tipo: 'moeda'},
    {key: 'sub', label: 'Subtotal', tipo: 'moeda'}];
  const linhas = doc.itens.map(i => ({...i, sub: N(i.quantidade) * N(i[D.campoPreco])}));
  const botoes = [{texto: 'Fechar'}, {texto: '🖨 Imprimir', acao: () => { imprimirDocumento(tipo, doc); return false; }}];
  if (V && doc.status === 'Confirmada') botoes.push({texto: 'Cancelar venda', classe: 'danger', acao: async () => {
    if (!await confirmar('Cancelar esta venda? O estoque será devolvido e a conta a receber cancelada.', 'Cancelar venda')) return false;
    await POST(`/api/vendas/${id}/cancelar`); toast('Venda cancelada.', 'ok'); onDone && onDone(); }});
  modal({titulo: `${D.titulo} nº ${doc.id}`, largo: true, botoes, corpo: `
    <div class="hint"><b>${esc(doc[D.campoNome])}</b> · ${fdata(doc.data)} · ${badge(doc.status)}${V ? ` · ${esc(doc.forma_pagamento)}${N(doc.prazo_dias) ? ' (' + doc.prazo_dias + ' dias)' : ''}${N(doc.desconto) ? ' · desconto ' + fnum(doc.desconto, 1) + '%' : ''}` : ` · NF ${esc(doc.nota_fiscal || '-')}`}</div>
    ${tabela(cols, linhas)}<div class="totals mt">${V ? `<div><span>Lucro da venda</span><b>${brl(N(doc.total) - N(doc.custo_total))}</b></div>` : ''}<div class="big"><span>TOTAL</span><span>${brl(doc.total)}</span></div></div>`});
}

async function viewDocumentos(root, tipo) {
  const D = DOC[tipo], V = tipo === 'venda';
  let dados = [], filtro = '', st = '';
  const carregar = async () => { dados = (await GET('/api/' + D.api)).sort((a, b) => b.id - a.id); desenhar(); };
  root.innerHTML = `<div class="pagehead"><div><h1>${V ? '💰 Vendas (PDV)' : '🛒 Compras'}</h1>
    <p class="sub" style="margin:0">${V ? 'Pedido de venda com preço, disponibilidade e margem automáticos. Emissão de orçamento.' : 'Pedido de compra, entrada de NF-e, atualização de custos e geração de contas a pagar.'}</p></div>
    <button class="btn primary" id="novo">＋ ${V ? 'Nova venda / orçamento' : 'Novo pedido de compra'}</button></div>
    <div class="toolbar"><input id="q" type="search" placeholder="Buscar por ${D.parte.toLowerCase()} ou nº..." style="min-width:280px">
    <select id="st"><option value="">Todos os status</option>${(V ? ['Orçamento', 'Confirmada', 'Cancelada'] : ['Pedido', 'Recebida', 'Cancelada']).map(s => `<option>${s}</option>`).join('')}</select>
    <span class="muted" id="cont"></span></div><div id="lista"></div>`;
  function desenhar() {
    const f = dados.filter(d => (!st || d.status === st) && (`${d.id} ${d[D.campoNome]}`).toLowerCase().includes(filtro));
    $('#cont', root).textContent = `${f.length} documento(s) · total ${brl(f.filter(d => d.status !== 'Cancelada').reduce((a, d) => a + N(d.total), 0))}`;
    const cols = [{key: 'id', label: 'Nº', tipo: 'int'}, {key: 'data', label: 'Data', tipo: 'data'}, {key: D.campoNome, label: D.parte},
      {key: 'status', label: 'Status', tipo: 'badge'}, ...(V ? [{key: 'forma_pagamento', label: 'Pagamento'}] : [{key: 'nota_fiscal', label: 'NF'}]),
      {key: 'total', label: 'Total', tipo: 'moeda'}, {key: 'a', label: '', render: d => {
        const ab = (V && d.status === 'Orçamento') || (!V && d.status === 'Pedido');
        return `<button class="btn sm" data-a="ver" data-id="${d.id}">${ab ? 'Abrir / editar' : 'Ver'}</button>` +
          (ab && !V ? ` <button class="btn sm" data-a="rec" data-id="${d.id}">Receber</button>` : '') +
          (ab ? ` <button class="btn sm danger" data-a="canc" data-id="${d.id}">Cancelar</button>` : '') +
          (V && d.status === 'Orçamento' ? ` <button class="btn sm primary" data-a="conf" data-id="${d.id}">Confirmar</button>` : ''); }}];
    $('#lista', root).innerHTML = tabela(cols, f, {clique: true});
    ligarLinhas($('#lista', root), f, d => verDocumento(tipo, d.id, carregar).catch(erro));
    $$('#lista button[data-a]', root).forEach(b => b.onclick = async () => {
      const id = +b.dataset.id, a = b.dataset.a;
      try {
        if (a === 'ver') await verDocumento(tipo, id, carregar);
        if (a === 'conf') { if (await confirmar('Confirmar a venda agora? Dá baixa no estoque e gera a conta a receber.')) { await POST(`/api/vendas/${id}/confirmar`); toast('Venda confirmada!', 'ok'); carregar(); } }
        if (a === 'rec') { if (await confirmar('Registrar a entrada deste pedido (NF-e)? Atualiza estoque, custo e gera conta a pagar.')) { await POST(`/api/compras/${id}/receber`, {}); toast('Entrada registrada!', 'ok'); carregar(); } }
        if (a === 'canc') { if (await confirmar('Cancelar este documento?', 'Cancelar')) { await POST(`/api/${D.api}/${id}/cancelar`); toast('Cancelado.', 'ok'); carregar(); } }
      } catch (e) { erro(e); }
    });
  }
  $('#novo', root).onclick = () => abrirDocumento(tipo, null, carregar, App.prefillCompra).catch(erro);
  $('#q', root).oninput = e => { filtro = e.target.value.toLowerCase(); desenhar(); };
  $('#st', root).onchange = e => { st = e.target.value; desenhar(); };
  await carregar();
  if (!V && App.prefillCompra) { const pf = App.prefillCompra; App.prefillCompra = null; abrirDocumento(tipo, null, carregar, pf).catch(erro); }
}
