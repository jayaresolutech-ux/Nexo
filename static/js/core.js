/* Utilitários compartilhados: API, formatação, modal, gráficos, tabelas e formulários */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const N = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const brl = (v, dec = 2) => (N(v)).toLocaleString('pt-BR', {style: 'currency', currency: 'BRL', minimumFractionDigits: dec, maximumFractionDigits: dec});
const fnum = (v, dec = 0) => N(v).toLocaleString('pt-BR', {minimumFractionDigits: dec, maximumFractionDigits: dec});
const fdata = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '';
const hojeISO = () => new Date().toISOString().slice(0, 10);
const badge = t => `<span class="badge ${esc(t)}">${esc(t)}</span>`;

async function api(metodo, url, corpo, arquivo = false) {
  const request = async () => {
    const headers = {'Content-Type': 'application/json'};
    const token = window.Auth?.accessToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(url, {method: metodo, headers,
      body: corpo === undefined ? undefined : JSON.stringify(corpo)});
  };
  let r = await request();
  if (r.status === 401 && window.Auth?.enabled()) {
    try {
      await window.Auth.refresh();
    } catch (e) {
      window.Auth.expire();
      throw e;
    }
    r = await request();
  }
  if (r.ok && arquivo) return r.blob();
  let dados = {};
  try { dados = await r.json(); } catch (e) { /* resposta sem JSON */ }
  if (r.status === 401 && window.Auth?.enabled()) {
    window.Auth.expire();
  }
  if (r.status === 403 && window.Auth?.enabled()) {
    window.Auth.expire('Sua conta está inativa ou suspensa. Contate o administrador.');
  }
  if (!r.ok) throw new Error(dados.erro || 'Falha na requisição.');
  return dados;
}
const GET = url => api('GET', url);
const POST = (url, b = {}) => api('POST', url, b);
const PUT = (url, b = {}) => api('PUT', url, b);
const DEL = url => api('DELETE', url);
async function baixarArquivo(url, nome) {
  const blob = await api('GET', url, undefined, true);
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = nome;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function toast(msg, tipo = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + tipo;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), tipo === 'err' ? 6000 : 3000);
}
const erro = e => toast(e.message || String(e), 'err');

const MODAIS_ABERTOS = new Set();

function modal({titulo, corpo, largo = false, botoes = [], onOpen}) {
  const root = $('#modal-root');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${largo ? 'wide' : ''}"><div class="modal-h"><h2>${esc(titulo)}</h2>
    <button class="modal-x" aria-label="Fechar">×</button></div><div class="modal-b">${corpo}</div>
    <div class="modal-f"></div></div>`;
  root.appendChild(ov);
  const ctl = {el: ov, titulo, body: $('.modal-b', ov), sujo: false};
  ctl.close = () => { ov.remove(); MODAIS_ABERTOS.delete(ctl); };
  ctl.pedirFechar = async () => {
    if (ctl.sujo && !await confirmar('Esta tela tem alterações NÃO SALVAS. Se fechar agora, elas serão perdidas. Deseja fechar mesmo assim?', 'Descartar alterações')) return;
    ctl.close();
  };
  MODAIS_ABERTOS.add(ctl);
  ov.addEventListener('input', () => { ctl.sujo = true; });
  ov.addEventListener('change', () => { ctl.sujo = true; });
  ov.addEventListener('click', e => { if (e.target.closest('.modal-b button')) ctl.sujo = true; });
  $('.modal-x', ov).onclick = ctl.pedirFechar;
  ov.addEventListener('mousedown', e => { if (e.target === ov && !botoes.length) ctl.pedirFechar(); });
  const foot = $('.modal-f', ov);
  if (!botoes.length) foot.remove();
  botoes.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (b.classe || '');
    btn.textContent = b.texto;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        if (!b.acao) return await ctl.pedirFechar();
        const r = await b.acao(ctl);
        if (r !== false) ctl.close();
      } catch (e) { erro(e); } finally { btn.disabled = false; }
    };
    foot.appendChild(btn);
  });
  if (onOpen) onOpen(ctl);
  const first = $('input,select,textarea', ov);
  if (first) first.focus();
  return ctl;
}

function confirmar(msg, textoOk = 'Confirmar') {
  return new Promise(res => {
    modal({titulo: 'Confirmação', corpo: `<p>${esc(msg)}</p>`, botoes: [
      {texto: 'Cancelar', acao: () => res(false)}, {texto: textoOk, classe: 'primary', acao: () => res(true)}]});
  });
}

/* ---------- formulários ---------- */
function campoHtml(c, v) {
  const id = 'f_' + c.k;
  let input;
  if (c.tipo === 'select') {
    input = `<select id="${id}">${c.opts.map(o => `<option value="${esc(o.v)}" ${String(o.v) === String(v ?? c.padrao ?? '') ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`;
  } else if (c.tipo === 'textarea') {
    input = `<textarea id="${id}" rows="3">${esc(v ?? '')}</textarea>`;
  } else {
    const t = {numero: 'number', dinheiro: 'number', data: 'date', email: 'email'}[c.tipo] || 'text';
    const step = c.tipo === 'dinheiro' ? ' step="0.01" min="0"' : c.tipo === 'numero' ? ` step="${c.passo || 1}" min="0"` : '';
    input = `<input id="${id}" type="${t}"${step} value="${esc(v ?? c.padrao ?? '')}" ${c.somenteLeitura ? 'readonly' : ''}>`;
  }
  return `<div class="field ${c.full ? 'full' : ''}"><label for="${id}">${esc(c.rot)}${c.req ? ' *' : ''}</label>${input}${c.ajuda ? `<small>${esc(c.ajuda)}</small>` : ''}</div>`;
}
const formHtml = (campos, v = {}) => `<div class="form-grid">${campos.map(c => campoHtml(c, v[c.k])).join('')}</div>`;
function lerForm(root, campos) {
  const o = {};
  campos.forEach(c => { const el = $('#f_' + c.k, root); if (el) o[c.k] = el.value; });
  return o;
}

/* ---------- tabelas ---------- */
function celula(col, row) {
  const v = row[col.key ?? col.k];
  if (col.render) return col.render(row);
  switch (col.tipo) {
    case 'moeda': return v === null || v === undefined ? '' : brl(v);
    case 'num': return v === null || v === undefined ? '' : fnum(v, 2).replace(/,00$/, '');
    case 'int': return v === null || v === undefined ? '' : fnum(v);
    case 'pct': return fnum(v, 1) + '%';
    case 'data': return fdata(v);
    case 'badge': return badge(v);
    default: return esc(v);
  }
}
const alinha = col => ['moeda', 'num', 'int', 'pct'].includes(col.tipo) ? 'r' : col.tipo === 'badge' ? 'c' : '';
function tabela(cols, rows, {totais, vazio = 'Nenhum registro encontrado.', clique} = {}) {
  if (!rows.length) return `<div class="tablewrap"><div class="empty">${esc(vazio)}</div></div>`;
  const th = cols.map(c => `<th class="${alinha(c)}">${esc(c.label ?? c.rot)}</th>`).join('');
  const tr = rows.map((r, i) => `<tr class="${clique ? 'click' : ''}" data-i="${i}">${cols.map(c => `<td class="${alinha(c)}">${celula(c, r)}</td>`).join('')}</tr>`).join('');
  let foot = '';
  if (totais && Object.keys(totais).length) {
    foot = `<tfoot><tr>${cols.map((c, i) => `<td class="${alinha(c)}">${i === 0 ? 'TOTAL' : (totais[c.key] !== undefined ? celula(c, totais) : '')}</td>`).join('')}</tr></tfoot>`;
  }
  return `<div class="tablewrap"><table class="t"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody>${foot}</table></div>`;
}
function ligarLinhas(root, rows, fn) {
  $$('tbody tr[data-i]', root).forEach(tr => tr.addEventListener('click', ev => {
    if (ev.target.closest('button,a,input,select')) return;
    fn(rows[+tr.dataset.i], ev);
  }));
}

/* ---------- gráficos SVG ---------- */
const CORES = ['#1b5de0', '#12805c', '#c97a0a', '#7b4fd0', '#c0392b', '#0f9fb0', '#8a94a8'];
const abrev = v => Math.abs(v) >= 1e6 ? fnum(v / 1e6, 1) + ' mi' : Math.abs(v) >= 1e3 ? fnum(v / 1e3, 0) + ' mil' : fnum(v);
function eixoY(max, W, H, pad) {
  const passo = Math.pow(10, Math.floor(Math.log10(max || 1)));
  let step = passo; while (max / step > 5) step *= 2;
  const topo = Math.ceil(max / step) * step || 1;
  let s = '';
  for (let v = 0; v <= topo + 1e-9; v += step) {
    const y = H - pad.b - (v / topo) * (H - pad.t - pad.b);
    s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="#e3e8f2"/><text x="${pad.l - 8}" y="${y + 4}" font-size="11" fill="#6b7794" text-anchor="end">${abrev(v)}</text>`;
  }
  return {svg: s, topo};
}
function graficoBarras(labels, series) {
  const W = 560, H = 260, pad = {l: 54, r: 10, t: 14, b: 30};
  const max = Math.max(1, ...series.flatMap(s => s.valores));
  const {svg, topo} = eixoY(max, W, H, pad);
  const gw = (W - pad.l - pad.r) / labels.length, bw = Math.min(34, gw / (series.length + 1));
  let barras = '';
  labels.forEach((lb, i) => {
    series.forEach((s, j) => {
      const h = (s.valores[i] / topo) * (H - pad.t - pad.b);
      const x = pad.l + i * gw + gw / 2 - (series.length * bw) / 2 + j * bw;
      barras += `<rect x="${x}" y="${H - pad.b - h}" width="${bw - 3}" height="${h}" rx="3" fill="${s.cor}"><title>${esc(s.nome)} ${esc(lb)}: ${brl(s.valores[i], 0)}</title></rect>`;
    });
    barras += `<text x="${pad.l + i * gw + gw / 2}" y="${H - 10}" font-size="11" fill="#6b7794" text-anchor="middle">${esc(lb)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${svg}${barras}</svg>${legenda(series.map(s => [s.nome, s.cor]))}`;
}
function graficoLinhas(labels, series) {
  const W = 560, H = 260, pad = {l: 54, r: 14, t: 14, b: 30};
  const max = Math.max(1, ...series.flatMap(s => s.valores));
  const {svg, topo} = eixoY(max, W, H, pad);
  const gw = (W - pad.l - pad.r) / labels.length;
  const X = i => pad.l + i * gw + gw / 2, Y = v => H - pad.b - (v / topo) * (H - pad.t - pad.b);
  let out = svg;
  labels.forEach((lb, i) => { out += `<text x="${X(i)}" y="${H - 10}" font-size="10" fill="#6b7794" text-anchor="middle">${esc(lb.replace(' (prev.)', '*'))}</text>`; });
  series.forEach(s => {
    out += `<polyline fill="none" stroke="${s.cor}" stroke-width="2.5" points="${s.valores.map((v, i) => `${X(i)},${Y(v)}`).join(' ')}"/>`;
    s.valores.forEach((v, i) => { out += `<circle cx="${X(i)}" cy="${Y(v)}" r="4" fill="${s.cor}"><title>${esc(s.nome)} ${esc(labels[i])}: ${brl(v, 0)}</title></circle>`; });
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${out}</svg>${legenda(series.map(s => [s.nome, s.cor]))}`;
}
function graficoRosca(itens) {
  const total = itens.reduce((a, i) => a + i.valor, 0) || 1;
  const R = 80, r = 50, cx = 100, cy = 100;
  let ang = -Math.PI / 2, paths = '';
  itens.forEach((it, i) => {
    const a = (it.valor / total) * Math.PI * 2, a2 = ang + Math.min(a, Math.PI * 2 - 0.0001);
    const p = (rad, t) => `${cx + rad * Math.cos(t)},${cy + rad * Math.sin(t)}`;
    paths += `<path d="M${p(R, ang)} A${R},${R} 0 ${a > Math.PI ? 1 : 0} 1 ${p(R, a2)} L${p(r, a2)} A${r},${r} 0 ${a > Math.PI ? 1 : 0} 0 ${p(r, ang)}Z" fill="${CORES[i % CORES.length]}"><title>${esc(it.nome)}: ${brl(it.valor, 0)} (${fnum(it.valor / total * 100, 1)}%)</title></path>`;
    ang += a;
  });
  const leg = itens.map((it, i) => `<div style="display:flex;justify-content:space-between;gap:14px"><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${CORES[i % CORES.length]};margin-right:6px"></i>${esc(it.nome)}</span><b>${fnum(it.valor / total * 100, 0)}%</b></div>`).join('');
  return `<div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap"><svg viewBox="0 0 200 200" width="190">${paths}
    <text x="100" y="97" text-anchor="middle" font-size="12" fill="#6b7794">Total</text><text x="100" y="116" text-anchor="middle" font-size="15" font-weight="700" fill="#0b1f4d">${abrev(total)}</text></svg>
    <div style="flex:1;min-width:150px;font-size:13px;display:grid;gap:5px">${leg}</div></div>`;
}
const legenda = itens => `<div class="legend">${itens.map(([n, c]) => `<span><i style="background:${c}"></i>${esc(n)}</span>`).join('')}</div>`;

const estrelas = n => `<span class="stars">${'★'.repeat(Math.round(N(n)))}${'☆'.repeat(5 - Math.round(N(n)))}</span>`;
