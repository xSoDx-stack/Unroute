'use strict';

import { t, localizeDocument } from '../../core/i18n.js';
import { initAppearance } from '../shared/appearance.js';

initAppearance();
localizeDocument();

const statusElement = document.getElementById('permissionStatus');
const openSettingsButton = document.getElementById('openExtensionSettings');
let permissionRevision = 0;

function updatePermissionStatus() {
  const revision = ++permissionRevision;
  const checker = chrome.extension?.isAllowedIncognitoAccess;
  const showError = () => {
    statusElement.classList.remove('allowed', 'denied');
    statusElement.textContent = t('firefoxPermissionCheckFailed', 'Не удалось проверить разрешение.');
  };
  if (typeof checker !== 'function') {
    showError();
    return;
  }

  try {
    checker.call(chrome.extension, (allowed) => {
      const error = chrome.runtime.lastError;
      if (revision !== permissionRevision) return;
      if (error) { showError(); return; }
      statusElement.classList.toggle('allowed', Boolean(allowed));
      statusElement.classList.toggle('denied', !allowed);
      statusElement.textContent = allowed
        ? t('firefoxPermissionAllowed', '✓ Работа в приватных окнах уже разрешена.')
        : t('firefoxPermissionDenied', 'Разрешение пока не выдано.');
    });
  } catch { showError(); }
}

openSettingsButton.addEventListener('click', () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('pages/options/index.html'),
  });
});

window.addEventListener('focus', updatePermissionStatus);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updatePermissionStatus();
});
updatePermissionStatus();
