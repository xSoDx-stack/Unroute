'use strict';

import { t, uiLocale } from '../../core/i18n.js';

import { sendMessage } from './client.js';

const histories = new WeakMap();
function historyState(container) {
  if (!histories.has(container)) histories.set(container, { generation: 0, read: 0 });
  return histories.get(container);
}

export function invalidateHistory(container) {
  if (!container) return;
  const state = historyState(container);
  state.generation++; state.read++;
  container.replaceChildren();
}

const LABELS = { auto: t("msg_automatically_detected_resources_59513472", "Автоматически найденные ресурсы"), site: t("msg_site_mode_switch_0ad4785f", "Переключение сайта"), manual: t("msg_manual_change_e949b5d6", "Ручное изменение"), import: t("msg_rules_imported_4513ec88", "Импорт правил") };
export function historyLabel(item) {
  return `${LABELS[item.source] || t("msg_rule_change_adbe9d5b", "Изменение правил")}${item.site ? ` · ${item.site}` : ''}`;
}

export async function renderHistory(container, notify = () => {}, afterUndo = () => {}) {
  const state = historyState(container);
  const read = ++state.read, generation = state.generation;
  const response = await sendMessage({ action: 'GET_RULE_HISTORY' });
  if (read !== state.read) return;
  container.replaceChildren();
  if (!response.success) { container.textContent = response.error; return; }
  if (!response.data.length) { container.textContent = t("msg_rule_changes_will_appear_here_existing_settin_d9e351cf", "Здесь появятся изменения правил. Старые настройки сохранены."); return; }
  for (const item of response.data) {
    const row = document.createElement('article');
    row.className = 'history-row';
    const description = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = historyLabel(item);
    const detail = document.createElement('small');
    detail.textContent = t("msg_sub_rules_sub_sub_2e625462", "$1 · правил: $2$3", [new Date(item.at).toLocaleString(uiLocale()), item.count, item.undoneAt ? t("msg_undone_c2ac555c", " · отменено") : item.truncated ? t("msg_undo_unavailable_for_a_large_batch_2a4e0aca", " · отмена недоступна для большого пакета") : '']);
    description.append(title, detail);
    const undo = document.createElement('button');
    undo.className = 'btn btn-secondary btn-sm';
    undo.textContent = item.undoneAt ? t("msg_undone_23a2a9bf", "Отменено") : t("msg_undo_7c47f729", "Отменить");
    undo.disabled = Boolean(item.undoneAt || item.truncated);
    undo.addEventListener('click', async () => {
      if (read !== state.read || generation !== state.generation) return;
      undo.disabled = true;
      const result = await sendMessage({ action: 'UNDO_RULE_CHANGE', id: item.id });
      if (generation !== state.generation) return;
      notify(result.success ? t("msg_restored_sub_later_edits_retained_sub_2419a5d4", "Восстановлено: $1. Последующих правок сохранено: $2.", [result.data.restored, result.data.skipped]) : result.error);
      await renderHistory(container, notify, afterUndo);
      if (generation !== state.generation) return;
      await afterUndo();
    });
    row.append(description, undo);
    container.append(row);
  }
}
