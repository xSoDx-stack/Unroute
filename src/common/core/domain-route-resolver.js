'use strict';

import { matchExceptionDomain } from './exception-rules.js';

// Both runtimes consume these immutable, precompiled tables. No list scans or
// domain-map construction occur on the network request path.
const snapshots = new WeakMap();
function put(table, key, value) {
  const clean = key.toLowerCase().trim();
  const wildcard = clean.startsWith('*.') || clean.startsWith('.');
  table[wildcard ? 'wild' : 'exact'][clean.replace(/^\*?\./, '')] = value;
}
const table = () => ({ exact: Object.create(null), wild: Object.create(null) });
export function compileConfiguredRules(mods) {
  const cached = snapshots.get(mods);
  if (cached) return cached;
  const all = table(), manual = table(), lists = table();
  let hasListResources = false;
  const add = (key, match) => {
    const meta = mods.ruleMeta?.[`exception:${key}`];
    const proxyMeta = mods.ruleMeta?.[`proxy:${key}`];
    const automatic = ['auto', 'site'].includes(meta?.source) && !meta.siteControl && meta.site !== key &&
      (!proxyMeta || ['auto', 'site'].includes(proxyMeta.source));
    if (automatic && meta.inheritedListId) hasListResources = true;
    const entry = { ...match, ruleKey: key, matched: true,
      ...(automatic ? { automaticSite: meta.site, inheritedListId: meta.inheritedListId,
        inheritedMainHost: meta.inheritedMainHost } : {}) };
    put(all, key, entry);
    if (!automatic) put(manual, key, entry);
  };
  for (const [key, value] of Object.entries(mods.exceptions || {})) {
    add(key, { isProxied: value === true,
      ...(value === true && Object.hasOwn(mods.domainProxyIds || {}, key) ? { proxyId: mods.domainProxyIds[key] } : {}) });
  }
  for (const key of mods.pacBypassDomains || []) add(key, { isProxied: null, isPac: true });
  // Reverse insertion preserves the first enabled owner at every suffix.
  for (let i = (mods.domainLists || []).length - 1; i >= 0; i--) {
    const list = mods.domainLists[i];
    if (!list.enabled) continue;
    for (const key of list.domains) put(lists, key, { matched: true, isProxied: true,
      ruleKey: key, proxyId: list.proxyId, listId: list.id, priority: i });
  }
  const compiled = { all, manual, lists, layered: Boolean(hasListResources || (mods.domainLists || []).length || (mods.pacBypassDomains || []).length) };
  snapshots.set(mods, compiled);
  return compiled;
}

// Self-contained so the exact same matcher can be embedded in a PAC VM.
export function matchCompiledRules(host, tables) {
  host = (host || '').toLowerCase().trim().replace(/\.+$/, '');
  function lookup(map, ordered, searchHost = host) {
    let winner;
    let start = 0;
    for (;;) {
      const suffix = start === 0 ? searchHost : searchHost.slice(start);
      // Exact wins at the full host; wildcard wins at ancestor suffixes.
      const first = (start === 0 ? map.exact : map.wild)[suffix];
      if (!ordered && first) return first;
      const second = (start === 0 ? map.wild : map.exact)[suffix];
      if (!ordered && second) return second;
      if (first && (!winner || first.priority < winner.priority)) winner = first;
      if (second && (!winner || second.priority < winner.priority)) winner = second;
      const dot = searchHost.indexOf('.', start);
      if (dot < 0) return winner;
      start = dot + 1;
    }
  }
  const all = lookup(tables.all);
  if (!tables.layered) return all ? { ...all, isExact: all.ruleKey === host || all.ruleKey === `*.${host}` } : { matched: false };
  const manual = lookup(tables.manual), list = lookup(tables.lists, true);
  // Keep materialized DIRECT policy above its plain parent intent. Positive
  // inherited copies must use the current list binding, not a stale profile
  // from before the delayed Chromium resource reconciliation.
  const parentIntent = all?.automaticSite && manual?.ruleKey === all.automaticSite;
  const parentListKey = list?.ruleKey.replace(/^\*\./, '');
  const independentList = list && parentListKey !== all?.automaticSite && parentListKey !== all?.inheritedMainHost;
  let inherited;
  if (all?.automaticSite && all.isProxied === true && (!manual || parentIntent) && !independentList) {
    const parentHost = all.inheritedMainHost || all.automaticSite;
    inherited = lookup(tables.manual, false, parentHost) || lookup(tables.lists, true, parentHost) ||
      (all.inheritedListId ? { matched: false } : undefined);
  }
  const winner = manual && !parentIntent ? manual :
    independentList ? list : inherited || all || list;
  if (!winner?.matched) return { matched: false };
  const { automaticSite: _automaticSite, priority: _priority,
    inheritedListId: _inheritedListId, inheritedMainHost: _inheritedMainHost, ...match } = winner;
  return { ...match, isExact: match.ruleKey === host || match.ruleKey === `*.${host}` };
}

export function matchConfiguredRule(host, mods) {
  if (mods.ifNoMods || mods.ifMindExceptions === false) return { matched: false };
  const mayBeLayered = mods.ruleMeta || mods.domainLists?.length || mods.pacBypassDomains?.length;
  const tables = mayBeLayered ? compileConfiguredRules(mods) : null;
  if (!tables?.layered) {
    const match = matchExceptionDomain(host, mods.exceptions);
    const proxyId = match.isProxied ? mods.domainProxyIds?.[match.ruleKey] : undefined;
    return proxyId === undefined ? match : { ...match, proxyId };
  }
  return matchCompiledRules(host, tables);
}
