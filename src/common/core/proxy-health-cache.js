'use strict';

import { storage } from './storage.js';
import { parseProxyScheme } from './utils.js';

export const PROXY_HEALTH_CACHE_KEY = 'proxy-health-cache';

const MAX_CACHE_ENTRIES = 100;
const MAX_ERROR_LENGTH = 500;
let cacheQueue = Promise.resolve();
const authenticatedResults = new Map();

function enqueueCacheOperation(operation) {
  const task = cacheQueue.then(operation, operation);
  cacheQueue = task.catch(() => {});
  return task;
}

function normalizeHealthEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.ok !== 'boolean') {
    return null;
  }

  const checkedAt = Number(entry.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) {
    return null;
  }

  const normalized = {
    checking: false,
    ok: entry.ok,
    checkedAt,
  };
  if (Number.isFinite(entry.latency) && entry.latency >= 0) {
    normalized.latency = Math.round(entry.latency);
  }
  if (typeof entry.error === 'string' && entry.error) {
    normalized.error = entry.error.slice(0, MAX_ERROR_LENGTH);
  }
  return normalized;
}

function normalizeProxyList(proxyList) {
  const unique = new Set();
  for (const proxyRaw of proxyList || []) {
    const parsed = parseProxyScheme(proxyRaw);
    if (parsed) unique.add(parsed.raw);
  }
  return unique;
}

function withoutCredentialKeys(stored) {
  return Object.fromEntries(Object.entries(stored || {}).filter(([key]) => {
    const proxy = parseProxyScheme(key);
    return proxy && !proxy.hasAuth;
  }));
}

/**
 * Read results without discarding checks performed before a proxy is saved.
 * Only explicit list edits may prune orphaned entries.
 */
function readHealthCache(proxyList, prune) {
  return enqueueCacheOperation(async () => {
    const allowed = normalizeProxyList(typeof proxyList === 'function' ? await proxyList() : proxyList);
    const stored = await storage.get(PROXY_HEALTH_CACHE_KEY, {});
    const safe = withoutCredentialKeys(stored);
    const filtered = {};
    const durable = {};

    for (const proxyRaw of allowed) {
      const entry = normalizeHealthEntry(authenticatedResults.get(proxyRaw) || safe[proxyRaw]);
      if (entry) filtered[proxyRaw] = entry;
      if (safe[proxyRaw] && entry) durable[proxyRaw] = entry;
    }

    if (prune) {
      for (const key of authenticatedResults.keys()) if (!allowed.has(key)) authenticatedResults.delete(key);
    }
    const next = prune ? durable : safe;
    if (JSON.stringify(stored || {}) !== JSON.stringify(next)) {
      await storage.set(PROXY_HEALTH_CACHE_KEY, next);
    }
    return filtered;
  });
}

export function loadProxyHealthCache(proxyList = []) {
  return readHealthCache(proxyList, false);
}

/** Persists one completed proxy check. In-progress checks are never cached. */
export function saveProxyHealthResult(proxyRaw, result, checkedAt = Date.now()) {
  return enqueueCacheOperation(async () => {
    const parsed = parseProxyScheme(proxyRaw);
    const entry = normalizeHealthEntry(Object.assign({}, result, { checkedAt }));
    if (!parsed || !entry) return null;

    const stored = await storage.get(PROXY_HEALTH_CACHE_KEY, {});
    const safe = withoutCredentialKeys(stored);
    if (parsed.hasAuth) {
      // Never persist a second copy of the password or a password-derived key.
      authenticatedResults.delete(parsed.raw);
      authenticatedResults.set(parsed.raw, entry);
      if (authenticatedResults.size > MAX_CACHE_ENTRIES) authenticatedResults.delete(authenticatedResults.keys().next().value);
    } else {
      safe[parsed.raw] = entry;
    }
    const entries = Object.entries(safe)
      .map(([proxy, health]) => [proxy, normalizeHealthEntry(health)])
      .filter(([, health]) => health)
      .sort((a, b) => b[1].checkedAt - a[1].checkedAt)
      .slice(0, MAX_CACHE_ENTRIES);

    await storage.set(PROXY_HEALTH_CACHE_KEY, Object.fromEntries(entries));
    return entry;
  });
}

/** Keeps cache entries only for the supplied proxy list. */
export function pruneProxyHealthCache(proxyList = []) {
  return readHealthCache(proxyList, true);
}

export function clearProxyHealthCache() {
  return pruneProxyHealthCache([]);
}
