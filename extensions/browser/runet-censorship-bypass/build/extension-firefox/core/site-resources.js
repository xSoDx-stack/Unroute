'use strict';

import { pacKitchen, matchExceptionDomain } from './pac-kitchen.js';
import { pacSync } from './pac-sync.js';
import { normalizeDomainRule } from './domain-rules.js';
import { utils } from './utils.js';
import { appState } from './app-state.js';
import { proxyBackend } from './proxy-backend.js';

const SESSION_KEY = 'site-resource-tabs';
const MAX_TABS = 100;
const MAX_HOSTS = 300;
const BATCH_MS = 1500;

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
          if (host) record.hosts.add(host);
        }
        record.needsReload = Boolean(previous.needsReload);
      }
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
        this.lastError = error.message || 'Не удалось применить правила ресурсов';
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

  async persist() {
    const snapshot = { needsApply: this.needsApply };
    for (const [id, record] of this.tabs) {
      snapshot[id] = { root: record.root, hosts: [...record.hosts], needsReload: record.needsReload };
    }
    await callApi(chrome.storage?.session, 'set', { [SESSION_KEY]: snapshot });
  }

  async flush() {
    const batches = [...this.tabs.values()].filter((record) => record.pending.size)
      .map((record) => ({ record, hosts: [...record.pending] }));
    const mods = await pacKitchen.getPacMods();
    // Avoid serializing/saving a large rule set for ordinary browsing.
    if (proxyBackend.platform !== 'firefox' && mods.filteredCustomsString && !mods.ifNoMods &&
        mods.ifMindExceptions && batches.some(({ record, hosts }) =>
      matchExceptionDomain(record.mainHost, mods.exceptions).matched &&
      hosts.some((host) => !matchExceptionDomain(host, mods.exceptions).matched))) {
      await appState.ensureInitialized();
      await pacKitchen.updatePacMods((current) => {
        const exceptions = { ...current.exceptions };
        for (const { record, hosts } of batches) {
          if (![...this.tabs.values()].includes(record)) continue;
          const parent = matchExceptionDomain(record.mainHost, exceptions);
          if (current.ifMindExceptions === false || !parent.matched) continue;
          for (const host of hosts) {
            // First saved rule wins in automatic discovery. Explicit clicks
            // below may override it, so two tabs cannot endlessly fight a CDN.
            if (matchExceptionDomain(host, exceptions).matched) continue;
            exceptions[host] = parent.isProxied;
            record.needsReload = true;
          }
        }
        return { ...current, exceptions };
      });
      this.needsApply = true;
    }
    if (this.needsApply) {
      await appState.ensureInitialized();
      await pacSync.reapplyCurrentPac();
      this.needsApply = false;
    }
    for (const { record, hosts } of batches) {
      for (const host of hosts) record.pending.delete(host);
    }
    this.lastError = '';
    await this.persist();
  }

  async summary(tabId, domain) {
    await this.init();
    const mods = await pacKitchen.getPacMods();
    const routing = !mods.ifNoMods && mods.filteredCustomsString ?
      (proxyBackend.platform === 'firefox' ? 'tab' : 'domains') : 'domain';
    const record = this.tabs.get(tabId);
    if (record && record.root !== (utils.getRootDomain(domain) || domain)) return null;
    if (!record) {
      return { routing, hosts: [], count: 0 };
    }
    return {
      routing,
      hosts: [...record.hosts].sort(), count: record.hosts.size,
      needsReload: record.needsReload, limited: record.limited, error: this.lastError,
    };
  }

  async setMode(tabId, domain, mode) {
    if (mode !== true && mode !== false && mode !== null) throw new Error('Неизвестный режим сайта');
    await this.init();
    return this.enqueue(async () => {
      const tab = await callApi(chrome.tabs, 'get', tabId);
      const host = resourceHost(tab?.url);
      const root = host && (utils.getRootDomain(host) || host);
      if (!root || root !== domain) throw new Error('Вкладка сменила сайт. Откройте расширение заново.');
      const record = tab.incognito ? null : this.observeTab(tabId, tab.url);
      const mods = await pacKitchen.getPacMods();
      const expand = proxyBackend.platform !== 'firefox' && !mods.ifNoMods && Boolean(mods.filteredCustomsString);
      const hosts = new Set([root, host, ...(expand ? record?.hosts || [] : [])]);
      await pacKitchen.updatePacMods((current) => {
        const exceptions = { ...current.exceptions };
        for (const key of Object.keys(exceptions)) {
          const bare = key.replace(/^\*\./, '');
          if (bare === root || bare.endsWith(`.${root}`)) {
            if (mode === null) delete exceptions[key];
            else exceptions[key] = mode;
          }
        }
        if (mode === null) {
          for (const target of hosts) {
            for (;;) {
              const match = matchExceptionDomain(target, exceptions);
              if (!match.matched) break;
              delete exceptions[match.ruleKey];
            }
          }
        } else {
          // A prior, more specific subdomain rule must not defeat an explicit
          // whole-site switch. External resources retain their exact hostname.
          for (const target of hosts) exceptions[target] = mode;
        }
        return { ...current, exceptions, ifMindExceptions: true };
      });
      if (record) {
        for (const target of hosts) record.pending.delete(target);
        record.needsReload = true;
      }
      this.needsApply = true;
      try {
        await pacSync.reapplyCurrentPac();
        this.needsApply = false;
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
    this.init().catch(report);
  }
}

export const siteResources = new SiteResources();
