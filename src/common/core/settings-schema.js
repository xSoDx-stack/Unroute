'use strict';

import { t } from './i18n.js';
import { sanitizeSiteResourceInheritance } from './site-resource-policy.js';
import { decodeSettings } from './settings-codec.js';
import { reconcileProxyProfiles, getProxyCatalog } from './proxy-profiles.js';
import { normalizeDomainLists, normalizeListDomains } from './domain-lists.js';
import { normalizeDomainRule } from './domain-rules.js';

export const SETTINGS_SCHEMA_VERSION = 3;
const EMPTY_DOMAINS = Object.freeze([]);
const MAX_HISTORY = 5;
const MAX_HISTORY_CHANGES = 50000;
const SOURCES = new Set(['manual', 'site', 'auto', 'import', 'undo']);
const trustedHistory = new WeakSet();
const trustedMeta = new WeakSet();
const normalizedMetadata = new WeakMap();
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const rulesRevision = raw => validRevision(raw._rulesRevision) ? raw._rulesRevision :
  (validRevision(raw._revision) ? raw._revision : 0);

function metadata(value) {
  if (!value || typeof value !== 'object' || !validRevision(value.revision) || !SOURCES.has(value.source)) return null;
  if (normalizedMetadata.has(value)) return normalizedMetadata.get(value);
  const normalized = { source: value.source, revision: value.revision, site: typeof value.site === 'string' ? value.site : '',
    updatedAt: Number(value.updatedAt) || 0, ...(value.suppressAuto === true ? { suppressAuto: true } : {}),
    ...(value.siteControl === true ? { siteControl: true } : {}),
    ...(typeof value.inheritedListId === 'string' && value.inheritedListId.length > 0 && value.inheritedListId.length <= 128 &&
        typeof value.inheritedMainHost === 'string' && value.inheritedMainHost.length > 0 && value.inheritedMainHost.length <= 253 ?
      { inheritedListId: value.inheritedListId, inheritedMainHost: value.inheritedMainHost } : {}) };
  normalizedMetadata.set(value, normalized);
  normalizedMetadata.set(normalized, normalized);
  return normalized;
}

const legacyControls = new WeakMap();
function controlMetadata(value, domain, legacy) {
  const meta = metadata(value);
  // Old site batches did not distinguish the selected main host from
  // same-site resources. Preserve those routes conservatively on upgrade;
  // never guess that an unrelated CDN was the selected main document.
  if (!legacy || !meta || meta.siteControl || meta.source !== 'site' || !meta.site ||
      !(domain === meta.site || domain.endsWith(`.${meta.site}`))) return meta;
  if (!legacyControls.has(meta)) legacyControls.set(meta, { ...meta, siteControl: true });
  return legacyControls.get(meta);
}

function normalizeHistory(history, legacy) {
  if (!legacy && Array.isArray(history) && trustedHistory.has(history)) return history;
  const normalized = [];
  let retained = 0;
  for (const item of Array.isArray(history) ? history.slice(0, MAX_HISTORY) : []) {
    if (!item || !validRevision(item.revision) || item.id !== `r${item.revision}` || !Array.isArray(item.changes)) continue;
    const oversized = retained + item.changes.length > MAX_HISTORY_CHANGES;
    const changes = oversized ? [] : item.changes.filter(change => change && ['exception', 'whitelist', 'proxy', 'pac'].includes(change.kind) &&
      typeof change.domain === 'string' && change.domain.length > 0 && change.domain.length <= 253 &&
      (change.kind === 'proxy' ? [change.before, change.after].every(v => v === null || typeof v === 'string') :
        [true, false, null].includes(change.before) && [true, false, null].includes(change.after)))
      .map(change => ({ kind: change.kind, domain: change.domain, before: change.before, after: change.after,
        beforeMeta: controlMetadata(change.beforeMeta, change.domain, legacy) }));
    retained += changes.length;
    normalized.push({ id: item.id, revision: item.revision, at: Number(item.at) || 0,
      source: SOURCES.has(item.source) ? item.source : 'manual', site: typeof item.site === 'string' ? item.site : '',
      changes, count: oversized ? item.changes.length : Number(item.count) || changes.length,
      ...(oversized || item.truncated ? { truncated: true } : {}), ...(item.undoneAt ? { undoneAt: Number(item.undoneAt) || 1 } : {}) });
  }
  trustedHistory.add(normalized);
  return normalized;
}

function normalizeMeta(raw, legacy) {
  if (!legacy && raw && trustedMeta.has(raw)) return raw;
  const normalized = {};
  for (const [key, value] of Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})) {
    if (!/^(exception|whitelist|proxy|pac):.{1,253}$/.test(key)) continue;
    const domain = key.slice(key.indexOf(':') + 1);
    // Provenance belongs to the exact stored rule key, not an alias of it.
    if (normalizeDomainRule(domain).domain !== domain) continue;
    const valid = controlMetadata(value, domain, legacy);
    if (valid) normalized[key] = valid;
  }
  trustedMeta.add(normalized);
  return normalized;
}

export function migrateSettings(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t("msg_invalid_settings_format_dc48c732", "Повреждён формат настроек"));
  if (raw._schemaVersion !== undefined && !validRevision(raw._schemaVersion)) throw new Error(t("msg_invalid_settings_format_dc48c732", "Повреждён формат настроек"));
  if ((raw._schemaVersion || 0) > SETTINGS_SCHEMA_VERSION) throw new Error(t("msg_these_settings_were_created_by_a_newer_versio_10a34f43", "Настройки созданы более новой версией расширения"));
  try { raw = decodeSettings(raw); }
  catch { throw new Error(t("msg_invalid_settings_format_dc48c732", "Повреждён формат настроек")); }
  const legacy = (raw._schemaVersion || 0) < 3;
  return reconcileProxyProfiles({ ...raw, _schemaVersion: SETTINGS_SCHEMA_VERSION,
    _revision: Number.isSafeInteger(raw._revision) && raw._revision >= 0 ? raw._revision : 0,
    _rulesRevision: rulesRevision(raw),
    domainLists: normalizeDomainLists(raw.domainLists === undefined ? EMPTY_DOMAINS : raw.domainLists),
    pacBypassDomains: normalizeListDomains(raw.pacBypassDomains === undefined ? EMPTY_DOMAINS : raw.pacBypassDomains),
    siteResourceInheritance: sanitizeSiteResourceInheritance(raw.siteResourceInheritance),
    ruleMeta: normalizeMeta(raw.ruleMeta, legacy), ruleHistory: normalizeHistory(raw.ruleHistory, legacy) });
}

export function recordRuleChange(previous, next, context = {}, now = Date.now()) {
  next = reconcileProxyProfiles(next, previous);
  const revision = (previous._revision || 0) + 1;
  const migrated = migrateSettings(next);
  const previousRulesRevision = rulesRevision(previous);
  const policyChanged = JSON.stringify(sanitizeSiteResourceInheritance(previous.siteResourceInheritance)) !==
    JSON.stringify(migrated.siteResourceInheritance);
  const listsChanged = previous.domainLists !== migrated.domainLists &&
    JSON.stringify(previous.domainLists || []) !== JSON.stringify(migrated.domainLists);
  if (context.metadataOnly) return { ...migrated, _revision: previous._revision || 0,
    _rulesRevision: previousRulesRevision + (next.ruleMeta !== previous.ruleMeta || policyChanged || listsChanged ? 1 : 0) };
  if (context.source === 'undo') return { ...migrated, _revision: revision,
    _rulesRevision: previousRulesRevision + (next.exceptions !== previous.exceptions ||
      next.whitelist !== previous.whitelist || next.pacBypassDomains !== previous.pacBypassDomains || next.domainProxyIds !== previous.domainProxyIds || next.ruleMeta !== previous.ruleMeta || policyChanged || listsChanged ? 1 : 0) };
  let meta = previous.ruleMeta || {};
  // A dedicated resource reset clears exact tombstones, including proxy
  // tombstones with no surviving assignment. Ordinary PAC edits keep theirs.
  if (context.resetResourceHost) {
    meta = { ...meta };
    delete meta[`exception:${context.resetResourceHost}`];
    delete meta[`proxy:${context.resetResourceHost}`];
  }
  const changes = [];
  const source = context.source || 'manual';
  // A bulk import shares one immutable provenance record per originating site.
  const operationMetadata = new Map();
  const siteControls = new Set(context.siteControlDomains || []);
  const touch = new Set(context.touchedDomains || []);
  const proxyTouch = new Set([...touch, ...(context.touchedProxyDomains || [])]
    .filter(domain => Object.hasOwn(next.domainProxyIds || {}, domain)));
  const visit = (kind, before, after) => {
    const touched = kind === 'exception' ? touch : kind === 'proxy' ? proxyTouch : new Set();
    if (before === after && touched.size === 0) return;
    for (const domain of new Set([...Object.keys(before), ...Object.keys(after), ...touched])) {
      const key = `${kind}:${domain}`;
      const oldValue = Object.hasOwn(before, domain) ? before[domain] : null;
      const value = Object.hasOwn(after, domain) ? after[domain] : null;
      if (oldValue === value && !touched.has(domain)) continue;
      if (!changes.length) meta = { ...meta };
      changes.push({ kind, domain, before: oldValue, after: value, beforeMeta: previous.ruleMeta?.[key] || null });
      const site = context.siteForDomain?.[domain] || context.site || '';
      const siteControl = source === 'site' && siteControls.has(domain);
      const owner = source === 'auto' ? context.listForDomain?.[domain] : null;
      const metadataKey = `${site}:${siteControl}:${owner?.id || ''}:${owner?.host || ''}`;
      if (!operationMetadata.has(metadataKey)) operationMetadata.set(metadataKey, { source, site, revision, updatedAt: now,
        ...(siteControl ? { siteControl: true } : {}),
        ...(owner ? { inheritedListId: owner.id, inheritedMainHost: owner.host } : {}) });
      meta[key] = operationMetadata.get(metadataKey);
    }
  };
  visit('exception', previous.exceptions || {}, next.exceptions || {});
  visit('proxy', previous.domainProxyIds || {}, next.domainProxyIds || {});
  if (previous.whitelist !== next.whitelist) {
    visit('whitelist', Object.fromEntries((previous.whitelist || []).map(d => [d, true])),
      Object.fromEntries((next.whitelist || []).map(d => [d, true])));
  }
  if (previous.pacBypassDomains !== migrated.pacBypassDomains) {
    visit('pac', Object.fromEntries((previous.pacBypassDomains || []).map(d => [d, true])),
      Object.fromEntries(migrated.pacBypassDomains.map(d => [d, true])));
  }
  let history = previous.ruleHistory || [];
  if (changes.length) {
    history = [{ id: `r${revision}`, revision, at: now, source, site: context.site || '',
      changes: changes.length > MAX_HISTORY_CHANGES ? [] : changes, count: changes.length,
      ...(changes.length > MAX_HISTORY_CHANGES ? { truncated: true } : {}) }, ...history].slice(0, MAX_HISTORY);
    while (history.length > 1 && history.reduce((sum, item) => sum + item.changes.length, 0) > MAX_HISTORY_CHANGES) history.pop();
  }
  trustedMeta.add(meta);
  trustedHistory.add(history);
  return { ...migrated, _revision: revision, _rulesRevision: previousRulesRevision + (changes.length || policyChanged || listsChanged ? 1 : 0),
    ruleMeta: meta, ruleHistory: history };
}

export function undoRuleChange(raw, id = null) {
  const history = raw.ruleHistory || [];
  const operation = history.find(item => !item.undoneAt && (!id || item.id === id));
  if (!operation) throw new Error(t("msg_no_changes_to_undo_0934f336", "Нет изменений для отмены"));
  if (operation.truncated) throw new Error(t("msg_this_change_is_too_large_to_undo_safely_use_i_e1b5ff7c", "Изменение слишком велико для безопасной отмены. Используйте импорт или редактор списков."));
  const exceptions = { ...(raw.exceptions || {}) };
  const domainProxyIds = { ...(raw.domainProxyIds || {}) };
  const validProxyIds = new Set(getProxyCatalog(raw).map(p => p.id));
  const proxyChanges = new Map(operation.changes.filter(change => change.kind === 'proxy')
    .map(change => [change.domain, change]));
  const whitelist = new Set(raw.whitelist || []);
  const pacBypassDomains = new Set(raw.pacBypassDomains || []);
  const meta = { ...(raw.ruleMeta || {}) };
  let restored = 0;
  let skipped = 0;
  for (const change of operation.changes) {
    const key = `${change.kind}:${change.domain}`;
    const current = change.kind === 'proxy' ? (Object.hasOwn(domainProxyIds, change.domain) ? domainProxyIds[change.domain] : null) : change.kind === 'pac' ? (pacBypassDomains.has(change.domain) ? true : null) : change.kind === 'whitelist' ? (whitelist.has(change.domain) ? true : null) :
      (Object.hasOwn(exceptions, change.domain) ? exceptions[change.domain] : null);
    // Tombstones retain ownership of deleted rules. A later same-mode click
    // also changes ownership, so undo never overwrites a newer decision.
    const ownerMatches = meta[key]?.revision === operation.revision;
    if (current !== change.after || !ownerMatches) { skipped++; continue; }
    // Boolean and assignment restoration form one route. Restoring only true
    // after its original profile was deleted would silently select the legacy
    // shared chain instead of the user's former proxy.
    const originalProxy = proxyChanges.get(change.domain)?.before;
    if (change.kind === 'exception' && change.before === true && originalProxy && !validProxyIds.has(originalProxy)) {
      skipped++; continue;
    }
    if (change.kind === 'proxy') {
      if (change.before !== null && (!validProxyIds.has(change.before) || exceptions[change.domain] !== true)) { skipped++; continue; }
      if (change.before === null) delete domainProxyIds[change.domain];
      else Object.defineProperty(domainProxyIds, change.domain, { value: change.before, enumerable: true, writable: true, configurable: true });
    } else if (change.kind === 'pac') {
      if (change.before === null) pacBypassDomains.delete(change.domain);
      else if (Object.hasOwn(exceptions, change.domain)) { skipped++; continue; }
      else pacBypassDomains.add(change.domain);
    } else if (change.kind === 'whitelist') {
      if (change.before === null) whitelist.delete(change.domain);
      else whitelist.add(change.domain);
    } else if (change.before === null) delete exceptions[change.domain];
    else exceptions[change.domain] = change.before;
    if (change.beforeMeta) meta[key] = change.beforeMeta;
    else if (change.before === null) meta[key] = {
      source: 'undo', revision: (raw._revision || 0) + 1, suppressAuto: true, updatedAt: Date.now(),
    };
    else delete meta[key];
    restored++;
  }
  const updatedHistory = history.map(item => item.id === operation.id ? { ...item, undoneAt: Date.now() } : item);
  trustedMeta.add(meta);
  trustedHistory.add(updatedHistory);
  if (!restored) return { settings: { ...raw, ruleHistory: updatedHistory }, restored, skipped };
  return { settings: { ...raw, exceptions, domainProxyIds, whitelist: [...whitelist], pacBypassDomains: [...pacBypassDomains], ruleMeta: meta,
    ruleHistory: updatedHistory }, restored, skipped };
}

export function describeHistory(raw) {
  return normalizeHistory(raw.ruleHistory).map(({ changes, ...item }) => ({ ...item, count: item.count || changes.length }));
}

export function clearRuleHistory(raw) {
  const whitelist = new Set(raw.whitelist || []);
  const pacBypassDomains = new Set(raw.pacBypassDomains || []);
  const currentMeta = raw.ruleMeta || {};
  const entries = Object.entries(currentMeta);
  const retained = entries.filter(([key, meta]) => {
    const domain = key.slice(key.indexOf(':') + 1);
    if (meta.suppressAuto) return true;
    if (key.startsWith('pac:')) return pacBypassDomains.has(domain);
    if (key.startsWith('whitelist:')) return whitelist.has(domain);
    if (key.startsWith('proxy:')) return Object.hasOwn(raw.domainProxyIds || {}, domain);
    return Object.hasOwn(raw.exceptions || {}, domain);
  });
  const ruleMeta = retained.length === entries.length ? currentMeta : Object.fromEntries(retained);
  return { ...raw, ruleHistory: [], ruleMeta };
}
