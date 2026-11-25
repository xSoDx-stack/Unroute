import { t } from '../../core/i18n.js';
import { copyText, renderLogsView } from './logs-view.js';

const initialState = () => ({ category: 'all', level: 'all', search: '', items: [], stats: {} });

export function initLogsPanel(root, { request, showToast }) {
  const el = {};
  el.logsNavBadge = root.getElementById('logsNavBadge');
  el.logsTotalCountPill = root.getElementById('logsTotalCountPill');
  el.logsFilterBtns = root.querySelectorAll('.log-filter-btn');
  el.categoryCounts = [...el.logsFilterBtns].map(button => [button.dataset.category, button.querySelector('.filter-count')]);
  el.logsLevelSelect = root.getElementById('logsLevelSelect');
  el.logsSearchInput = root.getElementById('logsSearchInput');
  el.clearLogsSearchBtn = root.getElementById('clearLogsSearchBtn');
  el.refreshLogsBtn = root.getElementById('refreshLogsBtn');
  el.copyLogsBtn = root.getElementById('copyLogsBtn');
  el.exportLogsBtn = root.getElementById('exportLogsBtn');
  el.clearLogsBtn = root.getElementById('clearLogsBtn');
  el.logsContainer = root.getElementById('logsContainer');

  let state = initialState();
  let loadRevision = 0;
  let searchDebounce = null;
  const filters = () => ({ category: state.category, level: state.level, search: state.search });

  async function loadLogs({ refresh = false } = {}) {
    clearTimeout(searchDebounce);
    const revision = ++loadRevision;
    const res = await request({
      action: 'GET_LOGS',
      ...filters(),
      limit: 150,
    });
    if (res.stale || revision !== loadRevision) return;

    if (res.success && Array.isArray(res.data?.logs)) {
      state.items = res.data.logs;
      state.stats = res.data.stats || {};
      renderLogs();
      if (refresh) showToast(t("msg_log_refreshed_3e3abc85", "Список логов обновлён"));
    } else if (refresh) {
      showToast(t("logs_refresh_failed", "Не удалось обновить журнал"));
    }
  }

  function renderLogs() { renderLogsView(el, state, showToast); }

  async function handleExportLogs(copy) {
    const session = state;
    const res = await request({ action: 'EXPORT_LOGS', ...filters() });
    if (res.stale || state !== session) return;
    const { text, count } = res.data ?? {};
    if (!res.success || !Number.isInteger(count) || count < 0 || typeof text !== 'string' || (count > 0 && !text)) {
      showToast(t("logs_export_failed", "Не удалось подготовить записи журнала"));
      return;
    }
    if (count === 0) {
      showToast(t("logs_no_matching_entries", "Нет записей по выбранным фильтрам"));
      return;
    }
    if (copy) {
      try {
        await copyText(text);
        if (state === session) showToast(t("msg_logs_copied_to_the_clipboard_b2eb247a", "✓ Логи скопированы в буфер обмена!"));
      } catch {
        if (state === session) showToast(t("msg_failed_to_copy_to_the_clipboard_2da3371a", "Не удалось скопировать в буфер обмена"));
      }
      return;
    }

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `unroute-logs-${dateStr}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(t("msg_log_file_exported_4f456a34", "✓ Файл логов успешно выгружен!"));
  }

  async function handleClearLogs() {
    if (!confirm(t("msg_clear_the_entire_error_log_f2d35721", "Очистить весь журнал ошибок и сбоев?"))) return;
    const session = state;
    const res = await request({ action: 'CLEAR_LOGS' });
    if (res.stale || state !== session) return;
    if (res.success) {
      ++loadRevision;
      state.items = [];
      state.stats = res.data?.stats || {};
      renderLogs();
      showToast(t("msg_log_cleared_8c011aaf", "Журнал логов очищен"));
    }
  }

  function reset() {
    ++loadRevision;
    clearTimeout(searchDebounce);
    state = initialState();
    el.logsSearchInput.value = '';
    el.clearLogsSearchBtn.style.display = 'none';
    if (el.logsLevelSelect) el.logsLevelSelect.value = state.level;
    selectCategory('all');
    renderLogs();
  }

  function selectCategory(category) {
    state.category = category;
    el.logsFilterBtns.forEach(button => {
      const selected = button.dataset.category === category;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  // Logs Tab: Category Filters
  if (el.logsFilterBtns) {
    el.logsFilterBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        selectCategory(btn.dataset.category || 'all');
        loadLogs();
      });
    });
  }

  if (el.logsLevelSelect) {
    el.logsLevelSelect.value = state.level;
    el.logsLevelSelect.addEventListener('change', () => {
      state.level = el.logsLevelSelect.value;
      loadLogs();
    });
  }

  // Logs Tab: Search Input & Clear
  // Debounce belongs to the resettable UI session.
  if (el.logsSearchInput) {
    el.logsSearchInput.addEventListener('input', () => {
      const val = (el.logsSearchInput.value || '').trim();
      state.search = val;
      ++loadRevision;
      if (el.clearLogsSearchBtn) {
        el.clearLogsSearchBtn.style.display = val ? 'block' : 'none';
      }
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        loadLogs();
      }, 250);
    });
  }

  if (el.clearLogsSearchBtn && el.logsSearchInput) {
    el.clearLogsSearchBtn.addEventListener('click', () => {
      el.logsSearchInput.value = '';
      state.search = '';
      el.clearLogsSearchBtn.style.display = 'none';
      loadLogs();
    });
  }

  // Logs Tab: Action Buttons
  if (el.refreshLogsBtn) {
    el.refreshLogsBtn.addEventListener('click', () => loadLogs({ refresh: true }));
  }

  if (el.copyLogsBtn) {
    el.copyLogsBtn.addEventListener('click', () => handleExportLogs(true));
  }

  if (el.exportLogsBtn) {
    el.exportLogsBtn.addEventListener('click', () => handleExportLogs(false));
  }

  if (el.clearLogsBtn) {
    el.clearLogsBtn.addEventListener('click', handleClearLogs);
  }

  return { load: loadLogs, reset };
}
