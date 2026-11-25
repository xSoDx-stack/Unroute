'use strict';

import { pacKitchen } from './pac-kitchen.js';
import { matchResourceRule } from './resource-routing.js';
import { proxyBackend } from './proxy-backend.js';
import { utils } from './utils.js';
import { resolveProxyRoute } from './proxy-profiles.js';
import { webHost } from './web-host.js';

import { routeConstraint, compilePolicy } from './routing-policy.js';

const failClosedChain = () => [{ type: 'http', host: '127.0.0.1', port: 9 }];
const PROXY_CHAIN_CACHE_LIMIT = 64;

const policies = new WeakMap();
const snapshotsWithTabRules = new WeakSet();

function hasTabRoutingRules(mods) {
  if (snapshotsWithTabRules.has(mods)) return true;
  // PAC-only bypass rules do not override PAC. Disabled inheritance can
  // return DIRECT without other rules. Never memoize a negative result:
  // adding the first rule in place must not skip route matching.
  const present = Object.keys(mods.exceptions || {}).length > 0 ||
    (mods.domainLists || []).some(list => list.enabled && list.domains.length > 0) ||
    Object.keys(mods.siteResourceInheritance || {}).length > 0;
  if (present) snapshotsWithTabRules.add(mods);
  return present;
}

function canOverridePac(mods) {
  return !mods.ifNoMods && mods.ifMindExceptions && hasTabRoutingRules(mods);
}

function requestAllowedByGlobalOptions(url, host, mods) {
  let compiled = policies.get(mods);
  if (!compiled || compiled.source !== mods.whitelist ||
      compiled.policy.httpsOnly !== Boolean(mods.ifProxyHttpsUrlsOnly) ||
      compiled.policy.whitelistEnabled !== Boolean(mods.ifMindWhitelist)) {
    compiled = { ...compilePolicy(mods), source: mods.whitelist };
    policies.set(mods, compiled);
  }
  return !routeConstraint(url, host, compiled.policy, compiled.whitelist);
}

export function ownProxyChain(mods) {
  const primary = (mods.filteredCustomsString || '').split(';').map(value => value.trim()).filter(Boolean);
  // An empty/filtered primary stays fail-closed rather than changing its route.
  if (primary.length) for (const directive of (mods.fallbackProxyChain || '').split(';').map(value => value.trim())) {
    if (directive && !primary.includes(directive)) primary.push(directive);
  }
  return primary.map(toProxyInfo).filter(Boolean);
}

function toProxyInfo(value) {
  const proxy = utils.parseProxyScheme(value.trim().replace(/^PROXY\s+/i, 'HTTP '));
  if (!proxy) return null;
  const type = { PROXY: 'http', HTTP: 'http', HTTPS: 'https', SOCKS: 'socks4',
    SOCKS4: 'socks4', SOCKS5: 'socks' }[proxy.type];
  if (!type) return null;
  return { type, host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port),
    ...(type === 'socks' || type === 'socks4' ? { proxyDNS: true } : {}) };
}

export class TabProxyRouter {
  #proxyChains = new Map();

  constructor() {
    this.tabs = new Map();
    this.settings = null;
    this.registered = false;
  }

  #proxyChain(primary, fallback, strict, replaceDirectWith) {
    const tail = strict ? '' : replaceDirectWith || '';
    const key = JSON.stringify([primary || '', fallback || '', tail]);
    let chain = this.#proxyChains.get(key);
    if (!chain) {
      chain = ownProxyChain({ filteredCustomsString: primary, fallbackProxyChain: fallback });
      if (chain.length && tail) {
        for (const part of tail.split(';')) {
          const directive = part.trim();
          const node = /^DIRECT$/i.test(directive) ? { type: 'direct' } : toProxyInfo(directive);
          if (node) chain.push(node);
        }
      }
      if (this.#proxyChains.size >= PROXY_CHAIN_CACHE_LIMIT) {
        this.#proxyChains.delete(this.#proxyChains.keys().next().value);
      }
      this.#proxyChains.set(key, chain);
    }
    if (!chain.length) return undefined;
    // Gecko normalizes ProxyInfo fields in place; never hand it cached nodes.
    const result = chain.map(proxy => ({ ...proxy }));
    if (!strict && !tail) result.push({ type: 'direct' });
    result.push(null);
    return result;
  }

  async handle(details) {
    // Speculative requests have no reliable tab association. Leave them and
    // browser/extension background traffic to the existing native PAC engine.
    if (!Number.isInteger(details.tabId) || details.tabId < 0 || details.type === 'speculative') return undefined;
    const requestHost = webHost(details.url, true);
    if (!requestHost) return undefined;
    if (details.type === 'main_frame') this.tabs.set(details.tabId, requestHost);
    const cachedMods = this.registered ? pacKitchen.getCachedMods() : null;
    if (cachedMods && !canOverridePac(cachedMods)) return undefined;
    if (!this.tabs.has(details.tabId)) {
      const pending = new Promise((resolve) => chrome.tabs.get(details.tabId, (tab) => {
        resolve(chrome.runtime.lastError ? '' : webHost(tab?.url, true));
      })).then(host => {
        if (this.tabs.get(details.tabId) === pending) this.tabs.set(details.tabId, host);
        return host;
      });
      this.tabs.set(details.tabId, pending);
    }
    const tabHost = this.tabs.get(details.tabId);
    if (!tabHost) return undefined;
    const [host, mods] = await Promise.all([tabHost, pacKitchen.getPacMods()]);
    if (!host || this.tabs.get(details.tabId) !== host) return undefined;
    if (!canOverridePac(mods)) return undefined;
    const match = matchResourceRule(mods, requestHost, host, true);
    if (!match.matched || match.isPac) return undefined;
    const assigned = match.isProxied && (match.proxyId !== undefined ||
          Object.hasOwn(mods.domainProxyIds || {}, match.ruleKey));
    if (match.isProxied && !assigned &&
        (!mods.filteredCustomsString || (mods.ifUseLocalTor && /\.onion\.*$/i.test(requestHost)))) return undefined;
    const strict = mods.ownProxyOrDie !== false;
    if (!this.settings) {
      this.settings = proxyBackend.getSettings().catch((error) => {
        this.settings = null;
        throw error;
      });
    }
    let settings;
    try { settings = await this.settings; } catch {
      if (assigned || (match.isProxied && strict && requestAllowedByGlobalOptions(details.url, requestHost, mods))) {
        return failClosedChain();
      }
      // Without confirmed ownership, leave other requests to the browser.
      return undefined;
    }
    if (settings.levelOfControl !== 'controlled_by_this_extension' ||
        settings.value?.proxyType !== 'autoConfig') return undefined;
    // Match the native PAC's global constraints before applying a tab rule.
    // Returning undefined here would let the PAC choose a proxy again.
    if (!requestAllowedByGlobalOptions(details.url, requestHost, mods)) return null;
    // A top-level null explicitly bypasses PAC. Inside a proxy array null
    // terminates the chain; it is NOT a DIRECT fallback node.
    if (!match.isProxied) return null;
    if (assigned) {
      try {
        const id = match.proxyId ?? mods.domainProxyIds?.[match.ruleKey];
        if (!Object.hasOwn(mods.proxyRoutes || {}, id)) return failClosedChain();
        const route = resolveProxyRoute({ domainProxyIds: match.proxyId !== undefined ?
          { [match.ruleKey]: match.proxyId } : mods.domainProxyIds, proxyRoutes: mods.proxyRoutes || {} }, match.ruleKey);
        if (route.unavailable) return failClosedChain();
        return this.#proxyChain(route.chain, mods.fallbackProxyChain, strict) ?? failClosedChain();
      } catch (error) {
        console.warn('[Tab routing] Assigned route unavailable:', error.message);
        return failClosedChain();
      }
    }
    // Unlike the implicit legacy tail, an assigned route's opt-in DIRECT
    // must not be rewritten into a different proxy (same as cooked PAC).
    return this.#proxyChain(mods.filteredCustomsString, mods.fallbackProxyChain, strict, mods.replaceDirectWith);
  }

  setup() {
    if (this.registered || proxyBackend.platform !== 'firefox' || !chrome.proxy?.onRequest) return;
    this.registered = true;
    // Gecko filters WebSocket handshakes by their exposed ws:/wss: URL.
    chrome.proxy.onRequest.addListener((details) => this.handle(details).catch((error) => {
      console.warn('[Tab routing]', error.message);
      return undefined;
    }), { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] });
    chrome.proxy.settings.onChange.addListener(() => { this.settings = null; });
    chrome.tabs.onRemoved.addListener((id) => this.tabs.delete(id));
    chrome.tabs.onUpdated.addListener((id, change) => {
      if (change.url) this.tabs.set(id, webHost(change.url, true));
    });
  }
}

export const tabProxyRouter = new TabProxyRouter();
