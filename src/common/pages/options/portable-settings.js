'use strict';

import { t } from '../../core/i18n.js';
import { fitsBackupByteLimit, MAX_BACKUP_BYTES as PORTABLE_SETTINGS_MAX_BYTES } from '../../core/settings-backup-size.js';

export { PORTABLE_SETTINGS_MAX_BYTES };
export const PORTABLE_SETTINGS_WARNING = 'Внимание: JSON не зашифрован и содержит логины и пароли всех прокси. Не публикуйте файл.';

function downloadJson(text, filename, doc = document) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const anchor = doc.createElement('a');
  anchor.href = url; anchor.download = filename;
  doc.body.append(anchor); anchor.click(); anchor.remove();
  // Keep the object URL alive until the browser has consumed the click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Parent supplies controls; this module never touches the domain/proxy editors.
 * IDs: portable-export/import/file/warning/status. Missing controls are harmless.
 * Returns programmatic handlers and an idempotent destroy() for view teardown. */
export function initPortableSettings({ request, showToast = () => {}, onImported = () => {},
  root = document, confirm = message => globalThis.confirm(message), download = downloadJson } = {}) {
  if (typeof request !== 'function') throw new TypeError('Portable settings request function is required');
  const find = id => root.getElementById?.(id) || root.querySelector?.(`#${id}`);
  const exportButton = find('portable-export'), importButton = find('portable-import'), fileInput = find('portable-file');
  const warning = find('portable-warning'), status = find('portable-status');
  const warningText = t('portable_settings_warning', PORTABLE_SETTINGS_WARNING);
  if (warning) { warning.textContent = warningText; warning.setAttribute?.('role', 'note'); }
  if (status) status.setAttribute?.('role', 'status');
  if (fileInput) fileInput.accept = '.json,application/json';
  let busy = false, destroyed = false;
  const disposers = [];
  function tell(message, error = false) {
    if (status) status.textContent = message;
    showToast(message, error ? 4500 : undefined);
  }
  function setBusy(value) {
    busy = value;
    for (const node of [exportButton, importButton, fileInput]) if (node) node.disabled = value;
  }
  async function run(action) {
    if (busy || destroyed) return;
    setBusy(true);
    try { return await action(); }
    catch { if (!destroyed) tell(t('portable_settings_failed', 'Операция не выполнена. Проверьте файл настроек и повторите попытку.'), true); }
    finally { if (!destroyed) { setBusy(false); if (fileInput) fileInput.value = ''; } }
  }
  const exportSettings = () => run(async () => {
    if (!await confirm(warningText)) return;
    if (destroyed) return;
    const response = await request({ action: 'EXPORT_SETTINGS' });
    if (destroyed) return;
    if (!response?.success || !response.data) throw new Error('Export failed');
    download(`${JSON.stringify(response.data, null, 2)}\n`, 'unroute-settings.json');
    tell(t('portable_settings_exported', 'Резервная копия сохранена. Храните файл с паролями в безопасном месте.'));
    return response.data;
  });
  const importFile = file => run(async () => {
    if (!file) return;
    if (!Number.isFinite(file.size) || file.size > PORTABLE_SETTINGS_MAX_BYTES || file.size < 0) {
      tell(t('portable_settings_too_large', 'Файл настроек слишком большой (максимум 64 МиБ).'), true); return;
    }
    if (!await confirm(`${warningText}\n\n${t('portable_settings_replace_confirm', 'Импорт заменит текущие настройки, прокси и списки. Продолжить?')}`)) return;
    if (destroyed) return;
    const backup = await file.text();
    if (destroyed) return;
    if (!fitsBackupByteLimit(backup)) throw new Error('File too large');
    const response = await request({ action: 'IMPORT_SETTINGS', backup });
    if (destroyed) return;
    if (!response?.success || !response.data?.saved) throw new Error('Import failed');
    const result = response.data;
    tell(result.pending
      ? t('portable_settings_pending', 'Настройки сохранены; применение PAC ожидает повторной попытки.')
      : t('portable_settings_imported', 'Настройки восстановлены и применены.'));
    // Refresh failures must not relabel a durable successful import as failed.
    try { await onImported(result); } catch { /* Parent can offer a page reload. */ }
    return result;
  });
  function listen(node, event, handler) {
    if (!node) return;
    node.addEventListener(event, handler); disposers.push(() => node.removeEventListener(event, handler));
  }
  listen(exportButton, 'click', exportSettings);
  listen(importButton, 'click', () => { if (!busy) fileInput?.click(); });
  listen(fileInput, 'change', () => importFile(fileInput.files?.[0]));
  return { exportSettings, importFile, destroy() {
    if (destroyed) return;
    destroyed = true;
    disposers.splice(0).forEach(dispose => dispose());
    setBusy(false);
    if (fileInput) fileInput.value = '';
  } };
}
