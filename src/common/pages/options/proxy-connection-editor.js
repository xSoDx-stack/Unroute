'use strict';

import { parseCustomProxies, parseProxyScheme, parseProxyHostInput, proxyEndpointKey } from '../../core/utils.js';
import { MAX_PROXY_NAME_LENGTH, proxyNameLength } from '../../core/proxy-profiles.js';
import { t } from '../../core/i18n.js';

// The caller owns this draft, keyed by profile ID. Reuse it on state refreshes;
// never recreate it after a rejected save. Credentials remain local to this UI.
export function createProxyEditDraft(profile, raw) {
  const connection = parseCustomProxies(typeof raw === 'string' ? raw : raw?.customProxyStringRaw || '')
    .find(item => proxyEndpointKey(item) === profile.endpoint);
  const parsed = connection || parseProxyScheme(profile.endpoint.replace(/^PROXY\s+/i, 'HTTP '));
  if (!parsed) throw new Error(t('proxyConnectionInvalidSaved', 'Сохранённое подключение прокси некорректно.'));
  return { mode: 'edit', name: profile.name, protocol: parsed.type, host: parsed.hostname, port: parsed.port,
    username: parsed.username, password: parsed.password, hasAuth: parsed.hasAuth };
}

export function renderProxyConnectionEditor({ profile, draft, busy = false, onSubmit, onCancel }) {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'proxy-profile-editor proxy-connection-editor';
  fieldset.disabled = busy;
  const legend = document.createElement('legend');
  legend.textContent = t('proxyEditConnection', 'Изменить подключение');
  const form = document.createElement('form');
  form.autocomplete = 'off';
  const grid = document.createElement('div');
  grid.className = 'proxy-connection-grid';
  const controls = {};
  function field(key, title, type = 'text', container = grid) {
    const label = document.createElement('label');
    label.className = 'proxy-connection-field';
    const caption = document.createElement('span');
    caption.className = 'form-label';
    caption.textContent = title;
    const input = document.createElement(type === 'select' ? 'select' : 'input');
    if (type !== 'select') input.type = type;
    input.name = key;
    input.className = type === 'select' ? 'select-input' : 'text-input';
    if (type === 'select') for (const protocol of ['HTTP', 'HTTPS', 'SOCKS4', 'SOCKS5', 'SOCKS']) {
      const option = document.createElement('option'); option.value = protocol; option.textContent = protocol; input.append(option);
    }
    input.value = draft[key] ?? '';
    input.addEventListener('input', () => { draft[key] = input.value; validate(); });
    input.addEventListener('change', () => { draft[key] = input.value; validate(); });
    label.append(caption, input); container.append(label); controls[key] = input;
    return input;
  }
  field('name', t('proxyConnectionName', 'Название')).required = true;
  field('protocol', t('proxyConnectionProtocol', 'Протокол'), 'select');
  field('host', t('proxyConnectionHost', 'Хост / IP-адрес')).required = true;
  const port = field('port', t('proxyConnectionPort', 'Порт'), 'number');
  port.required = true; port.min = '1'; port.max = '65535'; port.step = '1';
  const authLabel = document.createElement('label');
  authLabel.className = 'auth-checkbox-row';
  const auth = document.createElement('input');
  auth.type = 'checkbox'; auth.name = 'hasAuth'; auth.checked = draft.hasAuth;
  auth.addEventListener('change', () => { draft.hasAuth = auth.checked; validate(); });
  authLabel.append(auth, document.createTextNode(t('proxyConnectionAuth', 'Авторизация')));
  const authFields = document.createElement('div');
  authFields.className = 'auth-fields-container';
  field('username', t('proxyConnectionUsername', 'Логин'), 'text', authFields).autocomplete = 'off';
  field('password', t('proxyConnectionPassword', 'Пароль'), 'password', authFields).autocomplete = 'new-password';
  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.textContent = t('proxyConnectionHint', 'Назначения сайтов, списков и резервного прокси сохранятся. Авторизация SOCKS не поддерживается браузером.');
  const status = document.createElement('p');
  status.className = 'proxy-connection-error'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.textContent = draft.error || '';
  const actions = document.createElement('div'); actions.className = 'proxy-editor-actions';
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn-primary'; save.textContent = busy ? t('proxyConnectionSaving', 'Сохранение…') : t('proxyConnectionSave', 'Сохранить');
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = t('proxyConnectionCancel', 'Отмена');
  cancel.addEventListener('click', () => onCancel?.());
  actions.append(save, cancel);
  form.append(grid, authLabel, authFields, hint, status, actions);
  fieldset.append(legend, form);
  let payload;
  function validate() {
    for (const input of Object.values(controls)) input.setCustomValidity('');
    authFields.hidden = !draft.hasAuth;
    controls.username.disabled = controls.password.disabled = !draft.hasAuth;
    controls.username.required = Boolean(draft.hasAuth);
    const legacyName = draft.name === profile.name;
    const name = legacyName ? draft.name : draft.name.normalize('NFKC').trim();
    const hasControl = [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
    // Use the backend's code-point limit, not HTML maxlength (UTF-16 units).
    if (!legacyName && (!name || proxyNameLength(name) > MAX_PROXY_NAME_LENGTH || hasControl)) {
      controls.name.setCustomValidity(t('proxyConnectionInvalidName', 'Название должно содержать от 1 до 32 символов.'));
    }
    if (draft.hasAuth && draft.protocol.startsWith('SOCKS')) controls.protocol.setCustomValidity(t('proxyConnectionSocksAuth', 'Авторизация SOCKS не поддерживается браузером.'));
    const address = parseProxyHostInput(draft.host, draft.port);
    const credentials = draft.hasAuth ? `${encodeURIComponent(draft.username)}:${encodeURIComponent(draft.password)}@` : '';
    const proxy = address ? `${draft.protocol} ${credentials}${address.host}:${address.port}` : '';
    if (!address || ((!draft.hasAuth || draft.username) && !parseProxyScheme(proxy))) {
      controls.host.setCustomValidity(t('proxyConnectionInvalidAddress', 'Проверьте адрес и порт прокси (1–65535).'));
    }
    payload = { proxy, name };
  }
  let submitting = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || submitting) return;
    validate();
    if (!form.reportValidity()) return;
    submitting = true; fieldset.disabled = true; status.textContent = '';
    try { await onSubmit(payload); }
    catch { status.textContent = t('proxyConnectionSaveFailed', 'Не удалось сохранить подключение. Проверьте настройки и повторите попытку.'); }
    finally { submitting = false; fieldset.disabled = busy; }
  });
  validate();
  return fieldset;
}
