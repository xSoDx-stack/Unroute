'use strict';

import { t } from './i18n.js';

import { getDefaults, createPacModifiers } from './pac-modifiers.js';
import { normalizeDomainRule } from './domain-rules.js';
import { normalizeDomainLists } from './domain-lists.js';
import { isCanonicalSiteRoot } from './site-resource-policy.js';
import { parseProxyScheme, proxyEndpointKey, utils } from './utils.js';
import { validatePacScriptSource } from './pac-validator.js';
import { PAC_PROVIDERS } from './pac-sync.js';
import { BUILTIN_PROXY_IDS } from './proxy-profiles.js';
import { SETTINGS_SCHEMA_VERSION } from './settings-schema.js';
import { normalizeAppearance, APPEARANCE_KEY } from '../pages/shared/appearance.js';
import { APPEARANCE_RESET_KEY, withAppearanceWriteLock } from './appearance-lock.js';
import { storage as defaultStorage } from './storage.js';
import { pacKitchen as defaultKitchen } from './pac-kitchen.js';
import { pacSync as defaultSync } from './pac-sync.js';
import { settingsCoordinator as defaultCoordinator } from './settings-coordinator.js';
import { applicationState as defaultApplication } from './application-state.js';
import { errorHandlers as defaultHandlers } from './error-handlers.js';
import { encodeSettings, decodeSettings } from './settings-codec.js';
import { cancelProxyChecks } from './proxy-checker.js';
import { clearProxyAuthAttempts } from './proxy-auth.js';
import { ipToHost } from './ip-to-host.js';
import { blockInformer } from './block-informer.js';
import { fitsBackupByteLimit } from './settings-backup-size.js';

export { MAX_BACKUP_BYTES } from './settings-backup-size.js';

export const BACKUP_FORMAT = 'unroute-settings';
export const BACKUP_VERSION = 1;
export const BACKUP_WARNING = 'Внимание: JSON не зашифрован и содержит логины и пароли всех прокси. Не публикуйте файл.';

function backupEnvelope({ settings, pac, notifications, appearance }) {
  return { format: BACKUP_FORMAT, formatVersion: BACKUP_VERSION,
    includesPasswords: true, warning: t('portable_settings_warning', BACKUP_WARNING),
    settings: { ...getDefaults(), ...settings }, pac, notifications, appearance };
}

export function createSettingsBackup(parts) {
  return structuredClone(backupEnvelope(parts));
}

// Restoration must also support grandfathered catalogs above the creation cap.
export const MAX_BACKUP_PROXIES = 1000;
const LIMIT = 100000;
const SOURCES = ['manual', 'site', 'auto', 'import', 'undo'];
const KINDS = ['exception', 'whitelist', 'proxy', 'pac'];
const NOTIFICATIONS = ['pac-error', 'ext-error', 'no-control'];
const EXTRA_SETTINGS = ['proxyProfiles', 'defaultProxyId', 'fallbackProxyId', 'domainProxyIds', 'domainLists',
  'pacBypassDomains', 'siteResourceInheritance', 'ruleMeta', 'ruleHistory', '_schemaVersion', '_revision', '_rulesRevision', '_proxyCatalogRevision'];
function invalid() { throw Object.assign(new Error(backupErrorMessage('BACKUP_INVALID')), { code: 'BACKUP_INVALID' }); }
function check(value) { if (!value) invalid(); }
function record(value) { check(value && typeof value === 'object' && !Array.isArray(value)); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER - 1; }
function text(value, max = 1024) { check(typeof value === 'string' && value.length <= max); }
function keys(value, allowed) { record(value); check(Object.keys(value).every(key => allowed.includes(key))); }
function domain(value) { text(value, 253); const result = normalizeDomainRule(value); check(result.valid && result.domain === value); }
function domains(values) { check(Array.isArray(values) && values.length <= LIMIT); values.forEach(domain); check(new Set(values).size === values.length); }
function safeTree(value, depth = 0, seen = new WeakSet()) {
  check(depth < 30);
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') { check(Number.isFinite(value)); return; }
  check(value && typeof value === 'object'); check(!seen.has(value)); seen.add(value);
  check(Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    check(!['__proto__', 'constructor', 'prototype'].includes(key) && Object.hasOwn(descriptor, 'value'));
    safeTree(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
}
function meta(value) {
  keys(value, ['source', 'revision', 'site', 'updatedAt', 'suppressAuto', 'siteControl', 'inheritedListId', 'inheritedMainHost']);
  check(SOURCES.includes(value.source) && integer(value.revision));
  if (value.site !== undefined) text(value.site, 253);
  if (value.updatedAt !== undefined) check(integer(value.updatedAt));
  for (const key of ['suppressAuto', 'siteControl']) if (value[key] !== undefined) check(typeof value[key] === 'boolean');
  if (value.inheritedListId !== undefined || value.inheritedMainHost !== undefined) {
    text(value.inheritedListId, 128); check(value.inheritedListId.length); domain(value.inheritedMainHost);
  }
}
function validateRules(s) {
  record(s.exceptions); check(Object.keys(s.exceptions).length <= LIMIT);
  for (const [key, value] of Object.entries(s.exceptions)) { domain(key); check(typeof value === 'boolean'); }
  domains(s.whitelist); domains(s.pacBypassDomains);
  record(s.siteResourceInheritance); check(Object.keys(s.siteResourceInheritance).length <= LIMIT);
  for (const [key, value] of Object.entries(s.siteResourceInheritance)) check(isCanonicalSiteRoot(key) && value === false);
  record(s.ruleMeta); check(Object.keys(s.ruleMeta).length <= LIMIT * 4);
  for (const [key, value] of Object.entries(s.ruleMeta)) {
    const colon = key.indexOf(':'); check(KINDS.includes(key.slice(0, colon))); domain(key.slice(colon + 1)); meta(value);
  }
  check(Array.isArray(s.ruleHistory) && s.ruleHistory.length <= 5);
  let total = 0;
  for (const h of s.ruleHistory) {
    keys(h, ['id', 'revision', 'at', 'source', 'site', 'changes', 'count', 'truncated', 'undoneAt']);
    check(integer(h.revision) && h.id === `r${h.revision}` && SOURCES.includes(h.source));
    if (h.at !== undefined) check(integer(h.at));
    if (h.site !== undefined) text(h.site, 253);
    if (h.count !== undefined) check(integer(h.count));
    if (h.truncated !== undefined) check(typeof h.truncated === 'boolean');
    if (h.undoneAt !== undefined) check(integer(h.undoneAt));
    check(Array.isArray(h.changes) && h.changes.length <= 50000); total += h.changes.length; check(total <= 250000);
    for (const change of h.changes) {
      keys(change, ['kind', 'domain', 'before', 'after', 'beforeMeta']);
      check(KINDS.includes(change.kind)); domain(change.domain);
      for (const value of [change.before, change.after]) check(value === null || (change.kind === 'proxy' ? typeof value === 'string' && value.length <= 128 : typeof value === 'boolean'));
      if (change.beforeMeta != null) meta(change.beforeMeta);
    }
  }
}
function validateProfiles(s) {
  text(s.customProxyStringRaw, 1024 * 1024); text(s.replaceDirectWith, 8192);
  if (s.replaceDirectWith) check(s.replaceDirectWith.split(';').every(part => part.trim() === 'DIRECT' || parseProxyScheme(part.trim().replace(/^PROXY\s+/i, 'HTTP '))));
  const points = s.customProxyStringRaw.replace(/#.*$/gm, '').split(/[;\r\n]+/).map(p => p.trim()).filter(Boolean);
  check(points.length <= MAX_BACKUP_PROXIES);
  const endpoints = new Map(), authorities = new Map();
  for (const point of points) {
    const parsed = parseProxyScheme(point.replace(/^PROXY\s+/i, 'HTTP '));
    check(parsed && !(parsed.hasAuth && parsed.type.startsWith('SOCKS')));
    const endpoint = proxyEndpointKey(parsed); check(!endpoints.has(endpoint)); endpoints.set(endpoint, parsed);
    const authority = endpoint.slice(endpoint.indexOf(' ') + 1);
    const auth = JSON.stringify([parsed.username, parsed.password]);
    check(!authorities.has(authority) || authorities.get(authority) === auth); authorities.set(authority, auth);
  }
  check(Array.isArray(s.proxyProfiles) && s.proxyProfiles.length === endpoints.size);
  const ids = new Set(Object.values(BUILTIN_PROXY_IDS)), usedEndpoints = new Set(), names = new Set(['tor', 'warp', 'cloudflare warp']);
  for (const profile of s.proxyProfiles) {
    keys(profile, ['id', 'name', 'endpoint']);
    check(typeof profile.id === 'string' && /^custom:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(profile.id) && !ids.has(profile.id));
    text(profile.name, 8192); check(profileNameValid(profile.name));
    const name = profile.name.normalize('NFKC').trim().toLocaleLowerCase('en-US'); check(!names.has(name)); names.add(name);
    check(endpoints.has(profile.endpoint) && !usedEndpoints.has(profile.endpoint)); usedEndpoints.add(profile.endpoint); ids.add(profile.id);
  }
  for (const key of ['defaultProxyId', 'fallbackProxyId']) check(s[key] === null || ids.has(s[key]));
  record(s.domainProxyIds); check(Object.keys(s.domainProxyIds).length <= LIMIT);
  for (const [key, id] of Object.entries(s.domainProxyIds)) { domain(key); check(s.exceptions[key] === true && ids.has(id)); }
  check(Array.isArray(s.domainLists));
  for (const list of s.domainLists) { keys(list, ['id', 'name', 'proxyId', 'enabled', 'domains']); check(ids.has(list.proxyId)); domains(list.domains); }
  normalizeDomainLists(s.domainLists);
}
function profileNameValid(name) {
  return name.trim().length > 0 && name.normalize('NFKC').trim().length <= 80 && ![...name].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127);
}

/** Pure validation: no storage, logging, browser proxy calls or network. */
export function validateSettingsBackup(input) {
  try {
    const fromText = typeof input === 'string';
    if (fromText) { check(fitsBackupByteLimit(input)); input = JSON.parse(input); }
    safeTree(input);
    if (!fromText) check(fitsBackupByteLimit(JSON.stringify(input)));
    keys(input, ['format', 'formatVersion', 'includesPasswords', 'warning', 'settings', 'pac', 'notifications', 'appearance']);
    check(input.format === BACKUP_FORMAT && [0, BACKUP_VERSION].includes(input.formatVersion));
    if (input.includesPasswords !== undefined) check(input.includesPasswords === true);
    if (input.warning !== undefined) text(input.warning, 2048);
    keys(input.settings, [...Object.keys(getDefaults()), ...EXTRA_SETTINGS]);
    const s = { ...getDefaults(), exceptions: {}, whitelist: [], proxyProfiles: [], defaultProxyId: null, fallbackProxyId: null,
      domainProxyIds: {}, domainLists: [], pacBypassDomains: [], siteResourceInheritance: {}, ruleMeta: {}, ruleHistory: [], ...input.settings };
    if (s.ownProxyOrDie === null) s.ownProxyOrDie = true;
    for (const [key, value] of Object.entries(getDefaults())) if (typeof value === 'boolean') check(typeof s[key] === 'boolean');
    for (const key of ['_schemaVersion', '_revision', '_rulesRevision', '_proxyCatalogRevision']) if (s[key] !== undefined) check(integer(s[key]));
    check((s._schemaVersion || 0) <= SETTINGS_SCHEMA_VERSION);
    validateRules(s); validateProfiles(s);
    const [error] = createPacModifiers(s); check(!error);
    keys(input.pac, ['currentPacProviderKey', 'customPacUrl', 'rawPacData']);
    const pac = input.pac;
    check(pac.currentPacProviderKey === 'none' || Object.hasOwn(PAC_PROVIDERS, pac.currentPacProviderKey));
    text(pac.customPacUrl, 8192); text(pac.rawPacData, 25 * 1024 * 1024);
    if (pac.customPacUrl) check(utils.validatePacUrl(pac.customPacUrl).valid);
    if (pac.currentPacProviderKey === 'customPacUrl') check(pac.customPacUrl.length);
    if (pac.rawPacData) check(validatePacScriptSource(pac.rawPacData).valid);
    keys(input.notifications, NOTIFICATIONS);
    NOTIFICATIONS.forEach(key => check(typeof input.notifications[key] === 'boolean'));
    keys(input.appearance, ['theme', 'accent', 'customColor']);
    const appearance = normalizeAppearance(input.appearance);
    check(Object.keys(appearance).every(key => appearance[key] === input.appearance[key]));
    const snapshot = { ...input, formatVersion: BACKUP_VERSION, settings: s };
    return fromText ? snapshot : structuredClone(snapshot);
  } catch { invalid(); }
}

// Only the private map can authorize skipping validation. The caller receives
// an opaque, single-use handle, never a reference to the validated snapshot.
const preparedImports = new WeakMap();
export function prepareSettingsBackupImport(input) {
  const snapshot = validateSettingsBackup(input);
  const handle = Object.freeze({});
  preparedImports.set(handle, snapshot);
  return handle;
}

const PORTABLE_KEYS = ['pac-kitchen-mods', 'antiCensorRu', 'antiCensorPacFreshness', 'handlers-state', APPEARANCE_KEY,
  APPEARANCE_RESET_KEY, 'settings-application'];
// chrome.storage may reorder dictionary keys. Compare their logical content,
// while preserving every array position and every primitive/string verbatim.
function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equal(value, b[index]));
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
const pendingMessage = () => t('portable_settings_pending', 'Настройки сохранены; применение PAC ожидает повторной попытки.');
export function backupErrorMessage(code) {
  switch (code) {
    case 'BACKUP_INVALID': return t('backup_error_invalid', 'Некорректный или неподдерживаемый файл настроек.');
    case 'BACKUP_EXPORT_FAILED': return t('backup_error_export_failed', 'Не удалось создать резервную копию настроек.');
    case 'BACKUP_STORAGE_FAILED': return t('backup_error_storage_failed', 'Не удалось сохранить импорт. Предыдущие настройки восстановлены.');
    case 'BACKUP_ROLLBACK_FAILED': return t('backup_error_rollback_failed', 'Не удалось подтвердить восстановление настроек. Повторите импорт.');
    default: return t('backup_error_import_failed', 'Не удалось импортировать настройки.');
  }
}
function transactionError(rollbackFailed = false) {
  const code = rollbackFailed ? 'BACKUP_ROLLBACK_FAILED' : 'BACKUP_STORAGE_FAILED';
  return Object.assign(new Error(backupErrorMessage(code)), { code });
}

/** Dependency injection is for isolated tests; production uses the canonical queues.
 * IMPORT_SETTINGS must hold the message-bus reset/generation barrier around this call. */
export function createSettingsBackupService({ storage = defaultStorage, pacKitchen = defaultKitchen,
  pacSync = defaultSync, settingsCoordinator = defaultCoordinator, applicationState = defaultApplication,
  errorHandlers = defaultHandlers, appearanceLock = withAppearanceWriteLock, cancelChecks = cancelProxyChecks,
  clearAuthAttempts = clearProxyAuthAttempts, proxyIpMap = ipToHost, routeObserver = blockInformer } = {}) {
  let queue = Promise.resolve();
  async function cleanRuntime(label, operation) {
    try { await operation(); }
    catch {
      try { await operation(); }
      catch { console.warn(`[Settings Backup] Could not refresh ${label} after import`); }
    }
  }
  return {
    async exportSettings() {
      await queue;
      await pacSync.loadLocalState();
      const defaults = await pacKitchen.getRawPacMods();
      // One storage read selects a durable snapshot, not a mixture of RAM states
      // published at different points by the settings/provider queues.
      const stored = await storage.get(PORTABLE_KEYS);
      const settings = stored['pac-kitchen-mods'] ? decodeSettings(stored['pac-kitchen-mods']) : defaults;
      const appearance = normalizeAppearance(stored[APPEARANCE_KEY]);
      const pac = stored.antiCensorRu || pacSync;
      const handlers = stored['handlers-state'];
      const storedFlags = handlers?.notificationsEnabled && typeof handlers.notificationsEnabled === 'object'
        ? handlers.notificationsEnabled : handlers;
      const notifications = Object.fromEntries(NOTIFICATIONS.map(key => [key,
        typeof storedFlags?.[key] === 'boolean' ? storedFlags[key] : errorHandlers.notificationsEnabled[key],
      ]));
      const snapshot = backupEnvelope({ settings, appearance,
        pac: { currentPacProviderKey: pac.currentPacProviderKey || 'none', customPacUrl: pac.customPacUrl || '', rawPacData: pac.rawPacData || '' },
        notifications });
      // Never hand out a backup that cannot be restored losslessly.
      return validateSettingsBackup(snapshot);
    },
    importSettings(input, { apply = true } = {}) {
      // Intentionally before queue, initialization, reads, cancellation or writes.
      let validated = preparedImports.get(input);
      if (validated) preparedImports.delete(input);
      else {
        try { validated = validateSettingsBackup(input); }
        catch (error) { return Promise.reject(error); }
      }
      const task = async () => {
        cancelChecks();
        await settingsCoordinator.drainForReset();
        let committedRevision = 0;
        try {
          // Drain rollback and persistence as well as downloads before replacing PAC.
          await pacSync.drainPendingSync();
          await applicationState.reset();
          await appearanceLock(async () => {
            let previous, next;
            await pacKitchen.replacePortableSettings(async () => {
              previous = await storage.get(PORTABLE_KEYS);
              // Corrupt destination rules must not prevent recovery from a valid
              // portable file. The original bytes remain available for rollback.
              let old = {};
              try { old = decodeSettings(previous['pac-kitchen-mods'] || {}); } catch { /* Recoverable local corruption. */ }
              const revision = Math.max(integer(old._revision) ? old._revision : 0, validated.settings._revision || 0,
                ...validated.settings.ruleHistory.map(h => h.revision)) + 1;
              check(Number.isSafeInteger(revision));
              committedRevision = revision;
              const raw = { ...validated.settings, _schemaVersion: SETTINGS_SCHEMA_VERSION, _revision: revision,
                _rulesRevision: Math.max(integer(old._rulesRevision) ? old._rulesRevision : 0, validated.settings._rulesRevision || 0) + 1,
                _proxyCatalogRevision: Math.max(integer(old._proxyCatalogRevision) ? old._proxyCatalogRevision : 0, validated.settings._proxyCatalogRevision || 0) + 1 };
              next = { 'pac-kitchen-mods': encodeSettings(raw),
                antiCensorRu: { ...validated.pac, lastPacUpdateStamp: 0, providerUpdateStamps: {} },
                antiCensorPacFreshness: null,
                'handlers-state': { notificationsEnabled: validated.notifications, noControlActive: false },
                [APPEARANCE_KEY]: validated.appearance, [APPEARANCE_RESET_KEY]: crypto.randomUUID(),
                'settings-application': { appliedRevision: -1, appliedAt: 0, error: pendingMessage() } };
              return raw;
            }, async () => {
              try {
                await storage.set(next);
                const actual = await storage.get(PORTABLE_KEYS);
                check(PORTABLE_KEYS.every(key => equal(actual[key], next[key])));
              } catch {
                try {
                  const restore = Object.fromEntries(PORTABLE_KEYS.filter(key => previous[key] !== undefined).map(key => [key, previous[key]]));
                  // Invalidate queued UI writes even on rollback; generations are
                  // local synchronization tokens, not portable user settings.
                  restore[APPEARANCE_RESET_KEY] = crypto.randomUUID();
                  await storage.set(restore);
                  await storage.remove(PORTABLE_KEYS.filter(key => previous[key] === undefined && key !== APPEARANCE_RESET_KEY));
                  const actual = await storage.get(PORTABLE_KEYS);
                  check(PORTABLE_KEYS.every(key => key === APPEARANCE_RESET_KEY || equal(actual[key], previous[key])));
                } catch { throw transactionError(true); }
                throw transactionError();
              }
            });
            // No fallible asynchronous work between durable verification and RAM
            // publication. Runtime caches retain the old snapshot on any rollback.
            Object.assign(pacSync, validated.pac, { lastPacUpdateStamp: 0, providerUpdateStamps: {},
              cookedPacData: '', lastError: null, isExpectedPacApplied: false });
            errorHandlers.notificationsEnabled = { ...validated.notifications };
            errorHandlers._noControlActive = false;
          });
          // Invalidate observations from the replaced settings before a new
          // apply can populate them. Cleanup cannot undo the durable import.
          proxyIpMap.reset();
          await Promise.all([
            cleanRuntime('proxy IP cache', () => proxyIpMap.persistData()),
            cleanRuntime('tab routes', () => routeObserver.clearRoutes()),
            cleanRuntime('proxy control state', () => pacSync.updateControlState({ reportControlState: false })),
          ]);
        } finally { settingsCoordinator.finishReset(); }
        // Authentication retry budgets belong to the previous credentials, not
        // the imported ones. Cleanup failure cannot undo a durable snapshot.
        await clearAuthAttempts().catch(() => {});
        let state = { desiredRevision: committedRevision, appliedRevision: -1, appliedAt: 0,
          pending: true, applying: false, error: pendingMessage() };
        try { state = await settingsCoordinator.state(); } catch { /* Durable import still succeeded. */ }
        // Missing cached PAC stays honestly pending; pure import never fetches.
        if (apply && (validated.pac.currentPacProviderKey === 'none' || validated.pac.rawPacData)) {
          try { state = await settingsCoordinator.apply(); }
          catch { state = { ...state, pending: true, error: pendingMessage() }; }
        }
        // Keep transport errors credential-free even if a browser/backend
        // exception happened to echo the original proxy configuration.
        if (state.pending) state = { ...state, error: pendingMessage() };
        return { saved: true, applied: !state.pending, pending: state.pending, settingsState: state };
      };
      const result = queue.then(task, task);
      queue = result.catch(() => {});
      return result;
    },
  };
}

export const settingsBackup = createSettingsBackupService();
