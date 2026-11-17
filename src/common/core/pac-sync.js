'use strict';

import { t, uiLocale } from './i18n.js';

import { storage } from './storage.js';
import { applicationState } from './application-state.js';
import { httpLib } from './http-lib.js';
import { pacKitchen } from './pac-kitchen.js';
import { cookPac } from './pac-script.js';
import { ipToHost } from './ip-to-host.js';
import { utils } from './utils.js';
import { clarify, formatErrorMessage, getErrorCode } from './errors-lib.js';
import { logger } from './logger.js';
import { errorHandlers, isHardProxyControlConflict } from './error-handlers.js';
import { validatePacScriptSource } from './pac-validator.js';
import {
  assertProxySettingsControllable,
  withProxySettingsLock,
} from './proxy-settings-lock.js';
import { proxyBackend } from './proxy-backend.js';

const STORAGE_KEY = 'antiCensorRu';
const PAC_FRESHNESS_KEY = 'antiCensorPacFreshness';
const ALARM_NAME = 'periodic-pac-update';
const MAX_CUSTOM_PAC_BYTES = 10 * 1024 * 1024;
const MAX_TRUSTED_PAC_BYTES = 25 * 1024 * 1024;
const CONTROL_LOSS_CONFIRM_MS = 750;

class SyncSupersededError extends Error {
  constructor() {
    super(t("msg_the_pac_update_was_cancelled_by_a_newer_setti_087c54d3", "Запрос обновления PAC отменён более новым изменением настроек"));
    this.name = 'SyncSupersededError';
  }
}

const getPacSourceKey = (providerKey, customUrl = '') => providerKey === 'customPacUrl'
  ? `${providerKey}:${String(customUrl || '').trim()}`
  : String(providerKey || '');

export const PAC_PROVIDERS = {
  Антизапрет: {
    distinctKey: 'Antizapret',
    label: t('Antizapret', 'Антизапрет'),
    desc: t('pac_provider_antizapret_description', 'PAC-скрипт проекта «Антизапрет».'),
    order: 0,
    maxBytes: MAX_TRUSTED_PAC_BYTES,
    timeoutMs: 45000,
    allowedFinalHosts: [
      'e.cen.rodeo',
      'antizapret.prostovpn.org',
      '.ipfs.dweb.link',
    ],
    pacUrls: [
      'https://e.cen.rodeo:8443/proxy.pac',
      'https://antizapret.prostovpn.org:8443/proxy.pac',
      'https://antizapret.prostovpn.org:18443/proxy.pac',
      'https://antizapret.prostovpn.org/proxy.pac',
    ],
  },
  Антицензорити: {
    distinctKey: 'Anticensority',
    label: t('Anticensority', 'Антицензорити'),
    desc: t('pac_provider_anticensority_description', 'PAC-скрипт проекта «Антицензорити».'),
    order: 1,
    maxBytes: MAX_TRUSTED_PAC_BYTES,
    timeoutMs: 45000,
    allowedFinalHosts: [
      'anticensority.github.io',
      'raw.githubusercontent.com',
    ],
    pacUrls: [
      'https://anticensority.github.io/generated-pac-scripts/anticensority.pac',
      'https://raw.githubusercontent.com/anticensority/generated-pac-scripts/master/anticensority.pac',
    ],
  },
  onlyOwnSites: {
    distinctKey: 'onlyOwnSites',
    label: t("msg_only_your_sites_tor_custom_proxies_d3781c05", "Только свои сайты (Tor / Свои прокси)"),
    desc: t("msg_only_manually_added_sites_are_routed_through__6e0c474c", "Проксируются только вручную добавленные сайты через ваши прокси или локальный Tor."),
    order: 2,
    pacUrls: [
      'data:application/x-ns-proxy-autoconfig,' + encodeURIComponent('function FindProxyForURL(url, host){ return "DIRECT"; }'),
    ],
  },
  customPacUrl: {
    distinctKey: 'customPacUrl',
    label: t("msg_custom_pac_url_5933ecf2", "Свой PAC (по ссылке)"),
    desc: t("msg_a_ready_to_use_pac_script_at_your_own_direct__ca526c8e", "Готовый PAC-скрипт по собственной прямой ссылке (HTTPS или HTTP на этом компьютере)."),
    order: 3,
    pacUrls: [],
  },
};

class PacSyncManager {
  constructor() {
    this.currentPacProviderKey = 'Антизапрет';
    this.customPacUrl = '';
    this.lastPacUpdateStamp = 0;
    this.providerUpdateStamps = {};
    this.rawPacData = '';
    this.cookedPacData = '';
    this.lastError = null;
    this.isSyncing = false;
    this.isControlled = false;
    this.isControllable = false;
    this.isExpectedPacApplied = false;
    this.levelOfControl = 'unknown';
    this.isInitialized = false;
    this._localStatePromise = null;
    this.revision = 0;
    this._proxyMutationDepth = 0;
    this._lastControlDetails = null;
    this._reconcileGeneration = 0;

    // Pending sync queue mechanism (Task 1)
    this._isSyncRunning = false;
    this._currentSyncPromise = null;
    this._currentRunningOptions = null;
    this._pendingSync = null;
    this._syncGeneration = 0;
    this._downloadController = null;
  }

  _createStateSnapshot() {
    return {
      currentPacProviderKey: this.currentPacProviderKey,
      customPacUrl: this.customPacUrl,
      lastPacUpdateStamp: this.lastPacUpdateStamp,
      providerUpdateStamps: { ...this.providerUpdateStamps },
      rawPacData: this.rawPacData,
      cookedPacData: this.cookedPacData,
    };
  }

  _restoreStateSnapshot(snapshot) {
    this.currentPacProviderKey = snapshot.currentPacProviderKey;
    this.customPacUrl = snapshot.customPacUrl;
    this.lastPacUpdateStamp = snapshot.lastPacUpdateStamp;
    this.providerUpdateStamps = snapshot.providerUpdateStamps;
    this.rawPacData = snapshot.rawPacData;
    this.cookedPacData = snapshot.cookedPacData;
  }

  async _rollbackPacState(snapshot) {
    let rollbackError = null;
    try {
      if (snapshot.currentPacProviderKey &&
          snapshot.currentPacProviderKey !== 'none' &&
          snapshot.rawPacData) {
        await this.applyPacData(snapshot.rawPacData);
      } else {
        await this.clearPac({ persist: false });
      }
    } catch (err) {
      rollbackError = err;
    } finally {
      this._restoreStateSnapshot(snapshot);
      await this.updateControlState();
    }
    if (rollbackError) throw rollbackError;
  }

  resetRuntimeState() {
    this._downloadController?.abort();
    this._syncGeneration++;
    if (this._pendingSync) {
      const resetError = new SyncSupersededError();
      this._pendingSync.deferreds.forEach(({ reject }) => reject(resetError));
      this._pendingSync = null;
    }
    this.currentPacProviderKey = 'Антизапрет';
    this.customPacUrl = '';
    this.lastPacUpdateStamp = 0;
    this.providerUpdateStamps = {};
    this.rawPacData = '';
    this.cookedPacData = '';
    this.lastError = null;
    this.isControlled = false;
    this.isControllable = false;
    this.isExpectedPacApplied = false;
    this.levelOfControl = 'unknown';
    this._lastControlDetails = null;
    this._reconcileGeneration++;
    this.isInitialized = false;
    this._localStatePromise = null;
    this.revision++;
    if (!this._isSyncRunning) {
      this.isSyncing = false;
      this._currentSyncPromise = null;
      this._currentRunningOptions = null;
    }
    this.updateTitle();
  }

  loadLocalState() {
    if (!this._localStatePromise) this._localStatePromise = this._loadLocalState().catch(error => {
      this._localStatePromise = null;
      throw error;
    });
    return this._localStatePromise;
  }

  async _loadLocalState() {
    const [saved, freshness] = await Promise.all([
      storage.get(STORAGE_KEY, {}),
      storage.get(PAC_FRESHNESS_KEY, null),
    ]);
    if (saved && typeof saved === 'object') {
      if (saved.currentPacProviderKey !== undefined) {
        this.currentPacProviderKey = saved.currentPacProviderKey;
      }
      if (saved.customPacUrl !== undefined) {
        this.customPacUrl = saved.customPacUrl;
      }
      if (saved.lastPacUpdateStamp) {
        this.lastPacUpdateStamp = saved.lastPacUpdateStamp;
      }
      if (saved.providerUpdateStamps) {
        this.providerUpdateStamps = saved.providerUpdateStamps;
      }
      if (saved.rawPacData) {
        this.rawPacData = saved.rawPacData;
      }
    }

    if (freshness && typeof freshness === 'object') {
      const currentSourceKey = getPacSourceKey(this.currentPacProviderKey, this.customPacUrl);
      if (freshness.sourceKey === currentSourceKey) {
        const freshnessStamp = Number(freshness.lastPacUpdateStamp);
        if (Number.isFinite(freshnessStamp) && freshnessStamp > this.lastPacUpdateStamp) {
          this.lastPacUpdateStamp = freshnessStamp;
        }
      }
      if (freshness.providerUpdateStamps && typeof freshness.providerUpdateStamps === 'object') {
        for (const [key, value] of Object.entries(freshness.providerUpdateStamps)) {
          if (!Object.prototype.hasOwnProperty.call(PAC_PROVIDERS, key)) continue;
          const timestamp = Number(value);
          if (Number.isFinite(timestamp) && timestamp > (this.providerUpdateStamps[key] || 0)) {
            this.providerUpdateStamps[key] = timestamp;
          }
        }
      }
    }

    this.setupAlarms();
    this.updateTitle();
    await this.updateControlState({ reportControlState: false });
  }

  async init() {
    if (this.isInitialized) return;
    await this.loadLocalState();
    const generation = this._syncGeneration;
    const storedPacValidation = this.rawPacData
      ? validatePacScriptSource(this.rawPacData)
      : { valid: true };
    if (!storedPacValidation.valid) {
      console.warn('[PacSync] Ignoring invalid PAC data restored from storage:', storedPacValidation.error);
      this.rawPacData = '';
      this.cookedPacData = '';
    } else if (this.rawPacData) {
      const pacMods = await pacKitchen.getPacMods();
      this.cookedPacData = cookPac(this.rawPacData, pacMods);
    }

    await this.updateControlState();
    this.setupAlarms();
    this.updateTitle();

    const shouldHavePac = this.currentPacProviderKey &&
      this.currentPacProviderKey !== 'none';
    if (shouldHavePac) {
      if (!this.rawPacData) {
        await this.syncWithPacProvider({ ifUnattended: true });
      } else if (this.isControllable && !this.isExpectedPacApplied) {
        // Storage may say PAC is enabled while the profile proxy setting was
        // cleared after a browser crash or an interrupted extension update.
        await this.applyPacData(this.rawPacData, { expectedSyncGeneration: generation });
      }
    }

    this.isInitialized = true;
  }

  setupAlarms() {
    if (!chrome.alarms) return;
    chrome.alarms.get(ALARM_NAME, (existingAlarm) => {
      if (chrome.runtime.lastError) {
        // P1.8: Log alarm check errors rather than silently swallowing them
        console.warn('[PacSync] Alarm check error:', chrome.runtime.lastError);
        return;
      }
      if (!existingAlarm) {
        chrome.alarms.create(ALARM_NAME, {
          periodInMinutes: 240, // every 4 hours
        });
      }
    });
  }

  async updateControlState({
    reportControlState = true,
    updateIcon = reportControlState,
  } = {}) {
    let details = null;
    try {
      details = await proxyBackend.getSettings();
    } catch (error) {
      console.warn('proxy settings get error:', error);
    }
    if (!details) {
      this._lastControlDetails = null;
      return false;
    }

    this._lastControlDetails = details;
    this.levelOfControl = details.levelOfControl || 'unknown';
    this.isControllable = utils.areSettingsControllableFor(details);
    this.isControlled = utils.areSettingsControlledFor(details);
    const expectedControl = Boolean(
      this.currentPacProviderKey &&
      this.currentPacProviderKey !== 'none' &&
      this.rawPacData
    );
    const expectedPac = Boolean(expectedControl && this.cookedPacData);
    this.isExpectedPacApplied = Boolean(
      expectedPac &&
      this.isControlled &&
      proxyBackend.isExpectedPacApplied(details, this.cookedPacData)
    );
    const controlState = {
      isControlled: this.isControlled,
      isControllable: this.isControllable,
      expectedControl,
      levelOfControl: this.levelOfControl,
    };
    if (reportControlState) {
      await errorHandlers.handleControlState(controlState);
    }

    if (updateIcon) this._updateControlIcon();

    return this.isControlled;
  }

  _updateControlIcon() {
    const iconPath = this.isControlled
      ? {
          16: 'icons/default-16.png',
          32: 'icons/default-32.png',
          48: 'icons/default-48.png',
          128: 'icons/default-128.png',
        }
      : {
          16: 'icons/default-grayscale-16.png',
          32: 'icons/default-grayscale-32.png',
          48: 'icons/default-grayscale-48.png',
          128: 'icons/default-grayscale-128.png',
        };

    chrome.action.setIcon({ path: iconPath }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  }

  _getCurrentControlState() {
    return {
      isControlled: this.isControlled,
      isControllable: this.isControllable,
      expectedControl: Boolean(
        this.currentPacProviderKey &&
        this.currentPacProviderKey !== 'none' &&
        this.rawPacData
      ),
      levelOfControl: this.levelOfControl,
    };
  }

  _waitForControlStateStability() {
    return new Promise((resolve) => setTimeout(resolve, CONTROL_LOSS_CONFIRM_MS));
  }

  async reconcileProxyState() {
    const reconcileGeneration = ++this._reconcileGeneration;
    if (this._proxyMutationDepth > 0) return false;

    await this.updateControlState({ reportControlState: false });
    if (!this._lastControlDetails || reconcileGeneration !== this._reconcileGeneration) {
      return false;
    }

    let controlState = this._getCurrentControlState();
    if (isHardProxyControlConflict(controlState)) {
      await this._waitForControlStateStability();
      if (reconcileGeneration !== this._reconcileGeneration) return false;

      await this.updateControlState({ reportControlState: false });
      if (!this._lastControlDetails || reconcileGeneration !== this._reconcileGeneration) {
        return false;
      }
      controlState = this._getCurrentControlState();
    }

    await errorHandlers.handleControlState(controlState);
    this._updateControlIcon();
    const shouldHavePac = controlState.expectedControl;
    if (shouldHavePac && this.isControllable && !this.isExpectedPacApplied) {
      await this.reapplyCurrentPac();
      return true;
    }
    return false;
  }

  updateTitle() {
    let title = t("msg_runet_censorship_bypass_68c3f483", "Обход блокировок Рунета");
    if (this.lastPacUpdateStamp) {
      const upDate = new Date(this.lastPacUpdateStamp).toLocaleString(uiLocale(), {
        day: 'numeric',
        month: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      // P2.10: use i18n for provider label instead of hardcoded Russian string
      const customPacLabel = t("msg_custom_pac_0c76be79", "Свой PAC");
      const provName = this.currentPacProviderKey === 'customPacUrl'
        ? customPacLabel
        : (PAC_PROVIDERS[this.currentPacProviderKey]?.label || t("msg_disabled_3e958000", "Отключено"));
      title = t("msg_pac_updated_sub_sub_9481d056", "PAC обновлён: $1 | $2", [upDate, provName]);
    }
    chrome.action.setTitle({ title }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  }

  async persistState() {
    await storage.set(STORAGE_KEY, {
      currentPacProviderKey: this.currentPacProviderKey,
      customPacUrl: this.customPacUrl,
      lastPacUpdateStamp: this.lastPacUpdateStamp,
      providerUpdateStamps: this.providerUpdateStamps,
      rawPacData: this.rawPacData,
    });
    this.updateTitle();
  }

  async persistFreshness({
    lastPacUpdateStamp = this.lastPacUpdateStamp,
    providerUpdateStamps = this.providerUpdateStamps,
  } = {}) {
    await storage.set(PAC_FRESHNESS_KEY, {
      sourceKey: getPacSourceKey(this.currentPacProviderKey, this.customPacUrl),
      lastPacUpdateStamp,
      providerUpdateStamps: { ...providerUpdateStamps },
    });
  }

  async downloadPacFromProvider(provider, customUrlCandidate = null, signal = null) {
    if (!provider) {
      throw new Error(t("msg_the_provider_has_no_available_pac_script_urls_2fd9695a", "У провайдера нет доступных адресов PAC-скрипта"));
    }

    let urls = provider.pacUrls || [];
    if (provider.distinctKey === 'customPacUrl') {
      const targetUrl = customUrlCandidate || this.customPacUrl;
      const validation = utils.validatePacUrl(targetUrl);
      if (!validation.valid) {
        throw new Error(validation.error || t("msg_enter_a_valid_url_for_your_custom_pac_script_4ce9e844", "Не указан корректный URL для своего PAC-скрипта"));
      }
      urls = [validation.sanitizedUrl];
    }

    if (!urls.length) {
      throw new Error(t("msg_the_provider_has_no_available_pac_script_urls_2fd9695a", "У провайдера нет доступных адресов PAC-скрипта"));
    }

    let lastErr = null;
    for (const url of urls) {
      if (signal?.aborted) throw new SyncSupersededError();
      if (url.startsWith('data:')) {
        const decoded = decodeURIComponent(url.replace('data:application/x-ns-proxy-autoconfig,', ''));
        const validation = validatePacScriptSource(decoded);
        if (!validation.valid) throw new Error(validation.error);
        return decoded;
      }
      try {
        const text = await httpLib.get(url, {
          signal,
          timeoutMs: provider.timeoutMs || 15000,
          maxBytes: provider.maxBytes || MAX_CUSTOM_PAC_BYTES,
          validateFinalUrl: (finalUrl) => {
            const validation = utils.validatePacResponseUrl(url, finalUrl);
            if (!validation.valid || !provider.allowedFinalHosts) return validation;

            const finalHost = new URL(validation.sanitizedUrl).hostname.toLowerCase();
            const isAllowedHost = provider.allowedFinalHosts.some((allowedHost) =>
              allowedHost.startsWith('.')
                ? finalHost.endsWith(allowedHost)
                : finalHost === allowedHost
            );
            if (!isAllowedHost) {
              return {
                valid: false,
                error: t("msg_the_pac_provider_redirected_to_an_untrusted_h_4b1fdd0c", "PAC-провайдер перенаправил запрос на недоверенный хост: $1", [finalHost]),
              };
            }
            return validation;
          },
        });
        if (text && text.trim().length > 0) {
          const validation = validatePacScriptSource(text);
          if (!validation.valid) throw new Error(validation.error);
          return text;
        }
        throw new Error(t("msg_the_server_returned_an_empty_pac_script_a50f943f", "Сервер вернул пустой PAC-скрипт"));
      } catch (err) {
        if (signal?.aborted) throw new SyncSupersededError();
        lastErr = err;
        console.warn(`Failed to fetch PAC from ${url}:`, err);
      }
    }

    throw clarify(
      lastErr || new Error(t("msg_all_urls_are_unavailable_ea2246cd", "Все адреса недоступны")),
      t("msg_failed_to_download_the_pac_script_from_sub_d83eb735", "Не удалось загрузить PAC-скрипт с адресов: $1", [urls.join(', ')])
    );
  }

  async applyPacData(candidateRawData, options = {}) {
    this._proxyMutationDepth++;
    try {
      return await this._applyPacData(candidateRawData, options);
    } finally {
      this._proxyMutationDepth--;
    }
  }

  async _applyPacData(candidateRawData, { expectedSyncGeneration = null } = {}) {
    const ensureCurrentSync = () => {
      if (expectedSyncGeneration !== null && expectedSyncGeneration !== this._syncGeneration) {
        throw new SyncSupersededError();
      }
    };

    const validation = validatePacScriptSource(candidateRawData);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const pacMods = await pacKitchen.getPacMods();
    ensureCurrentSync();
    const candidateCooked = cookPac(candidateRawData, pacMods);

    const isProxyOrDie = pacMods && pacMods.ifProxyOrDie !== false;

    await withProxySettingsLock(async () => {
      ensureCurrentSync();
      const previousDetails = await assertProxySettingsControllable();
      ensureCurrentSync();
      const alreadyApplied = previousDetails.levelOfControl === 'controlled_by_this_extension' &&
        proxyBackend.isExpectedPacApplied(previousDetails, candidateCooked) &&
        (proxyBackend.platform === 'firefox' || Boolean(previousDetails.value?.pacScript?.mandatory) === Boolean(isProxyOrDie));
      if (!alreadyApplied) {
        await proxyBackend.applyPac(candidateCooked, { mandatory: Boolean(isProxyOrDie) });
      }

      try {
        ensureCurrentSync();
      } catch (err) {
        // A reset or a newer sync may supersede this request while Chrome is
        // applying the PAC. Restore the exact setting observed under the same
        // lock before allowing the stale operation to escape.
        await proxyBackend.restore(previousDetails);
        throw err;
      }
    });

    // Transaction Commit on success
    this.revision++;
    this.rawPacData = candidateRawData;
    this.cookedPacData = candidateCooked;
    await applicationState.applied(pacMods.revision || 0).catch(error => {
      console.warn('[Settings] Could not checkpoint applied revision:', error.message);
    });
    try {
      ipToHost.updateFromPac(candidateRawData);
      await ipToHost.persistData();
    } catch {
      // Non-critical
    }
    await this.updateControlState();
  }

  _isSameSyncRequest(optA, optB) {
    if (!optA || !optB) return false;
    return (
      (optA.key || '') === (optB.key || '') &&
      (optA.customUrl || '') === (optB.customUrl || '') &&
      Boolean(optA.ifUnattended) === Boolean(optB.ifUnattended) &&
      optA.generation === optB.generation
    );
  }

  async syncWithPacProvider(options = {}) {
    const opts = typeof options === 'string' ? { key: options } : (options || {});
    const key = opts.key || this.currentPacProviderKey;
    const customUrl = opts.customUrl || null;
    const ifUnattended = Boolean(opts.ifUnattended);
    const requestOptions = {
      key,
      customUrl,
      ifUnattended,
      generation: this._syncGeneration,
    };

    // If no sync is currently in-flight, start the execution loop immediately
    if (!this._isSyncRunning) {
      this._isSyncRunning = true;
      this.isSyncing = true;
      this._currentSyncPromise = this._runSyncLoop(requestOptions);
      try {
        return await this._currentSyncPromise;
      } finally {
        this._isSyncRunning = false;
        this.isSyncing = false;
        this._currentSyncPromise = null;
        this._currentRunningOptions = null;
      }
    }

    // A sync is currently in progress.
    // If this request is identical to the current running request AND there is no pending request yet, await it.
    if (!this._pendingSync && this._isSameSyncRequest(this._currentRunningOptions, requestOptions)) {
      return this._currentSyncPromise;
    }

    // Otherwise, enqueue as the latest desired pending request (replaces any older pending request)
    return new Promise((resolve, reject) => {
      if (this._pendingSync) {
        if (this._isSameSyncRequest(this._pendingSync.options, requestOptions)) {
          this._pendingSync.deferreds.push({ resolve, reject });
          return;
        }
        // Update to the newer desired request and attach deferreds
        this._pendingSync.options = requestOptions;
        this._pendingSync.deferreds.push({ resolve, reject });
      } else {
        this._pendingSync = {
          options: requestOptions,
          deferreds: [{ resolve, reject }],
        };
      }
    });
  }

  async _runSyncLoop(initialOptions) {
    let nextOptions = initialOptions;
    let initialCallerError = null;
    let pendingDeferredsToResolve = [];

    while (nextOptions) {
      this._currentRunningOptions = nextOptions;

      if (this._pendingSync && this._isSameSyncRequest(this._pendingSync.options, nextOptions)) {
        pendingDeferredsToResolve.push(...this._pendingSync.deferreds);
        this._pendingSync = null;
      }

      let stepError = null;
      try {
        await this._performSync(nextOptions);
        for (const d of pendingDeferredsToResolve) {
          d.resolve();
        }
      } catch (err) {
        stepError = err;
        for (const d of pendingDeferredsToResolve) {
          d.reject(err);
        }
      }
      pendingDeferredsToResolve = [];

      if (nextOptions === initialOptions) {
        initialCallerError = stepError;
      }

      // Check if another pending request arrived while executing this step
      if (this._pendingSync) {
        const pending = this._pendingSync;
        this._pendingSync = null;
        nextOptions = pending.options;
        pendingDeferredsToResolve = pending.deferreds;
      } else {
        nextOptions = null;
      }
    }

    if (initialCallerError && !initialOptions.ifUnattended) {
      throw initialCallerError;
    }
  }

  async _performSync({
    key = this.currentPacProviderKey,
    customUrl = null,
    ifUnattended = false,
    generation = this._syncGeneration,
  } = {}) {
    if (key === 'none' || !key) {
      await this.clearPac();
      return;
    }

    const provider = PAC_PROVIDERS[key];
    if (!provider) {
      throw new Error(t("msg_unknown_pac_provider_sub_0b6f9cf5", "Неизвестный провайдер PAC: $1", [key]));
    }

    this.lastError = null;
    const previousState = this._createStateSnapshot();
    let appliedRevision = null;

    try {
      console.log(`[PAC Sync] Downloading PAC for provider "${key}"...`);
      const controller = new AbortController();
      this._downloadController = controller;
      let candidateRaw;
      try {
        candidateRaw = await this.downloadPacFromProvider(provider, customUrl, controller.signal);
      } finally {
        // A cancelled older download may finish after a newer sync starts.
        if (this._downloadController === controller) this._downloadController = null;
      }
      if (generation !== this._syncGeneration) {
        throw new SyncSupersededError();
      }

      const requestedCustomUrl = key === 'customPacUrl'
        ? String(customUrl || this.customPacUrl || '').trim()
        : '';
      const isSameSource = key === this.currentPacProviderKey && (
        key !== 'customPacUrl' || requestedCustomUrl === String(this.customPacUrl || '').trim()
      );
      if (isSameSource && candidateRaw === this.rawPacData && this.isExpectedPacApplied) {
        const now = Date.now();
        const nextProviderUpdateStamps = {
          ...this.providerUpdateStamps,
          [key]: now,
        };
        await this.persistFreshness({
          lastPacUpdateStamp: now,
          providerUpdateStamps: nextProviderUpdateStamps,
        });
        this.lastPacUpdateStamp = now;
        this.providerUpdateStamps = nextProviderUpdateStamps;
        this.updateTitle();
        console.log('[PAC Sync] PAC script is unchanged; keeping the active proxy configuration.');
        logger.info('pac', t("msg_pac_script_sub_is_already_up_to_date_d473bbb4", "PAC-скрипт \"$1\" уже актуален", [PAC_PROVIDERS[key]?.label || key]), t("msg_no_need_to_apply_again_4b0aed8f", "Повторное применение не требуется"), {
          provider: key,
          lastPacUpdateStamp: now,
        });
        return;
      }

      console.log('[PAC Sync] Cooking and applying PAC script...');
      await this.applyPacData(candidateRaw, { expectedSyncGeneration: generation });
      appliedRevision = this.revision;
      if (generation !== this._syncGeneration) {
        throw new SyncSupersededError();
      }

      this.currentPacProviderKey = key;
      if (key === 'customPacUrl' && customUrl) {
        this.customPacUrl = customUrl.trim();
      }

      const now = Date.now();
      this.lastPacUpdateStamp = now;
      this.providerUpdateStamps[key] = now;
      await this.persistState();

      console.log('[PAC Sync] Successfully updated PAC!');
      logger.info('pac', t("msg_pac_script_sub_updated_successfully_6de11e5c", "PAC-скрипт \"$1\" успешно обновлён", [PAC_PROVIDERS[key]?.label || key]), t("msg_pac_size_sub_kb_c27da43e", "Размер PAC: $1 КБ", [(candidateRaw.length / 1024).toFixed(1)]), {
        provider: key,
        lastPacUpdateStamp: now,
      });
    } catch (err) {
      if (err instanceof SyncSupersededError) {
        throw err;
      }
      if (appliedRevision !== null && this.revision === appliedRevision) {
        try {
          await this._rollbackPacState(previousState);
        } catch (rollbackErr) {
          console.error('[PAC Sync] Failed to roll back an uncommitted PAC update:', rollbackErr);
        }
      }
      this.lastError = err;
      const errorMsg = formatErrorMessage(err) || err.message || String(err);
      console.warn(`[PAC Sync Warning for "${key}"]:`, errorMsg);
      logger.error('pac', t("msg_pac_synchronization_failed_for_sub_90d01013", "Ошибка синхронизации PAC \"$1\"", [PAC_PROVIDERS[key]?.label || key]), errorMsg, {
        provider: key,
        ifUnattended,
        error: errorMsg,
      });
      if (!ifUnattended) {
        const publicError = new Error(errorMsg);
        publicError.code = getErrorCode(err);
        throw publicError;
      }
    }
  }

  async installPac(key, customUrl = null) {
    this.cancelPendingSync();
    await this.syncWithPacProvider({ key, customUrl, ifUnattended: false });
  }

  cancelPendingSync() {
    this._syncGeneration++;
    this._downloadController?.abort();
    if (this._pendingSync) {
      const error = new SyncSupersededError();
      this._pendingSync.deferreds.forEach(({ reject }) => reject(error));
      this._pendingSync = null;
    }
  }

  async setRawPacData(candidateRawData) {
    this.cancelPendingSync();
    const previousState = this._createStateSnapshot();
    await this.applyPacData(candidateRawData, { expectedSyncGeneration: this._syncGeneration });
    const appliedRevision = this.revision;
    try {
      await this.persistState();
    } catch (err) {
      if (this.revision === appliedRevision) {
        try {
          await this._rollbackPacState(previousState);
        } catch (rollbackErr) {
          console.error('[PAC Sync] Failed to roll back uncommitted raw PAC data:', rollbackErr);
        }
      }
      throw err;
    }
  }

  async clearPac(options = {}) {
    this.cancelPendingSync();
    this._proxyMutationDepth++;
    try {
      return await this._clearPac(options);
    } finally {
      this._proxyMutationDepth--;
    }
  }

  async _clearPac({ persist = true } = {}) {
    const previousState = this._createStateSnapshot();
    let previousDetails = null;
    await withProxySettingsLock(async () => {
      previousDetails = await assertProxySettingsControllable();
      return proxyBackend.clear();
    });

    // Transaction Commit on success
    this.revision++;
    this.currentPacProviderKey = 'none';
    this.rawPacData = '';
    this.cookedPacData = '';
    if (persist) {
      const clearedRevision = this.revision;
      try {
        await this.persistState();
      } catch (err) {
        if (this.revision === clearedRevision) {
          try {
            await withProxySettingsLock(async () => {
              await assertProxySettingsControllable();
              if (!previousDetails) return;
              await proxyBackend.restore(previousDetails);
            });
          } catch (rollbackErr) {
            console.error('[PAC Sync] Failed to roll back an uncommitted clear:', rollbackErr);
          }
          this.revision++;
          this._restoreStateSnapshot(previousState);
        }
        await this.updateControlState();
        throw err;
      }
    }
    await this.updateControlState();
  }

  async reapplyCurrentPac() {
    const generation = this._syncGeneration;
    this.revision++;
    if (this.currentPacProviderKey === 'none' || !this.currentPacProviderKey) {
      return withProxySettingsLock(async () => {
        await assertProxySettingsControllable();
        await proxyBackend.clear();
        await this.updateControlState();
      });
    }
    if (this.rawPacData) {
      await this.applyPacData(this.rawPacData, { expectedSyncGeneration: generation });
    } else {
      await this.syncWithPacProvider({ key: this.currentPacProviderKey, ifUnattended: true });
    }
  }

  async getPacScriptDetails() {
    await this.loadLocalState();
    const details = await proxyBackend.getSettings();
    const active = details?.levelOfControl === 'controlled_by_this_extension' ?
      details.value?.pacScript?.data || details.backendSnapshot?.pacData || '' : '';
    const cookedPacData = active || (this.rawPacData ? cookPac(this.rawPacData, await pacKitchen.getPacMods()) : '');
    return { rawPacData: this.rawPacData, cookedPacData, currentProvider: this.currentPacProviderKey,
      scriptKind: active ? 'applied' : cookedPacData ? 'preview' : 'none' };
  }

  getState() {
    return {
      currentPacProviderKey: this.currentPacProviderKey,
      customPacUrl: this.customPacUrl,
      lastPacUpdateStamp: this.lastPacUpdateStamp,
      providerUpdateStamps: this.providerUpdateStamps,
      isSyncing: this.isSyncing,
      isControlled: this.isControlled,
      isControllable: this.isControllable,
      levelOfControl: this.levelOfControl,
      lastError: this.lastError ? this.lastError.message : null,
      lastErrorCode: getErrorCode(this.lastError) || null,
      providers: PAC_PROVIDERS,
      hasPacData: Boolean(this.rawPacData),
      revision: this.revision,
    };
  }
}

export const pacSync = new PacSyncManager();
