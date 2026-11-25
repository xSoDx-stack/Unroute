'use strict';

import { t } from '../../core/i18n.js';

import { sendMessage } from './client.js';

export function renderApplicationBanner(container, state, refresh) {
  container.hidden = !state?.pending || Boolean(state.applying);
  container.replaceChildren();
  if (container.hidden) return;
  const text = document.createElement('span');
  text.textContent = t("msg_settings_are_saved_but_have_not_been_applied__7dcb3526", "Настройки сохранены, но ещё не применены.$1", [state.error ? ` ${state.error}` : '']);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-secondary btn-sm';
  const retryLabel = t("msg_apply_again_4548c504", "Применить снова");
  button.textContent = retryLabel;
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = t("msg_applying_b001f5d8", "Применяем…");
    try {
      await sendMessage({ action: 'RETRY_SETTINGS_APPLY' });
      await refresh();
    } catch (error) {
      console.warn('[Settings] Could not refresh application status:', error.message);
    } finally {
      button.disabled = false;
      button.textContent = retryLabel;
    }
  });
  container.append(text, button);
}
