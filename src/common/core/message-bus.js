'use strict';

import { t } from './i18n.js';

import { appState } from './app-state.js';
import { pacSync, PAC_PROVIDERS } from './pac-sync.js';
import { pacKitchen } from './pac-kitchen.js';
import { getDefaultConfigs } from './pac-modifiers.js';
import { matchExceptionDomain } from './exception-rules.js';
import { matchConfiguredRule } from './domain-route-resolver.js';
import { errorHandlers } from './error-handlers.js';
import { storage } from './storage.js';
import { APPEARANCE_RESET_KEY, withAppearanceWriteLock } from './appearance-lock.js';
import { httpLib } from './http-lib.js';
import { checkProxyHealth, cancelProxyChecks } from './proxy-checker.js';
import {
  loadProxyHealthCache,
  pruneProxyHealthCache,
  saveProxyHealthResult,
  drainProxyHealthCache,
} from './proxy-health-cache.js';
import {
  checkLocalProxyService,
  getLocalProxyService,
} from './local-proxy-services.js';
import { logger } from './logger.js';
import { formatErrorMessage, getErrorCode } from './errors-lib.js';
import { ipToHost } from './ip-to-host.js';
import { clearProxyAuthAttempts, resetProxyCredentialsState } from './proxy-auth.js';
import { utils } from './utils.js';
import { proxyBackend } from './proxy-backend.js';
import { blockInformer } from './block-informer.js';
import { siteResources } from './site-resources.js';
import { settingsCoordinator } from './settings-coordinator.js';
import { applicationState } from './application-state.js';
import { getProxyCatalog, reconcileProxyProfiles, renameProxyProfile, selectDefaultProxy, deleteProxyProfile } from './proxy-profiles.js';
import { applyDomainRuleMutations, assignDomainProxies, replaceDomainRuleLists } from './domain-rule-mutations.js';
import { normalizeDomainRule } from './domain-rules.js';
import { formatRoutingError } from './routing-errors.js';
import { saveDomainList, deleteDomainList, reorderDomainLists } from './domain-lists.js';

const FALLBACK_CONNECTION_TEST_URL = PAC_PROVIDERS['Антизапрет'].pacUrls[0];
let resetting = false;
let resetGeneration = 0;

export function getConfiguredSiteMatch(host, mods) {
  const match = matchConfiguredRule(host, mods);
  if (match.isPac) return { matched: false };
  if (!match.matched || !match.isProxied) return match;
  const proxyId = match.proxyId ?? mods.domainProxyIds?.[match.ruleKey] ?? null;
  return { ...match, proxyId,
    proxyName: getProxyCatalog(mods).find(profile => profile.id === proxyId)?.name ?? null };
}

export function getRequestedCurrentHost(message = {}) {
  const candidate = typeof message.currentDomain === 'string'
    ? message.currentDomain
    : message.currentHost;
  return typeof candidate === 'string' ? candidate.trim().toLowerCase() : '';
}

export function getConnectionTestUrl(syncState = {}) {
  const providerKey = syncState.currentPacProviderKey || 'Антизапрет';
  if (providerKey === 'customPacUrl' && syncState.customPacUrl) {
    return syncState.customPacUrl;
  }

  const provider = PAC_PROVIDERS[providerKey] || PAC_PROVIDERS['Антизапрет'];
  const providerUrl = provider.pacUrls && provider.pacUrls[0];
  return providerUrl && !providerUrl.startsWith('data:')
    ? providerUrl
    : FALLBACK_CONNECTION_TEST_URL;
}

export function serializePacMods(pacMods = {}, includeExceptions = false) {
  const serialized = {
    ifProxyHttpsUrlsOnly: Boolean(pacMods.ifProxyHttpsUrlsOnly),
    ifUseSecureProxiesOnly: Boolean(pacMods.ifUseSecureProxiesOnly),
    ifProhibitDns: Boolean(pacMods.ifProhibitDns),
    ifProxyOrDie: pacMods.ifProxyOrDie !== false,
    ifUsePacScriptProxies: pacMods.ifUsePacScriptProxies !== false,
    ifUseLocalTor: Boolean(pacMods.ifUseLocalTor),
    ifUseLocalWarp: Boolean(pacMods.ifUseLocalWarp),
    ifMindExceptions: pacMods.ifMindExceptions !== false,
    ifMindWhitelist: Boolean(pacMods.ifMindWhitelist),
    ifUseOwnProxiesOnlyForOwnSites: Boolean(pacMods.ifUseOwnProxiesOnlyForOwnSites),
    customProxyStringRaw: pacMods.customProxyStringRaw || '',
    ifProxyMoreDomains: Boolean(pacMods.ifProxyMoreDomains),
    replaceDirectWith: pacMods.replaceDirectWith || '',
    proxyProfiles: pacMods.proxyProfiles || [],
    proxyCatalog: getProxyCatalog(pacMods),
    defaultProxyId: pacMods.defaultProxyId ?? null,
    proxyCatalogRevision: pacMods.proxyCatalogRevision || 0,
    rulesRevision: pacMods.rulesRevision ?? pacMods.revision ?? 0,
  };
  if (includeExceptions) {
    serialized.exceptions = Object.assign({}, pacMods.exceptions || {});
    serialized.whitelist = [...(pacMods.whitelist || [])];
    serialized.domainProxyIds = { ...(pacMods.domainProxyIds || {}) };
  }
  return serialized;
}

export function getRequestedCurrentTabId(message = {}) {
  const tabId = message.currentTabId;
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

export function removeMatchingExceptionRules(domain, exceptions = {}) {
  const host = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
  const updatedExceptions = Object.assign({}, exceptions || {});
  const removedRuleKeys = [];
  const visitedRuleKeys = new Set();

  if (!host) {
    return {
      exceptions: updatedExceptions,
      removedRuleKeys,
      currentSiteMatch: { matched: false },
    };
  }

  // A host can be covered by several nested rules (for example an exact rule,
  // then *.example.com). "Reset to PAC" means that none of those manual rules
  // may remain effective for the current host.
  const maxMatches = Object.keys(updatedExceptions).length;
  for (let index = 0; index < maxMatches; index += 1) {
    const match = matchExceptionDomain(host, updatedExceptions);
    if (!match.matched || !match.ruleKey || visitedRuleKeys.has(match.ruleKey)) break;
    visitedRuleKeys.add(match.ruleKey);
    removedRuleKeys.push(match.ruleKey);
    delete updatedExceptions[match.ruleKey];
  }

  return {
    exceptions: updatedExceptions,
    removedRuleKeys,
    currentSiteMatch: matchExceptionDomain(host, updatedExceptions),
  };
}

export function createErrorResponse(err) {
  const errorCode = getErrorCode(err);
  const error = formatRoutingError(errorCode) || formatErrorMessage(err) || err?.message || String(err);
  return {
    success: false,
    error,
    ...(errorCode ? { errorCode } : {}),
  };
}

export function setupMessageBus({ checkHealth = checkProxyHealth } = {}) {
  if (chrome.runtime.onMessage.hasListeners && chrome.runtime.onMessage.hasListeners()) {
    return;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender && sender.id && chrome.runtime?.id && sender.id !== chrome.runtime.id) {
      return false;
    }
    if (sender && sender.url && !sender.url.startsWith(chrome.runtime.getURL(''))) {
      return false;
    }

    if (!message || !message.action) {
      return false;
    }

    const handleMessage = async () => {
      const generation = resetGeneration;
      const ensureCurrent = () => {
        if (generation !== resetGeneration) throw new Error(t("msg_the_operation_was_cancelled_by_a_settings_res_5072fc6c", "Операция отменена из-за сброса настроек"));
      };
      if (resetting) throw new Error(t("msg_settings_are_being_reset_please_wait_4d08e3d1", "Выполняется сброс настроек. Дождитесь завершения."));
      if (message.action !== 'RESET_SETTINGS') await appState.ensureLocalStateInitialized();
      ensureCurrent();
      if (resetting) throw new Error(t("msg_settings_are_being_reset_please_wait_4d08e3d1", "Выполняется сброс настроек. Дождитесь завершения."));

      switch (message.action) {
        case 'GET_STATE': {
          const syncState = pacSync.getState();
          const { mods: pacMods, stats: exceptionStats } = await pacKitchen.getSnapshot();
          const proxyList = utils.parseCustomProxies(pacMods.customProxyStringRaw || '')
            .map((proxy) => proxy.raw);
          ensureCurrent();
          const proxyHealthMap = await loadProxyHealthCache(proxyList).catch((err) => {
            console.warn('[Proxy Health] Failed to load cached results:', err);
            return {};
          });
          const configs = getDefaultConfigs();
          const defaultConfigs = {};
          for (const k in configs) {
            defaultConfigs[k] = configs[k].dflt;
          }
          // Derive the counters from the same rules snapshot returned below.
          // This prevents a long-lived Firefox popup from observing a stale
          // statistics cache after the standalone editor changes the lists.

          let currentSiteMatch = null;
          let currentSiteRoute = null;
          const currentHost = getRequestedCurrentHost(message);
          if (currentHost) {
            currentSiteMatch = getConfiguredSiteMatch(currentHost, pacMods);
            const currentTabId = getRequestedCurrentTabId(message);
            if (currentTabId !== null) {
              currentSiteRoute = await blockInformer.getTabRoute(currentTabId, currentHost);
            }
          }

          return {
            success: true,
            data: {
              syncState,
              pacMods: serializePacMods(pacMods, Boolean(message.includeExceptions)),
              defaultConfigs,
              notifications: errorHandlers.notificationsEnabled,
              lastErrors: errorHandlers.getLastErrors(),
              version: chrome.runtime.getManifest().version,
              exceptionStats,
              currentSiteMatch,
              currentRuleSource: currentSiteMatch?.matched ? pacMods.ruleMeta?.[`exception:${currentSiteMatch.ruleKey}`] || null : null,
              currentSiteRoute,
              siteResources: currentHost ? await siteResources.summary(
                getRequestedCurrentTabId(message), currentHost
              ) : null,
              proxyHealthMap,
              settingsState: await settingsCoordinator.state(),
              history: await settingsCoordinator.history(),
            },
          };
        }

        case 'GET_DOMAIN_LISTS':
        case 'GET_DOMAIN_LIST': {
          const raw = await pacKitchen.getRawPacMods();
          const data = { revision: raw._rulesRevision ?? raw._revision ?? 0,
            proxyCatalog: getProxyCatalog(raw) };
          if (message.action === 'GET_DOMAIN_LISTS') {
            data.defaultProxyId = raw.defaultProxyId ?? null;
            data.lists = (raw.domainLists || []).map(({ id, name, proxyId, enabled, domains }) =>
              ({ id, name, proxyId, enabled, count: domains.length }));
          } else {
            const list = (raw.domainLists || []).find(item => item.id === message.listId);
            if (!list) throw Object.assign(new Error('Domain list no longer exists.'), { code: 'DOMAIN_LIST_UNKNOWN' });
            data.list = list;
          }
          return { success: true, data };
        }

        case 'SAVE_DOMAIN_LIST':
        case 'DELETE_DOMAIN_LIST':
        case 'REORDER_DOMAIN_LISTS': {
          let listId = message.listId;
          await pacKitchen.updatePacMods(current => {
            ensureCurrent();
            let next;
            if (message.action === 'SAVE_DOMAIN_LIST') {
              next = saveDomainList(current, message, { catalog: getProxyCatalog(current) });
              if (listId === undefined) listId = next.domainLists.at(-1).id;
            } else if (message.action === 'DELETE_DOMAIN_LIST') next = deleteDomainList(current, message);
            else next = reorderDomainLists(current, message);
            return next;
          }, { source: 'manual', copyOnWrite: true });
          await settingsCoordinator.apply();
          const latest = await pacKitchen.getRawPacMods();
          return { success: true, data: { revision: latest._rulesRevision ?? latest._revision ?? 0,
            rulesRevision: latest._rulesRevision ?? latest._revision ?? 0,
            listId: listId ?? null,
            ...(message.action === 'SAVE_DOMAIN_LIST' ? { list: latest.domainLists.find(item => item.id === listId) || null } : {}),
            lists: (latest.domainLists || []).map(({ id, name, proxyId, enabled, domains }) =>
              ({ id, name, proxyId, enabled, count: domains.length })),
            proxyCatalog: getProxyCatalog(latest), defaultProxyId: latest.defaultProxyId ?? null } };
        }

        case 'GET_EXCEPTIONS': {
          const pacMods = await pacKitchen.getPacMods();
          const revision = pacMods.rulesRevision ?? pacMods.revision ?? 0;
          const catalog = { proxyCatalog: getProxyCatalog(pacMods), defaultProxyId: pacMods.defaultProxyId ?? null,
            catalogRevision: pacMods.proxyCatalogRevision || 0 };
          if (Number.isSafeInteger(message.knownRevision) && message.knownRevision === revision) {
            return { success: true, data: { revision, unchanged: true, ...catalog } };
          }
          return {
            success: true,
            data: {
              revision,
              ...catalog,
              domainProxyIds: pacMods.domainProxyIds || {},
              exceptions: pacMods.exceptions || {},
              whitelist: pacMods.whitelist || [],
              pacBypassDomains: pacMods.pacBypassDomains || [],
              ruleMeta: pacMods.ruleMeta || {},
            },
          };
        }

        case 'MUTATE_DOMAIN_RULES':
        case 'ASSIGN_DOMAIN_PROXIES': {
          let mutation;
          const context = { source: 'manual', copyOnWrite: true };
          const parsed = await pacKitchen.updatePacMods(current => {
            ensureCurrent();
            const options = { catalog: getProxyCatalog(current), expectedRevision: message.expectedRevision };
            mutation = message.action === 'ASSIGN_DOMAIN_PROXIES'
              ? assignDomainProxies(current, message.domains, message.proxyId, options)
              : applyDomainRuleMutations(current, message.operations, options);
            if (message.action === 'ASSIGN_DOMAIN_PROXIES') context.touchedProxyDomains = mutation.touchedDomains;
            else context.touchedDomains = mutation.touchedExceptionDomains;
            return mutation.settings;
          }, context);
          await settingsCoordinator.apply();
          return { success: true, data: { rulesRevision: parsed.rulesRevision,
            added: mutation.added, changed: mutation.changed, unchanged: mutation.unchanged,
            exceptionStats: pacKitchen.getCachedStats() } };
        }

        case 'RESET_RESOURCE_RULE':
        case 'SET_SITE_RESOURCE_INHERITANCE': {
          const tabId = getRequestedCurrentTabId(message);
          const result = message.action === 'RESET_RESOURCE_RULE'
            ? await siteResources.resetResourceRule(tabId, message.domain, message.host, message.expectedRevision, message.expectedHost)
            : await siteResources.setInheritance(tabId, message.domain, message.enabled, message.expectedRevision, message.expectedHost);
          blockInformer.clearTab(tabId);
          const mods = await pacKitchen.getPacMods();
          return { success: true, data: { ...result, exceptionStats: pacKitchen.getCachedStats(),
            currentSiteMatch: getConfiguredSiteMatch(message.domain, mods),
            siteResources: await siteResources.summary(tabId, message.domain) } };
        }

        case 'SET_SITE_ROUTE': {
          const tabId = getRequestedCurrentTabId(message);
          if (tabId === null) throw new Error(t("msg_the_site_tab_was_not_found_3a836d67", "Не найдена вкладка сайта"));
          const result = await siteResources.setMode(tabId, message.domain, message.isProxy, message.proxyId, message.expectedRevision, message.expectedHost);
          blockInformer.clearTab(tabId);
          const mods = await pacKitchen.getPacMods();
          return {
            success: true,
            data: {
              ...result,
              exceptionStats: pacKitchen.getCachedStats(),
              currentSiteMatch: getConfiguredSiteMatch(message.domain, mods),
              siteResources: await siteResources.summary(tabId, message.domain),
            },
          };
        }

        case 'SET_SINGLE_EXCEPTION': {
          const domain = typeof message.domain === 'string'
            ? message.domain.trim().toLowerCase()
            : '';
          if (!domain) throw new Error(t("msg_no_domain_was_provided_for_the_site_rule_cb6d5c38", "Не указан домен для правила сайта"));

          let updatedExceptions = {};
          let removedRuleKeys = [];
          await pacKitchen.updatePacMods((current) => {
            let exceptions = Object.assign({}, current.exceptions || {});
            if (message.isProxy === null || message.isProxy === undefined) {
              const resetResult = removeMatchingExceptionRules(domain, exceptions);
              exceptions = resetResult.exceptions;
              removedRuleKeys = resetResult.removedRuleKeys;
            } else {
              const catalog = getProxyCatalog(current);
              const defaultId = catalog.some(profile => profile.enabled && profile.id === current.defaultProxyId)
                ? current.defaultProxyId : undefined;
              const operation = { domain, mode: message.isProxy ? 'proxy' : 'direct' };
              if (message.isProxy && (message.proxyId !== undefined || current.exceptions?.[domain] !== true)) {
                operation.proxyId = message.proxyId ?? defaultId;
              }
              const result = applyDomainRuleMutations(current, [operation], { catalog });
              updatedExceptions = result.settings.exceptions;
              return result.settings;
            }
            updatedExceptions = exceptions;
            return Object.assign({}, current, { exceptions });
          }, { source: 'manual', touchedDomains: [domain], copyOnWrite: true });
          await settingsCoordinator.apply();
          const currentTabId = getRequestedCurrentTabId(message);
          if (currentTabId !== null) blockInformer.clearTab(currentTabId);
          const exceptionStats = pacKitchen.getCachedStats();
          const currentSiteMatch = matchExceptionDomain(domain, updatedExceptions);
          return {
            success: true,
            data: { exceptionStats, currentSiteMatch, removedRuleKeys },
          };
        }

        case 'IMPORT_EXCEPTIONS_BATCH': {
          const domains = message.domains || [];
          const target = message.target || 'excluded';
          const mode = { included: 'proxy', excluded: 'direct', whitelist: 'whitelist-add' }[target];
          if (!mode || !Array.isArray(domains)) throw new Error(t('msg_invalid_domain_import', 'Invalid domain import.'));
          let mutation;
          await pacKitchen.updatePacMods((current) => {
            ensureCurrent();
            const operations = domains.map(domain => {
              const operation = { domain, mode };
              // Existing positive rules retain their route unless the caller
              // explicitly requests reassignment, including URL/IDN aliases.
              const normalized = normalizeDomainRule(domain);
              if (mode === 'proxy' && message.proxyId !== undefined &&
                (message.reassignExisting === true || current.exceptions?.[normalized.domain] !== true)) operation.proxyId = message.proxyId;
              return operation;
            });
            mutation = applyDomainRuleMutations(current, operations, {
              catalog: getProxyCatalog(current), expectedRevision: message.expectedRevision });
            return mutation.settings;
          }, { source: 'import', copyOnWrite: true });
          await settingsCoordinator.apply();
          const exceptionStats = pacKitchen.getCachedStats();
          const latest = await pacKitchen.getPacMods();
          return { success: true, data: { count: mutation.added + mutation.changed,
            added: mutation.added, changed: mutation.changed, unchanged: mutation.unchanged,
            rulesRevision: latest.rulesRevision, exceptionStats } };
        }

        case 'CLEAR_EXCEPTIONS_CATEGORY': {
          const target = message.target || 'included';
          await pacKitchen.updatePacMods((current) => {
            const exceptions = Object.assign({}, current.exceptions || {});
            let whitelist = [...(current.whitelist || [])];
            if (target === 'included') {
              for (const k in exceptions) {
                if (exceptions[k] === true) delete exceptions[k];
              }
            } else if (target === 'excluded') {
              for (const k in exceptions) {
                if (exceptions[k] === false) delete exceptions[k];
              }
            } else if (target === 'whitelist') {
              whitelist = [];
            } else if (target === 'all') {
              for (const k in exceptions) delete exceptions[k];
              whitelist = [];
            }
            return Object.assign({}, current, { exceptions, whitelist });
          }, { copyOnWrite: true });
          await settingsCoordinator.apply();
          const exceptionStats = pacKitchen.getCachedStats();
          return { success: true, data: { exceptionStats } };
        }

        case 'SYNC_PAC': {
          pacSync.cancelPendingSync();
          await pacSync.syncWithPacProvider({
            key: message.key || pacSync.currentPacProviderKey,
            customUrl: message.customPacUrl,
            ifUnattended: false,
          });
          return { success: true, data: pacSync.getState() };
        }

        case 'INSTALL_PAC': {
          await pacSync.installPac(message.key, message.customPacUrl);
          return { success: true, data: pacSync.getState() };
        }

        case 'SET_CUSTOM_PAC_URL': {
          await pacSync.installPac('customPacUrl', message.url);
          return { success: true, data: pacSync.getState() };
        }

        case 'CLEAR_PAC': {
          await pacSync.clearPac();
          await applicationState.applied((await pacKitchen.getRawPacMods())._revision || 0);
          return { success: true, data: pacSync.getState() };
        }

        case 'RENAME_PROXY_PROFILE':
        case 'SET_DEFAULT_PROXY': {
          const parsed = await pacKitchen.updatePacMods(current => {
            ensureCurrent();
            return message.action === 'RENAME_PROXY_PROFILE'
              ? renameProxyProfile(current, message.proxyId, message.name)
              : selectDefaultProxy(current, message.proxyId);
          }, { metadataOnly: true, preferencesOnly: true });
          return { success: true, data: { pacMods: serializePacMods(parsed),
            proxyCatalog: getProxyCatalog(parsed), defaultProxyId: parsed.defaultProxyId } };
        }

        case 'DELETE_PROXY_PROFILE': {
          const parsed = await pacKitchen.updatePacMods(current => {
            ensureCurrent();
            return deleteProxyProfile(current, message.proxyId, message.replacementProxyId);
          }, { source: 'manual', copyOnWrite: true });
          await settingsCoordinator.apply();
          return { success: true, data: { pacMods: serializePacMods(parsed), proxyCatalog: getProxyCatalog(parsed) } };
        }

        case 'SAVE_MODS': {
          const patch = message.mods || {};
          const parsedMods = await pacKitchen.updatePacMods((current) => {
            ensureCurrent();
            for (const key of ['proxyProfiles', 'domainProxyIds', 'defaultProxyId', '_proxyCatalogRevision', 'siteResourceInheritance', 'domainLists']) {
              if (Object.hasOwn(patch, key)) throw new Error(t('msg_use_dedicated_proxy_domain_operations', 'Use the dedicated proxy and domain operations.'));
            }
            let next = reconcileProxyProfiles({ ...current, ...patch }, current);
            if (Object.hasOwn(patch, 'exceptions') || Object.hasOwn(patch, 'whitelist') || Object.hasOwn(patch, 'pacBypassDomains')) {
              const replacement = replaceDomainRuleLists(current, patch, { expectedRevision: message.expectedRevision,
                proxyId: message.proxyId, catalog: getProxyCatalog(next) }).settings;
              // Preferences and raw proxy edits share this same atomic write.
              next = { ...next, exceptions: replacement.exceptions,
                whitelist: replacement.whitelist, domainProxyIds: replacement.domainProxyIds,
                pacBypassDomains: replacement.pacBypassDomains };
            }
            return next;
          }, { copyOnWrite: true,
            source: message.ruleSource === 'import' ? 'import' : 'manual',
            touchedDomains: Array.isArray(message.touchedDomains) ? message.touchedDomains.filter(domain =>
              typeof domain === 'string' && Object.hasOwn(patch.exceptions || {}, domain)).slice(0, 100000) : [] });
          await settingsCoordinator.apply();

          if (Object.prototype.hasOwnProperty.call(message.mods || {}, 'customProxyStringRaw')) {
            ensureCurrent();
            await pruneProxyHealthCache(async () => utils.parseCustomProxies(
              (await pacKitchen.getRawPacMods()).customProxyStringRaw || '').map(proxy => proxy.raw)).catch((err) => {
              console.warn('[Proxy Health] Failed to prune cached results:', err);
            });
          }

          const returnMods = serializePacMods(parsedMods, Boolean(message.includeExceptions));
          return { success: true, data: { ...returnMods, rulesRevision: parsedMods.rulesRevision } };
        }

        case 'ADD_PROXY': {
          const proxy = utils.parseProxyScheme(message.proxy);
          if (!proxy) throw new Error(t("msg_check_the_proxy_address_and_port_1_65535_12481406", "Проверьте адрес прокси и номер порта (1–65535)"));
          const append = current => {
            ensureCurrent();
            const proxies = utils.parseCustomProxies(current.customProxyStringRaw || '');
            if (proxies.some(item => item.type === proxy.type && item.address === proxy.address)) {
              throw new Error(t("msg_this_proxy_is_already_in_the_list_84e5bfa6", "Такой прокси уже добавлен в список"));
            }
            let next = reconcileProxyProfiles({ ...current,
              customProxyStringRaw: [...proxies.map(item => item.raw), proxy.raw].join(';\n') }, current);
            if (message.name !== undefined && String(message.name).trim()) {
              const existingIds = new Set((current.proxyProfiles || []).map(profile => profile.id));
              const profile = next.proxyProfiles.find(item => !existingIds.has(item.id));
              if (profile) next = renameProxyProfile(next, profile.id, message.name);
            }
            return next;
          };
          append(await pacKitchen.getRawPacMods());
          const health = await checkHealth(proxy.raw);
          ensureCurrent();
          if (!health.ok) return { success: false, error: health.error, data: { health } };
          // Merge into the latest list inside its mutation queue, after the
          // potentially slow check. Other views may have edited it meanwhile.
          const parsedMods = await pacKitchen.updatePacMods(append, { preferencesOnly: true });
          ensureCurrent();
          const checkedAt = Date.now();
          const cached = await saveProxyHealthResult(proxy.raw, health, checkedAt).catch(error => {
            console.warn('[Proxy Health] Failed to persist added proxy result:', error);
            return null;
          });
          ensureCurrent();
          await settingsCoordinator.apply();
          ensureCurrent();
          return { success: true, data: { pacMods: serializePacMods(parsedMods), proxy: proxy.raw,
            health: { ...health, checkedAt: cached?.checkedAt || checkedAt } } };
        }

        case 'CHECK_PROXY_HEALTH': {
          const res = await checkHealth(message.proxy);
          ensureCurrent();
          const checkedAt = Date.now();
          const cached = await saveProxyHealthResult(message.proxy, res, checkedAt)
            .catch((err) => {
              console.warn('[Proxy Health] Failed to persist result:', err);
              return null;
            });
          return {
            success: true,
            data: Object.assign({}, res, { checkedAt: cached?.checkedAt || checkedAt }),
          };
        }

        case 'SET_LOCAL_PROXY_ENABLED': {
          const service = getLocalProxyService(message.service);
          const enabled = Boolean(message.enabled);
          let health = null;

          if (enabled) {
            health = await checkLocalProxyService(message.service, proxy => { ensureCurrent(); return checkHealth(proxy); });
            ensureCurrent();
            if (!health.ok) {
              return { success: false, error: health.error, data: { health } };
            }
          }

          const parsedMods = await pacKitchen.updatePacMods((current) => {
            return Object.assign({}, current, { [service.modKey]: enabled });
          }, { preferencesOnly: true });
          await settingsCoordinator.apply();

          return {
            success: true,
            data: {
              pacMods: serializePacMods(parsedMods),
              health,
            },
          };
        }

        case 'GET_PAC_SCRIPT': {
          const pacData = await pacSync.getPacScriptDetails();
          return {
            success: true,
            data: {
              rawPacData: pacData.rawPacData,
              cookedPacData: pacData.cookedPacData,
              currentProvider: pacData.currentProvider,
              scriptKind: pacData.scriptKind,
            },
          };
        }

        case 'GET_RULE_HISTORY':
          return { success: true, data: await settingsCoordinator.history() };
        case 'CLEAR_RULE_HISTORY':
          await settingsCoordinator.clearHistory();
          return { success: true };
        case 'UNDO_RULE_CHANGE':
          return { success: true, data: await settingsCoordinator.undo(message.id || null) };
        case 'RETRY_SETTINGS_APPLY':
          return { success: true, data: await settingsCoordinator.apply() };

        case 'SET_RAW_PAC': {
          // Restricted to trusted extension pages by the sender-origin guard
          // above; applyPacData also performs lexical PAC validation.
          await pacSync.setRawPacData(message.pacData);
          return { success: true };
        }

        case 'SET_NOTIFICATION_OPTION': {
          await errorHandlers.setNotificationOption(message.key, message.enabled);
          return { success: true, data: errorHandlers.notificationsEnabled };
        }

        case 'GET_LAST_ERRORS': {
          return { success: true, data: errorHandlers.getLastErrors() };
        }

        case 'OPEN_PRIVATE_BROWSING_SETTINGS': {
          if (typeof proxyBackend.openPrivateBrowsingSettings !== 'function') {
            throw new Error(t("msg_this_setting_is_only_available_in_firefox_9a4f6560", "Эта настройка доступна только в Firefox"));
          }
          await proxyBackend.openPrivateBrowsingSettings();
          return { success: true };
        }

        case 'GET_LOGS': {
          const logs = logger.getLogs({
            category: message.category || 'all',
            level: message.level || 'all',
            search: message.search || '',
            limit: message.limit || 150,
          });
          const stats = logger.getStats();
          return { success: true, data: { logs, stats } };
        }

        case 'CLEAR_LOGS': {
          await logger.clear();
          return { success: true, data: { stats: logger.getStats() } };
        }

        case 'EXPORT_LOGS': {
          const text = logger.exportText(message.category || 'all', message.search || '');
          return { success: true, data: { text } };
        }

        case 'LOG_CLIENT_EVENT': {
          if (message.entry) {
            logger.add(message.entry);
          }
          return { success: true };
        }

        case 'TEST_CONNECTION': {
          const startTime = Date.now();
          try {
            const syncState = pacSync.getState();
            const testUrl = getConnectionTestUrl(syncState);
            const validation = utils.validatePacUrl(testUrl);
            if (!validation.valid) {
              throw new Error(validation.error);
            }
            await httpLib.probe(validation.sanitizedUrl, {
              validateFinalUrl: (finalUrl, requestedUrl) =>
                utils.validatePacResponseUrl(requestedUrl, finalUrl),
            });
            const latency = Date.now() - startTime;
            return { success: true, latency };
          } catch (err) {
            return { success: false, error: err.message || t("msg_connection_failed_4b7c43eb", "Сбой соединения") };
          }
        }

        case 'RESET_SETTINGS': {
          resetting = true;
          resetGeneration++;
          try {
            cancelProxyChecks();
            pacSync.cancelPendingSync();
            const drain = settingsCoordinator.drainForReset();
            await pacKitchen.beginReset();
            await drain;
            await appState.settlePendingInitialization();
            await siteResources.clear();
            pacSync.resetRuntimeState();
            await applicationState.reset();
            await drainProxyHealthCache();
            await withAppearanceWriteLock(async () => {
              await storage.clear();
              // clear() emits no appearance event before the first saved choice.
              // Persist a fresh generation to invalidate every queued UI write.
              await storage.set({ [APPEARANCE_RESET_KEY]: crypto.randomUUID() });
            });
            pacKitchen.invalidateCache();
            resetProxyCredentialsState();
            await clearProxyAuthAttempts();
            await blockInformer.clearRoutes();
            ipToHost.reset();
            await pacSync.clearPac({ persist: false });
            // Old mutations have drained and storage is clean. Allow fresh
            // defaults to load; RPC and coordinator barriers remain held.
            pacKitchen.endReset();
            await pacSync.syncWithPacProvider({ key: 'Антизапрет', ifUnattended: true });
            // Drain pending log writes created before/during reset, then remove
            // them so an old callback cannot resurrect cleared diagnostics.
            await logger.clear();
            logger.resetRuntimeState();
            errorHandlers.resetRuntimeState();
            await appState.reset();
            return { success: true };
          } finally {
            pacKitchen.endReset();
            settingsCoordinator.finishReset();
            resetting = false;
          }
        }

        default:
          return { success: false, error: t('msg_unknown_action', 'Unknown action: $1', [message.action]) };
      }
    };

    handleMessage()
      .then(async (res) => {
        if (res.success) res.settingsState = await settingsCoordinator.state();
        sendResponse(res);
      })
      .catch((err) => {
        const response = createErrorResponse(err);
        console.warn(`[Message Bus] Handled error for action "${message.action}":`, response.error);
        sendResponse(response);
      });

    return true; // Keep message port open for async response
  });
}
