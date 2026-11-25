'use strict';

import { normalizeDomainRule } from './domain-rules.js';

export function domainMutationError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function requireRuleRevision(raw, expectedRevision, required = false) {
  if (expectedRevision === undefined || expectedRevision === null) {
    if (required) throw domainMutationError('RULES_REVISION_REQUIRED', 'Обновите список перед сохранением.');
    return;
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== (raw._rulesRevision ?? raw._revision ?? 0)) {
    throw domainMutationError('RULES_CONFLICT', 'Список изменён в другой вкладке. Обновите его и повторите действие.');
  }
}

function normalizeKey(value) {
  const result = normalizeDomainRule(value);
  if (!result.valid) throw domainMutationError('INVALID_DOMAIN_MUTATION', result.error);
  return result.domain;
}

function checkTarget(catalog, proxyId) {
  if (typeof proxyId !== 'string' || !catalog.some(profile => profile.id === proxyId && profile.enabled)) {
    throw domainMutationError('PROXY_TARGET_UNAVAILABLE', 'Выбранный прокси недоступен. Обновите список прокси.');
  }
  return proxyId;
}

/** Apply deltas to the latest canonical snapshot inside the background write queue. */
export function applyDomainRuleMutations(raw, operations, { catalog = [], expectedRevision } = {}) {
  requireRuleRevision(raw, expectedRevision);
  if (!Array.isArray(operations) || operations.length > 100000) {
    throw domainMutationError('INVALID_DOMAIN_MUTATION', 'Некорректный список изменений сайтов.');
  }
  return applyDeltas(raw, operations, catalog);
}

function applyDeltas(raw, operations, catalog) {
  let exceptions = raw.exceptions || {};
  let assignments = raw.domainProxyIds || {};
  let whitelist = raw.whitelist || [];
  let whitelistSet;
  let originalWhitelistSet;
  let originalPacSet;
  let pacSet;
  const initial = new Map();
  const touchedDomains = new Set();
  const touchedExceptionDomains = new Set();
  const enabled = catalog.filter(profile => profile.enabled);
  const setException = (domain, mode) => {
    if (exceptions === raw.exceptions) exceptions = { ...exceptions };
    if (mode === 'pac') delete exceptions[domain];
    else exceptions[domain] = mode === 'proxy';
  };
  const setAssignment = (domain, proxyId) => {
    if ((assignments[domain] ?? null) === proxyId) return;
    if (assignments === raw.domainProxyIds) assignments = { ...assignments };
    if (proxyId === null) delete assignments[domain];
    else assignments[domain] = proxyId;
  };
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') throw domainMutationError('INVALID_DOMAIN_MUTATION', 'Некорректное изменение сайта.');
    const domain = normalizeKey(operation.domain);
    const mode = operation.mode;
    if (!['proxy', 'direct', 'pac', 'pac-bypass', 'whitelist-add', 'whitelist-remove'].includes(mode)) {
      throw domainMutationError('INVALID_DOMAIN_MUTATION', 'Неизвестный режим сайта.');
    }
    touchedDomains.add(domain);
    const whitelistOperation = mode.startsWith('whitelist-');
    if (!whitelistOperation) touchedExceptionDomains.add(domain);
    const key = `${whitelistOperation ? 'w' : 'e'}:${domain}`;
    if (!initial.has(key)) initial.set(key, { domain, whitelistOperation,
      value: whitelistOperation ? (originalWhitelistSet ??= new Set(raw.whitelist || [])).has(domain) : (raw.exceptions?.[domain] ?? null),
      proxyId: whitelistOperation ? null : (raw.domainProxyIds?.[domain] ?? null),
      pac: !whitelistOperation && (originalPacSet ??= new Set(raw.pacBypassDomains || [])).has(domain) });
    if (whitelistOperation) {
      whitelistSet ??= new Set(whitelist);
      if (mode === 'whitelist-add') whitelistSet.add(domain);
      else whitelistSet.delete(domain);
      continue;
    }
    const wantsPac = mode === 'pac-bypass';
    if ((pacSet || originalPacSet).has(domain) !== wantsPac) {
      pacSet ??= new Set(originalPacSet);
      if (wantsPac) pacSet.add(domain);
      else pacSet.delete(domain);
    }
    if (mode === 'proxy') {
      let target = assignments[domain] ?? null;
      if (operation.proxyId !== undefined) target = checkTarget(catalog, operation.proxyId);
      else if (exceptions[domain] !== true) {
        if (enabled.length > 1) throw domainMutationError('PROXY_SELECTION_REQUIRED', 'Выберите прокси для новых сайтов.');
        target = enabled[0]?.id ?? null;
      }
      if (exceptions[domain] !== true) setException(domain, mode);
      setAssignment(domain, target);
    } else {
      const removes = mode === 'pac' || wantsPac;
      if (removes ? Object.hasOwn(exceptions, domain) : exceptions[domain] !== false) setException(domain, removes ? 'pac' : mode);
      setAssignment(domain, null);
    }
  }
  if (whitelistSet) whitelist = [...whitelistSet];
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const before of initial.values()) {
    const after = before.whitelistOperation ? (whitelistSet || new Set(whitelist)).has(before.domain) : (exceptions[before.domain] ?? null);
    const afterProxy = before.whitelistOperation ? null : (assignments[before.domain] ?? null);
    const afterPac = !before.whitelistOperation && (pacSet || originalPacSet).has(before.domain);
    if (before.value === after && before.proxyId === afterProxy && before.pac === afterPac) unchanged++;
    else if (!before.pac && afterPac && before.value === null) added++;
    else if (!before.pac && (before.whitelistOperation ? before.value === false : before.value === null) && after !== null && after !== false) added++;
    else if (!before.pac && !before.whitelistOperation && before.value === null && after === false) added++;
    else changed++;
  }
  return { settings: { ...raw, exceptions, domainProxyIds: assignments, whitelist,
    ...(pacSet ? { pacBypassDomains: [...pacSet] } : {}) },
    added, changed, unchanged, touchedDomains: [...touchedDomains],
    touchedExceptionDomains: [...touchedExceptionDomains] };
}

export function assignDomainProxies(raw, domains, proxyId, options = {}) {
  requireRuleRevision(raw, options.expectedRevision, true);
  checkTarget(options.catalog || [], proxyId);
  if (!Array.isArray(domains) || domains.length > 100000) throw domainMutationError('INVALID_DOMAIN_MUTATION', 'Некорректный список сайтов.');
  const keys = [...new Set(domains.map(normalizeKey))];
  for (const key of keys) {
    if (raw.exceptions?.[key] !== true) throw domainMutationError('PROXY_RULE_MISSING', 'Один из сайтов больше не находится в списке проксируемых. Обновите список.');
  }
  return applyDomainRuleMutations(raw, keys.map(domain => ({ domain, mode: 'proxy', proxyId })), options);
}

/** Explicit raw replace: keep assignments for unchanged positives; require a current revision. */
export function replaceDomainRuleLists(raw, patch, options = {}) {
  requireRuleRevision(raw, options.expectedRevision, true);
  const operations = [];
  let normalized;
  if (Object.hasOwn(patch, 'exceptions')) {
    if (!patch.exceptions || typeof patch.exceptions !== 'object' || Array.isArray(patch.exceptions)) {
      throw domainMutationError('INVALID_DOMAIN_MUTATION', 'Некорректный список правил сайтов.');
    }
    normalized = {};
    if (Object.keys(patch.exceptions).length > 100000) throw domainMutationError('INVALID_DOMAIN_MUTATION', 'Некорректный список правил сайтов.');
    for (const [input, value] of Object.entries(patch.exceptions)) {
      if (value !== true && value !== false) throw domainMutationError('INVALID_DOMAIN_MUTATION', 'Правило сайта должно содержать только режим прокси или напрямую.');
      const domain = normalizeKey(input);
      if (Object.hasOwn(normalized, domain) && normalized[domain] !== value) throw domainMutationError('INVALID_DOMAIN_MUTATION', 'В списке есть противоречащие друг другу правила сайта.');
      normalized[domain] = value;
    }
    for (const domain of Object.keys(raw.exceptions || {})) {
      if (!Object.hasOwn(normalized, domain)) operations.push({ domain, mode: 'pac' });
    }
    for (const [domain, value] of Object.entries(normalized)) {
      const operation = { domain, mode: value ? 'proxy' : 'direct' };
      if (value && raw.exceptions?.[domain] !== true && options.proxyId !== undefined) operation.proxyId = options.proxyId;
      operations.push(operation);
    }
  }
  if (Object.hasOwn(patch, 'whitelist')) {
    if (!Array.isArray(patch.whitelist) || patch.whitelist.length > 100000) throw domainMutationError('INVALID_DOMAIN_MUTATION', 'Некорректный белый список.');
    const next = new Set(patch.whitelist.map(normalizeKey));
    for (const domain of raw.whitelist || []) if (!next.has(domain)) operations.push({ domain, mode: 'whitelist-remove' });
    for (const domain of next) operations.push({ domain, mode: 'whitelist-add' });
  }
  if (Object.hasOwn(patch, 'pacBypassDomains')) {
    if (!Array.isArray(patch.pacBypassDomains) || patch.pacBypassDomains.length > 100000) throw domainMutationError('INVALID_DOMAIN_MUTATION', 'Некорректный список исключений PAC.');
    const next = new Set(patch.pacBypassDomains.map(normalizeKey));
    for (const domain of next) if (normalized && Object.hasOwn(normalized, domain)) {
      throw domainMutationError('INVALID_DOMAIN_MUTATION', 'В списке есть противоречащие друг другу правила сайта.');
    }
    for (const domain of raw.pacBypassDomains || []) if (!next.has(domain) && !(normalized && Object.hasOwn(normalized, domain))) operations.push({ domain, mode: 'pac' });
    for (const domain of next) operations.push({ domain, mode: 'pac-bypass' });
  }
  return applyDeltas(raw, operations, options.catalog || []);
}
