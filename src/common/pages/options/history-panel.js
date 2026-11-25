import { t } from '../../core/i18n.js';
import { invalidateHistory, renderHistory } from '../shared/history.js';

export function initHistoryPanel(root, { request, notify, afterUndo }) {
  const container = root.getElementById('historyList');
  const load = () => renderHistory(container, notify, afterUndo);

  root.getElementById('clearHistoryBtn').addEventListener('click', async () => {
    if (!root.defaultView.confirm(t("msg_delete_change_history_rules_and_do_not_add_au_f947995e", "Удалить историю изменений? Правила и отметки «не добавлять автоматически» сохранятся."))) return;
    const response = await request({ action: 'CLEAR_RULE_HISTORY' });
    if (response.stale) return;
    notify(response.success ? t("msg_history_deleted_57e6da69", "История удалена") : response.error);
    await load();
  });

  return { load, reset: () => invalidateHistory(container) };
}
