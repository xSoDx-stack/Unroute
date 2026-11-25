'use strict';

import { t } from './i18n.js';
import { addBrowserListener, callBrowserMethod } from './browser-api.js';

function callProxySetting(method, details) {
  return callBrowserMethod(chrome.proxy?.settings, method, [details], () =>
    t("msg_the_browser_does_not_support_proxy_settings_s_c3082d3d", "Браузер не поддерживает proxy.settings.$1()", [method]));
}

/**
 * Chromium implementation of the profile-wide proxy contract used by the
 * shared application code. The Firefox build replaces this module at build
 * time, so Chromium keeps its native PAC configuration unchanged.
 */
export const proxyBackend = {
  platform: 'chromium',

  async getSettings() {
    return callProxySetting('get', {});
  },

  async applyPac(pacData, { mandatory = false } = {}) {
    await callProxySetting('set', {
      value: {
        mode: 'pac_script',
        pacScript: {
          data: pacData,
          mandatory: Boolean(mandatory),
        },
      },
      scope: 'regular',
    });
  },

  async clear() {
    await callProxySetting('clear', { scope: 'regular' });
  },

  async restore(details) {
    if (details?.levelOfControl === 'controlled_by_this_extension' && details.value) {
      await callProxySetting('set', {
        value: details.value,
        scope: 'regular',
      });
      return;
    }
    await this.clear();
  },

  isExpectedPacApplied(details, pacData) {
    return Boolean(
      details &&
      details.value &&
      details.value.mode === 'pac_script' &&
      details.value.pacScript &&
      details.value.pacScript.data === pacData
    );
  },

  addSettingsChangeListener(listener) {
    return addBrowserListener(chrome.proxy?.settings?.onChange, listener);
  },

  addErrorListener(listener) {
    return addBrowserListener(chrome.proxy?.onProxyError, listener);
  },

  async getCapabilities() {
    return {
      platform: this.platform,
      canApplyPac: true,
      requiresPrivateBrowsing: false,
      privateBrowsingAllowed: true,
    };
  },
};
