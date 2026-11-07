import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

const scripts = [
  '/js/core.js',
  '/js/auth.js',
  '/js/cadastros.js',
  '/js/documentos.js',
  '/js/gestao.js',
  '/js/app.js',
];

declare global {
  interface Window {
    __miniErpLegacyStarted?: boolean;
  }
}

function carregarScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Não foi possível carregar ${src}.`));
    document.body.appendChild(script);
  });
}

function LegacyERP() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.__miniErpLegacyStarted) return;
    window.__miniErpLegacyStarted = true;

    void (async () => {
      try {
        for (const script of scripts) await carregarScript(script);
      } catch (error) {
        window.__miniErpLegacyStarted = false;
        const view = host.current?.querySelector('#view');
        if (view) {
          view.textContent = error instanceof Error ? error.message : String(error);
        }
      }
    })();
  }, []);

  return (
    <div ref={host}>
      <section id="auth-screen" hidden />
      <div id="app">
        <aside id="menu">
          <div className="brand">
            <span className="brand-ico">▦</span>
            <div><b>MINI ERP</b><small>Gestão Empresarial</small></div>
          </div>
          <nav id="nav" />
          <div className="menu-foot">
            <button className="btn-sair" id="fechar-sistema" title="Desliga o Mini ERP com segurança">
              <span className="ico-sair">⏻</span><span className="t"> Fechar sistema</span>
            </button>
            <div>v2.0 · sistema de gestão</div>
          </div>
        </aside>
        <main>
          <header id="topbar">
            <div>
              <div className="top-title">MINI ERP - GESTÃO EMPRESARIAL</div>
              <div id="empresa" className="top-sub" />
            </div>
            <div className="top-right">
              <input id="busca" type="search" placeholder="🔍 Consulta rápida (cliente, produto, venda...)" autoComplete="off" />
              <div id="usuario" className="user" />
              <button className="btn" id="sair-conta" hidden>Sair</button>
            </div>
          </header>
          <section id="view" />
        </main>
      </div>
      <div id="modal-root" />
      <div id="toast" />
    </div>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Elemento raiz do Mini ERP não encontrado.');

createRoot(rootElement).render(<LegacyERP />);
