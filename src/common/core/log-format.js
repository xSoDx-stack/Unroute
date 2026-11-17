'use strict';

import { t, uiLocale } from './i18n.js';

export function formatLogEntryForClipboard(log, detailsText = '') {
  const date = new Date(log.timestamp);
  const lines = [
    `[${date.toLocaleString(uiLocale())}] [${String(log.level || 'error').toUpperCase()}] [${String(log.category || 'system').toUpperCase()}]`,
    log.title || t("msg_unknown_error_2d55ddef", "Неизвестная ошибка"),
  ];
  if (log.message) lines.push(log.message);
  if (detailsText) lines.push(detailsText);
  if (log.count > 1) lines.push(t("msg_repeated_sub_b45a9140", "Повторено: $1", [log.count]));
  return lines.join('\n');
}
