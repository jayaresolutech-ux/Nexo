/* Navegação e inicialização */
const App = {params: {}, prefillCompra: null, abaRel: null};

const MENU = [
  ['home', '🏠', 'Visão Geral'], ['clientes', '👥', 'Clientes'], ['fornecedores', '🚚', 'Fornecedores'], ['produtos', '📦', 'Produtos'],
  ['vendas', '💰', 'Vendas'], ['compras', '🛒', 'Compras'], ['estoque', '📊', 'Estoque'], ['financeiro', '💵', 'Financeiro'],
  ['relatorios', '📋', 'Relatórios'], ['dashboard', '📈', 'Dashboard'], ['parametros', '⚙️', 'Parâmetros']];

const VIEWS = {
  home: viewHome, dashboard: viewDashboard, estoque: viewEstoque, financeiro: viewFinanceiro, relatorios: viewRelatorios,
  parametros: viewParametros, vendas: r => viewDocumentos(r, 'venda'), compras: r => viewDocumentos(r, 'compra'),
  clientes: r => viewCadastro(r, 'clientes'), fornecedores: r => viewCadastro(r, 'fornecedores'), produtos: r => viewCadastro(r, 'produtos'),
};

App.cabecalho = () => {
  $('#empresa').textContent = App.params.empresa_nome || '';
  $('#usuario').textContent = '👤 Usuário: ' + (App.params.usuario || 'Administrador');
};

async function rotear() {
  const rota = (location.hash.replace(/^#\//, '') || 'home').split('?')[0];
  const nome = VIEWS[rota] ? rota : 'home';
  $('#nav').innerHTML = MENU.map(([r, i, t], n) => `${n === 9 ? '<div class="sep"></div>' : ''}<a href="#/${r}" class="${r === nome ? 'on' : ''}"><span class="ico">${i}</span><span class="t">${t}</span></a>`).join('');
  const view = $('#view');
  view.innerHTML = '<div class="empty">Carregando...</div>';
  try { await VIEWS[nome](view); window.scrollTo(0, 0); } catch (e) { view.innerHTML = `<div class="card"><h2>Não foi possível carregar</h2><p>${esc(e.message)}</p></div>`; }
}

function telaLicenca(b) {
  $('#nav').innerHTML = MENU.map(([r, i, t]) => `<a class="locked" style="opacity:.45;cursor:not-allowed" title="Ative a licença"><span class="ico">${i}</span><span class="t">${t} 🔒</span></a>`).join('');
  $('#empresa').textContent = 'Licença não ativada';
  $('#usuario').textContent = '🔒 Bloqueado';
  $('#busca').disabled = true;
  $('#view').innerHTML = `<div class="card" style="max-width:560px;margin:30px auto">
    <h1 style="margin-top:0">🔑 Ativação da licença</h1>
    <p class="sub">${b.copia ? '<b style="color:#c0392b">Esta cópia do Mini ERP não está licenciada para este computador.</b> ' : ''}Informe os dados da empresa e a chave recebida para liberar os módulos.</p>
    <div class="field"><label>Nome da empresa</label><input id="l_nome" autocomplete="off"></div>
    <div class="field"><label>CNPJ</label><input id="l_cnpj" placeholder="00.000.000/0000-00" maxlength="18" autocomplete="off"></div>
    <div class="field"><label>Chave de licença</label><input id="l_chave" placeholder="ERP-00000000000000-XXXX" autocomplete="off" style="text-transform:uppercase"></div>
    <button class="btn primary" id="l_ok">Ativar licença</button>
    <p class="muted" style="margin-top:14px;font-size:12px">A licença é vinculada ao CNPJ e a este computador. Código da máquina: <b>${esc(b.maquina)}</b></p></div>`;
  $('#l_cnpj').oninput = e => {
    const d = e.target.value.replace(/\D/g, '').slice(0, 14);
    e.target.value = d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
  };
  $('#l_ok').onclick = async () => {
    try {
      await POST('/api/licenca/ativar', {nome: $('#l_nome').value, cnpj: $('#l_cnpj').value, chave: $('#l_chave').value});
      location.hash = '#/home'; location.reload();
    } catch (e) { erro(e); }
  };
}

App.fechando = false;

function telaSistemaEncerrado() {
  document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;font-family:inherit;color:#1c2740;text-align:center">' +
    '<div><h1 style="color:#0b1f4d">Mini ERP encerrado com segurança</h1><p>O servidor local foi desligado. Você já pode fechar esta aba.</p></div></div>';
}

async function fecharSistema() {
  if (!await confirmar('Deseja fechar o Mini ERP? O servidor local será desligado e esta aba deixará de funcionar.', 'Fechar sistema')) return;
  try {
    await POST('/api/sair');
  } catch (e) { return erro(e); }
  App.fechando = true;
  telaSistemaEncerrado();
}

window.addEventListener('beforeunload', e => {
  if (!App.fechando && [...MODAIS_ABERTOS].some(c => c.sujo)) { e.preventDefault(); e.returnValue = ''; }
});
$('#fechar-sistema').onclick = () => fecharSistema().catch(erro);
$('#sair-conta').onclick = () => Auth.signOut().catch(erro);

async function iniciar() {
  try {
    const b = await GET('/api/bootstrap');
    if (!b.licenciado) return telaLicenca(b);
    App.params = b.params;
    if (Auth.enabled() && Auth.user()?.email) App.params.usuario = Auth.user().email;
    App.cabecalho();
    if (Auth.enabled()) {
      $('#fechar-sistema').hidden = true;
      $('#sair-conta').hidden = false;
    }
  } catch (e) {
    if (Auth.enabled() && !Auth.accessToken()) return;
    document.body.innerHTML = `<p style="padding:30px">${esc(e.message || 'Servidor do Mini ERP indisponível. Execute o app novamente.')}</p>`;
    return;
  }
  let t;
  $('#busca').addEventListener('input', e => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = e.target.value.trim();
      if (q.length < 2) return;
      const r = await GET('/api/busca?q=' + encodeURIComponent(q));
      modal({titulo: `Consulta rápida: "${q}"`, largo: true, corpo: r.length ? tabela([{key: 'tipo', label: 'Tipo', render: x => badge(x.tipo)}, {key: 'rotulo', label: 'Resultado'}, {key: 'detalhe', label: 'Detalhe'}], r, {clique: true}) : '<div class="empty">Nada encontrado.</div>',
        onOpen: ctl => { ligarLinhas(ctl.body, r, x => { ctl.close(); location.hash = '#/' + x.rota; }); $('#busca').focus(); }});
    }, 500);
  });
  window.addEventListener('hashchange', rotear);
  rotear();
}
Auth.start(iniciar).catch(e => {
  const mensagem = e.message || String(e);
  $('#view').innerHTML = `<div class="card" role="alert"><h2>Não foi possível iniciar o Mini ERP</h2><p>${esc(mensagem)}</p></div>`;
});
