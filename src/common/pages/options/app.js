'use strict';

import { t, uiLocale, localizeDocument } from '../../core/i18n.js';
import { initSettingsHelp, refreshSettingsHelp } from './settings-help.js';
import { initAppearance } from '../shared/appearance.js';
import { initAppearanceControls } from '../shared/appearance-controls.js';

import { utils, parseCustomProxies, parseProxyHostInput, proxyEndpointKey } from '../../core/utils.js';
import { MAX_PROXY_NAME_LENGTH, proxyNameLength } from '../../core/proxy-profiles.js';
import { initSitesEditor } from './sites-editor.js';
import { copyText, renderLogsView } from './logs-view.js';

import { FIREFOX_PRIVATE_BROWSING_REQUIRED_ERROR_CODE } from '../../core/errors-lib.js';
import { sendMessage as requestBackground } from '../shared/client.js';

import { renderHistory, invalidateHistory } from '../shared/history.js';
import { renderApplicationBanner } from '../shared/application-banner.js';

initAppearance();
localizeDocument();

/**
 * Settings application for Manifest V3
 */

// Single source of truth for fallback version placeholder
const DEFAULT_VERSION = '';
const PROXY_HEALTH_FRESH_MS = 15 * 60 * 1000;
const PAC_MODS_STORAGE_KEY = 'pac-kitchen-mods';
const PROXY_HEALTH_STORAGE_KEY = 'proxy-health-cache';

// State
let appState = {
  syncState: {
    currentPacProviderKey: 'Антизапрет',
    lastPacUpdateStamp: 0,
    isSyncing: false,
    isControlled: false,
    isControllable: false,
    providers: {},
  },
  pacMods: {},
  defaultConfigs: {},
  notifications: {},
  lastErrors: [],
  version: DEFAULT_VERSION,
  activeTab: 'exceptions',

  proxyHealthMap: {},
  logsState: {
    category: 'all',
    search: '',
    items: [],
    stats: {},
  },
};
let stateLoadRevision = 0;
let resetGeneration = 0;
let resetBusy = false;
let logsLoadRevision = 0;
let logsSearchDebounce = null;

let externalStateRefreshTimer = null;
let externalRefreshPending = false;
let proxyAddBusy = false;
let proxyProfileBusy = false;
const proxyProfileDrafts = new Map();
let proxyTextDirty = false;
let sitesEditor;
let navigationRevision = 0;
let proxyTextBase = '';

function updateProxyDraftHint() {
  const hint = document.getElementById('proxyDraftHint');
  const conflict = proxyTextDirty && proxyTextBase !== (appState.pacMods.customProxyStringRaw || '');
  const text = conflict ? t("msg_the_saved_list_has_changed_your_draft_has_not_36e48c20", "Сохранённый список изменился. Ваш текст ещё не применён; «Применить» заменит список.") :
    proxyTextDirty ? t("msg_not_saved_apply_will_replace_the_entire_proxy_e8c154bc", "Не сохранено. «Применить» заменит весь список прокси.") : t("msg_use_apply_to_save_changes_to_this_list_278f74a1", "Изменения списка применяются кнопкой «Применить».");
  if (hint.textContent !== text) hint.textContent = text;
}

function formatVersion(ver) {
  if (!ver) return DEFAULT_VERSION ? `v${DEFAULT_VERSION}` : '';
  let clean = String(ver).replace(/^0\.0\./, '').replace(/^v+/i, '').trim();
  return clean ? `v${clean}` : '';
}

// DOM Elements Cache
const el = {};

function initElements() {
  el.applicationBanner = document.getElementById('applicationBanner');
  el.historyList = document.getElementById('historyList');
  el.headerStatus = document.getElementById('headerStatus');
  el.statusText = document.getElementById('statusText');
  el.extVersion = document.getElementById('extVersion');
  el.syncDate = document.getElementById('syncDate');
  el.syncBtn = document.getElementById('syncBtn');
  el.syncBtnIcon = document.getElementById('syncBtnIcon');
  el.toast = document.getElementById('toast');
  el.navTabs = document.querySelectorAll('.nav-tab-btn');
  el.tabContents = document.querySelectorAll('.tab-content');
  el.providerCards = document.querySelectorAll('.provider-card');
  el.customPacUrlBox = document.getElementById('customPacUrlBox');
  el.customPacUrlInput = document.getElementById('customPacUrlInput');
  el.saveCustomPacUrlBtn = document.getElementById('saveCustomPacUrlBtn');
  el.homeProxyWarningBanner = document.getElementById('homeProxyWarningBanner');
  el.homeProxyWarningText = document.getElementById('homeProxyWarningText');
  // Own Proxies Form & Controls
  el.proxyFormView = document.getElementById('proxyFormView');
  el.proxyRawView = document.getElementById('proxyRawView');
  el.proxyEditorModeToggle = document.getElementById('proxyEditorModeToggle');
  el.proxyFormAlert = document.getElementById('proxyFormAlert');
  el.proxyFormAlertText = document.getElementById('proxyFormAlertText');
  el.proxyName = document.getElementById('proxyName');
  initProxyNameInput(el.proxyName);
  el.defaultProxySelect = document.getElementById('defaultProxySelect');
  el.proxyProtocol = document.getElementById('proxyProtocol');
  el.proxyHost = document.getElementById('proxyHost');
  el.proxyPort = document.getElementById('proxyPort');
  el.authSectionWrapper = document.getElementById('authSectionWrapper');
  el.proxyAuthCheck = document.getElementById('proxyAuthCheck');
  el.proxyAuthFields = document.getElementById('proxyAuthFields');
  el.proxyUser = document.getElementById('proxyUser');
  el.proxyPass = document.getElementById('proxyPass');
  el.socksNotice = document.getElementById('socksNotice');
  el.addProxyBtn = document.getElementById('addProxyBtn');
  el.addProxyBtnIcon = document.getElementById('addProxyBtnIcon');
  el.addProxyBtnText = document.getElementById('addProxyBtnText');
  el.recheckAllProxiesBtn = document.getElementById('recheckAllProxiesBtn');
  el.proxyCardsList = document.getElementById('proxyCardsList');
  el.customProxyText = document.getElementById('customProxyText');
  el.saveProxiesBtn = document.getElementById('saveProxiesBtn');
  el.torToggle = document.getElementById('torToggle');
  el.warpToggle = document.getElementById('warpToggle');
  el.ownOnlyToggle = document.getElementById('ownOnlyToggle');
  // Modifiers
  el.httpsOnlyToggle = document.getElementById('httpsOnlyToggle');
  el.secureProxiesOnlyToggle = document.getElementById('secureProxiesOnlyToggle');
  el.prohibitDnsToggle = document.getElementById('prohibitDnsToggle');
  el.proxyOrDieToggle = document.getElementById('proxyOrDieToggle');
  el.moreDomainsToggle = document.getElementById('moreDomainsToggle');
  // Notifications
  el.notifPacErrorToggle = document.getElementById('notifPacErrorToggle');
  el.notifExtErrorToggle = document.getElementById('notifExtErrorToggle');
  el.notifNoControlToggle = document.getElementById('notifNoControlToggle');
  // Diagnostics
  el.testConnBtn = document.getElementById('testConnBtn');
  el.connResult = document.getElementById('connResult');

  el.viewPacScriptBtn = document.getElementById('viewPacScriptBtn');
  el.pacScriptModal = document.getElementById('pacScriptModal');
  el.pacScriptContent = document.getElementById('pacScriptContent');
  el.closePacModalBtn = document.getElementById('closePacModalBtn');
  el.resetSettingsBtn = document.getElementById('resetSettingsBtn');
  // Logs Tab
  el.logsNavBadge = document.getElementById('logsNavBadge');
  el.logsTotalCountPill = document.getElementById('logsTotalCountPill');
  el.logsFilterBtns = document.querySelectorAll('.log-filter-btn');
  el.countNetwork = document.getElementById('countNetwork');
  el.countProxy = document.getElementById('countProxy');
  el.countPac = document.getElementById('countPac');
  el.countAuth = document.getElementById('countAuth');
  el.countSystem = document.getElementById('countSystem');
  el.logsSearchInput = document.getElementById('logsSearchInput');
  el.clearLogsSearchBtn = document.getElementById('clearLogsSearchBtn');
  el.refreshLogsBtn = document.getElementById('refreshLogsBtn');
  el.copyLogsBtn = document.getElementById('copyLogsBtn');
  el.exportLogsBtn = document.getElementById('exportLogsBtn');
  el.clearLogsBtn = document.getElementById('clearLogsBtn');
  el.logsContainer = document.getElementById('logsContainer');
}

// Messaging helper
async function sendMessage(message) {
  const readRevision = stateLoadRevision;
  const generation = resetGeneration;
  const response = await requestBackground(message).catch(error => ({ success: false, error: error.message }));
  if (generation !== resetGeneration) return { success: false, stale: true };
  if (response.settingsState && el.applicationBanner &&
      (message.action !== 'GET_STATE' || readRevision === stateLoadRevision)) {
    appState.settingsState = response.settingsState;
    renderApplicationBanner(el.applicationBanner, response.settingsState, refreshState);
  }
  return response;
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





// Check if any custom proxies / Tor / WARP are configured

// Render Current Active Site Widget

// Check if at least one proxy / tor / warp is working
function hasAnyWorkingProxy() {
  const tor = Boolean(appState.pacMods?.ifUseLocalTor);
  const warp = Boolean(appState.pacMods?.ifUseLocalWarp);
  if (tor || warp) return true;

  const customList = parseCustomProxies(appState.pacMods?.customProxyStringRaw || '');
  if (!customList.length) return false;

  return customList.some((p) => {
    const st = appState.proxyHealthMap[p.raw];
    if (!st || st.checking) return true;
    if (!isProxyHealthFresh(st)) return true;
    return st.ok === true;
  });
}

function isProxyHealthFresh(health, now = Date.now()) {
  const checkedAt = Number(health?.checkedAt);
  return Number.isFinite(checkedAt) && checkedAt > 0 && now - checkedAt <= PROXY_HEALTH_FRESH_MS;
}

// Check Health of a Single Proxy
async function checkProxyAvailability(proxyRaw) {
  appState.proxyHealthMap[proxyRaw] = Object.assign(
    {},
    appState.proxyHealthMap[proxyRaw],
    { checking: true },
  );
  renderCustomProxiesList();
  updateHomeWarning();

  const res = await sendMessage({ action: 'CHECK_PROXY_HEALTH', proxy: proxyRaw });
  if (res.stale) return;
  if (res.success && res.data) {
    appState.proxyHealthMap[proxyRaw] = {
      checking: false,
      ok: res.data.ok,
      latency: res.data.latency,
      error: res.data.error,
      checkedAt: res.data.checkedAt,
    };
  } else {
    appState.proxyHealthMap[proxyRaw] = {
      checking: false,
      ok: false,
      error: res.error || t("msg_check_failed_4e395375", "Ошибка проверки"),
      checkedAt: Date.now(),
    };
  }

  renderCustomProxiesList();
  updateHomeWarning();
  return appState.proxyHealthMap[proxyRaw];
}

// Check Health of All Configured Proxies
async function checkAllProxiesHealth() {
  const generation = resetGeneration;
  const customList = parseCustomProxies(appState.pacMods.customProxyStringRaw);
  if (!customList.length) {
    updateHomeWarning();
    return;
  }

  for (const proxy of customList) {
    await checkProxyAvailability(proxy.raw);
    if (generation !== resetGeneration) return false;
  }
  return true;
}

// Update Home Page Warning Banner if proxies are dead
function updateHomeWarning() {
  if (!el.homeProxyWarningBanner) return;

  setActionableErrorElement(el.homeProxyWarningBanner, false);
  const syncError = appState.syncState && appState.syncState.lastError;
  if (syncError) {
    const actionable = isPrivateBrowsingPermissionError(appState.syncState);
    setActionableErrorElement(el.homeProxyWarningBanner, actionable);
    el.homeProxyWarningBanner.style.display = 'flex';
    el.homeProxyWarningText.textContent = actionable
      ? t("msg_failed_to_apply_pac_sub_click_to_open_firefox_a5c7c194", "Не удалось применить PAC: $1 Нажмите, чтобы открыть разрешения Firefox.", [syncError])
      : t("msg_failed_to_apply_pac_sub_905498f4", "Не удалось применить PAC: $1", [syncError]);
    return;
  }

  const customList = parseCustomProxies(appState.pacMods.customProxyStringRaw);
  if (!customList.length) {
    el.homeProxyWarningBanner.style.display = 'none';
    return;
  }

  const deadProxies = customList.filter((p) => {
    const status = appState.proxyHealthMap[p.raw];
    return status && status.ok === false && !status.checking && isProxyHealthFresh(status);
  });

  if (deadProxies.length > 0) {
    el.homeProxyWarningBanner.style.display = 'flex';
    if (deadProxies.length === customList.length) {
      el.homeProxyWarningText.textContent = t("msg_warning_all_your_proxies_sub_are_unavailable_913b09a2", "Внимание: Все ваши прокси ($1) недоступны!", [deadProxies.length]);
    } else {
      el.homeProxyWarningText.textContent = t("msg_warning_sub_of_your_sub_proxies_are_unavailab_17a33ccc", "Внимание: $1 из $2 ваших прокси недоступен.", [deadProxies.length, customList.length]);
    }
  } else {
    el.homeProxyWarningBanner.style.display = 'none';
  }
}

// Update Protocol Controls Visibility
function updateProtocolUI() {
  const proto = (el.proxyProtocol?.value || 'HTTP').toUpperCase();
  const isHttpFamily = proto === 'HTTP' || proto === 'HTTPS';

  if (isHttpFamily) {
    if (el.authSectionWrapper) el.authSectionWrapper.style.display = 'block';
    if (el.socksNotice) el.socksNotice.style.display = 'none';
    if (el.proxyPort && !el.proxyPort.value) {
      el.proxyPort.placeholder = proto === 'HTTP' ? '8080' : '443';
    }
  } else {
    // SOCKS5 or SOCKS4
    if (el.authSectionWrapper) el.authSectionWrapper.style.display = 'none';
    if (el.proxyAuthCheck) el.proxyAuthCheck.checked = false;
    if (el.proxyAuthFields) el.proxyAuthFields.style.display = 'none';
    if (el.socksNotice) el.socksNotice.style.display = 'flex';
    if (el.proxyPort && !el.proxyPort.value) {
      el.proxyPort.placeholder = '1080';
    }
  }
}

// Render State
function render() {
  const { syncState, pacMods, notifications, version } = appState;

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

  // Sync date & loading icon
  if (el.syncDate) {
    if (syncState.lastPacUpdateStamp) {
      const date = new Date(syncState.lastPacUpdateStamp);
      el.syncDate.textContent = date.toLocaleString(uiLocale(), {
        day: 'numeric',
        month: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } else {
      el.syncDate.textContent = t("msg_never_updated_e314a133", "Не обновлялся");
    }
  }

  if (el.syncBtnIcon) {
    if (syncState.isSyncing) {
      el.syncBtnIcon.classList.add('spinning');
      el.syncBtn.disabled = true;
    } else {
      el.syncBtnIcon.classList.remove('spinning');
      el.syncBtn.disabled = false;
    }
  }

  // Selected Provider Radio Card & Individual Provider Update Dates
  const provStamps = syncState.providerUpdateStamps || {};
  const isCustomSelected = (syncState.currentPacProviderKey === 'customPacUrl');
  if (el.customPacUrlBox) {
    el.customPacUrlBox.style.display = isCustomSelected ? 'block' : 'none';
  }
  if (el.customPacUrlInput && syncState.customPacUrl && !el.customPacUrlInput.value) {
    el.customPacUrlInput.value = syncState.customPacUrl;
  }

  el.providerCards.forEach((card) => {
    const provKey = card.dataset.provider;
    const isSelected = provKey === (syncState.currentPacProviderKey || 'none');
    card.classList.toggle('selected', isSelected);
    const radio = card.querySelector('input[type="radio"]');
    if (radio) radio.checked = isSelected;

    const dateEl = card.querySelector('[data-provider-date]');
    if (dateEl) {
      if (provKey === 'onlyOwnSites') {
        dateEl.textContent = t("msg_local_rules_ff97b927", "Локальные правила");
      } else if (provKey === 'customPacUrl' && !syncState.customPacUrl) {
        dateEl.textContent = t("msg_enter_a_url_26d5dd4d", "Укажите ссылку");
      } else {
        const stamp = provStamps[provKey] || (provKey === syncState.currentPacProviderKey ? syncState.lastPacUpdateStamp : 0);
        if (stamp) {
          const d = new Date(stamp);
          dateEl.textContent = t("msg_updated_sub_0c40c480", "Обновлён: $1", [d.toLocaleString(uiLocale(), {
            day: 'numeric',
            month: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })]);
        } else {
          dateEl.textContent = t("msg_not_updated_yet_5b05f298", "Ещё не обновлялся");
        }
      }
    }
  });

  // Tor, WARP, Custom proxies
  if (el.torToggle) el.torToggle.checked = Boolean(pacMods.ifUseLocalTor);
  if (el.warpToggle) el.warpToggle.checked = Boolean(pacMods.ifUseLocalWarp);
  if (el.ownOnlyToggle) el.ownOnlyToggle.checked = Boolean(pacMods.ifUseOwnProxiesOnlyForOwnSites);
  document.getElementById('proxyAdvancedState').textContent = pacMods.ifUseOwnProxiesOnlyForOwnSites ? t("msg_a_restriction_is_enabled_6a5d64e3", "есть включённое ограничение") : '';
  if (el.customProxyText) {
    const saved = pacMods.customProxyStringRaw || '';
    if (!proxyTextDirty) {
      if (el.customProxyText.value !== saved) el.customProxyText.value = saved;
      proxyTextBase = saved;
    } else if (el.customProxyText.value === saved) {
      proxyTextDirty = false;
      proxyTextBase = saved;
    }
    updateProxyDraftHint();
  }

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

  // Render Stats, Current Site, and Proxies
  renderCustomProxiesList();
  updateHomeWarning();
  updateProtocolUI();
}

// Render Stats Counters in Sites Tab (Instant O(1) from lightweight state)


// Render Custom Proxies in Structured Form View
function renderCustomProxiesList() {
  if (!el.proxyCardsList) return;

  const rawString = appState.pacMods.customProxyStringRaw || '';
  const list = parseCustomProxies(rawString);
  const catalog = appState.pacMods.proxyCatalog || appState.pacMods.proxyProfiles || [];
  const selectedDefault = appState.pacMods.defaultProxyId;
  el.defaultProxySelect.replaceChildren();
  const eligible = catalog.filter(proxy => proxy.enabled !== false);
  if (!eligible.length) el.defaultProxySelect.add(new Option(t('mpNoTargets', 'Нет доступных прокси'), ''));
  for (const profile of eligible) el.defaultProxySelect.add(new Option(profile.name, profile.id));
  el.defaultProxySelect.value = selectedDefault || '';
  el.defaultProxySelect.disabled = proxyProfileBusy || !eligible.length;

  el.proxyCardsList.innerHTML = '';

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = t("msg_no_custom_proxies_added_96a8dc56", "Свои прокси не добавлены");
    el.proxyCardsList.append(empty);
    return;
  }

  list.forEach((item) => {
    const profile = catalog.find(proxy => !proxy.builtin && proxyEndpointKey(proxy.endpoint) === proxyEndpointKey(item));
    const health = appState.proxyHealthMap[item.raw] || {};

    const itemEl = document.createElement('div');
    itemEl.className = 'proxy-item';

    const infoDiv = document.createElement('div');
    infoDiv.className = 'proxy-info';
    const identityDiv = document.createElement('div');
    identityDiv.className = 'proxy-identity';
    infoDiv.appendChild(identityDiv);

    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'proxy-badge';
    badgeSpan.textContent = item.type;
    identityDiv.appendChild(badgeSpan);
    if (profile) {
      const name = document.createElement('strong');
      name.className = 'proxy-profile-name';
      name.textContent = profile.name;
      name.title = profile.name;
      identityDiv.appendChild(name);
    }

    const addrSpan = document.createElement('span');
    addrSpan.className = 'proxy-addr';
    addrSpan.title = item.address;
    addrSpan.textContent = item.address;
    infoDiv.appendChild(addrSpan);

    if (item.hasAuth) {
      const authSpan = document.createElement('span');
      authSpan.className = 'proxy-auth-tag';
      authSpan.title = t("msg_authentication_59664d4b", "Авторизация");
      authSpan.textContent = '🔒';
      identityDiv.appendChild(authSpan);
    }

    const statusSpan = document.createElement('span');
    const checkedAt = Number(health.checkedAt);
    const checkedAtText = Number.isFinite(checkedAt) && checkedAt > 0
      ? new Date(checkedAt).toLocaleString(uiLocale())
      : '';
    const isStale = typeof health.ok === 'boolean' && !isProxyHealthFresh(health);
    if (health.checking) {
      statusSpan.className = 'proxy-status-tag checking';
      statusSpan.textContent = t("msg_checking_60762acf", "Проверка");
    } else if (health.ok === true) {
      statusSpan.className = `proxy-status-tag ${isStale ? 'stale' : 'online'}`;
      const latency = Number.isFinite(health.latency) ? t("msg_sub_ms_485532ae", "$1 мс", [health.latency]) : t("msg_available_d81568b8", "Доступен");
      statusSpan.title = checkedAtText
        ? t("msg_latency_sub_last_checked_sub_sub_08f10410", "Задержка: $1. Последняя проверка: $2$3", [latency, checkedAtText, isStale ? t("msg_the_result_may_be_out_of_date_824db2ef", ". Результат мог устареть") : ''])
        : t("msg_latency_sub_a8827757", "Задержка: $1", [latency]);
      statusSpan.textContent = latency;
    } else if (health.ok === false) {
      statusSpan.className = `proxy-status-tag ${isStale ? 'stale' : 'offline'}`;
      const errorText = health.error || t("msg_unavailable_53ba89ac", "Недоступен");
      statusSpan.title = checkedAtText
        ? t("msg_sub_last_checked_sub_sub_31650300", "$1. Последняя проверка: $2$3", [errorText, checkedAtText, isStale ? t("msg_the_result_may_be_out_of_date_824db2ef", ". Результат мог устареть") : ''])
        : errorText;
      statusSpan.textContent = isStale ? t("msg_no_connection_ee60619b", "Нет связи") : t("msg_unavailable_0a1f9ba9", "Недоступен");
    } else {
      statusSpan.className = 'proxy-status-tag unchecked';
      statusSpan.textContent = t("msg_not_checked_f951698d", "Не проверен");
    }

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'proxy-actions';

    const recheckBtn = document.createElement('button');
    recheckBtn.className = `icon-btn recheck-btn${health.checking ? ' is-checking' : ''}`;
    recheckBtn.title = t("msg_check_availability_5579e6b7", "Проверить доступность");
    recheckBtn.disabled = Boolean(health.checking);
    recheckBtn.setAttribute('aria-label', recheckBtn.title);
    recheckBtn.setAttribute('aria-busy', String(Boolean(health.checking)));
    const refreshIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    refreshIcon.setAttribute('viewBox', '0 0 24 24');
    refreshIcon.setAttribute('fill', 'none');
    refreshIcon.setAttribute('stroke', 'currentColor');
    refreshIcon.setAttribute('stroke-width', '1.75');
    refreshIcon.setAttribute('stroke-linecap', 'round');
    refreshIcon.setAttribute('stroke-linejoin', 'round');
    refreshIcon.setAttribute('aria-hidden', 'true');
    refreshIcon.setAttribute('focusable', 'false');
    const refreshPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    refreshPath.setAttribute('d', 'M3 12a9 9 0 0 1 15.36-6.36L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.36 6.36L3 16M8 16H3v5');
    refreshIcon.appendChild(refreshPath);
    recheckBtn.appendChild(refreshIcon);
    recheckBtn.addEventListener('click', async () => {
      showToast(t("msg_checking_sub_39a95af3", "Проверка $1...", [item.address]));
      const res = await checkProxyAvailability(item.raw);
      if (!res) return;
      if (res.ok) {
        showToast(t("msg_sub_is_available_sub_ms_2be3b1ee", "✓ $1 доступен ($2 мс)", [item.address, res.latency]));
      } else {
        showToast(t("msg_sub_is_unavailable_sub_33e94220", "✕ $1 недоступен: $2", [item.address, res.error || t("msg_failed_4bdba3ac", "Сбой")]));
      }
    });
    actionsDiv.appendChild(recheckBtn);
    const renameBtn = document.createElement('button');
    renameBtn.className = 'icon-btn rename-proxy-btn';
    renameBtn.textContent = t('mpRename', 'Переименовать');
    renameBtn.disabled = !profile || proxyProfileBusy;
    renameBtn.addEventListener('click', () => {
      proxyProfileDrafts.set(profile.id, { mode: 'rename', name: profile.name });
      renderCustomProxiesList();
    });
    actionsDiv.appendChild(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'icon-btn delete delete-btn';
    deleteBtn.title = t("msg_delete_be99b136", "Удалить");
    deleteBtn.textContent = '✕';
    deleteBtn.disabled = !profile || proxyProfileBusy;
    deleteBtn.addEventListener('click', async () => {
      proxyProfileDrafts.set(profile.id, { mode: 'delete', replacementProxyId: '' });
      renderCustomProxiesList();
    });
    actionsDiv.appendChild(deleteBtn);

    itemEl.appendChild(infoDiv);
    itemEl.appendChild(statusSpan);
    itemEl.appendChild(actionsDiv);
    if (profile && proxyProfileDrafts.has(profile.id)) {
      itemEl.appendChild(renderProfileEditor(profile, eligible));
    }
    el.proxyCardsList.appendChild(itemEl);
  });
  refreshSettingsHelp(el.proxyCardsList);
}

async function mutateProxyProfile(message) {
  const generation = resetGeneration;
  if (proxyProfileBusy) return false;
  proxyProfileBusy = true;
  ++stateLoadRevision;
  renderCustomProxiesList();
  try {
    const response = await sendMessage(message);
    if (response.stale) return false;
    if (!response?.success) {
      const error = response?.error?.message || response?.error || t('msg_failed_4bdba3ac', 'Сбой');
      const draft = proxyProfileDrafts.get(message.proxyId);
      if (draft) draft.error = error;
      showToast(error);
      return false;
    }
    // Do not replace metadata from a stale write acknowledgement.
    const refreshed = await refreshState();
    if (generation !== resetGeneration) return false;
    if (!refreshed) {
      showToast(t('mpReadbackFailed', 'Сохранено · обновите данные'));
      return false;
    }
    proxyProfileDrafts.delete(message.proxyId);
    sitesEditor?.refresh();
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  } finally {
    proxyProfileBusy = false;
    renderCustomProxiesList();
    if (externalRefreshPending) scheduleExternalStateRefresh();
  }
}

function validateProxyNameInput(input) {
  input.setCustomValidity(proxyNameLength(input.value) > MAX_PROXY_NAME_LENGTH
    ? t('mpErrorName', 'Введите уникальное название из 1–32 символов. Имена Tor и Cloudflare WARP зарезервированы.') : '');
  return input.checkValidity();
}

function initProxyNameInput(input) {
  if (!input) return;
  // Native maxlength counts UTF-16 units; 32 astral code points need 64.
  // The shared normalized code-point check enforces the actual name limit.
  input.maxLength = MAX_PROXY_NAME_LENGTH * 2;
  input.addEventListener('input', () => validateProxyNameInput(input));
  validateProxyNameInput(input);
}

function renderProfileEditor(profile, eligible) {
  const draft = proxyProfileDrafts.get(profile.id);
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'proxy-profile-editor';
  fieldset.disabled = proxyProfileBusy;
  const legend = document.createElement('legend');
  legend.textContent = draft.mode === 'rename' ? t('mpRename', 'Переименовать') : t('mpDeleteReplace', 'Удалить прокси · перенести сайты на');
  fieldset.append(legend);
  const input = document.createElement(draft.mode === 'rename' ? 'input' : 'select');
  input.setAttribute('aria-label', legend.textContent);
  if (draft.mode === 'rename') {
    input.value = draft.name;
    initProxyNameInput(input);
    input.addEventListener('input', () => { draft.name = input.value; });
  } else {
    input.add(new Option(t('mpChooseReplacement', 'Выберите замену явно'), ''));
    for (const proxy of eligible) if (proxy.id !== profile.id) input.add(new Option(proxy.name, proxy.id));
    input.value = draft.replacementProxyId;
    input.addEventListener('change', () => { draft.replacementProxyId = input.value; });
  }
  const submit = document.createElement('button');
  submit.className = 'btn btn-secondary btn-sm';
  submit.textContent = draft.mode === 'rename' ? t('msg_apply_e15f960d', 'Применить') : t('msg_delete_be99b136', 'Удалить');
  submit.addEventListener('click', () => {
    if (draft.mode === 'rename') {
      if (!input.value.trim()) { input.focus(); return; }
      if (!validateProxyNameInput(input)) { input.reportValidity(); return; }
      mutateProxyProfile({ action: 'RENAME_PROXY_PROFILE', proxyId: profile.id, name: input.value });
    } else {
      // No guessed replacement; backend is authoritative about dependencies.
      if (eligible.some(proxy => proxy.id !== profile.id) && !input.value) { input.focus(); return; }
      mutateProxyProfile({ action: 'DELETE_PROXY_PROFILE', proxyId: profile.id, replacementProxyId: input.value || null });
    }
  });
  const cancel = document.createElement('button');
  cancel.className = 'btn btn-secondary btn-sm';
  cancel.textContent = t('mpCancel', 'Отмена');
  cancel.addEventListener('click', () => { proxyProfileDrafts.delete(profile.id); renderCustomProxiesList(); });
  fieldset.append(input, submit, cancel);
  if (draft.error) {
    const error = document.createElement('small');
    error.className = 'profile-error';
    error.setAttribute('role', 'alert');
    error.textContent = draft.error;
    fieldset.append(error);
  }
  return fieldset;
}

// Add Proxy from Structured Form with Instant Health Check
async function handleAddStructuredProxy() {
  const generation = resetGeneration;
  if (proxyAddBusy) return;
  if (el.proxyFormAlert) el.proxyFormAlert.style.display = 'none';
  if (el.proxyName && !validateProxyNameInput(el.proxyName)) { el.proxyName.reportValidity(); return; }

  const protocol = (el.proxyProtocol?.value || 'HTTP').toUpperCase();
  let host = (el.proxyHost?.value || '').trim();
  let port = (el.proxyPort?.value || '').trim();
  const hasAuth = el.proxyAuthCheck?.checked && (protocol === 'HTTP' || protocol === 'HTTPS');
  const user = (el.proxyUser?.value || '').trim();
  const pass = (el.proxyPass?.value || '').trim();

  if (!host) {
    showFormAlert(t("msg_enter_an_ip_address_or_host_e_g_127_0_0_1_acccaf52", "Укажите IP-адрес или хост (напр. 127.0.0.1)"));
    el.proxyHost?.focus();
    return;
  }

  const parsedHostInput = parseProxyHostInput(host, port);
  if (!parsedHostInput) {
    showFormAlert(t("msg_invalid_ip_address_or_host_883d3e7e", "Некорректный IP-адрес или хост"));
    el.proxyHost?.focus();
    return;
  }
  host = parsedHostInput.host;
  port = parsedHostInput.port;

  if (!port) {
    port = protocol === 'HTTP' ? '8080' : protocol === 'HTTPS' ? '443' : '1080';
  }

  let proxyLine = '';
  if (hasAuth && (user || pass)) {
    proxyLine = `${protocol} ${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  } else {
    proxyLine = `${protocol} ${host}:${port}`;
  }

  const [candidateProxy] = parseCustomProxies(proxyLine);
  if (!candidateProxy) {
    showFormAlert(t("msg_check_the_proxy_address_and_port_1_65535_12481406", "Проверьте адрес прокси и номер порта (1–65535)"));
    return;
  }

  const currentRaw = appState.pacMods.customProxyStringRaw || '';
  const currentList = parseCustomProxies(currentRaw);

  // Check duplicates
  if (currentList.some((p) => p.address === candidateProxy.address && p.type === candidateProxy.type)) {
    showFormAlert(t("msg_this_proxy_is_already_in_the_list_84e5bfa6", "Такой прокси уже добавлен в список"));
    return;
  }

  const formFields = [el.proxyName, el.proxyHost, el.proxyPort, el.proxyUser, el.proxyPass];
  const submittedValues = formFields.map(input => input?.value);
  const submittedProtocol = el.proxyProtocol?.value;
  const submittedAuth = el.proxyAuthCheck?.checked;
  proxyAddBusy = true;
  ++stateLoadRevision;
  setAddButtonLoading(true);
  try {
    const res = await sendMessage({ action: 'ADD_PROXY', proxy: proxyLine, name: el.proxyName?.value.trim() || undefined });
    if (res.stale) return;
    if (!res.success) {
      const error = res.error || t("msg_failed_4bdba3ac", "Сбой");
      showFormAlert(res.data?.health?.ok === false
        ? t("msg_proxy_unavailable_sub_d325e3a8", "Прокси недоступен: $1", [error]) : error);
      if (isPrivateBrowsingPermissionError(res)) showResponseError(res);
      return;
    }
    const refreshed = await refreshState();
    if (generation !== resetGeneration) return;
    if (!refreshed) {
      showFormAlert(t('proxyAddedRefreshFailed', 'Прокси добавлен, но не удалось обновить его состояние. Обновите страницу настроек.'));
      return;
    }
    const health = res.data.health;
    const proxy = res.data.proxy;
    if (parseCustomProxies(appState.pacMods.customProxyStringRaw).some(item => item.raw === proxy) &&
        (appState.proxyHealthMap[proxy]?.checkedAt || 0) <= health.checkedAt) {
      appState.proxyHealthMap[proxy] = { ...health, checking: false };
    }
    if (formFields.every((input, index) => input?.value === submittedValues[index]) &&
        el.proxyProtocol?.value === submittedProtocol && el.proxyAuthCheck?.checked === submittedAuth) {
      formFields.forEach(input => { if (input) input.value = ''; });
    }
    renderCustomProxiesList();
    updateHomeWarning();
    showToast(t("msg_proxy_is_available_sub_ms_and_has_been_added_fab250e5", "✓ Прокси доступен ($1 мс) и добавлен!", [health.latency]));
  } catch (err) {
    showFormAlert(t('proxyAddFailed', 'Не удалось добавить прокси: $1', [err.message || t("msg_failed_4bdba3ac", "Сбой")]));
  } finally {
    proxyAddBusy = false;
    setAddButtonLoading(false);
    if (externalRefreshPending) scheduleExternalStateRefresh();
  }
}

function showFormAlert(msg) {
  if (!el.proxyFormAlert || !el.proxyFormAlertText) return;
  el.proxyFormAlertText.textContent = msg;
  el.proxyFormAlert.style.display = 'flex';
}

function setAddButtonLoading(isLoading) {
  if (!el.addProxyBtn) return;
  el.addProxyBtn.disabled = isLoading;
  if (isLoading) {
    if (el.addProxyBtnIcon) el.addProxyBtnIcon.textContent = '⏳';
    if (el.addProxyBtnText) el.addProxyBtnText.textContent = t("msg_checking_f325c5cc", "Проверка...");
  } else {
    if (el.addProxyBtnIcon) el.addProxyBtnIcon.textContent = '+';
    if (el.addProxyBtnText) el.addProxyBtnText.textContent = t("msg_add_and_check_2392c0b8", "Добавить и проверить");
  }
}

// Logs Tab: Load and Render
async function loadLogs() {
  const revision = ++logsLoadRevision;
  const { category, search } = appState.logsState;
  const res = await sendMessage({
    action: 'GET_LOGS',
    category,
    search,
    limit: 150,
  });
  if (res.stale) return;

  if (res.success && res.data) {
    if (revision !== logsLoadRevision) return;
    appState.logsState.items = res.data.logs || [];
    appState.logsState.stats = res.data.stats || {};
    renderLogs();
  }
}

function renderLogs() { renderLogsView(el, appState.logsState, showToast); }

// Logs Tab: Actions
async function handleCopyLogs() {
  const res = await sendMessage({
    action: 'EXPORT_LOGS',
    category: appState.logsState.category,
    search: appState.logsState.search,
  });

  if (res.success && res.data && res.data.text) {
    try {
      await copyText(res.data.text);
      showToast(t("msg_logs_copied_to_the_clipboard_b2eb247a", "✓ Логи скопированы в буфер обмена!"));
    } catch {
      showToast(t("msg_failed_to_copy_to_the_clipboard_2da3371a", "Не удалось скопировать в буфер обмена"));
    }
  } else {
    showToast(t("msg_the_log_is_empty_nothing_to_copy_99cda969", "Логи пусты — нечего копировать"));
  }
}

async function handleExportLogs() {
  const res = await sendMessage({
    action: 'EXPORT_LOGS',
    category: appState.logsState.category,
    search: appState.logsState.search,
  });

  if (!res.success || !res.data || !res.data.text) {
    showToast(t("msg_the_log_is_empty_nothing_to_export_0e05bccf", "Логи пусты — нечего экспортировать"));
    return;
  }

  const blob = new Blob([res.data.text], { type: 'text/plain;charset=utf-8' });
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
  const res = await sendMessage({ action: 'CLEAR_LOGS' });
  if (res.stale) return;
  if (res.success) {
    appState.logsState.items = [];
    appState.logsState.stats = res.data?.stats || {};
    renderLogs();
    showToast(t("msg_log_cleared_8c011aaf", "Журнал логов очищен"));
  }
}

// Init State from background (Ultra-lightweight and fast)
async function loadState({ preloadLogs = true } = {}) {
  const loadRevision = ++stateLoadRevision;
  const res = await sendMessage({
    action: 'GET_STATE',
    includeExceptions: false,
  });
  if (res.stale) return;
  if (loadRevision !== stateLoadRevision) return false;
  if (res.success && res.data) {
    appState.syncState = res.data.syncState || appState.syncState;
    appState.pacMods = res.data.pacMods || appState.pacMods;
    if (!Array.isArray(appState.pacMods.proxyCatalog)) {
      const catalogResponse = await sendMessage({ action: 'GET_EXCEPTIONS' });
      if (loadRevision !== stateLoadRevision) return false;
      if (catalogResponse?.success && Array.isArray(catalogResponse.data?.proxyCatalog)) {
        appState.pacMods.proxyCatalog = catalogResponse.data.proxyCatalog;
        appState.pacMods.defaultProxyId = catalogResponse.data.defaultProxyId;
      }
    }
    appState.defaultConfigs = res.data.defaultConfigs || appState.defaultConfigs;
    appState.notifications = res.data.notifications || appState.notifications;
    appState.lastErrors = res.data.lastErrors || appState.lastErrors;
    appState.version = formatVersion(res.data.version || (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()?.version) || DEFAULT_VERSION);
    appState.proxyHealthMap = res.data.proxyHealthMap || {};
    render();
  }

  // Preload log stats for navigation badge
  if (preloadLogs) loadLogs().catch(() => { });
  return Boolean(res.success && res.data);
}

async function refreshState({ preloadLogs = false } = {}) {
  return loadState({ preloadLogs });
}

function scheduleExternalStateRefresh() {
  externalRefreshPending = true;
  if (externalStateRefreshTimer !== null) {
    clearTimeout(externalStateRefreshTimer);
  }
  externalStateRefreshTimer = null;
  if (proxyAddBusy || proxyProfileBusy || document.visibilityState !== 'visible') return;
  externalStateRefreshTimer = setTimeout(() => {
    externalStateRefreshTimer = null;
    if (proxyAddBusy || proxyProfileBusy || document.visibilityState !== 'visible') return;
    externalRefreshPending = false;
    refreshState().catch(() => { });
    if (appState.activeTab === 'exceptions') sitesEditor.refresh();
  }, 50);
}

function setupExternalStateRefresh() {
  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' &&
          (Object.prototype.hasOwnProperty.call(changes || {}, PAC_MODS_STORAGE_KEY) ||
            changes[PROXY_HEALTH_STORAGE_KEY] || changes['settings-application'])) {
        const modsChange = changes[PAC_MODS_STORAGE_KEY];
        if (modsChange && (!modsChange.newValue || !modsChange.oldValue ||
            (modsChange.newValue._revision || 0) < (modsChange.oldValue._revision || 0))) sitesEditor.invalidate();
        else if (modsChange &&
            (modsChange.newValue._rulesRevision ?? modsChange.newValue._revision ?? 0) !==
            (modsChange.oldValue._rulesRevision ?? modsChange.oldValue._revision ?? 0)) sitesEditor.cancelRead();
        scheduleExternalStateRefresh();
      }
    });
  }

  window.addEventListener('focus', scheduleExternalStateRefresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleExternalStateRefresh();
  });
}

// Event Listeners
function setupEvents() {
  document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
    if (!confirm(t("msg_delete_change_history_rules_and_do_not_add_au_f947995e", "Удалить историю изменений? Правила и отметки «не добавлять автоматически» сохранятся."))) return;
    const response = await sendMessage({ action: 'CLEAR_RULE_HISTORY' });
    showToast(response.success ? t("msg_history_deleted_57e6da69", "История удалена") : response.error);
    await renderHistory(el.historyList, showToast, refreshState);
  });
  const activateActionableError = (event, action) => {
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    action();
  };

  if (el.homeProxyWarningBanner) {
    const activateHomeWarning = (event) => {
      if (el.homeProxyWarningBanner.dataset.errorAction !==
          'open-private-browsing-settings') {
        return;
      }
      activateActionableError(event, openPrivateBrowsingSettings);
    };
    el.homeProxyWarningBanner.addEventListener('click', activateHomeWarning);
    el.homeProxyWarningBanner.addEventListener('keydown', activateHomeWarning);
  }

  if (el.toast) {
    const activateToast = (event) => {
      if (!toastAction) return;
      activateActionableError(event, toastAction);
    };
    el.toast.addEventListener('click', activateToast);
    el.toast.addEventListener('keydown', activateToast);
  }

  // Navigation Tabs
  el.navTabs.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const navigation = ++navigationRevision;
      const tabKey = btn.dataset.tab;
      if (appState.activeTab === 'exceptions' && tabKey !== 'exceptions' && !await sitesEditor.flush()) return;
      if (navigation !== navigationRevision) return;
      el.navTabs.forEach((b) => {
        b.classList.toggle('active', b === btn);
        if (b === btn) b.setAttribute('aria-current', 'page');
        else b.removeAttribute('aria-current');
      });
      el.tabContents.forEach((content) => {
        content.classList.toggle('active', content.id === `tab-${tabKey}`);
      });
      appState.activeTab = tabKey;
      if (tabKey === 'exceptions') sitesEditor.activate();
      if (tabKey === 'logs') {
        loadLogs();
      }
      if (tabKey === 'history') renderHistory(el.historyList, showToast, refreshState);
      history.replaceState(null, '', `#${tabKey}`);
    });
  });

  // Custom PAC URL Apply Handler
  async function handleApplyCustomPacUrl() {
    const rawUrl = (el.customPacUrlInput?.value || '').trim();
    if (!rawUrl) {
      showToast(t("msg_enter_the_pac_script_url_be71f02a", "Введите адрес ссылки на PAC-скрипт"));
      el.customPacUrlInput?.focus();
      return;
    }

    const validation = utils.validatePacUrl(rawUrl);
    if (!validation.valid) {
      showToast(validation.error);
      el.customPacUrlInput?.focus();
      return;
    }

    if (el.saveCustomPacUrlBtn) el.saveCustomPacUrlBtn.disabled = true;
    showToast(t("msg_downloading_and_applying_your_pac_script_73e85156", "Загрузка и применение своего PAC-скрипта..."));
    const res = await sendMessage({
      action: 'INSTALL_PAC',
      key: 'customPacUrl',
      customPacUrl: validation.sanitizedUrl,
    });
    if (el.saveCustomPacUrlBtn) el.saveCustomPacUrlBtn.disabled = false;
    if (res.stale) return;

    if (res.success && res.data) {
      appState.syncState = res.data;
      render();
      showToast(t("msg_your_pac_script_was_downloaded_and_applied_68bf08d2", "✓ Свой PAC-скрипт успешно загружен и применён!"));
    } else {
      showResponseError(res, { fallback: t("msg_failed_to_download_pac_34599d21", "Не удалось загрузить PAC") });
      render();
    }
  }

  if (el.saveCustomPacUrlBtn) {
    el.saveCustomPacUrlBtn.addEventListener('click', handleApplyCustomPacUrl);
  }
  if (el.customPacUrlInput) {
    el.customPacUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleApplyCustomPacUrl();
    });
  }

  // Provider Selection with Gating for onlyOwnSites and customPacUrl
  el.providerCards.forEach((card) => {
    card.addEventListener('click', async (event) => {
      // Keep radios on confirmed state until the selected provider is applied.
      event.preventDefault();
      const key = card.dataset.provider;
      if (key === appState.syncState.currentPacProviderKey) return;

      if (key === 'onlyOwnSites') {
        const canUseOwnSites = hasAnyWorkingProxy();
        if (!canUseOwnSites) {
          showToast(t("msg_no_working_proxy_configure_a_proxy_in_my_prox_5507b02d", "❌ Нет рабочего прокси! Настройте прокси во вкладке «Прокси»"), 3000);
          render();
          return;
        }
      }

      if (key === 'customPacUrl') {
        if (el.customPacUrlBox) el.customPacUrlBox.style.display = 'block';
        const urlToApply = (el.customPacUrlInput?.value || appState.syncState.customPacUrl || '').trim();
        if (urlToApply) {
          const validation = utils.validatePacUrl(urlToApply);
          if (!validation.valid) {
            showToast(validation.error);
            el.customPacUrlInput?.focus();
            return;
          }
          showToast(t("msg_installing_your_pac_script_6bee6c48", "Установка своего PAC-скрипта..."));
          const res = await sendMessage({ action: 'INSTALL_PAC', key: 'customPacUrl', customPacUrl: validation.sanitizedUrl });
          if (res.stale) return;
          if (res.success) {
            appState.syncState = res.data;
            render();
            showToast(t("msg_your_pac_script_is_installed_0e199b55", "Свой PAC-скрипт установлен!"));
          } else {
            showResponseError(res, { fallback: t("msg_failed_to_download_pac_34599d21", "Не удалось загрузить PAC") });
            render();
          }
        } else {
          el.customPacUrlInput?.focus();
          showToast(t("msg_enter_a_direct_pac_script_url_and_click_apply_bdc39d75", "Укажите прямую ссылку на PAC-скрипт и нажмите «Применить»"));
        }
        return;
      }

      if (key === 'none') {
        showToast(t("msg_disabling_proxy_be6a5e5a", "Отключение прокси..."));
        const res = await sendMessage({ action: 'CLEAR_PAC' });
        if (res.stale) return;
        if (res.success) {
          appState.syncState = res.data;
          render();
          showToast(t("msg_proxy_disabled_a2fd1e2b", "Прокси отключён"));
        } else {
          showResponseError(res);
        }
        render();
      } else {
        showToast(t("msg_installing_pac_script_sub_eb597f4b", "Установка PAC-скрипта \"$1\"...", [appState.syncState.providers[key]?.label || key]));
        const res = await sendMessage({ action: 'INSTALL_PAC', key });
        if (res.stale) return;
        if (res.success) {
          appState.syncState = res.data;
          render();
          showToast(t("msg_pac_script_sub_installed_35eaff15", "PAC-скрипт \"$1\" установлен!", [appState.syncState.providers[key]?.label || key]));
        } else {
          showResponseError(res, { fallback: t("msg_failed_to_install_pac_3087f370", "Не удалось установить PAC") });
          render();
        }
      }
    });
  });

  // Manual Sync PAC
  if (el.syncBtn) {
    el.syncBtn.addEventListener('click', async () => {
      const currentKey = appState.syncState.currentPacProviderKey;
      if (!currentKey || currentKey === 'none') {
        showToast(t("msg_select_a_pac_provider_first_2614fea6", "Сначала выберите PAC-провайдера"));
        return;
      }
      showToast(t("msg_updating_the_pac_script_07fb13cc", "Обновление PAC-скрипта..."));
      appState.syncState.isSyncing = true;
      render();

      const res = await sendMessage({ action: 'SYNC_PAC', key: currentKey });
      if (res.stale) return;
      appState.syncState.isSyncing = false;
      if (res.success) {
        appState.syncState = res.data;
        showToast(t("msg_pac_script_updated_a7c851de", "PAC-скрипт успешно обновлён!"));
      } else {
        showResponseError(res, { prefix: t("msg_update_failed_798e384c", "Ошибка обновления: "), fallback: t("msg_network_failure_dd0f89b6", "Сбой сети") });
      }
      render();
    });
  }

  el.defaultProxySelect.addEventListener('change', async () => {
    const proxyId = el.defaultProxySelect.value;
    if (!proxyId || proxyProfileBusy) return;
    await mutateProxyProfile({ action: 'SET_DEFAULT_PROXY', proxyId });
  });

  // Own Proxies: Protocol change updates UI
  if (el.proxyProtocol) {
    el.proxyProtocol.addEventListener('change', updateProtocolUI);
  }

  // Own Proxies: Auth Checkbox Toggle
  if (el.proxyAuthCheck && el.proxyAuthFields) {
    el.proxyAuthCheck.addEventListener('change', () => {
      el.proxyAuthFields.style.display = el.proxyAuthCheck.checked ? 'grid' : 'none';
    });
  }

  // Own Proxies: Add Structured Proxy Button
  if (el.addProxyBtn) {
    el.addProxyBtn.addEventListener('click', handleAddStructuredProxy);
  }

  // Own Proxies: Recheck All Proxies Button
  if (el.recheckAllProxiesBtn) {
    el.recheckAllProxiesBtn.addEventListener('click', async () => {
      showToast(t("msg_checking_all_proxies_eaa51f32", "Проверка всех прокси..."));
      if (await checkAllProxiesHealth() === false) return;
      showToast(t("msg_check_complete_880c43c5", "Проверка завершена"));
    });
  }

  // Own Proxies: Editor Mode Toggle (Form vs Raw Text)
  if (el.proxyEditorModeToggle) {
    el.proxyEditorModeToggle.addEventListener('click', () => {
      const isRaw = el.proxyRawView.style.display !== 'none';
      if (isRaw) {
        el.proxyRawView.style.display = 'none';
        el.proxyFormView.style.display = 'block';
        el.proxyEditorModeToggle.textContent = t("msg_text_3091aca2", "Текст");
      } else {
        el.proxyFormView.style.display = 'none';
        el.proxyRawView.style.display = 'block';
        el.proxyEditorModeToggle.textContent = t("msg_form_b26b88d6", "Форма");
        if (el.customProxyText && !proxyTextDirty) {
          el.customProxyText.value = appState.pacMods.customProxyStringRaw || '';
        }
      }
    });
  }

  // Save Raw Proxies Textarea
  el.customProxyText?.addEventListener('input', () => {
    if (!proxyTextDirty) proxyTextBase = appState.pacMods.customProxyStringRaw || '';
    proxyTextDirty = el.customProxyText.value !== (appState.pacMods.customProxyStringRaw || '');
    if (!proxyTextDirty) proxyTextBase = appState.pacMods.customProxyStringRaw || '';
    updateProxyDraftHint();
  });
  if (el.saveProxiesBtn) {
    el.saveProxiesBtn.addEventListener('click', async () => {
      if (el.saveProxiesBtn.disabled || resetBusy) return;
      const generation = resetGeneration;
      const mods = {
        customProxyStringRaw: el.customProxyText?.value || '',
      };
      el.saveProxiesBtn.disabled = true;
      el.saveProxiesBtn.textContent = t("msg_saving_9c27c381", "Сохраняем…");
      try {
        const res = await sendMessage({ action: 'SAVE_MODS', mods });
        if (res.stale) return;
        if (res.success) {
          // A different view may have committed a newer list while apply was
          // pending. The acknowledgement is not the current shared snapshot.
          const refreshed = await refreshState();
          if (generation !== resetGeneration) return;
          if (!refreshed) {
            proxyTextDirty = true;
            proxyTextBase = mods.customProxyStringRaw;
            updateProxyDraftHint();
            showToast(t("msg_the_list_is_saved_refreshing_the_current_stat_ca109519", "Список сохранён. Обновление актуального состояния ещё не подтверждено."));
            return;
          }
          const saved = appState.pacMods.customProxyStringRaw || '';
          proxyTextDirty = el.customProxyText.value !== saved;
          proxyTextBase = proxyTextDirty ? mods.customProxyStringRaw : saved;
          updateProxyDraftHint();
          renderCustomProxiesList();
          if (saved !== mods.customProxyStringRaw) {
            showToast(t("msg_the_saved_list_has_already_changed_check_the__b38ea703", "Сохранённый список уже изменился. Проверьте актуальные данные и черновик."));
          } else {
            if (!appState.settingsState?.pending) checkAllProxiesHealth().catch(() => { });
            showToast(appState.settingsState?.pending ? t("msg_the_list_is_saved_applying_it_is_waiting_for__c9687d2a", "Список сохранён. Применение ожидает повторной попытки.") : t("msg_proxy_list_saved_375fb339", "Список прокси сохранён"));
          }
        } else {
          showResponseError(res, { fallback: t("msg_invalid_format_396ace06", "Неверный формат") });
        }
      } catch (error) {
        showToast(error.message || t("msg_failed_to_save_the_proxy_list_1196b92d", "Не удалось сохранить список прокси"));
      } finally {
        el.saveProxiesBtn.disabled = false;
        el.saveProxiesBtn.textContent = t("msg_apply_e15f960d", "Применить");
      }
    });
  }

  // Quick Toggles: Tor, WARP, OwnOnly
  const bindProxyToggle = (checkbox, key, localService = null) => {
    if (!checkbox) return;
    checkbox.addEventListener('change', async () => {
      if (checkbox.disabled || resetBusy) return;
      ++stateLoadRevision;
      const generation = resetGeneration;
      // The current snapshot, not a stale pre-request value, is used on rollback.
      const enabled = Boolean(checkbox.checked);
      checkbox.disabled = true;

      try {
        if (localService && enabled) {
          showToast(t("msg_checking_local_proxy_cea92cfe", "Проверяем локальный прокси…"));
        }

        const res = localService
          ? await sendMessage({
            action: 'SET_LOCAL_PROXY_ENABLED',
            service: localService,
            enabled,
          })
          : await sendMessage({ action: 'SAVE_MODS', mods: { [key]: enabled } });

        if (res.stale || generation !== resetGeneration) return;
        if (!res.success) {
          checkbox.checked = Boolean(appState.pacMods?.[key]);
          const actionText = enabled ? t("msg_enable_54768313", "включить") : t("msg_disable_fa545d9d", "выключить");
          showResponseError(res, {
            prefix: t("msg_failed_to_sub_5342e22f", "Не удалось $1: ", [actionText]),
            fallback: t("msg_local_proxy_unavailable_9d04b608", "локальный прокси недоступен"),
            duration: 4500,
          });
          return;
        }

        appState.pacMods = localService ? res.data.pacMods : res.data;
        updateHomeWarning();

        if (localService && enabled) {
          const health = res.data.health;
          const latency = Number.isFinite(health?.latency) ? t("msg_sub_ms_124b5754", ", $1 мс", [health.latency]) : '';
          showToast(t("msg_proxy_available_sub_sub_b4142c92", "✓ Прокси доступен: $1$2", [health.workingProxy, latency]));
        } else {
          showToast(t("msg_settings_updated_d8ea53b0", "Настройки обновлены"));
        }
      } catch (err) {
        if (generation !== resetGeneration) return;
        checkbox.checked = Boolean(appState.pacMods?.[key]);
        showToast(t("msg_error_sub_9ca75e4a", "Ошибка: $1", [err.message || t("msg_failed_to_save_the_setting_752f6fb0", "не удалось сохранить настройку")]), 4500);
      } finally {
        checkbox.checked = Boolean(appState.pacMods?.[key]);
        checkbox.disabled = false;
      }
    });
  };

  bindProxyToggle(el.torToggle, 'ifUseLocalTor', 'tor');
  bindProxyToggle(el.warpToggle, 'ifUseLocalWarp', 'warp');
  bindProxyToggle(el.ownOnlyToggle, 'ifUseOwnProxiesOnlyForOwnSites');

  // Modifiers: Instant Autosave on change
  const bindModToggle = (element, key) => {
    if (!element) return;
    element.addEventListener('change', async () => {
      const mods = {
        [key]: Boolean(element.checked),
      };

      if (element.disabled || resetBusy) return;
      element.disabled = true;
      ++stateLoadRevision;
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
      if (element.disabled || resetBusy) return;
      const enabled = element.checked;
      element.disabled = true;
      ++stateLoadRevision;
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

  // Diagnostics: Test Connection
  if (el.testConnBtn && el.connResult) {
    el.testConnBtn.addEventListener('click', async () => {
      el.testConnBtn.disabled = true;
      el.connResult.textContent = t("msg_testing_f7c8f44d", "Тестирование...");
      const res = await sendMessage({ action: 'TEST_CONNECTION' });
      el.testConnBtn.disabled = false;
      if (res.stale) return;
      el.connResult.textContent = '';
      const span = document.createElement('span');
      if (res.success) {
        span.style.color = 'var(--success)';
        span.textContent = t("msg_available_sub_ms_98493bf5", "✓ Доступно ($1 мс)", [res.latency]);
      } else {
        span.style.color = 'var(--danger)';
        span.textContent = t("msg_error_sub_f9b87abd", "✕ Ошибка ($1)", [res.error || t("msg_failed_4bdba3ac", "Сбой")]);
      }
      el.connResult.appendChild(span);
    });
  }


  // Diagnostics: View PAC Script Modal
  if (el.viewPacScriptBtn && el.pacScriptModal && el.pacScriptContent) {
    el.viewPacScriptBtn.addEventListener('click', async () => {
      const res = await sendMessage({ action: 'GET_PAC_SCRIPT' });
      if (res.stale) return;
      if (res.success && res.data) {
        const label = res.data.scriptKind === 'applied' ? t("msg_pac_installed_in_the_browser_b3a5d782", "// PAC, установленный в браузере") :
          res.data.scriptKind === 'preview' ? t("msg_preview_of_saved_settings_application_has_not_e210f47a", "// Предпросмотр по сохранённым настройкам; применение не подтверждено") : t("msg_no_pac_script_installed_b4950c71", "// PAC-скрипт не установлен");
        el.pacScriptContent.textContent = `${label}\n${res.data.cookedPacData || ''}`;
        el.pacScriptModal.style.display = 'flex';
      }
    });

    if (el.closePacModalBtn) {
      el.closePacModalBtn.addEventListener('click', () => {
        el.pacScriptModal.style.display = 'none';
      });
    }
  }

  // Diagnostics: Reset Settings
  if (el.resetSettingsBtn) {
    el.resetSettingsBtn.addEventListener('click', async () => {
      if (resetBusy || !confirm(t('msg_reset_all_settings_to_defaults_e8ab9d8b', 'Сбросить все настройки к исходным?'))) return;
      resetBusy = true;
      el.resetSettingsBtn.disabled = true;
      ++stateLoadRevision;
      showToast(t('msg_resetting_settings_3250682c', 'Сброс настроек...'));
      try {
        const res = await sendMessage({ action: 'RESET_SETTINGS' });
        if (!res.success) { showResponseError(res); return; }
        ++resetGeneration; ++stateLoadRevision; ++navigationRevision; ++logsLoadRevision;
        clearTimeout(externalStateRefreshTimer); externalStateRefreshTimer = null; externalRefreshPending = false;
        clearTimeout(logsSearchDebounce);
        proxyProfileDrafts.clear(); proxyTextDirty = false; proxyTextBase = '';
        appState.pacMods = {}; appState.proxyHealthMap = {}; appState.notifications = {};
        appState.syncState = { currentPacProviderKey: 'none', providers: {} };
        appState.settingsState = res.settingsState || null;
        renderApplicationBanner(el.applicationBanner, appState.settingsState, refreshState);
        el.customPacUrlInput.value = ''; el.customProxyText.value = '';
        [el.proxyName, el.proxyHost, el.proxyPort, el.proxyUser, el.proxyPass].forEach(input => { input.value = ''; });
        el.proxyFormAlert.style.display = 'none';
        sitesEditor.reset();
        invalidateHistory(el.historyList);
        appState.logsState = { category: 'all', search: '', items: [], stats: {} };
        el.logsSearchInput.value = ''; el.clearLogsSearchBtn.style.display = 'none';
        el.logsFilterBtns.forEach(button => button.classList.toggle('active', button.dataset.category === 'all'));
        renderLogs(); render();
        const loaded = await loadState({ preloadLogs: false });
        await sitesEditor.refresh();
        showToast(loaded ? t('msg_settings_reset_78395c27', 'Настройки сброшены!')
          : t('optionsResetReadbackFailed', 'Настройки сброшены, но не удалось обновить данные. Обновите страницу.'));
      } catch (error) {
        showResponseError({ error: error.message });
      } finally {
        resetBusy = false; el.resetSettingsBtn.disabled = false;
      }
    });
  }

  // Logs Tab: Category Filters
  if (el.logsFilterBtns) {
    el.logsFilterBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        el.logsFilterBtns.forEach((b) => b.classList.toggle('active', b === btn));
        appState.logsState.category = btn.dataset.category || 'all';
        loadLogs();
      });
    });
  }

  // Logs Tab: Search Input & Clear
  // Debounce belongs to the resettable UI session.
  if (el.logsSearchInput) {
    el.logsSearchInput.addEventListener('input', () => {
      const val = (el.logsSearchInput.value || '').trim();
      appState.logsState.search = val;
      if (el.clearLogsSearchBtn) {
        el.clearLogsSearchBtn.style.display = val ? 'block' : 'none';
      }
      clearTimeout(logsSearchDebounce);
      logsSearchDebounce = setTimeout(() => {
        loadLogs();
      }, 250);
    });
  }

  if (el.clearLogsSearchBtn && el.logsSearchInput) {
    el.clearLogsSearchBtn.addEventListener('click', () => {
      el.logsSearchInput.value = '';
      appState.logsState.search = '';
      el.clearLogsSearchBtn.style.display = 'none';
      loadLogs();
    });
  }

  // Logs Tab: Action Buttons
  if (el.refreshLogsBtn) {
    el.refreshLogsBtn.addEventListener('click', () => {
      loadLogs();
      showToast(t("msg_log_refreshed_3e3abc85", "Список логов обновлён"));
    });
  }

  if (el.copyLogsBtn) {
    el.copyLogsBtn.addEventListener('click', handleCopyLogs);
  }

  if (el.exportLogsBtn) {
    el.exportLogsBtn.addEventListener('click', handleExportLogs);
  }

  if (el.clearLogsBtn) {
    el.clearLogsBtn.addEventListener('click', handleClearLogs);
  }
}

// Bootstrap
async function initApp() {
  initElements();
  initAppearanceControls(document.getElementById('appearanceSettings'));
  initSettingsHelp();
  sitesEditor = initSitesEditor(document.getElementById('tab-exceptions'), {
    notify: showToast,
    navigate: section => document.querySelector(`.nav-tab-btn[data-tab="${section}"]`)?.click(),
    onApplicationState: state => {
      if (state) {
        appState.settingsState = state;
        renderApplicationBanner(el.applicationBanner, state, refreshState);
      }
    },
  });
  setupEvents();
  render(); // Instant 0ms UI render before async network/storage calls
  await refreshState({ preloadLogs: true });
  const section = location.hash.slice(1);
  document.querySelector(`.nav-tab-btn[data-tab="${['pac', 'exceptions', 'proxies', 'mods', 'logs', 'notifications', 'tools', 'history', 'appearance'].includes(section) ? section : 'exceptions'}"]`)?.click();
  setupExternalStateRefresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
