'use strict';

import { t } from '../../core/i18n.js';

export function sendMessage(message) {
  return new Promise(resolve => chrome.runtime.sendMessage(message, response => {
    const error = chrome.runtime.lastError;
    resolve(error ? { success: false, error: error.message } : response || { success: false, error: t("msg_no_response_from_the_background_process_1efd4dd6", "Нет ответа фонового процесса") });
  })).catch(error => ({ success: false, error: error.message }));
}

export function openSettings(section = 'exceptions') {
  chrome.tabs.create({ url: chrome.runtime.getURL(`pages/options/index.html#${section}`) });
}
