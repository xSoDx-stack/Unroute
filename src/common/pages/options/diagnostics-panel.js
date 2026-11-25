import { t } from '../../core/i18n.js';

export function bindDiagnosticsPanel(root, { request }) {
  const el = {};
  el.testConnBtn = root.getElementById('testConnBtn');
  el.connResult = root.getElementById('connResult');

  el.viewPacScriptBtn = root.getElementById('viewPacScriptBtn');
  el.pacScriptModal = root.getElementById('pacScriptModal');
  el.pacScriptContent = root.getElementById('pacScriptContent');
  el.closePacModalBtn = root.getElementById('closePacModalBtn');
  let generation = 0;

  // Diagnostics: Test Connection
  if (el.testConnBtn && el.connResult) {
    el.testConnBtn.addEventListener('click', async () => {
      if (el.testConnBtn.disabled) return;
      const current = generation;
      el.testConnBtn.disabled = true;
      el.connResult.textContent = t("msg_testing_f7c8f44d", "Тестирование...");
      const res = await request({ action: 'TEST_CONNECTION' });
      if (current !== generation) return;
      el.testConnBtn.disabled = false;
      if (res.stale) return;
      el.connResult.textContent = '';
      const span = root.createElement('span');
      if (res.success) {
        span.style.color = 'var(--success)';
        span.textContent = t("msg_available_sub_ms_98493bf5", "✓ Доступно ($1 мс)", [res.latency]);
      } else {
        span.style.color = 'var(--danger)';
        span.textContent = t("msg_error_sub_f9b87abd", "✕ Ошибка ($1)", [res.error || t("msg_failed_4bdba3ac", "Сбой")]);
      }
      el.connResult.appendChild(span);
    });
  }

  // Diagnostics: View PAC Script Modal
  if (el.viewPacScriptBtn && el.pacScriptModal && el.pacScriptContent) {
    el.viewPacScriptBtn.addEventListener('click', async () => {
      const current = generation;
      const res = await request({ action: 'GET_PAC_SCRIPT' });
      if (current !== generation || res.stale || el.pacScriptModal.open) return;
      if (res.success && res.data) {
        const label = res.data.scriptKind === 'applied' ? t("msg_pac_installed_in_the_browser_b3a5d782", "// PAC, установленный в браузере") :
          res.data.scriptKind === 'preview' ? t("msg_preview_of_saved_settings_application_has_not_e210f47a", "// Предпросмотр по сохранённым настройкам; применение не подтверждено") : t("msg_no_pac_script_installed_b4950c71", "// PAC-скрипт не установлен");
        el.pacScriptContent.textContent = `${label}\n${res.data.cookedPacData || ''}`;
        el.pacScriptModal.showModal();
      }
    });

    if (el.closePacModalBtn) {
      el.closePacModalBtn.addEventListener('click', () => {
        el.pacScriptModal.close();
      });
    }
  }
  return { reset() {
    ++generation;
    if (el.connResult) el.connResult.textContent = '';
    if (el.testConnBtn) el.testConnBtn.disabled = false;
    if (el.pacScriptModal?.open) el.pacScriptModal.close();
    if (el.pacScriptContent) el.pacScriptContent.textContent = '';
  } };
}
