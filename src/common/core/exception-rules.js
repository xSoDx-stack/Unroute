'use strict';

// Pure rule lookup and statistics, shared by background routing and settings.

export function matchExceptionDomain(host, exceptions = {}) {
  if (!host || !exceptions || typeof exceptions !== 'object') return { matched: false };
  host = host.toLowerCase().trim();

  // 1. Direct exact match
  if (Object.prototype.hasOwnProperty.call(exceptions, host)) {
    return {
      matched: true,
      ruleKey: host,
      isProxied: exceptions[host] === true,
      isExact: true,
    };
  }

  // 2. Exact wildcard match
  const exactWild = `*.${host}`;
  if (Object.prototype.hasOwnProperty.call(exceptions, exactWild)) {
    return {
      matched: true,
      ruleKey: exactWild,
      isProxied: exceptions[exactWild] === true,
      isExact: true,
    };
  }

  // 3. Parent domain suffix matches
  const parts = host.split('.');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(i).join('.');
    const parentWild = `*.${parent}`;
    if (Object.prototype.hasOwnProperty.call(exceptions, parentWild)) {
      return {
        matched: true,
        ruleKey: parentWild,
        isProxied: exceptions[parentWild] === true,
        isExact: false,
      };
    }
    if (Object.prototype.hasOwnProperty.call(exceptions, parent)) {
      return {
        matched: true,
        ruleKey: parent,
        isProxied: exceptions[parent] === true,
        isExact: false,
      };
    }
  }

  return { matched: false };
}

export function calculateExceptionStats(exceptions = {}, whitelist = []) {
  let includedCount = 0;
  let excludedCount = 0;
  if (exceptions && typeof exceptions === 'object') {
    const keys = Object.keys(exceptions);
    for (let i = 0; i < keys.length; i++) {
      const val = exceptions[keys[i]];
      if (val === true) includedCount++;
      else if (val === false) excludedCount++;
    }
  }
  const whitelistCount = (whitelist && whitelist.length) || 0;
  return { includedCount, excludedCount, whitelistCount };
}
