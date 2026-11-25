'use strict';

import { t, localizeDocument } from '../../core/i18n.js';
import { initSettingsHelp, refreshSettingsHelp } from './settings-help.js';
import { initAppearance } from '../shared/appearance.js';
import { initAppearanceControls } from '../shared/appearance-controls.js';

import { initPacPanel } from './pac-panel.js';
import { initPreferencesPanel } from './preferences-panel.js';
import { bindDiagnosticsPanel } from './diagnostics-panel.js';
import { initProxiesPanel } from './proxies-panel.js';
import { initPortableSettings } from './portable-settings.js';
import { initSitesEditor } from './sites-editor.js';
import { initLogsPanel } from './logs-panel.js';
import { initHistoryPanel } from './history-panel.js';
import { initOptionsNavigation } from './navigation.js';
import { createOptionsState } from './options-state.js';

import { FIREFOX_PRIVATE_BROWSING_REQUIRED_ERROR_CODE } from '../../core/errors-lib.js';
import { sendMessage as requestBackground } from '../shared/client.js';

import { renderApplicationBanner } from '../shared/application-banner.js';

initAppearance();
localizeDocument();

/**
 * Settings application for Manifest V3
 */

// State
const appState = {
  syncState: {
    currentPacProviderKey: 'Антизапрет',
    lastPacUpdateStamp: 0,
    isSyncing: false,
    isControlled: false,
    isControllable: false,
    providers: {},
  },
  pacMods: {},
  notifications: {},
  version: '',
  proxyHealthMap: {},
};
let resetBusy = false;
let logsPanel;
let historyPanel;


let proxiesPanel;
let pacPanel;
let preferencesPanel;
let sitesEditor;
let navigation;

function formatVersion(ver) {
  if (!ver) return '';
  let clean = String(ver).replace(/^0\.0\./, '').replace(/^v+/i, '').trim();
  return clean ? `v${clean}` : '';
}

// DOM Elements Cache
const el = {};

function initElements() {
  el.applicationBanner = document.getElementById('applicationBanner');

  el.headerStatus = document.getElementById('headerStatus');
  el.statusText = document.getElementById('statusText');
  el.extVersion = document.getElementById('extVersion');

  el.toast = document.getElementById('toast');
  el.resetSettingsBtn = document.getElementById('resetSettingsBtn');

}

const optionsState = createOptionsState({
  appState, request: requestBackground, render, formatVersion,
  getManifestVersion: () => globalThis.chrome?.runtime?.getManifest?.()?.version || '',
  preloadLogStats: () => logsPanel.load(),
  applySettingsState: state => {
    if (el.applicationBanner) applySettingsState(state);
  },
});
const { sendMessage, refresh: refreshState } = optionsState;

function applySettingsState(state) {
  appState.settingsState = state;
  renderApplicationBanner(el.applicationBanner, state, refreshState);
}

function isPrivateBrowsingPermissionError(value) {
  return Boolean(
    value &&
    (value.errorCode === FIREFOX_PRIVATE_BROWSING_REQUIRED_ERROR_CODE ||
      value.lastErrorCode === FIREFOX_PRIVATE_BROWSING_REQUIRED_ERROR_CODE)
  );
}

function setActionableErrorElement(element, enabled) {
  if (!element) return;
  element.classList.toggle('actionable-error', enabled);
  if (enabled) {
    element.dataset.errorAction = 'open-private-browsing-settings';
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
    refreshSettingsHelp(element);
    return;
  }
  delete element.dataset.errorAction;
  element.removeAttribute('role');
  element.removeAttribute('tabindex');
  element.removeAttribute('title');
  element.removeAttribute('aria-description');
}

async function openPrivateBrowsingSettings() {
  showToast(t("msg_opening_extension_management_in_firefox_21563903", "Открываем управление расширением в Firefox…"));
  const response = await sendMessage({ action: 'OPEN_PRIVATE_BROWSING_SETTINGS' });
  if (!response.success) {
    showToast(t("msg_failed_to_open_firefox_settings_sub_e16cbef9", "Не удалось открыть настройки Firefox: $1", [response.error || t("msg_failed_b15413de", "сбой")]), 4500);
  }
}

// Toast notification
let toastTimer = null;
let toastAction = null;
function showToast(text, duration = 2400, action = null) {
  if (!el.toast) return;
  toastAction = typeof action === 'function' ? action : null;
  setActionableErrorElement(el.toast, Boolean(toastAction));
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('show');
    toastAction = null;
    setActionableErrorElement(el.toast, false);
  }, duration);
}

function showResponseError(response, {
  prefix = t("msg_error_37eceb9f", "Ошибка: "),
  fallback = t("msg_failed_4bdba3ac", "Сбой"),
  duration = 2400,
} = {}) {
  if (response?.stale) return;
  const actionable = isPrivateBrowsingPermissionError(response);
  const suffix = actionable
    ? t("msg_click_to_open_firefox_permissions_3bee63f9", " Нажмите, чтобы открыть разрешения Firefox.")
    : '';
  if (actionable) {
    appState.syncState.lastError = response.error || fallback;
    appState.syncState.lastErrorCode = response.errorCode;
  }
  showToast(
    `${prefix}${response?.error || fallback}${suffix}`,
    actionable ? Math.max(duration, 8000) : duration,
    actionable ? openPrivateBrowsingSettings : null
  );
}





function createProxiesPanel() {
  return initProxiesPanel(document, {
    appState, sendMessage, refreshState,
    invalidateStateRead: optionsState.invalidateRead,
    getResetGeneration: optionsState.getResetGeneration,
    isResetBusy: () => resetBusy,
    showToast, showResponseError, isPrivateBrowsingPermissionError, setActionableErrorElement,
    onWarningAction: event => activateActionableError(event, openPrivateBrowsingSettings),
    onSitesChanged: () => sitesEditor?.refresh(),
    onMutationSettled: optionsState.resumeExternalRefresh,
  });
}

function createPacPanel() {
  return initPacPanel(document, {
    getSyncState: () => appState.syncState,
    setSyncState: optionsState.setSyncState,
    sendMessage, showToast, showResponseError, render,
    hasAnyWorkingProxy: () => proxiesPanel.hasAnyWorkingProxy(),
  });
}

function createPreferencesPanel() {
  return initPreferencesPanel(document, {
    appState, sendMessage, showToast, showResponseError,
    isResetBusy: () => resetBusy,
    invalidateStateRead: optionsState.invalidateRead,
    onModifiersSettled: () => proxiesPanel.renderList(),
  });
}

function activateActionableError(event, action) {
  if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') {
    return;
  }
  event.preventDefault();
  action();
}

// Render State
function render() {
  const { syncState, version } = appState;

  if (el.extVersion) {
    el.extVersion.textContent = formatVersion(version);
  }

  // Header status pill
  if (el.headerStatus && el.statusText) {
    if (appState.settingsState?.pending) {
      el.headerStatus.className = 'status-pill warning';
      el.statusText.textContent = t("msg_not_applied_09415f65", "Не применено");
    } else if (syncState.currentPacProviderKey === 'none') {
      el.headerStatus.className = 'status-pill inactive';
      el.statusText.textContent = t("msg_disabled_3e958000", "Отключено");
    } else if (!syncState.isControlled) {
      el.headerStatus.className = 'status-pill warning';
      el.statusText.textContent = t("msg_no_control_cce05ad1", "Нет контроля");
    } else {
      el.headerStatus.className = 'status-pill active';
      el.statusText.textContent = t("msg_working_0232a305", "Работает");
    }
  }

  pacPanel.render();
  preferencesPanel.render();
  proxiesPanel.render();
}



// Event Listeners
function setupEvents() {
  historyPanel = initHistoryPanel(document, { request: sendMessage, notify: showToast, afterUndo: refreshState });
  proxiesPanel.bindEvents();

  if (el.toast) {
    const activateToast = (event) => {
      if (!toastAction) return;
      activateActionableError(event, toastAction);
    };
    el.toast.addEventListener('click', activateToast);
    el.toast.addEventListener('keydown', activateToast);
  }

  navigation = initOptionsNavigation(document, {
    flushSites: () => sitesEditor.flush(),
    onActivate: tabKey => {
      if (tabKey === 'exceptions') sitesEditor.activate();
      if (tabKey === 'logs') logsPanel.load();
      if (tabKey === 'history') historyPanel.load();
    },
  });

  pacPanel.bindEvents();
  preferencesPanel.bindEvents();

  const diagnosticsPanel = bindDiagnosticsPanel(document, { request: sendMessage });

  // Diagnostics: Reset Settings
  if (el.resetSettingsBtn) {
    el.resetSettingsBtn.addEventListener('click', async () => {
      if (resetBusy || !confirm(t('msg_reset_all_settings_to_defaults_e8ab9d8b', 'Сбросить все настройки к исходным?'))) return;
      resetBusy = true;
      el.resetSettingsBtn.disabled = true;
      optionsState.invalidateRead();
      showToast(t('msg_resetting_settings_3250682c', 'Сброс настроек...'));
      try {
        const res = await sendMessage({ action: 'RESET_SETTINGS' });
        if (!res.success) { showResponseError(res); return; }
        optionsState.reset();
        navigation.invalidate();

        appState.pacMods = {}; appState.proxyHealthMap = {}; appState.notifications = {};
        appState.syncState = { currentPacProviderKey: 'none', providers: {} };
        applySettingsState(res.settingsState || null);
        pacPanel.reset();
        diagnosticsPanel.reset();
        proxiesPanel.reset();
        sitesEditor.reset();
        historyPanel.reset();
        logsPanel.reset();
        render();
        const loaded = await refreshState();
        await sitesEditor.refresh();
        showToast(loaded ? t('msg_settings_reset_78395c27', 'Настройки сброшены!')
          : t('optionsResetReadbackFailed', 'Настройки сброшены, но не удалось обновить данные. Обновите страницу.'));
      } catch (error) {
        showResponseError({ error: error.message });
      } finally {
        resetBusy = false; el.resetSettingsBtn.disabled = false;
        optionsState.resumeExternalRefresh();
      }
    });
  }

}

// Bootstrap
async function initApp() {
  initElements();
  proxiesPanel = createProxiesPanel();
  pacPanel = createPacPanel();
  preferencesPanel = createPreferencesPanel();
  logsPanel = initLogsPanel(document, { request: sendMessage, showToast });
  initAppearanceControls(document.getElementById('appearanceSettings'));
  initSettingsHelp();
  sitesEditor = initSitesEditor(document.getElementById('tab-exceptions'), {
    notify: showToast,
    navigate: section => navigation.open(section),
    onApplicationState: state => {
      if (state) optionsState.publishSettingsState(state);
    },
  });
  setupEvents();
  initPortableSettings({ request: sendMessage, showToast,
    onImported: () => { location.reload(); } });
  render(); // Instant 0ms UI render before async network/storage calls
  const loaded = await refreshState({ preloadLogs: true });
  if (!loaded && el.headerStatus && el.statusText) {
    el.headerStatus.className = 'status-pill error';
    el.statusText.textContent = t("msg_no_connection_9f0c20cc", "Нет связи");
  }
  navigation.restore(location.hash);
  optionsState.watchExternal({
    document, changesEvent: chrome.storage?.onChanged, sitesEditor,
    isBusy: () => resetBusy || proxiesPanel.isBusy(),
    isResetBusy: () => resetBusy,
    isSitesActive: () => navigation.activeTab === 'exceptions',
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
