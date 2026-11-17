'use strict';

import { t } from './i18n.js';
import { isCanonicalSiteRoot, inheritsSiteResources } from './site-resource-policy.js';

import { pacKitchen } from './pac-kitchen.js';
import { hasUnassignedResources, inheritResourceRules, planSiteRuleMode, resetExactResourceRule } from './site-resource-rules.js';
import { normalizeDomainRule } from './domain-rules.js';
import { matchConfiguredRule } from './domain-route-resolver.js';
import { describeResourceRoute, canResetExactResource } from './resource-routing.js';
import { compileProxyRoutes } from './proxy-profiles.js';
import { utils } from './utils.js';
import { appState } from './app-state.js';
import { proxyBackend } from './proxy-backend.js';
import { settingsCoordinator } from './settings-coordinator.js';

const SESSION_KEY = 'site-resource-tabs';
const MAX_TABS = 100;
const MAX_HOSTS = 300;
const BATCH_MS = 1500;

const hasOwnRoutes = mods => Boolean(mods.filteredCustomsString || Object.keys(mods.domainProxyIds || {}).length ||
  mods.domainLists?.some(list => list.enabled));

export function resourceHost(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return '';
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    // Never silently turn local services into public proxy destinations.
    if (host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host) ||
        /^[\d.]+$/.test(host) || host.includes(':')) return '';
    const normalized = normalizeDomainRule(host, { allowWildcard: false });
    return normalized.valid ? normalized.domain : '';
  } catch {
    return '';
  }
}

function callApi(owner, method, ...args) {
  return new Promise((resolve, reject) => {
    if (!owner?.[method]) { resolve(null); return; }
    owner[method](...args, (result) => {
      const error = chrome.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

export class SiteResources {
  constructor() {
    this.tabs = new Map();
    this.ready = null;
    this.timer = null;
    this.queue = Promise.resolve();
    this.lastError = '';
    this.needsApply = false;
    this.registered = false;
    this.rulesRevision = 0;
  }

  init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const saved = await callApi(chrome.storage?.session, 'get', SESSION_KEY);
      this.needsApply = Boolean(saved?.[SESSION_KEY]?.needsApply);
      if (this.needsApply) this.schedule();
      const tabs = await callApi(chrome.tabs, 'query', {});
      for (const tab of tabs || []) {
        if (tab.incognito) continue;
        const record = this.observeTab(tab.id, tab.url);
        const previous = saved?.[SESSION_KEY]?.[tab.id];
        if (!record || previous?.root !== record.root) continue;
        for (const value of (Array.isArray(previous.hosts) ? previous.hosts : []).slice(0, MAX_HOSTS)) {
          const host = resourceHost(`https://${value}`);
          if (host) {
            record.hosts.add(host);
            record.pending.add(host);
          }
        }
        record.needsReload = Boolean(previous.needsReload);
      }
      if ([...this.tabs.values()].some(record => record.pending.size)) this.schedule();
    })().catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  observeTab(tabId, url) {
    const host = resourceHost(url);
    if (!Number.isInteger(tabId) || tabId < 0 || !host) {
      this.tabs.delete(tabId);
      return null;
    }
    const root = utils.getRootDomain(host) || host;
    let record = this.tabs.get(tabId);
    if (!record || record.root !== root) {
      if (this.tabs.size >= MAX_TABS) this.tabs.delete(this.tabs.keys().next().value);
      record = { root, mainHost: host, hosts: new Set(), pending: new Set(), needsReload: false, limited: false };
      this.tabs.set(tabId, record);
    }
    record.mainHost = host;
    return record;
  }

  async observe(details) {
    if (details.incognito || details.tabId < 0) return;
    await this.init();
    let record = this.tabs.get(details.tabId);
    if (details.type === 'main_frame') {
      record = this.observeTab(details.tabId, details.url);
      if (record) { record.needsReload = false; this.schedule(); }
    } else if (!record) {
      const tab = await callApi(chrome.tabs, 'get', details.tabId);
      if (!tab || tab.incognito) return;
      record = this.observeTab(tab.id, tab.url);
    }
    const host = resourceHost(details.url);
    if (!record || !host || record.hosts.has(host)) return;
    if (record.hosts.size >= MAX_HOSTS) { record.limited = true; return; }
    record.hosts.add(host);
    record.pending.add(host);
    this.schedule();
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueue(() => this.flush()).catch((error) => {
        this.lastError = error.message || t("msg_failed_to_apply_resource_rules_32100f47", "Не удалось применить правила ресурсов");
        console.warn('[Site resources] Batch failed:', error);
        this.persist().catch(reportError => console.warn('[Site resources] State save failed:', reportError));
      });
    }, BATCH_MS);
  }

  enqueue(task) {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  async reconsider() {
    // Settings may change while a batch is applying its PAC. Do not let that
    // batch consume the pending work belonging to the new settings revision.
    this.rulesRevision++;
    await this.init();
    for (const record of this.tabs.values()) {
      for (const host of record.hosts) record.pending.add(host);
    }
    this.schedule();
  }

  async persist() {
    const snapshot = { needsApply: this.needsApply };
    for (const [id, record] of this.tabs) {
      snapshot[id] = { root: record.root, hosts: [...record.hosts], needsReload: record.needsReload };
    }
    await callApi(chrome.storage?.session, 'set', { [SESSION_KEY]: snapshot });
  }

  async flush() {
    const rulesRevision = this.rulesRevision;
    const batches = [...this.tabs.values()].filter((record) => record.pending.size)
      .map((record) => ({ record, hosts: [...record.pending] }));
    const mods = await pacKitchen.getPacMods();
    // Avoid serializing/saving a large rule set for ordinary browsing.
    if (proxyBackend.platform !== 'firefox' && hasOwnRoutes(mods) && !mods.ifNoMods &&
        mods.ifMindExceptions && hasUnassignedResources(mods, batches)) {
      await appState.ensureLocalStateInitialized();
      let changed = false;
      const siteForDomain = {};
      const listForDomain = {};
      await pacKitchen.updatePacMods(async (current) => {
        // Read the current parsed snapshot inside the serialized mutation.
        // Own proxies may have been disabled during initialization above.
        const latest = await pacKitchen.getPacMods();
        if (!hasOwnRoutes(latest) ||
            latest.ifNoMods || !latest.ifMindExceptions) return current;
        const activeRecords = new Set(this.tabs.values());
        const result = inheritResourceRules(current,
          batches.filter(({ record }) => activeRecords.has(record)), latest.ruleMeta);
        changed = result.changedRecords.size > 0;
        if (!changed) return current;
        Object.assign(siteForDomain, result.siteForDomain);
        Object.assign(listForDomain, result.listForDomain);
        for (const record of result.changedRecords) record.needsReload = true;
        return { ...current, exceptions: result.exceptions, domainProxyIds: result.domainProxyIds };
      }, { source: 'auto', siteForDomain, listForDomain, copyOnWrite: true });
      if (changed) this.needsApply = true;
    }
    if (this.needsApply) {
      const applied = await settingsCoordinator.apply();
      this.needsApply = applied.pending;
      if (applied.pending) throw new Error(applied.error || t("msg_rules_are_saved_but_have_not_been_applied_yet_9917d69b", "Правила сохранены, но ещё не применены"));
    }
    if (rulesRevision === this.rulesRevision) {
      for (const { record, hosts } of batches) {
        for (const host of hosts) record.pending.delete(host);
      }
    }
    this.lastError = '';
    await this.persist();
  }

  async summary(tabId, domain) {
    await this.init();
    const mods = await pacKitchen.getPacMods();
    const routing = !mods.ifNoMods && hasOwnRoutes(mods) ?
      (proxyBackend.platform === 'firefox' ? 'tab' : 'domains') : 'domain';
    const record = this.tabs.get(tabId);
    if (record && record.root !== (utils.getRootDomain(domain) || domain)) return null;
    const tab = await callApi(chrome.tabs, 'get', tabId);
    const inheritResources = inheritsSiteResources(mods, record?.root || utils.getRootDomain(domain) || domain);
    const canInheritResources = Boolean(record && isCanonicalSiteRoot(record.root) && tab && !tab.incognito && routing !== 'domain' && mods.ifMindExceptions !== false);
    if (!record) {
      return { routing, hosts: [], count: 0, inheritResources, canInheritResources };
    }
    const hosts = [...record.hosts].sort();
    const routes = Object.fromEntries(hosts.map(host => [host, describeResourceRoute(
      mods.ifMindExceptions === false ? { ...mods, exceptions: {}, domainProxyIds: {}, ruleMeta: {} } : mods,
      host, record.mainHost || record.root, routing === 'tab' && mods.ifMindExceptions !== false
    )]));
    return {
      routing, inheritResources, canInheritResources,
      hosts, count: record.hosts.size, routes, rulesRevision: mods.rulesRevision ?? mods.revision ?? 0,
      needsReload: record.needsReload, limited: record.limited, error: this.lastError,
    };
  }

  async resetResourceRule(tabId, domain, host, expectedRevision, expectedHost) {
    const conflict = () => Object.assign(new Error(t('mpErrorConflict', 'Список изменён или устарел. Обновите данные и повторите действие; черновик сохранён.')),
      { code: 'REVISION_CONFLICT' });
    const canonicalHost = value => typeof value === 'string' && resourceHost(`https://${value}`) === value;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isInteger(tabId) || tabId < 0 ||
        !isCanonicalSiteRoot(domain) || !canonicalHost(host) || !canonicalHost(expectedHost) ||
        host === domain || host === expectedHost) throw conflict();
    const validate = async (mods, revision) => {
      const tab = await callApi(chrome.tabs, 'get', tabId);
      const actualHost = resourceHost(tab?.url);
      const record = this.tabs.get(tabId);
      if (revision !== expectedRevision || actualHost !== expectedHost ||
          (utils.getRootDomain(actualHost) || actualHost) !== domain ||
          record?.root !== domain || record.mainHost !== actualHost || !record.hosts.has(host)) throw conflict();
      if (tab.incognito || mods.ifNoMods || mods.ifMindExceptions === false) {
        throw Object.assign(new Error(t('mpErrorUnavailable', 'Выберите включённый прокси, разрешённый текущими ограничениями.')),
          { code: 'RESOURCE_INHERITANCE_UNAVAILABLE' });
      }
      // Repeat resets reject atomically rather than manufacturing a new pin.
      if (!canResetExactResource(mods, host, actualHost)) throw conflict();
      return record;
    };
    await this.init();
    const initial = await pacKitchen.getPacMods();
    await validate(initial, initial.rulesRevision ?? initial._rulesRevision ?? initial.revision ?? initial._revision ?? 0);
    return this.enqueue(async () => {
      const context = { source: 'auto', site: domain, touchedDomains: [host], resetResourceHost: host, copyOnWrite: true };
      await pacKitchen.updatePacMods(async current => {
        const record = await validate(current, current._rulesRevision ?? current._revision ?? 0);
        const parent = matchConfiguredRule(record.mainHost || record.root, current);
        if (parent.listId) context.listForDomain = { [host]: { id: parent.listId, host: record.mainHost || record.root } };
        return resetExactResourceRule(current, record, host);
      }, context);
      const record = this.tabs.get(tabId);
      if (record) {
        record.pending.delete(host);
        record.needsReload = proxyBackend.platform !== 'firefox';
      }
      this.needsApply = true;
      try {
        const applied = await settingsCoordinator.apply();
        this.needsApply = applied.pending;
      } finally { await this.persist(); }
      this.lastError = '';
      return { count: 1, privateTab: false };
    });
  }

  async setInheritance(tabId, domain, enabled, expectedRevision, expectedHost) {
    const conflict = () => Object.assign(new Error(t('mpErrorConflict', 'Список изменён или устарел. Обновите данные и повторите действие; черновик сохранён.')),
      { code: 'REVISION_CONFLICT' });
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        !Number.isInteger(tabId) || tabId < 0 || !isCanonicalSiteRoot(domain) ||
        typeof expectedHost !== 'string' || resourceHost(`https://${expectedHost}`) !== expectedHost) throw conflict();
    const validate = async (mods, revision) => {
      const tab = await callApi(chrome.tabs, 'get', tabId);
      const host = resourceHost(tab?.url);
      if (host !== expectedHost || (utils.getRootDomain(host) || host) !== domain || revision !== expectedRevision) throw conflict();
      if (tab.incognito || mods.ifNoMods || mods.ifMindExceptions === false ||
          !hasOwnRoutes(mods)) {
        throw Object.assign(new Error(t('mpErrorUnavailable', 'Выберите включённый прокси, разрешённый текущими ограничениями.')),
          { code: 'RESOURCE_INHERITANCE_UNAVAILABLE' });
      }
      return tab;
    };
    await this.init();
    return this.enqueue(async () => {
      const mods = await pacKitchen.getPacMods();
      await validate(mods, mods.rulesRevision ?? mods._rulesRevision ?? mods.revision ?? mods._revision ?? 0);
      const touchedDomains = [];
      const listForDomain = {};
      await pacKitchen.updatePacMods(async current => {
        const latest = await pacKitchen.getPacMods();
        const tab = await validate(latest, current._rulesRevision ?? current._revision ?? 0);
        const record = this.observeTab(tabId, tab.url);
        const siteResourceInheritance = { ...current.siteResourceInheritance };
        if (enabled) delete siteResourceInheritance[domain];
        else siteResourceInheritance[domain] = false;
        const next = { ...current, siteResourceInheritance };
        // Include persisted owned rules even if this worker has not observed
        // them yet. Manual exception/proxy provenance is never rewritten.
        const hosts = new Set(proxyBackend.platform === 'firefox' ? [] : record.hosts);
        for (const key of Object.keys(current.exceptions || {})) {
          const meta = latest.ruleMeta?.[`exception:${key}`];
          if (['auto', 'site'].includes(meta?.source) && meta.site === domain) hosts.add(key);
        }
        const result = inheritResourceRules({ ...next, ruleMeta: latest.ruleMeta }, [{ record, hosts: [...hosts] }]);
        touchedDomains.push(...Object.keys(result.siteForDomain));
        Object.assign(listForDomain, result.listForDomain);
        return { ...next, exceptions: result.exceptions, domainProxyIds: result.domainProxyIds };
      }, { source: 'auto', site: domain, listForDomain, touchedDomains, copyOnWrite: true });
      const record = this.tabs.get(tabId);
      if (record) record.needsReload = proxyBackend.platform !== 'firefox';
      this.needsApply = true;
      try {
        const applied = await settingsCoordinator.apply();
        this.needsApply = applied.pending;
      } finally { await this.persist(); }
      this.lastError = '';
      return { count: touchedDomains.length, privateTab: false };
    });
  }

  async setMode(tabId, domain, mode, proxyId, expectedRevision, expectedHost) {
    if (mode !== true && mode !== false && mode !== null) throw new Error(t("msg_unknown_site_mode_3989bf81", "Неизвестный режим сайта"));
    await this.init();
    return this.enqueue(async () => {
      const validateSite = (tab) => {
        const host = resourceHost(tab?.url);
        const root = host && (utils.getRootDomain(host) || host);
        if (!root || root !== domain || (expectedHost !== undefined && host !== expectedHost)) {
          throw new Error(t("msg_the_tab_has_moved_to_another_site_reopen_the__58a7207a", "Вкладка сменила сайт. Откройте расширение заново."));
        }
        return { host, root };
      };
      const tab = await callApi(chrome.tabs, 'get', tabId);
      const { host, root } = validateSite(tab);
      const record = tab.incognito ? null : this.observeTab(tabId, tab.url);
      const mods = await pacKitchen.getPacMods();
      const expand = proxyBackend.platform !== 'firefox' && !mods.ifNoMods && Boolean(hasOwnRoutes(mods) ||
        (mode === true && (proxyId || mods.defaultProxyId)));
      const hosts = new Set([root, host, ...(expand ? record?.hosts || [] : [])]);
      const touchedDomains = [];
      await pacKitchen.updatePacMods(async (current) => {
        // A queued write may start after navigation to another subdomain.
        // Never promote that resource to the user-selected main host.
        if (expectedHost !== undefined) validateSite(await callApi(chrome.tabs, 'get', tabId));
        // The revision must be checked after reaching the global write queue,
        // not against the snapshot read before another settings mutation.
        if (expectedRevision !== undefined && expectedRevision !== null &&
            (!Number.isSafeInteger(expectedRevision) ||
             expectedRevision !== (current._rulesRevision ?? current._revision ?? 0))) {
          throw Object.assign(new Error(t('mpErrorConflict', 'Список изменён или устарел. Обновите данные и повторите действие; черновик сохранён.')),
            { code: 'REVISION_CONFLICT' });
        }
        const latest = await pacKitchen.getPacMods();
        const match = matchConfiguredRule(host, current);
        const existingId = match.isProxied ? match.proxyId ?? current.domainProxyIds?.[match.ruleKey] : null;
        const selectedId = mode === true ? (proxyId !== undefined ? proxyId : existingId || current.defaultProxyId) : null;
        // Existing unavailable bindings remain explicit/fail-closed. New or
        // deliberately changed bindings must point to an available target.
        if (mode === true && (proxyId !== undefined || (selectedId && selectedId !== existingId))) {
          const routes = latest.proxyRoutes || compileProxyRoutes(current);
          if (typeof selectedId !== 'string' || !Object.prototype.hasOwnProperty.call(routes, selectedId) || !routes[selectedId]) {
            const error = new Error(t('mpErrorUnavailable', 'Выберите включённый прокси, разрешённый текущими ограничениями.'));
            error.code = 'PROXY_TARGET_UNAVAILABLE';
            throw error;
          }
        }
        const result = planSiteRuleMode({ ...current, ruleMeta: latest.ruleMeta }, root, hosts, mode, selectedId, host);
        touchedDomains.push(...result.touchedDomains);
        return { ...current, exceptions: result.exceptions, domainProxyIds: result.domainProxyIds,
          pacBypassDomains: result.pacBypassDomains, ifMindExceptions: true };
      }, { source: 'site', site: root, siteControlDomains: [root, host], touchedDomains, copyOnWrite: true });
      if (record) {
        for (const target of hosts) record.pending.delete(target);
        record.needsReload = true;
      }
      this.needsApply = true;
      try {
        const applied = await settingsCoordinator.apply();
        this.needsApply = applied.pending;
      } finally {
        await this.persist();
      }
      this.lastError = '';
      return { count: hosts.size, privateTab: Boolean(tab.incognito) };
    });
  }

  async clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.enqueue(async () => {
      this.tabs.clear();
      this.lastError = '';
      this.needsApply = false;
      await callApi(chrome.storage?.session, 'remove', SESSION_KEY);
    });
  }

  setup() {
    if (this.registered) return;
    this.registered = true;
    const report = (error) => console.warn('[Site resources]', error.message);
    chrome.webRequest?.onBeforeRequest?.addListener(
      (details) => { this.observe(details).catch(report); },
      { urls: ['<all_urls>'] }
    );
    chrome.tabs?.onRemoved?.addListener((id) => {
      this.tabs.delete(id);
      this.schedule();
    });
    chrome.tabs?.onUpdated?.addListener((id, change, tab) => {
      if (!change.url) return;
      if (tab.incognito) this.tabs.delete(id);
      else this.observeTab(id, change.url);
      this.schedule();
    });
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === 'local' && changes['pac-kitchen-mods']) {
        const { oldValue, newValue } = changes['pac-kitchen-mods'];
        // Catalog labels and the new-rule default do not alter existing routes.
        // Compare all other persisted fields, including compact rule/history
        // provenance, without depending on the particular storage codec.
        const routingSnapshot = (value) => {
          const { proxyProfiles: _profiles, defaultProxyId: _default, _proxyCatalogRevision, ...routing } = value || {};
          return JSON.stringify(routing);
        };
        if (oldValue && newValue && routingSnapshot(oldValue) === routingSnapshot(newValue)) return;
        return this.reconsider().catch(report);
      }
    });
    this.init().catch(report);
  }
}

export const siteResources = new SiteResources();
