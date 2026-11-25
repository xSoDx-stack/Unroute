'use strict';

import { getRawProxyEntries, parseProxyScheme, proxyEndpointKey } from './utils.js';
import { LOCAL_PROXY_SERVICES } from './local-proxy-services.js';

export const BUILTIN_PROXY_IDS = Object.freeze({ tor: 'builtin:tor', warp: 'builtin:warp' });
export const MAX_CUSTOM_PROXIES = 50;
export const MAX_PROXY_NAME_LENGTH = 32;
export const proxyNameLength = name => [...name.normalize('NFKC').trim()].length;
const EMPTY = Object.freeze({});
const validatedBindings = new WeakMap();
const connectionEdits = new WeakMap();
const folded = name => name.normalize('NFKC').trim().toLocaleLowerCase('en-US');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

const rawEntries = raw => getRawProxyEntries(raw).map(({ text }) => text);

function rewriteRawEntries(raw, rewrite) {
  let result = '';
  let cursor = 0;
  for (const { text, start, end } of getRawProxyEntries(raw)) {
    const replacement = rewrite(text, end);
    if (replacement === undefined) continue;
    result += raw.slice(cursor, start) + replacement.text;
    cursor = replacement.end ?? end;
  }
  return result + raw.slice(cursor);
}

function normalizeRawConnection(text) {
  let normalized = text.replace(/^PROXY(?=\s)/i, 'HTTP');
  if (normalized.includes('#')) {
    const parsed = parseProxyScheme(normalized);
    if (parsed?.creds.includes('#')) {
      // Keep the persisted form compatible with older readers that strip
      // everything after a hash. Preserve decoding even on legacy invalid %.
      const end = normalized.lastIndexOf('@');
      const start = /^(?:HTTP|HTTPS|SOCKS[45]?)\s+/i.exec(normalized)?.[0].length ?? 0;
      const creds = normalized.slice(start, end);
      const colon = creds.indexOf(':');
      const encodeHashes = part => {
        if (!part.includes('#')) return part;
        try { decodeURIComponent(part); } catch { part = part.replace(/%/g, '%25'); }
        return part.replace(/#/g, '%23');
      };
      const encoded = colon < 0 ? encodeHashes(creds) :
        `${encodeHashes(creds.slice(0, colon))}:${encodeHashes(creds.slice(colon + 1))}`;
      normalized = normalized.slice(0, start) + encoded + normalized.slice(end);
    }
  }
  return normalized === text ? undefined : { text: normalized };
}
function connections(raw, strict = true, legacyRaw = '') {
  const entries = rawEntries(raw);
  const legacy = rawEntries(legacyRaw);
  const legacyCounts = new Map();
  for (const text of legacy) legacyCounts.set(text, (legacyCounts.get(text) || 0) + 1);

  const result = [];
  const authorities = new Map();
  const endpoints = new Map();
  for (const text of entries) {
    const existing = (legacyCounts.get(text) || 0) > 0;
    if (existing) legacyCounts.set(text, legacyCounts.get(text) - 1);
    const parsed = parseProxyScheme(text.replace(/^PROXY\s+/i, 'HTTP '));
    if (!parsed) { if (strict && !existing) fail('PROXY_INVALID_ENDPOINT', 'Invalid proxy endpoint.'); else continue; }
    const type = parsed.type === 'HTTP' ? 'PROXY' : parsed.type === 'SOCKS4' ? 'SOCKS' : parsed.type;
    const endpoint = proxyEndpointKey(parsed);
    const authority = endpoint.slice(type.length + 1);
    const auth = JSON.stringify([parsed.username, parsed.password]);
    if (strict && authorities.has(authority) && authorities.get(authority).auth !== auth && !(existing && authorities.get(authority).existing)) fail('PROXY_AUTH_CONFLICT', 'Conflicting credentials for one proxy authority.');
    authorities.set(authority, { auth, existing });
    if (strict && !existing && parsed.hasAuth && type.startsWith('SOCKS')) fail('PROXY_SOCKS_AUTH', 'SOCKS authentication is not supported by the browser.');
    if (endpoints.has(endpoint)) { if (strict && !(existing && endpoints.get(endpoint))) fail('PROXY_DUPLICATE_ENDPOINT', 'This proxy endpoint already exists.'); else continue; }
    endpoints.set(endpoint, existing);
    result.push({ endpoint, text, type, directive: `${type} ${parsed.hostname}:${parsed.port}` });
  }
  return result;
}

function validName(name, legacy = false) {
  if (typeof name !== 'string') fail('PROXY_INVALID_NAME', 'Enter a proxy name.');
  const normalized = name.normalize('NFKC').trim();
  const tooLong = legacy ? normalized.length > 80 : proxyNameLength(normalized) > MAX_PROXY_NAME_LENGTH;
  if (!normalized || tooLong || [...normalized].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail('PROXY_INVALID_NAME', 'Proxy names must contain 1–32 characters.');
  return legacy ? name : normalized;
}

export function reconcileProxyProfiles(next, previous = null) {
  if (next.ownProxyOrDie != null && typeof next.ownProxyOrDie !== 'boolean') fail('PROXY_INVALID_FAILOVER', 'Invalid own-domain fallback policy.');
  const edit = connectionEdits.get(next.proxyProfiles);
  // Keep one connection source readable by the profile, PAC and backup paths.
  if (typeof next.customProxyStringRaw === 'string') {
    const normalizedRaw = rewriteRawEntries(next.customProxyStringRaw, normalizeRawConnection);
    if (normalizedRaw !== next.customProxyStringRaw) next = { ...next, customProxyStringRaw: normalizedRaw };
  }
  const strict = Boolean(previous && next.customProxyStringRaw !== previous.customProxyStringRaw);
  const points = connections(next.customProxyStringRaw, strict, previous?.customProxyStringRaw);
  // Reads/migrations have no previous snapshot and must retain oversized
  // legacy lists. Writes compare unique valid custom endpoints, including
  // disabled profiles, against the CURRENT snapshot (never a high-water mark).
  if (previous && points.length > Math.max(MAX_CUSTOM_PROXIES, connections(previous.customProxyStringRaw, false).length)) {
    fail('PROXY_LIMIT', `At most ${MAX_CUSTOM_PROXIES} custom proxies are allowed. Existing larger lists may be edited or reduced, but not increased.`);
  }
  const old = (previous ? previous.proxyProfiles : next.proxyProfiles) || [];
  const supplied = next.proxyProfiles || [];
  const profiles = [];
  const usedIds = new Set();
  const usedNames = new Set(['tor', 'cloudflare warp', 'warp']);
  const profileInputs = points.map(point => {
    const candidate = supplied.find(p => p.endpoint === point.endpoint);
    return { point, candidate, prior: old.find(p => p.endpoint === point.endpoint) ||
      (edit && candidate?.id === edit.id && point.endpoint === edit.endpoint ?
        old.find(p => p.id === edit.id && p.endpoint === edit.previousEndpoint) : undefined) };
  });
  // Reserve explicit/persisted names before generating any defaults: a new
  // endpoint may precede its existing namesake in an edited raw list.
  const reservedNames = new Set(profileInputs.map(({ candidate, prior }) => candidate?.name ?? prior?.name)
    .filter(name => typeof name === 'string').map(folded));
  for (const { point, prior, candidate } of profileInputs) {
    const id = prior?.id || candidate?.id || `custom:${globalThis.crypto.randomUUID()}`;
    if (previous && !prior && old.some(p => p.id === id)) fail('PROXY_INVALID_ID', 'An existing proxy ID cannot be moved to another endpoint.');
    if (!/^custom:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) || usedIds.has(id)) fail('PROXY_INVALID_ID', 'Invalid or duplicate proxy ID.');
    let name = candidate?.name ?? prior?.name;
    // Hydration is a read, not permission to introduce long names on writes.
    // Preserve unchanged saved spelling verbatim, including legacy 33–80 names.
    const legacyName = name !== undefined && (!previous || (prior && name === prior.name));
    if (name === undefined) {
      const endpointName = [...point.endpoint.normalize('NFKC').trim()];
      name = endpointName.slice(0, MAX_PROXY_NAME_LENGTH).join('');
      let suffix = 2;
      while (usedNames.has(folded(name)) || reservedNames.has(folded(name))) {
        const tail = ` (${suffix++})`;
        name = endpointName.slice(0, MAX_PROXY_NAME_LENGTH - tail.length).join('') + tail;
      }
    }
    name = validName(name, legacyName);
    if (usedNames.has(folded(name))) fail('PROXY_DUPLICATE_NAME', 'Proxy names must be unique; built-in names are reserved.');
    usedIds.add(id); usedNames.add(folded(name));
    profiles.push({ id, name, endpoint: point.endpoint });
  }
  // Preserve first-added ordering across raw text reorderings.
  const additionOrder = new Map(profiles.map((p, index) => [p.id, index]));
  profiles.sort((a, b) => {
    const ai = old.findIndex(p => p.id === a.id); const bi = old.findIndex(p => p.id === b.id);
    return (ai < 0 ? old.length + additionOrder.get(a.id) : ai) - (bi < 0 ? old.length + additionOrder.get(b.id) : bi);
  });
  const proxyProfiles = equal(profiles, next.proxyProfiles) ? next.proxyProfiles : profiles;
  let bindings = next.domainProxyIds || EMPTY;
  if (typeof bindings !== 'object' || Array.isArray(bindings)) fail('PROXY_INVALID_ASSIGNMENTS', 'Proxy assignments must be a domain-to-ID map.');
  let copied = false;
  const catalog = getProxyCatalog({ ...next, proxyProfiles });
  const byId = new Map(catalog.map(p => [p.id, p]));
  const signature = catalog.map(p => `${p.id}:${p.enabled}`).join('|');
  const fallback = next.fallbackProxyId;
  if (fallback != null && (typeof fallback !== 'string' || !fallback)) fail('PROXY_UNAVAILABLE', 'Select an enabled fallback proxy.');
  if (previous && fallback != null) {
    const target = byId.get(fallback);
    if (fallback !== previous.fallbackProxyId && (!target || !target.enabled)) fail('PROXY_UNAVAILABLE', 'Select an enabled fallback proxy.');
    if (!target && getProxyCatalog(previous).some(p => p.id === fallback)) fail('PROXY_REPLACEMENT_REQUIRED', 'Select a replacement fallback before deleting its proxy.');
  }
  for (const list of next.domainLists || []) {
    const prior = previous?.domainLists?.find(item => item.id === list.id);
    const profile = byId.get(list.proxyId);
    // Hydration keeps unavailable saved identities fail-closed. A write may
    // preserve them, but cannot introduce a bad binding or delete its target.
    if (!previous) continue;
    if (prior?.proxyId !== list.proxyId && (!profile || !profile.enabled)) fail('PROXY_UNAVAILABLE', 'Select an enabled proxy for this domain list.');
    if (!profile && getProxyCatalog(previous).some(item => item.id === list.proxyId)) fail('PROXY_REPLACEMENT_REQUIRED', 'Reassign domain lists before deleting their proxy.');
  }
  const validated = validatedBindings.get(bindings);
  const unchangedBindings = validated && validated.exceptions === next.exceptions && validated.signature === signature &&
    (!previous || bindings === previous.domainProxyIds);
  for (const [key, id] of unchangedBindings ? [] : Object.entries(bindings)) {
    if (next.exceptions?.[key] !== true) {
      if (previous && previous.domainProxyIds?.[key] !== id) fail('PROXY_INVALID_ASSIGNMENTS', 'Only proxied domain rules may have a proxy assignment.');
      if (!copied) { bindings = { ...bindings }; copied = true; }
      delete bindings[key]; continue;
    }
    const profile = byId.get(id);
    if (!profile) fail('PROXY_UNKNOWN_ID', 'The assigned proxy no longer exists. Reassign its sites before deleting it.');
    if (previous && previous.domainProxyIds?.[key] !== id && !profile.enabled) fail('PROXY_UNAVAILABLE', 'This proxy is disabled or excluded by the current restrictions.');
  }
  validatedBindings.set(bindings, { exceptions: next.exceptions, signature });
  let defaultProxyId = next.defaultProxyId ?? null;
  if (defaultProxyId && !byId.has(defaultProxyId)) {
    // A raw-list replacement may remove an unbound old default. Bindings were
    // validated above: any surviving use of its ID has already been rejected.
    if (previous && defaultProxyId === previous.defaultProxyId) defaultProxyId = null;
    else fail('PROXY_REPLACEMENT_REQUIRED', 'Select a replacement for the default proxy.');
  }
  if (previous && defaultProxyId && defaultProxyId !== previous.defaultProxyId && !byId.get(defaultProxyId).enabled) fail('PROXY_UNAVAILABLE', 'Select an enabled proxy.');
  if (!defaultProxyId) defaultProxyId = catalog.find(p => p.enabled)?.id || null;
  const changed = previous && (!equal(proxyProfiles, previous.proxyProfiles) || defaultProxyId !== previous.defaultProxyId ||
    next.ifUseLocalTor !== previous.ifUseLocalTor || next.ifUseLocalWarp !== previous.ifUseLocalWarp || next.ifUseSecureProxiesOnly !== previous.ifUseSecureProxiesOnly);
  const revision = previous ? (previous._proxyCatalogRevision || 0) + (changed ? 1 : 0) : Number(next._proxyCatalogRevision) || 0;
  if (proxyProfiles === next.proxyProfiles && bindings === next.domainProxyIds && defaultProxyId === next.defaultProxyId && revision === next._proxyCatalogRevision) return next;
  return { ...next, proxyProfiles, domainProxyIds: bindings, defaultProxyId, _proxyCatalogRevision: revision };
}

export function getProxyCatalog(mods) {
  const custom = (mods.proxyProfiles || []).map(p => ({ ...p, enabled: !mods.ifUseSecureProxiesOnly || p.endpoint.startsWith('HTTPS '), builtin: false }));
  return [...custom, ...Object.entries(BUILTIN_PROXY_IDS).map(([key, id]) => ({ id,
    name: key === 'tor' ? 'Tor' : 'Cloudflare WARP', endpoint: LOCAL_PROXY_SERVICES[key].proxies.join('; '),
    enabled: Boolean(mods[LOCAL_PROXY_SERVICES[key].modKey]), builtin: true }))];
}

export function compileProxyRoutes(mods) {
  const routes = {};
  const endpoints = new Map(connections(mods.customProxyStringRaw, false).map(p => [p.endpoint, p.directive]));
  for (const profile of getProxyCatalog(mods)) {
    if (!profile.enabled || (!profile.builtin && !endpoints.has(profile.endpoint))) continue;
    let chain = profile.builtin ? profile.endpoint : endpoints.get(profile.endpoint);
    if (profile.builtin && mods.ifUseSecureProxiesOnly && profile.id === BUILTIN_PROXY_IDS.warp) chain = LOCAL_PROXY_SERVICES.warp.proxies.filter(p => p.startsWith('HTTPS ')).join('; ');
    if (chain) routes[profile.id] = chain;
  }
  return routes;
}

export function resolveProxyRoute(mods, ruleKey) {
  const id = Object.hasOwn(mods.domainProxyIds || EMPTY, ruleKey) ? mods.domainProxyIds[ruleKey] : null;
  if (!id) return { assigned: false, proxyId: null, chain: mods.filteredCustomsString || '', unavailable: false };
  const chain = (mods.proxyRoutes || compileProxyRoutes(mods))[id];
  return { assigned: true, proxyId: id, chain: chain || 'PROXY 127.0.0.1:1', unavailable: !chain };
}

export function updateProxyProfile(raw, id, { proxy, name } = {}) {
  if (Object.values(BUILTIN_PROXY_IDS).includes(id)) fail('PROXY_BUILTIN_READONLY', 'Built-in proxy connections cannot be edited.');
  const profile = raw.proxyProfiles?.find(p => p.id === id);
  if (!profile) fail('PROXY_UNKNOWN_ID', 'Unknown proxy.');
  if (typeof proxy !== 'string' || rawEntries(proxy)[0] !== proxy.trim() || /[;\r\n]/.test(proxy)) fail('PROXY_INVALID_ENDPOINT', 'Enter exactly one proxy endpoint.');
  proxy = proxy.trim().replace(/^PROXY\s+/i, 'HTTP ');
  const [point] = connections(proxy);
  if (!point) fail('PROXY_INVALID_ENDPOINT', 'Invalid proxy endpoint.');
  if (raw.proxyProfiles.some(p => p.id !== id && p.endpoint === point.endpoint)) fail('PROXY_DUPLICATE_ENDPOINT', 'This proxy endpoint already exists.');
  name = name === undefined || name === profile.name ? profile.name : validName(name);
  let matched = false;
  const customProxyStringRaw = rewriteRawEntries(raw.customProxyStringRaw || '', text => {
    if (proxyEndpointKey(text) !== profile.endpoint) return;
    // Collapse duplicate legacy spellings of this one connection on edit,
    // preserving comments, separators, and every unrelated raw entry.
    const replacement = matched ? '' : proxy;
    matched = true;
    return { text: replacement };
  });
  if (!matched) fail('PROXY_INVALID_ENDPOINT', 'The saved connection is unavailable.');
  const proxyProfiles = name === profile.name && point.endpoint === profile.endpoint ? raw.proxyProfiles :
    raw.proxyProfiles.map(p => p.id === id ? { ...p, name, endpoint: point.endpoint } : p);
  const next = { ...raw, customProxyStringRaw, proxyProfiles };
  // Private capability follows the profile branch through savePacMods' shallow
  // copies. Raw input and auth are still validated against the real old raw.
  connectionEdits.set(proxyProfiles, { id, previousEndpoint: profile.endpoint, endpoint: point.endpoint });
  return reconcileProxyProfiles(next, raw);
}

export function renameProxyProfile(raw, id, name) {
  if (Object.values(BUILTIN_PROXY_IDS).includes(id)) fail('PROXY_BUILTIN_READONLY', 'Built-in proxies cannot be renamed or deleted.');
  if (!raw.proxyProfiles?.some(p => p.id === id)) fail('PROXY_UNKNOWN_ID', 'Unknown proxy.');
  name = validName(name);
  return reconcileProxyProfiles({ ...raw, proxyProfiles: raw.proxyProfiles.map(p => p.id === id ? { ...p, name } : p) }, raw);
}

export function selectDefaultProxy(raw, id) {
  const catalog = getProxyCatalog(raw);
  if (id === null ? catalog.some(p => p.enabled) : !catalog.some(p => p.id === id && p.enabled)) fail('PROXY_UNAVAILABLE', 'Select an enabled proxy.');
  return reconcileProxyProfiles({ ...raw, defaultProxyId: id }, raw);
}

export function deleteProxyProfile(raw, id, replacementProxyId) {
  if (Object.values(BUILTIN_PROXY_IDS).includes(id)) fail('PROXY_BUILTIN_READONLY', 'Built-in proxies cannot be renamed or deleted.');
  const profile = raw.proxyProfiles?.find(p => p.id === id);
  if (!profile) fail('PROXY_UNKNOWN_ID', 'Unknown proxy.');
  const bindings = raw.domainProxyIds || EMPTY;
  const bound = Object.values(bindings).includes(id);
  const listBound = (raw.domainLists || []).some(list => list.proxyId === id);
  const remaining = getProxyCatalog(raw).filter(p => p.id !== id && p.enabled);
  const fallbackBound = raw.fallbackProxyId === id;
  const needsReplacement = bound || listBound || (remaining.length > 0 && (fallbackBound || raw.defaultProxyId === id));
  if ((needsReplacement || replacementProxyId != null) && !remaining.some(p => p.id === replacementProxyId)) fail('PROXY_REPLACEMENT_REQUIRED', 'Select an enabled replacement proxy before deleting this proxy.');
  const domainProxyIds = bound ? Object.fromEntries(Object.entries(bindings).map(([key, value]) => [key, value === id ? replacementProxyId : value])) : bindings;
  const domainLists = listBound ? raw.domainLists.map(list => list.proxyId === id ? { ...list, proxyId: replacementProxyId } : list) : raw.domainLists;
  const source = raw.customProxyStringRaw || '';
  const customProxyStringRaw = rewriteRawEntries(source, (text, end) => {
    if (proxyEndpointKey(text) !== profile.endpoint) return;
    // Drop an immediately adjacent inline separator, but not comments or
    // indentation on another line.
    if (source[end] === ';') end += source[end + 1] === ' ' ? 2 : 1;
    return { text: '', end };
  });
  return reconcileProxyProfiles({ ...raw, customProxyStringRaw,
    proxyProfiles: raw.proxyProfiles.filter(p => p.id !== id), domainProxyIds, ...(domainLists ? { domainLists } : {}),
    ...(fallbackBound ? { fallbackProxyId: replacementProxyId ?? null } : {}),
    defaultProxyId: raw.defaultProxyId === id ? replacementProxyId || null : raw.defaultProxyId }, raw);
}
