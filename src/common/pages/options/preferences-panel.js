import { t } from '../../core/i18n.js';

export function initPreferencesPanel(root, {
  appState, sendMessage, showToast, showResponseError,
  isResetBusy, invalidateStateRead, onModifiersSettled,
}) {
  const el = {};
  // Modifiers
  el.httpsOnlyToggle = root.getElementById('httpsOnlyToggle');
  el.secureProxiesOnlyToggle = root.getElementById('secureProxiesOnlyToggle');
  el.prohibitDnsToggle = root.getElementById('prohibitDnsToggle');
  el.proxyOrDieToggle = root.getElementById('proxyOrDieToggle');
  el.moreDomainsToggle = root.getElementById('moreDomainsToggle');
  // Notifications
  el.notifPacErrorToggle = root.getElementById('notifPacErrorToggle');
  el.notifExtErrorToggle = root.getElementById('notifExtErrorToggle');
  el.notifNoControlToggle = root.getElementById('notifNoControlToggle');

  function render() {
    const { pacMods, notifications } = appState;
    // Modifiers
    if (el.httpsOnlyToggle) el.httpsOnlyToggle.checked = Boolean(pacMods.ifProxyHttpsUrlsOnly);
    if (el.secureProxiesOnlyToggle) el.secureProxiesOnlyToggle.checked = Boolean(pacMods.ifUseSecureProxiesOnly);
    if (el.prohibitDnsToggle) el.prohibitDnsToggle.checked = Boolean(pacMods.ifProhibitDns);
    if (el.proxyOrDieToggle) el.proxyOrDieToggle.checked = pacMods.ifProxyOrDie !== false;
    if (el.moreDomainsToggle) el.moreDomainsToggle.checked = Boolean(pacMods.ifProxyMoreDomains);

    // Notifications
    if (el.notifPacErrorToggle) el.notifPacErrorToggle.checked = notifications['pac-error'] !== false;
    if (el.notifExtErrorToggle) el.notifExtErrorToggle.checked = notifications['ext-error'] !== false;
    if (el.notifNoControlToggle) el.notifNoControlToggle.checked = notifications['no-control'] !== false;
  }

  function bindEvents() {
    // Modifiers: Instant Autosave on change
    const bindModToggle = (element, key) => {
      if (!element) return;
      element.addEventListener('change', async () => {
        const mods = {
          [key]: Boolean(element.checked),
        };

        if (element.disabled || isResetBusy()) return;
        element.disabled = true;
        invalidateStateRead();
        try {
          const res = await sendMessage({ action: 'SAVE_MODS', mods });
          if (res.stale) return;
          if (res.success) {
            appState.pacMods = res.data;
            showToast(appState.settingsState?.pending ? t('msg_saved_waiting_to_apply_cee8b842', 'Сохранено · ожидает применения') : t('msg_settings_saved_dc80b2da', '✓ Настройки сохранены'));
          } else showResponseError(res, { fallback: t('msg_failed_to_save_6d1e3f7c', 'Не удалось сохранить') });
        } catch (error) {
          showResponseError({ error: error.message });
        } finally {
          element.checked = key === 'ifProxyOrDie' ? appState.pacMods[key] !== false : Boolean(appState.pacMods[key]);
          element.disabled = false;
          onModifiersSettled();
        }
      });
    };

    bindModToggle(el.httpsOnlyToggle, 'ifProxyHttpsUrlsOnly');
    bindModToggle(el.secureProxiesOnlyToggle, 'ifUseSecureProxiesOnly');
    bindModToggle(el.prohibitDnsToggle, 'ifProhibitDns');
    bindModToggle(el.proxyOrDieToggle, 'ifProxyOrDie');
    bindModToggle(el.moreDomainsToggle, 'ifProxyMoreDomains');

    // Notifications Toggles
    const bindNotifToggle = (element, key) => {
      if (!element) return;
      element.addEventListener('change', async () => {
        if (element.disabled || isResetBusy()) return;
        const enabled = element.checked;
        element.disabled = true;
        invalidateStateRead();
        try {
          const res = await sendMessage({ action: 'SET_NOTIFICATION_OPTION', key, enabled });
          if (res.stale) return;
          if (res.success) {
            appState.notifications[key] = enabled;
            showToast(t('msg_notification_settings_updated_2669bcf6', 'Оповещения обновлены'));
          } else showResponseError(res);
        } catch (error) {
          showResponseError({ error: error.message });
        } finally {
          element.checked = appState.notifications[key] !== false;
          element.disabled = false;
        }
      });
    };

    bindNotifToggle(el.notifPacErrorToggle, 'pac-error');
    bindNotifToggle(el.notifExtErrorToggle, 'ext-error');
    bindNotifToggle(el.notifNoControlToggle, 'no-control');
  }

  return { render, bindEvents };
}
