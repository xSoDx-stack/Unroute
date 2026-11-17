'use strict';

import { matchConfiguredRule } from './domain-route-resolver.js';
import { utils } from './utils.js';
import { inheritsSiteResources } from './site-resource-policy.js';

import { isSiteOwned } from './site-resource-rules.js';

function isAutomatic(mods, key, root) {
  const meta = mods.ruleMeta?.[`exception:${key}`];
  const proxyMeta = mods.ruleMeta?.[`proxy:${key}`];
  // Site-controlled rules from another root retain their explicit global
  // intent. Only legacy auto CDN rules remain per-tab across owners.
  return isSiteOwned(mods.ruleMeta, key, root) ||
    (meta?.source === 'auto' && (!proxyMeta || proxyMeta.source === 'auto'));
}

export function canResetExactResource(mods, host, mainHost) {
  const root = utils.getRootDomain(mainHost) || mainHost;
  if (host === root || host === mainHost || matchConfiguredRule(host, mods).listId) return false;
  if ((mods.pacBypassDomains || []).includes(host) &&
      !['auto', 'site'].includes(mods.ruleMeta?.[`exception:${host}`]?.source)) return true;
  return ['exception', 'proxy'].some(kind => {
    const meta = mods.ruleMeta?.[`${kind}:${host}`];
    const present = Object.hasOwn(kind === 'exception' ? mods.exceptions || {} : mods.domainProxyIds || {}, host);
    const source = meta?.source || (kind === 'proxy' ? mods.ruleMeta?.[`exception:${host}`]?.source : undefined);
    return (present || meta?.suppressAuto === true) && (meta?.siteControl === true || !['auto', 'site'].includes(source));
  });
}

// Runtime and popup share provenance; matching proxy IDs do not imply ownership.
function resourceDecision(mods, host, mainHost, inheritTab) {
  const request = matchConfiguredRule(host, mods);
  const root = utils.getRootDomain(mainHost) || mainHost;
  const main = host === root || host === mainHost;
  const parentSuffix = request.ruleKey === root || request.ruleKey === mainHost;
  const automatic = request.matched && isAutomatic(mods, request.ruleKey, root);
  const manual = request.matched && (!automatic || request.listId) && !parentSuffix;
  const suppressed = ['exception', 'proxy'].some(kind => mods.ruleMeta?.[`${kind}:${host}`]?.suppressAuto);
  const followsTab = inheritTab && !main && !manual && !suppressed;
  const match = followsTab ? (!inheritsSiteResources(mods, root) ?
    { matched: true, isProxied: false, ruleKey: null } : matchConfiguredRule(mainHost, mods)) : request;
  const origin = request.listId && !followsTab ? 'list' : main ? 'main' : manual || suppressed ? 'manual' : followsTab || parentSuffix ? 'site' :
    automatic ? (isSiteOwned(mods.ruleMeta, request.ruleKey, root) ? 'site' : 'automatic-other') : 'pac';
  return { match, origin, ruleKey: request.matched ? request.ruleKey : null };
}

export function matchResourceRule(mods, host, mainHost, inheritTab = false) {
  return resourceDecision(mods, host, mainHost, inheritTab).match;
}

export function describeResourceRoute(mods, host, mainHost, inheritTab = false) {
  const { match, origin, ruleKey } = resourceDecision(mods, host, mainHost, inheritTab);
  return { mode: !match.matched || match.isPac ? 'pac' : match.isProxied ? 'proxy' : 'direct',
    proxyId: match.matched && match.isProxied ? match.proxyId ?? mods.domainProxyIds?.[match.ruleKey] ?? null : null,
    origin, ruleKey, canResetExact: canResetExactResource(mods, host, mainHost) };
}
