'use strict';

import { t } from './i18n.js';

import { utils } from './utils.js';
import { registerTemporaryCredentials, unregisterTemporaryCredentials } from './proxy-auth.js';
import { logger } from './logger.js';
import { pacSync } from './pac-sync.js';
import { pacKitchen } from './pac-kitchen.js';
import { cookPac } from './pac-script.js';
import {
  assertProxySettingsControllable,
  withProxySettingsLock,
} from './proxy-settings-lock.js';
import { proxyBackend } from './proxy-backend.js';

// Mutex queue to serialize health check probes and prevent race conditions on chrome.proxy.settings
let checkQueue = Promise.resolve();
let probeGeneration = 0;
let activeProbeController = null;

export function cancelProxyChecks() {
  probeGeneration++;
  activeProbeController?.abort();
}

/**
 * Constructs a layered Health Check PAC script that intercepts probe hostnames to route
 * through candidate test proxy, while delegating ALL other browser traffic to the original FindProxyForURL.
 *
 * NOTE: Uses variable assignment binding (FindProxyForURL = function(...) { ... }) instead of
 * a function declaration to prevent JavaScript hoisting from breaking the reference to the original function.
 */
export function generateHealthCheckPac(basePacScript, testProxyScheme) {
  const base = (basePacScript && basePacScript.trim())
    ? basePacScript
    : 'function FindProxyForURL(url, host) { return "DIRECT"; }';

  return `
${base}

var __originalFindProxyForURL = (typeof FindProxyForURL === 'function')
  ? FindProxyForURL
  : function(url, host) { return "DIRECT"; };

FindProxyForURL = function(url, host) {
  if (host === '1.1.1.1') {
    return ${JSON.stringify(testProxyScheme)};
  }
  return __originalFindProxyForURL(url, host);
};
`;
}

/**
 * Proxy Health Checker for Chromium and Firefox MV3
 * Safely executes health probes without disrupting active browser traffic, delegating non-probe
 * requests to the active PAC script and ensuring zero secret/password leakage into diagnostic logs.
 */
export function checkProxyHealth(proxyString) {
  const generation = probeGeneration;
  const ensureCurrent = () => {
    if (generation !== probeGeneration) throw new Error(t("msg_the_proxy_check_was_cancelled_by_a_settings_r_5b7a1cfb", "Проверка прокси отменена сбросом настроек"));
  };
  const run = () => withProxySettingsLock(() => {
    ensureCurrent();
    return executeSingleProxyHealthCheck(proxyString, ensureCurrent);
  });
  const resultPromise = checkQueue.then(run, run);
  checkQueue = resultPromise.catch(() => {});
  return resultPromise;
}

/**
 * Internal execution of a single proxy health probe with PAC delegation and revision safety
 */
async function executeSingleProxyHealthCheck(proxyString, ensureCurrent) {
  if (!proxyString || !proxyString.trim()) {
    logger.warn('proxy', t("msg_proxy_check_empty_address_2d604bfe", "Проверка прокси: пустая строка"), t("msg_the_proxy_address_is_empty_6d75e286", "Передана пустая строка адреса прокси"));
    return { ok: false, error: t("msg_empty_proxy_address_2a5b2c86", "Пустая строка прокси") };
  }

  const parsed = utils.parseProxyScheme(proxyString);
  if (!parsed || !parsed.hostname || !parsed.port) {
    logger.warn('proxy', t("msg_proxy_check_invalid_format_3942c068", "Проверка прокси: неверный формат"), t("msg_a_host_or_port_is_missing_from_the_proxy_addr_8deb1d83", "Не указан хост или порт для проверяемого прокси"));
    return { ok: false, error: t("msg_host_or_port_is_missing_b4bbf9e7", "Не указан хост или порт") };
  }

  const portNum = parseInt(parsed.port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    logger.warn('proxy', t("msg_proxy_check_invalid_port_57f77bbb", "Проверка прокси: неверный порт"), t("msg_port_sub_is_outside_the_valid_range_1_65535_d383d658", "Номер порта $1 вне диапазона (1-65535)", [parsed.port]));
    return { ok: false, error: t("msg_invalid_port_number_1_65535_48da3c6b", "Неверный номер порта (1-65535)") };
  }

  // Safe sanitized proxy metadata for diagnostic logging (NEVER logs credentials)
  const proxyMeta = {
    scheme: parsed.type || 'unknown',
    host: parsed.hostname || 'unknown',
    port: parsed.port || 'unknown',
    hasAuth: Boolean(parsed.username),
  };

  const rawType = parsed.type.toUpperCase();
  if (parsed.hasAuth && rawType.startsWith('SOCKS')) {
    const msg = t("msg_browser_proxy_apis_do_not_support_socks4_sock_18db49ba", "Прокси-API браузера не поддерживает авторизацию по логину и паролю для SOCKS4/SOCKS5 — ни в Chromium, ни в Firefox");
    logger.warn('auth', t("msg_unsupported_socks_authentication_ccd8cae5", "Неподдерживаемая авторизация SOCKS"), msg, proxyMeta);
    return { ok: false, error: msg };
  }

  // 1. Map protocol to PAC keyword
  // P1.3: Use explicit isSocks flag instead of fragile includes(';') detection
  let pacKeyword;
  let isSocks = false;

  if (rawType === 'HTTP') {
    pacKeyword = 'PROXY';
  } else if (rawType === 'SOCKS4') {
    pacKeyword = 'SOCKS';
  } else if (rawType === 'SOCKS5' || rawType === 'SOCKS') {
    isSocks = true;
  } else {
    pacKeyword = rawType; // HTTPS or other
  }

  const testProxyScheme = isSocks
    ? `SOCKS5 ${parsed.hostname}:${parsed.port}; SOCKS ${parsed.hostname}:${parsed.port}`
    : `${pacKeyword} ${parsed.hostname}:${parsed.port}`;

  // 2. Resolve active base PAC script with full top-level scope preservation
  let basePacScript = '';
  if (pacSync.currentPacProviderKey !== 'none') {
    if (pacSync.cookedPacData) {
      basePacScript = pacSync.cookedPacData;
    } else if (pacSync.rawPacData) {
      try {
        const pacMods = await pacKitchen.getPacMods();
        basePacScript = cookPac(pacSync.rawPacData, pacMods);
      } catch {
        basePacScript = pacSync.rawPacData;
      }
    }
  }
  if (!basePacScript || !basePacScript.trim()) {
    basePacScript = 'function FindProxyForURL(url, host) { return "DIRECT"; }';
  }

  // 3. Construct layered Test PAC via generateHealthCheckPac
  const testPac = generateHealthCheckPac(basePacScript, testProxyScheme);

  const activeMods = await pacKitchen.getPacMods();
  const startTime = Date.now();
  let result = null;
  let restorationError = null;
  const previousDetails = await assertProxySettingsControllable();
  ensureCurrent();
  const snapshot = previousDetails.backendSnapshot;
  if (snapshot?.wasControlledByThisExtension && !snapshot.pacData &&
      snapshot.nativeValue?.proxyType === 'autoConfig' && /^blob:/i.test(snapshot.nativeValue.autoConfigUrl || '')) {
    // After an event-page restart the old Blob cannot be restored. Do not
    // replace it with a temporary probe whose rollback would be impossible.
    throw new Error(t('firefoxPacRestoreUnavailable', 'Исходный код PAC Firefox недоступен. Повторно примените PAC в настройках.'));
  }

  // All asynchronous preflight steps are complete. Register credentials only
  // for the short interval in which the probe PAC may challenge for auth.
  if (parsed.username) {
    registerTemporaryCredentials(parsed.hostname, parsed.port, parsed.username, parsed.password);
  }

  const controller = new AbortController();
  activeProbeController = controller;
  try {
    // Apply layered test proxy configuration
    await assertProxySettingsControllable();
    ensureCurrent();
    await proxyBackend.applyPac(testPac, {
      mandatory: activeMods.ifProxyOrDie !== false,
    });
    ensureCurrent();

    // Execute probe fetch with timeout
    const timeoutMs = 5000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const probeUrl = `https://1.1.1.1/cdn-cgi/trace?_probe=${Date.now()}`;
      const res = await fetch(probeUrl, {
        cache: 'no-store',
        signal: controller.signal,
      });

      clearTimeout(timer);
      ensureCurrent();

      if (res && (res.status === 200 || res.status === 204)) {
        const latency = Date.now() - startTime;
        result = { ok: true, latency };
      } else if (res && res.status === 407) {
        const msg = t("msg_proxy_authentication_failed_407_proxy_authent_369d0eb4", "Ошибка авторизации (407 Proxy Authentication Required): неверный логин или пароль");
        logger.warn('auth', t("msg_proxy_authentication_failed_407_f81ecb68", "Ошибка авторизации прокси (407)"), msg, proxyMeta);
        result = { ok: false, error: msg };
      } else {
        const msg = t("msg_the_server_returned_http_status_sub_e243638d", "Сервер вернул статус HTTP $1", [res ? res.status : t("msg_no_response_6947861c", "нет ответа")]);
        logger.warn('proxy', t("msg_the_proxy_returned_an_invalid_status_c76b5be9", "Прокси вернул некорректный статус"), msg, { ...proxyMeta, status: res ? res.status : null });
        result = { ok: false, error: msg };
      }
    } catch (fetchErr) {
      clearTimeout(timer);
      ensureCurrent();
      if (fetchErr.name === 'AbortError') {
        const msg = t("msg_timeout_the_proxy_server_did_not_respond_with_0c5f062e", "Таймаут: прокси-сервер не ответил за 5 секунд");
        logger.warn('proxy', t("msg_proxy_connection_timed_out_a443899a", "Таймаут подключения к прокси"), msg, proxyMeta);
        result = { ok: false, error: msg };
      } else {
        const errStr = (fetchErr.message || String(fetchErr)).toLowerCase();
        let msg = '';
        if (errStr.includes('407') || errStr.includes('auth')) {
          msg = t("msg_authentication_failed_407_incorrect_username__4a9eba6e", "Ошибка авторизации (407): неверный логин или пароль");
          logger.warn('auth', t("msg_authentication_failed_79fb3249", "Ошибка авторизации"), msg, proxyMeta);
        } else if (errStr.includes('cert') || errStr.includes('tls') || errStr.includes('ssl')) {
          msg = t("msg_tls_ssl_error_if_your_local_proxy_does_not_us_fffbdb88", "Ошибка TLS/SSL: если ваш локальный прокси без SSL, выберите протокол HTTP вместо HTTPS");
          logger.warn('proxy', t("msg_proxy_ssl_tls_error_a5e9fedd", "Ошибка SSL/TLS прокси"), msg, { ...proxyMeta, error: fetchErr.message });
        } else {
          msg = t("msg_cannot_connect_to_the_proxy_check_that_the_se_95fe5d54", "Не удалось подключиться к прокси. Убедитесь, что сервер запущен и выбран правильный протокол (HTTP/HTTPS/SOCKS5)");
          logger.warn('proxy', t("msg_proxy_connection_failed_ee759242", "Сбой подключения к прокси"), msg, { ...proxyMeta, error: fetchErr.message });
        }
        result = { ok: false, error: msg };
      }
    }
  } finally {
    // 4. Restore exactly what was active before the probe. Permanent proxy
    // changes wait on the same lock and will run immediately afterwards.
    try {
      await assertProxySettingsControllable();
      await proxyBackend.restore(previousDetails);
    } catch (restoreErr) {
      const msg = t("msg_failed_to_restore_proxy_settings_after_the_ch_53688b8c", "Не удалось восстановить настройки прокси после проверки: $1", [restoreErr.message || restoreErr]);
      logger.error('proxy', t("msg_critical_proxy_restoration_error_1ab48bfb", "Критическая ошибка восстановления прокси"), msg);
      restorationError = new Error(msg);
    }
    if (parsed.username) {
      unregisterTemporaryCredentials(parsed.hostname, parsed.port);
    }
    if (activeProbeController === controller) activeProbeController = null;
  }

  if (restorationError) throw restorationError;
  return result || { ok: false, error: t("msg_unknown_check_error_4cf33ab7", "Неизвестная ошибка проверки") };
}
