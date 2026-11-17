'use strict';

import { normalizeDomainLists, normalizeListDomains } from './domain-lists.js';

// Store the rule snapshot as one string so storage IPC does not clone tens of
// thousands of history/metadata objects into every listening extension page.
// Domains and repeated provenance records are stored once and referenced by ID.
let cached = null;
const EMPTY_ASSIGNMENTS = Object.freeze({});
const EMPTY_LISTS = Object.freeze([]);
const kindId = kind => kind === 'exception' ? 0 : kind === 'whitelist' ? 1 : kind === 'proxy' ? 2 : kind === 'pac' ? 3 : (() => { throw new TypeError('Invalid rule kind'); })();

export function clearSettingsCodecCache() { cached = null; }

export function encodeSettings(raw) {
  const { exceptions = {}, whitelist = [], ruleMeta = {}, ruleHistory = [], domainProxyIds = EMPTY_ASSIGNMENTS,
    domainLists = EMPTY_LISTS, pacBypassDomains = EMPTY_LISTS, ...preferences } = raw;
  if (cached && cached.exceptions === exceptions && cached.whitelist === whitelist &&
      cached.ruleMeta === ruleMeta && cached.ruleHistory === ruleHistory && cached.domainProxyIds === domainProxyIds &&
      cached.domainLists === domainLists && cached.pacBypassDomains === pacBypassDomains) {
    return { ...preferences, _ruleData: cached.data };
  }
  const domains = [];
  const domainIds = new Map();
  const meta = [];
  const metaIds = new Map();
  const metaObjectIds = new WeakMap();
  const domainId = domain => {
    if (typeof domain !== 'string' || !domain) throw new TypeError('Invalid domain value');
    if (!domainIds.has(domain)) {
      domainIds.set(domain, domains.length);
      domains.push(domain);
    }
    return domainIds.get(domain);
  };
  const metaId = value => {
    if (!value) return null;
    if (metaObjectIds.has(value)) return metaObjectIds.get(value);
    const key = JSON.stringify(value);
    if (!metaIds.has(key)) {
      metaIds.set(key, meta.length);
      meta.push(value);
    }
    const id = metaIds.get(key);
    metaObjectIds.set(value, id);
    return id;
  };
  const rules = [];
  for (const domain of Object.keys(exceptions)) {
    const value = exceptions[domain];
    if (value !== true && value !== false) throw new TypeError('Invalid rule value');
    rules.push(domainId(domain), value);
  }
  const allowed = whitelist.map(domainId);
  const provenance = [];
  for (const key of Object.keys(ruleMeta)) {
    const separator = key.indexOf(':');
    provenance.push(kindId(key.slice(0, separator)), domainId(key.slice(separator + 1)), metaId(ruleMeta[key]));
  }
  const history = ruleHistory.map(({ changes, ...operation }) => {
    const entries = [];
    for (const change of changes) {
      entries.push(kindId(change.kind), domainId(change.domain),
        change.before, change.after, metaId(change.beforeMeta));
    }
    return { ...operation, changes: entries };
  });
  const assignments = [];
  for (const [domain, id] of Object.entries(domainProxyIds)) {
    if (typeof id !== 'string' || !id) throw new TypeError('Invalid proxy ID');
    assignments.push(domainId(domain), id);
  }
  const lists = normalizeDomainLists(domainLists).map(({ domains: listDomains, ...list }) => ({ ...list, domains: listDomains.map(domainId) }));
  const bypass = normalizeListDomains(pacBypassDomains).map(domainId);
  const data = JSON.stringify([domains, meta, rules, allowed, provenance, history, assignments, lists, bypass]);
  cached = { exceptions, whitelist, ruleMeta, ruleHistory, domainProxyIds, domainLists, pacBypassDomains, data };
  return { ...preferences, _ruleData: data };
}

export function decodeSettings(raw) {
  if (!Object.hasOwn(raw, '_ruleData')) return raw;
  const { _ruleData, ...preferences } = raw;
  const packed = JSON.parse(_ruleData);
  if (!Array.isArray(packed) || ![6, 7, 9].includes(packed.length) || !packed.every(Array.isArray)) {
    throw new TypeError('Invalid compact rule snapshot');
  }
  const [domains, meta, rules, allowed, provenance, history, assignments = [], lists = [], bypass = []] = packed;
  if (domains.some(domain => typeof domain !== 'string' || !domain) ||
      rules.length % 2 || provenance.length % 3 || assignments.length % 2) throw new TypeError('Invalid compact rule tables');
  const domainAt = id => {
    if (!Number.isSafeInteger(id) || id < 0 || id >= domains.length) throw new TypeError('Invalid domain ID');
    return domains[id];
  };
  const metaAt = id => {
    if (id === null) return null;
    if (!Number.isSafeInteger(id) || id < 0 || id >= meta.length) throw new TypeError('Invalid metadata ID');
    return meta[id];
  };
  const kindAt = value => {
    if (value !== 0 && value !== 1 && !(value === 2 && packed.length >= 7) && !(value === 3 && packed.length === 9)) throw new TypeError('Invalid rule kind');
    return ['exception', 'whitelist', 'proxy', 'pac'][value];
  };
  const exceptions = {};
  for (let index = 0; index < rules.length; index += 2) {
    const value = rules[index + 1];
    if (value !== true && value !== false) throw new TypeError('Invalid rule value');
    Object.defineProperty(exceptions, domainAt(rules[index]), { value, enumerable: true, configurable: true, writable: true });
  }
  const whitelist = allowed.map(domainAt);
  const ruleMeta = {};
  for (let index = 0; index < provenance.length; index += 3) {
    ruleMeta[`${kindAt(provenance[index])}:${domainAt(provenance[index + 1])}`] = metaAt(provenance[index + 2]);
  }
  const ruleHistory = history.map(operation => {
    if (!operation || typeof operation !== 'object' || !Array.isArray(operation.changes) || operation.changes.length % 5) {
      throw new TypeError('Invalid compact rule history');
    }
    const changes = [];
    for (let index = 0; index < operation.changes.length; index += 5) {
      const [kind, domain, before, after, beforeMeta] = operation.changes.slice(index, index + 5);
      const valid = value => kind === 2 && packed.length >= 7 ? value === null || (typeof value === 'string' && value.length > 0) : [true, false, null].includes(value);
      if (!valid(before) || !valid(after)) throw new TypeError('Invalid history value');
      changes.push({ kind: kindAt(kind), domain: domainAt(domain), before, after, beforeMeta: metaAt(beforeMeta) });
    }
    return { ...operation, changes };
  });
  const domainProxyIds = {};
  for (let index = 0; index < assignments.length; index += 2) {
    const id = assignments[index + 1];
    if (typeof id !== 'string' || !id) throw new TypeError('Invalid proxy ID');
    Object.defineProperty(domainProxyIds, domainAt(assignments[index]), { value: id, enumerable: true, configurable: true, writable: true });
  }
  const domainLists = normalizeDomainLists(lists.map(list => {
    if (!list || typeof list !== 'object' || !Array.isArray(list.domains)) throw new TypeError('Invalid compact domain list');
    return { ...list, domains: list.domains.map(domainAt) };
  }));
  const pacBypassDomains = normalizeListDomains(bypass.map(domainAt));
  return { ...preferences, exceptions, whitelist, ruleMeta, ruleHistory, domainProxyIds, domainLists, pacBypassDomains };
}
