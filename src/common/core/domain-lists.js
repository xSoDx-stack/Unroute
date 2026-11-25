'use strict';

import { matchExceptionDomain } from './exception-rules.js';
import { normalizeDomainRule } from './domain-rules.js';
import { domainMutationError, requireRuleRevision } from './domain-rule-mutations.js';

export const MAX_DOMAIN_LISTS = 100;
export const MAX_LIST_DOMAINS = 100000;
export const MAX_DOMAIN_LIST_NAME_LENGTH = 64;
// Only snapshots owned by this module may bypass validation by identity.
const normalizedLists = new WeakSet();
const normalizedDomains = new WeakSet();
const normalizedRows = new WeakSet();

function invalid(message = 'Invalid domain list.') {
  return domainMutationError('INVALID_DOMAIN_LIST', message);
}

export function normalizeDomainListName(value) {
  if (typeof value !== 'string') throw invalid('A list name is required.');
  const name = value.normalize('NFKC').trim();
  if (!name || [...name].length > MAX_DOMAIN_LIST_NAME_LENGTH || [...name].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)) throw invalid('Invalid list name.');
  return name;
}

export function suggestDomainListName(value, existingNames = []) {
  // Names use NFKC + lowercase, not transliteration or full Unicode case folding.
  const base = normalizeDomainListName([...value.normalize('NFKC').trim()].slice(0, MAX_DOMAIN_LIST_NAME_LENGTH).join(''));
  const used = new Set([...existingNames].map(name => name.normalize('NFKC').trim().toLowerCase()));
  let candidate = base;
  for (let index = 2; used.has(candidate.toLowerCase()); index++) {
    const suffix = ` (${index})`;
    candidate = [...base].slice(0, MAX_DOMAIN_LIST_NAME_LENGTH - suffix.length).join('') + suffix;
  }
  return candidate;
}

export function normalizeListDomains(values) {
  if (!Array.isArray(values) || values.length > MAX_LIST_DOMAINS) throw invalid('Invalid list domains.');
  if (normalizedDomains.has(values)) return values;
  const domains = new Set();
  for (const value of values) {
    const result = normalizeDomainRule(value);
    if (!result.valid) throw invalid(result.error);
    domains.add(result.domain);
  }
  const normalized = Object.freeze([...domains]);
  normalizedDomains.add(normalized);
  return normalized;
}

/** Validate atomically; never drop invalid rows or collapse different owners. */
export function normalizeDomainLists(values) {
  if (!Array.isArray(values) || values.length > MAX_DOMAIN_LISTS) throw invalid('Invalid domain lists.');
  if (normalizedLists.has(values)) return values;
  const ids = new Set(), names = new Set();
  // Reserve unique existing names before suffixing older duplicates.
  const reservedNames = new Set(Array.from(values, list => normalizeDomainListName(list?.name).toLowerCase()));
  let total = 0;
  const normalized = values.map(list => {
    if (!list || typeof list !== 'object' || typeof list.id !== 'string' || !list.id || list.id.length > 128 ||
        ids.has(list.id) || typeof list.proxyId !== 'string' || !list.proxyId || list.proxyId.length > 128 ||
        typeof list.enabled !== 'boolean') throw invalid();
    ids.add(list.id);
    let name = normalizeDomainListName(list.name);
    if (names.has(name.toLowerCase())) name = suggestDomainListName(name, reservedNames);
    names.add(name.toLowerCase()); reservedNames.add(name.toLowerCase());
    const domains = normalizeListDomains(list.domains);
    total += domains.length;
    if (total > MAX_LIST_DOMAINS) throw invalid('Domain list limit exceeded.');
    if (normalizedRows.has(list) && name === list.name) return list;
    const row = Object.freeze({ ...list, name, domains });
    normalizedRows.add(row);
    return row;
  });
  Object.freeze(normalized);
  normalizedLists.add(normalized);
  return normalized;
}

function findList(raw, id) {
  const list = (raw.domainLists || []).find(item => item.id === id);
  if (!list) throw domainMutationError('DOMAIN_LIST_UNKNOWN', 'Domain list no longer exists.');
  return list;
}

export function saveDomainList(raw, message, { catalog = [] } = {}) {
  requireRuleRevision(raw, message.expectedRevision, true);
  const creating = message.listId === undefined;
  const current = creating ? null : findList(raw, message.listId);
  const name = message.name === undefined && current ? current.name : normalizeDomainListName(message.name);
  if ((raw.domainLists || []).some(list => list.id !== current?.id && normalizeDomainListName(list.name).toLowerCase() === name.toLowerCase())) {
    throw domainMutationError('DOMAIN_LIST_NAME_EXISTS', 'A domain list with this name already exists.');
  }
  const enabled = message.enabled === undefined && current ? current.enabled : message.enabled;
  if (typeof enabled !== 'boolean') throw invalid('List enabled must be boolean.');
  const proxyId = message.proxyId === undefined && current ? current.proxyId : message.proxyId;
  if (!current || proxyId !== current.proxyId || (enabled && !current.enabled)) {
    if (typeof proxyId !== 'string' || !catalog.some(profile => profile.id === proxyId && profile.enabled)) {
      throw domainMutationError('PROXY_TARGET_UNAVAILABLE', 'Selected proxy is unavailable.');
    }
  }
  const domains = message.domains === undefined ? current?.domains || [] : normalizeListDomains(message.domains);
  if (current && name === current.name && enabled === current.enabled && proxyId === current.proxyId &&
      domains.length === current.domains.length && domains.every((value, i) => value === current.domains[i])) return raw;
  const list = { id: current?.id || `list:${crypto.randomUUID()}`, name, proxyId, enabled, domains };
  const domainLists = creating ? [...(raw.domainLists || []), list] : raw.domainLists.map(item => item.id === list.id ? list : item);
  if (domainLists.length > MAX_DOMAIN_LISTS || domainLists.reduce((sum, item) => sum + item.domains.length, 0) > MAX_LIST_DOMAINS) {
    throw invalid('Domain list limit exceeded.');
  }
  return { ...raw, domainLists };
}

const compiledSnapshots = new WeakMap();
const EMPTY_LISTS = Object.freeze([]);

export function deleteDomainList(raw, message) {
  requireRuleRevision(raw, message.expectedRevision, true);
  findList(raw, message.listId);
  return { ...raw, domainLists: raw.domainLists.filter(list => list.id !== message.listId) };
}

export function reorderDomainLists(raw, message) {
  requireRuleRevision(raw, message.expectedRevision, true);
  const current = raw.domainLists || EMPTY_LISTS;
  const ids = message.listIds;
  if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== current.length) throw invalid('Expected every list ID exactly once.');
  const byId = new Map(current.map(list => [list.id, list]));
  if (ids.some(id => !byId.has(id))) throw invalid('Unknown list ID.');
  if (ids.every((id, i) => current[i].id === id)) return raw;
  return { ...raw, domainLists: ids.map(id => byId.get(id)) };
}

/** Immutable canonical snapshots are compiled once, never once per request. */
export function matchDomainLists(host, lists = EMPTY_LISTS) {
  let compiled = compiledSnapshots.get(lists);
  if (!compiled) {
    compiled = lists.filter(list => list.enabled).map(list => ({ list,
      rules: Object.fromEntries(list.domains.map(domain => [domain, true])) }));
    if (normalizedLists.has(lists) || lists === EMPTY_LISTS) compiledSnapshots.set(lists, compiled);
  }
  for (const { list, rules } of compiled) {
    const match = matchExceptionDomain(host, rules);
    if (match.matched) return { matched: true, isProxied: true, ruleKey: match.ruleKey,
      proxyId: list.proxyId, listId: list.id };
  }
  return { matched: false };
}
