'use strict';

import { pacKitchen } from './pac-kitchen.js';
import { matchResourceRule } from './resource-routing.js';
import { proxyBackend } from './proxy-backend.js';
import { utils } from './utils.js';
import { resolveProxyRoute } from './proxy-profiles.js';

import { routeConstraint, compilePolicy } from './routing-policy.js';

const failClosedChain = () => [{ type: 'http', host: '127.0.0.1', port: 9 }];

const policies = new WeakMap();

function requestAllowedByGlobalOptions(url, mods) {
  let compiled = policies.get(mods);
  if (!compiled || compiled.source !== mods.whitelist ||
      compiled.policy.httpsOnly !== Boolean(mods.ifProxyHttpsUrlsOnly) ||
      compiled.policy.whitelistEnabled !== Boolean(mods.ifMindWhitelist)) {
    compiled = { ...compilePolicy(mods), source: mods.whitelist };
    policies.set(mods, compiled);
  }
  return !routeConstraint(url, new URL(url).hostname, compiled.policy, compiled.whitelist);
}

export function ownProxyChain(mods) {
  return (mods.filteredCustomsString || '').split(';').map((value) => {
    const proxy = utils.parseProxyScheme(value.trim().replace(/^PROXY\s+/i, 'HTTP '));
    if (!proxy) return null;
    const type = { PROXY: 'http', HTTP: 'http', HTTPS: 'https', SOCKS: 'socks4',
      SOCKS4: 'socks4', SOCKS5: 'socks' }[proxy.type];
    if (!type) return null;
    return { type, host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port),
      ...(type === 'socks' || type === 'socks4' ? { proxyDNS: true } : {}) };
  }).filter(Boolean);
}

function webHost(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) ? parsed.hostname : '';
  } catch { return ''; }
}

export class TabProxyRouter {
  constructor() {
    this.tabs = new Map();
    this.settings = null;
    this.registered = false;
  }

  async handle(details) {
    // Speculative requests have no reliable tab association. Leave them and
    // browser/extension background traffic to the existing native PAC engine.
    if (!Number.isInteger(details.tabId) || details.tabId < 0 ||
        details.type === 'speculative' || !webHost(details.url)) return undefined;
    if (details.type === 'main_frame') this.tabs.set(details.tabId, webHost(details.url));
    if (!this.tabs.has(details.tabId)) {
      const pending = new Promise((resolve) => chrome.tabs.get(details.tabId, (tab) => {
        resolve(chrome.runtime.lastError ? '' : webHost(tab?.url));
      }));
      this.tabs.set(details.tabId, pending);
      const host = await pending;
      if (this.tabs.get(details.tabId) === pending) this.tabs.set(details.tabId, host);
    }
    const host = await this.tabs.get(details.tabId);
    if (!host) return undefined;
    const mods = await pacKitchen.getPacMods();
    if (mods.ifNoMods || !mods.ifMindExceptions) return undefined;
    const match = matchResourceRule(mods, webHost(details.url), host, true);
    if (!match.matched || match.isPac) return undefined;
    const assigned = match.isProxied && (match.proxyId !== undefined ||
          Object.prototype.hasOwnProperty.call(mods.domainProxyIds || {}, match.ruleKey));
    if (match.isProxied && !assigned &&
        (!mods.filteredCustomsString || (mods.ifUseLocalTor && webHost(details.url).endsWith('.onion')))) return undefined;
    if (!this.settings) {
      this.settings = proxyBackend.getSettings().catch((error) => {
        this.settings = null;
        throw error;
      });
    }
    let settings;
    try { settings = await this.settings; } catch (error) {
      if (assigned) return failClosedChain();
      throw error;
    }
    if (settings.levelOfControl !== 'controlled_by_this_extension' ||
        settings.value?.proxyType !== 'autoConfig') return undefined;
    // Match the native PAC's global constraints before applying a tab rule.
    // Returning undefined here would let the PAC choose a proxy again.
    if (!requestAllowedByGlobalOptions(details.url, mods)) return null;
    // In Gecko `direct` may reuse the native PAC result. null explicitly
    // overrides it; undefined leaves it untouched. A terminal null also
    // prevents falling back from our own proxy chain to public PAC proxies.
    if (!match.isProxied) return null;
    if (assigned) {
      try {
        const id = match.proxyId ?? mods.domainProxyIds?.[match.ruleKey];
        if (!Object.hasOwn(mods.proxyRoutes || {}, id)) return failClosedChain();
        const route = resolveProxyRoute({ domainProxyIds: match.proxyId !== undefined ?
          { [match.ruleKey]: match.proxyId } : mods.domainProxyIds, proxyRoutes: mods.proxyRoutes || {} }, match.ruleKey);
        if (route.unavailable) return failClosedChain();
        const chain = ownProxyChain({ filteredCustomsString: route.chain });
        if (!chain.length) return failClosedChain();
        return mods.ifProxyOrDie === false ? [...chain, null] : chain;
      } catch (error) {
        console.warn('[Tab routing] Assigned route unavailable:', error.message);
        return failClosedChain();
      }
    }
    const chain = ownProxyChain(mods);
    return chain.length ? [...chain, null] : undefined;
  }

  setup() {
    if (this.registered || proxyBackend.platform !== 'firefox' || !chrome.proxy?.onRequest) return;
    this.registered = true;
    chrome.proxy.onRequest.addListener((details) => this.handle(details).catch((error) => {
      console.warn('[Tab routing]', error.message);
      return undefined;
    }), { urls: ['<all_urls>'] });
    chrome.proxy.settings.onChange.addListener(() => { this.settings = null; });
    chrome.tabs.onRemoved.addListener((id) => this.tabs.delete(id));
    chrome.tabs.onUpdated.addListener((id, change) => {
      if (change.url) this.tabs.set(id, webHost(change.url));
    });
  }
}

export const tabProxyRouter = new TabProxyRouter();
