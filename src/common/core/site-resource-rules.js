'use strict';

import { matchExceptionDomain } from './exception-rules.js';
import { matchConfiguredRule } from './domain-route-resolver.js';
import { matchDomainLists } from './domain-lists.js';

const pacRules = new WeakMap();
function isManualPacResource(mods, host, root, mainHost) {
  const domains = mods.pacBypassDomains;
  if (!domains?.length) return false;
  let rules = pacRules.get(domains);
  if (!rules) {
    rules = Object.fromEntries(domains.map(domain => [domain, true]));
    pacRules.set(domains, rules);
  }
  const match = matchExceptionDomain(host, rules);
  return match.matched && match.ruleKey !== root && match.ruleKey !== mainHost;
}

function isListedResource(mods, host, root, mainHost) {
  const match = matchDomainLists(host, mods.domainLists);
  return match.matched && match.ruleKey !== root && match.ruleKey !== mainHost;
}

export function isSiteOwned(ruleMeta, key, root) {
  const meta = ruleMeta?.[`exception:${key}`];
  const proxyMeta = ruleMeta?.[`proxy:${key}`];
  return ['auto', 'site'].includes(meta?.source) && !meta.siteControl && meta.site === root &&
    (!proxyMeta || (['auto', 'site'].includes(proxyMeta.source) && proxyMeta.site === root));
}

function resourcePlan(mods, record, host, parent, ruleMeta = mods.ruleMeta, exactOnly = false) {
  const parentWildcards = [`*.${record.root}`, `*.${record.mainHost}`];
  if (host === record.root || host === record.mainHost || parentWildcards.includes(host)) return null;
  if (isManualPacResource(mods, host, record.root, record.mainHost)) return null;
  if (isListedResource(mods, host, record.root, record.mainHost)) return null;
  if (ruleMeta?.[`exception:${host}`]?.suppressAuto || ruleMeta?.[`proxy:${host}`]?.suppressAuto) return null;
  const match = matchExceptionDomain(host, mods.exceptions);
  const owned = match.matched && isSiteOwned(ruleMeta, match.ruleKey, record.root);
  const parentSuffix = match.ruleKey === record.root || match.ruleKey === record.mainHost;
  // Plain parent suffixes express parent intent, not a manual CDN decision.
  // Wildcards and legacy exact resource booleans remain manual unless owned.
  if (match.matched && !owned && !parentSuffix) return null;
  const key = !exactOnly && owned && !parentSuffix && !parentWildcards.includes(match.ruleKey) ? match.ruleKey : host;
  const enabled = mods.siteResourceInheritance?.[record.root] !== false;
  const mode = !enabled ? false : parent.matched && !parent.isPac ? parent.isProxied : null;
  if (mode === null && !owned) return null;
  const id = mode === true ? parent.proxyId ?? mods.domainProxyIds?.[parent.ruleKey] : undefined;
  if (mode === null || !match.matched || match.isProxied !== mode ||
      mods.domainProxyIds?.[key] !== id) return { mode, id, key };
  return null;
}

// Dedicated exact reset: never edit a matched wildcard or another resource.
export function resetExactResourceRule(current, record, host) {
  const exceptions = { ...current.exceptions };
  const domainProxyIds = { ...current.domainProxyIds };
  const ruleMeta = { ...current.ruleMeta };
  delete exceptions[host];
  delete domainProxyIds[host];
  delete ruleMeta[`exception:${host}`];
  delete ruleMeta[`proxy:${host}`];
  const next = { ...current, exceptions, domainProxyIds, ruleMeta,
    ...(current.pacBypassDomains ? { pacBypassDomains: current.pacBypassDomains.filter(domain => domain !== host) } : {}) };
  const parent = matchConfiguredRule(record.mainHost, next);
  const plan = resourcePlan(next, record, host, parent, ruleMeta, true);
  if (plan) {
    if (plan.mode !== null) exceptions[host] = plan.mode;
    if (plan.id !== undefined) domainProxyIds[host] = plan.id;
  }
  return next;
}

export function hasUnassignedResources(mods, batches) {
  return mods.ifMindExceptions !== false && batches.some(({ record, hosts }) => {
    const parent = matchConfiguredRule(record.mainHost, mods);
    return hosts.some(host => resourcePlan(mods, record, host, parent));
  });
}

// One shared snapshot preserves first-writer ownership of shared CDN hosts.
export function inheritResourceRules(current, batches, ruleMeta = current.ruleMeta) {
  const exceptions = { ...current.exceptions };
  const domainProxyIds = { ...current.domainProxyIds };
  const siteForDomain = {};
  const listForDomain = {};
  const changedRecords = new Set();
  for (const { record, hosts } of batches) {
    const parent = matchConfiguredRule(record.mainHost, current);
    if (current.ifMindExceptions === false) continue;
    for (const host of hosts) {
      const plan = resourcePlan({ ...current, exceptions, domainProxyIds }, record, host, parent, ruleMeta);
      if (!plan) continue;
      if (plan.mode === null) delete exceptions[plan.key];
      else exceptions[plan.key] = plan.mode;
      if (plan.id !== undefined) domainProxyIds[plan.key] = plan.id;
      else delete domainProxyIds[plan.key];
      siteForDomain[plan.key] = record.root;
      if (parent.listId) listForDomain[plan.key] = { id: parent.listId, host: record.mainHost || record.root };
      changedRecords.add(record);
    }
  }
  return { exceptions, domainProxyIds, siteForDomain, listForDomain, changedRecords };
}

// Plan boolean rules and their assignment map in one atomic mutation. The
// older boolean-only helper remains available for legacy callers.
export function planSiteRuleMode(current, root, hosts, mode, proxyId, mainHost = root) {
  // Only the explicitly selected root/main host may replace manual intent.
  // Same-root resource rules are not site controls merely because of suffix.
  const isControl = key => key === root || key === mainHost;
  const owned = key => isSiteOwned(current.ruleMeta, key, root);
  const touchedDomains = new Set([root, mainHost]);
  for (const key of Object.keys(current.exceptions || {})) {
    if (isControl(key) || (owned(key) && !isManualPacResource(current, key, root, mainHost) &&
      !isListedResource(current, key, root, mainHost))) touchedDomains.add(key);
  }
  for (const host of hosts) {
    if (!isControl(host) && isManualPacResource(current, host, root, mainHost)) continue;
    if (!isControl(host) && isListedResource(current, host, root, mainHost)) continue;
    const match = matchExceptionDomain(host, current.exceptions);
    if (!match.matched || isControl(match.ruleKey) || owned(match.ruleKey)) touchedDomains.add(host);
  }
  const exceptions = { ...current.exceptions };
  const domainProxyIds = { ...current.domainProxyIds };
  for (const key of touchedDomains) {
    const resourceMode = !isControl(key) && current.siteResourceInheritance?.[root] === false ? false : mode;
    if (resourceMode === null) delete exceptions[key];
    else exceptions[key] = resourceMode;
    if (exceptions[key] !== true) delete domainProxyIds[key];
    else if (proxyId) domainProxyIds[key] = proxyId;
  }
  const pacBypass = new Set(current.pacBypassDomains || []);
  for (const key of new Set([root, mainHost])) {
    if (mode === null) pacBypass.add(key);
    else pacBypass.delete(key);
  }
  return { exceptions, domainProxyIds, touchedDomains, pacBypassDomains: [...pacBypass] };
}

export function setSiteRuleMode(currentExceptions, root, hosts, mode) {
  const exceptions = { ...currentExceptions };
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
    // A more specific subdomain rule must not defeat an explicit whole-site
    // switch. External resources retain their exact hostname.
    for (const target of hosts) exceptions[target] = mode;
  }
  return exceptions;
}
