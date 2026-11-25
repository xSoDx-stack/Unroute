'use strict';

import { t } from './i18n.js';

import { storage } from './storage.js';
import { logger, sanitizeLogData, sanitizeLogString } from './logger.js';
import { proxyBackend } from './proxy-backend.js';
import { diagnoseBrowserProxyError } from './proxy-diagnostics.js';

const HANDLERS_STATE_KEY = 'handlers-state';
const LAST_ERRORS_MAX = 30;
const PROXY_ERROR_THROTTLE_MS = 5000;
const NOTIFICATION_KEYS = ['pac-error', 'ext-error', 'no-control'];
const HARD_PROXY_CONTROL_LEVELS = new Set([
  'controlled_by_other_extensions',
  'not_controllable',
]);

export function isHardProxyControlConflict({
  isControlled = false,
  isControllable = false,
  expectedControl = false,
  levelOfControl = 'unknown',
} = {}) {
  return expectedControl &&
    !isControlled &&
    !isControllable &&
    HARD_PROXY_CONTROL_LEVELS.has(levelOfControl);
}

function getControlLossMessage(levelOfControl) {
  if (levelOfControl === 'controlled_by_other_extensions') {
    return t("msg_another_extension_with_higher_priority_has_ta_1eaed9f7", "Настройки прокси перехвачены другим расширением с более высоким приоритетом.");
  }
  if (levelOfControl === 'not_controllable') {
    return t("msg_proxy_settings_are_locked_by_browser_policy_o_73ef93ce", "Настройки прокси заблокированы политикой или параметрами браузера.");
  }
  return t("msg_the_extension_cannot_control_proxy_settings_b5feb167", "Расширение не может управлять настройками прокси.");
}

class ErrorHandlersManager {
  #initPromise = null;
  #stateQueue = Promise.resolve();
  #generation = 0;

  constructor() {
    this.lastErrors = [];
    this.notificationsEnabled = {
      'pac-error': true,
      'ext-error': true,
      'no-control': true,
    };
    this.isInitialized = false;
    this._listenersRegistered = false;
    this._noControlActive = false;
    this._lastProxyErrorSignature = '';
    this._lastProxyErrorAt = 0;
    this._contextProvider = null;
  }

  setDiagnosticContextProvider(provider) {
    this._contextProvider = typeof provider === 'function' ? provider : null;
  }

  setupListeners(ensureReady = null) {
    if (this._listenersRegistered) return;

    const handleWhenReady = (handle) => ensureReady
      ? ensureReady().then(handle).catch(error => console.warn('[Error Handlers] Failed to process diagnostic event:', error))
      : handle();
    proxyBackend.addErrorListener(details => handleWhenReady(() => this.handleProxyError(details)));

    if (chrome.notifications && chrome.notifications.onClicked &&
        (typeof chrome.notifications.onClicked.hasListeners !== 'function' || !chrome.notifications.onClicked.hasListeners())) {
      chrome.notifications.onClicked.addListener((notId) => {
        chrome.notifications.clear(notId);
      });
    }

    if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
      self.addEventListener('error', (event) => {
        return handleWhenReady(() => this.handleExtensionError(event.error || event.message || t("msg_unknown_error_2d55ddef", "Неизвестная ошибка")));
      });
      self.addEventListener('unhandledrejection', (event) => {
        return handleWhenReady(() => this.handleExtensionError(event.reason || t("msg_unhandled_promise_rejection_9d88667c", "Необработанная ошибка Promise")));
      });
    }

    this._listenersRegistered = true;
  }

  init() {
    if (this.isInitialized) return Promise.resolve();
    if (this.#initPromise) return this.#initPromise;
    const generation = this.#generation;
    this.#initPromise = this.#stateQueue.then(async () => {
      if (generation !== this.#generation) return;
      this.setupListeners();
      const saved = await storage.get(HANDLERS_STATE_KEY, null);
      if (generation !== this.#generation) return;
      this.#restoreState(saved);
      this.isInitialized = true;
    }).catch(error => {
      if (generation === this.#generation) this.#initPromise = null;
      throw error;
    });
    return this.#initPromise;
  }

  #restoreState(saved) {
    if (saved && typeof saved === 'object') {
      const savedNotifications = saved.notificationsEnabled &&
        typeof saved.notificationsEnabled === 'object'
        ? saved.notificationsEnabled
        : saved;
      for (const key of NOTIFICATION_KEYS) {
        if (typeof savedNotifications[key] === 'boolean') {
          this.notificationsEnabled[key] = savedNotifications[key];
        }
      }
      this._noControlActive = saved.noControlActive === true;
    }
  }

  #mutateState(mutate) {
    const generation = this.#generation;
    const ready = this.init();
    const result = this.#stateQueue.then(async () => {
      await ready;
      if (generation === this.#generation) await mutate(generation);
    });
    this.#stateQueue = result.catch(() => {});
    return result;
  }

  async _persistState() {
    await storage.set(HANDLERS_STATE_KEY, {
      notificationsEnabled: { ...this.notificationsEnabled },
      noControlActive: this._noControlActive,
    });
  }

  handleProxyError(details) {
    const safeDetails = sanitizeLogData(details || {});
    const signature = JSON.stringify([
      safeDetails.error || '',
      safeDetails.details || '',
      Boolean(safeDetails.fatal),
    ]);
    const now = Date.now();
    if (signature === this._lastProxyErrorSignature &&
        now - this._lastProxyErrorAt < PROXY_ERROR_THROTTLE_MS) {
      return;
    }
    this._lastProxyErrorSignature = signature;
    this._lastProxyErrorAt = now;

    console.warn('[Proxy Error]:', safeDetails);
    const errItem = {
      type: 'proxy',
      error: safeDetails.error || 'Proxy error',
      details: safeDetails.details || '',
      fatal: safeDetails.fatal || false,
      timestamp: now,
    };
    this.addError(errItem);

    let context = {};
    try {
      context = this._contextProvider ? (this._contextProvider() || {}) : {};
    } catch {
      context = {};
    }
    const diagnosed = diagnoseBrowserProxyError({
      safeDetails,
      mods: context.mods || null,
      pacProviderKey: context.pacProviderKey || '',
      customPacUrl: context.customPacUrl || '',
    });

    logger.add({
      level: safeDetails.fatal ? 'error' : 'warn',
      category: diagnosed.category,
      title: diagnosed.title,
      message: diagnosed.message,
      details: diagnosed.details,
    });

    if (this.notificationsEnabled['pac-error']) {
      this.notify(
        'pac-error',
        diagnosed.title,
        diagnosed.message
      );
    }
  }

  addError(errObj) {
    this.lastErrors.unshift(errObj);
    if (this.lastErrors.length > LAST_ERRORS_MAX) {
      this.lastErrors.pop();
    }
  }

  notify(id, title, message) {
    if (!chrome.notifications) return;
    let iconName = 'default-128.png';
    if (id === 'pac-error') iconName = 'pac-error-128.png';
    else if (id === 'ext-error') iconName = 'ext-error-128.png';
    else if (id === 'no-control') iconName = 'no-control-128.png';

    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL(`icons/${iconName}`),
      title,
      message: String(message),
      priority: 1,
    }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  }

  async setNotificationOption(key, enabled) {
    if (!NOTIFICATION_KEYS.includes(key)) {
      throw new TypeError('Invalid notification option');
    }
    await this.#mutateState(() => {
      this.notificationsEnabled[key] = Boolean(enabled);
      return this._persistState();
    });
  }

  handleExtensionError(error) {
    const rawMessage = error && error.message ? error.message : String(error || t("msg_unknown_error_2d55ddef", "Неизвестная ошибка"));
    const message = sanitizeLogString(rawMessage);
    this.addError({
      type: 'extension',
      error: message,
      timestamp: Date.now(),
    });
    logger.error('system', t("msg_unexpected_extension_error_7188d268", "Непредвиденная ошибка расширения"), message);
    if (this.notificationsEnabled['ext-error']) {
      this.notify('ext-error', t("msg_extension_error_6ed6d859", "Ошибка расширения"), message);
    }
  }

  async handleControlState({
    isControlled = false,
    isControllable = false,
    expectedControl = false,
    levelOfControl = 'unknown',
  } = {}) {
    const hasHardConflict = isHardProxyControlConflict({
      isControlled,
      isControllable,
      expectedControl,
      levelOfControl,
    });
    try {
      await this.#mutateState(generation => this.#applyControlState(hasHardConflict, levelOfControl, generation));
    } catch (error) {
      console.warn('[Error Handlers] Failed to report proxy control state:', error);
    }
  }

  async #applyControlState(hasHardConflict, levelOfControl, generation) {
    if (!hasHardConflict) {
      if (this._noControlActive) {
        this._noControlActive = false;
        try {
          await this._persistState();
        } catch (err) {
          console.warn('[Error Handlers] Failed to persist restored proxy control:', err);
        }
        if (generation === this.#generation && chrome.notifications?.clear) {
          chrome.notifications.clear('no-control', () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        }
      }
      return;
    }
    if (this._noControlActive) return;
    this._noControlActive = true;

    try {
      await this._persistState();
    } catch (err) {
      console.warn('[Error Handlers] Failed to persist lost proxy control:', err);
    }

    if (generation !== this.#generation) return;
    const message = getControlLossMessage(levelOfControl);
    this.addError({
      type: 'no-control',
      error: message,
      timestamp: Date.now(),
    });
    logger.add({
      level: 'warn',
      category: 'system',
      title: t("msg_lost_control_of_proxy_settings_bbe730b5", "Утерян контроль настроек прокси"),
      message,
      details: { levelOfControl },
    });
    if (this.notificationsEnabled['no-control']) {
      this.notify('no-control', t("msg_lost_proxy_control_425ac1cb", "Утерян контроль прокси"), message);
    }
  }

  resetRuntimeState() {
    this.#generation++;
    this.#initPromise = null;
    this.lastErrors = [];
    this.notificationsEnabled = {
      'pac-error': true,
      'ext-error': true,
      'no-control': true,
    };
    this._noControlActive = false;
    this._lastProxyErrorSignature = '';
    this._lastProxyErrorAt = 0;
    this.isInitialized = false;
  }

  getLastErrors() {
    return this.lastErrors;
  }
}

export const errorHandlers = new ErrorHandlersManager();
