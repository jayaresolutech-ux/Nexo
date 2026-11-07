/* Autenticação Supabase para o modo hospedado. */
const Auth = (() => {
  const SESSION_KEY = 'minierp-auth-session';
  let config = null;
  let session = null;
  let onReady = null;
  let passwordSetup = false;
  let refreshing = null;

  const enabled = () => Boolean(config?.auth_enabled);
  const accessToken = () => session?.access_token || '';
  const user = () => session?.user || null;

  function saveSession(value) {
    session = value;
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  }

  function readSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    } catch (e) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  async function authRequest(path, method, body, token = '') {
    const headers = {
      apikey: config.publishable_key,
      'Content-Type': 'application/json',
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(config.supabase_url + '/auth/v1/' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.msg || result.message || result.error_description || result.error || 'Falha na autenticação.');
    }
    return result;
  }

  function displayLogin(error = '') {
    $('#app').hidden = true;
    $('#auth-screen').hidden = false;
    const title = passwordSetup ? 'Defina sua senha' : 'Acessar o Mini ERP';
    const description = passwordSetup
      ? 'Crie uma senha para concluir a ativação da sua conta.'
      : 'Entre com o e-mail e a senha da sua conta.';
    $('#auth-screen').innerHTML = `<div class="auth-card">
      <div class="brand-ico">▦</div>
      <h1>${title}</h1>
      <p class="sub">${description}</p>
      <form id="auth-form">
        ${passwordSetup ? '' : '<div class="field"><label for="auth-email">E-mail</label><input id="auth-email" type="email" autocomplete="username" required></div>'}
        <div class="field"><label for="auth-password">${passwordSetup ? 'Nova senha' : 'Senha'}</label><input id="auth-password" type="password" autocomplete="${passwordSetup ? 'new-password' : 'current-password'}" minlength="6" required></div>
        ${passwordSetup ? '<div class="field"><label for="auth-password-confirm">Confirme a senha</label><input id="auth-password-confirm" type="password" autocomplete="new-password" minlength="6" required></div>' : ''}
        <p id="auth-error" class="auth-error" role="alert"></p>
        <button id="auth-submit" class="btn primary" type="submit">${passwordSetup ? 'Salvar senha' : 'Entrar'}</button>
      </form>
    </div>`;
    if (error) $('#auth-error').textContent = error;
    $('#auth-form').addEventListener('submit', event => {
      event.preventDefault();
      submit().catch(showError);
    });
  }

  function showError(error) {
    const el = $('#auth-error');
    if (el) el.textContent = error.message || String(error);
  }

  async function continueToApp() {
    $('#auth-screen').hidden = true;
    $('#app').hidden = false;
    if (onReady) await onReady();
  }

  async function submit() {
    const button = $('#auth-submit');
    const password = $('#auth-password').value;
    button.disabled = true;
    $('#auth-error').textContent = '';
    try {
      if (passwordSetup) {
        if (password !== $('#auth-password-confirm').value) {
          throw new Error('As senhas não conferem.');
        }
        await authRequest('user', 'PUT', {password}, accessToken());
        passwordSetup = false;
      } else {
        const result = await authRequest('token?grant_type=password', 'POST', {
          email: $('#auth-email').value.trim(),
          password,
        });
        saveSession({...result, expires_at: Date.now() + result.expires_in * 1000});
      }
      await continueToApp();
    } catch (error) {
      showError(error);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  async function refresh() {
    if (!enabled()) return;
    if (refreshing) return refreshing;
    if (!session?.refresh_token) throw new Error('Sua sessão expirou. Entre novamente.');
    refreshing = authRequest('token?grant_type=refresh_token', 'POST', {
      refresh_token: session.refresh_token,
    }).then(result => {
      saveSession({...result, expires_at: Date.now() + result.expires_in * 1000});
    }).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  function expire(message = 'Sua sessão expirou. Entre novamente.') {
    saveSession(null);
    passwordSetup = false;
    displayLogin(message);
  }

  async function signOut() {
    let failure = null;
    try {
      if (accessToken()) await authRequest('logout', 'POST', {}, accessToken());
    } catch (error) {
      failure = error;
    } finally {
      saveSession(null);
      passwordSetup = false;
      displayLogin();
    }
    if (failure) throw failure;
  }

  async function start(ready) {
    onReady = ready;
    const response = await fetch('/api/config', {cache: 'no-store'});
    if (!response.ok) throw new Error('Não foi possível carregar a configuração do sistema.');
    config = await response.json();
    if (!enabled()) {
      await continueToApp();
      return;
    }
    if (!config.supabase_url || !config.publishable_key) {
      throw new Error('A autenticação Supabase não está configurada no servidor.');
    }

    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.has('access_token') && hash.has('refresh_token')) {
      const expiresIn = Number(hash.get('expires_in') || 3600);
      saveSession({
        access_token: hash.get('access_token'),
        refresh_token: hash.get('refresh_token'),
        expires_at: Date.now() + expiresIn * 1000,
      });
      passwordSetup = ['invite', 'recovery'].includes(hash.get('type'));
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      session = readSession();
    }

    if (!session) {
      displayLogin();
      return;
    }
    if (passwordSetup) {
      displayLogin();
      return;
    }
    await continueToApp();
  }

  return {accessToken, enabled, expire, refresh, signOut, start, user};
})();
