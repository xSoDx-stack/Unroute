'use strict';

import { t } from './i18n.js';

import { migrateSettings, recordRuleChange } from './settings-schema.js';
import { createPacModifiers, getDefaults } from './pac-modifiers.js';
import { calculateExceptionStats } from './exception-rules.js';

import { storage } from './storage.js';
import { sanitizeRuleCollections } from './domain-rules.js';
import { decodeSettings, encodeSettings, clearSettingsCodecCache } from './settings-codec.js';
import {
  buildProxyCredentialsMap,
  clearProxyAuthAttempts,
  commitProxyCredentials,
  getPersistentCredentialsMap,
} from './proxy-auth.js';

const MODS_KEY = 'pac-kitchen-mods';

// Keep derived snapshots in memory between settings changes.
let _cachedRawMods = null;
let _cachedParsedMods = null;
let _cachedStats = null;
let _loadPromise = null;
let _cacheGeneration = 0;
const snapshotStats = new WeakMap();

// Raw settings include the complete lists, provenance and undo history. Share
// one cold read across request handlers and UI reads after a worker restart.
async function loadRawMods() {
  if (_cachedRawMods) return _cachedRawMods;
  if (!_loadPromise) {
    const generation = _cacheGeneration;
    const pending = storage.get(MODS_KEY, {}).then(async (raw) => {
      if (generation !== _cacheGeneration) return loadRawMods();
      let decoded;
      if (_mutationsPaused) throw new Error(t("msg_settings_are_being_reset_3089ff9b", "Выполняется сброс настроек"));
      try { decoded = decodeSettings(raw); }
      catch { throw new Error(t("msg_invalid_settings_format_dc48c732", "Повреждён формат настроек")); }
      const migrated = migrateSettings(decoded);
      const historyTrimmed = Array.isArray(decoded.ruleHistory) &&
        decoded.ruleHistory.length > migrated.ruleHistory.length;
      const inheritanceChanged = JSON.stringify(decoded.siteResourceInheritance) !== JSON.stringify(migrated.siteResourceInheritance);
      const registryChanged = JSON.stringify(decoded.proxyProfiles) !== JSON.stringify(migrated.proxyProfiles) ||
        decoded.defaultProxyId !== migrated.defaultProxyId || decoded._proxyCatalogRevision !== migrated._proxyCatalogRevision;
      if ((!Object.hasOwn(raw, '_ruleData') || historyTrimmed || registryChanged || inheritanceChanged) && Object.keys(raw).length && !_mutationsPaused) {
        // Mutations await this loader: persist directly rather than entering
        // their queue and deadlocking. Never publish generated IDs on failure.
        let packed;
        try { packed = encodeSettings(migrated); }
        catch (error) {
          // Unsupported legacy rule values must not be rewritten or lost.
          // They remain readable only when no unpersisted profile IDs would
          // escape; introducing identities still requires a durable snapshot.
          const identitiesUnchanged = JSON.stringify(decoded.proxyProfiles || []) === JSON.stringify(migrated.proxyProfiles);
          if (!(error instanceof TypeError) || !identitiesUnchanged || Object.hasOwn(raw, '_ruleData')) throw error;
        }
        if (packed) await storage.set(MODS_KEY, packed);
      }
      if (generation !== _cacheGeneration) return loadRawMods();
      _cachedRawMods = migrated;
      return _cachedRawMods;
    }).finally(() => {
      if (_loadPromise === pending) _loadPromise = null;
    });
    _loadPromise = pending;
  }
  const raw = await _loadPromise;
  return raw === _cachedRawMods ? raw : loadRawMods();
}

let _mutationQueue = Promise.resolve();
let _mutationGeneration = 0;
let _mutationsPaused = false;

/**
 * P1-2: Serialized mutation queue for PAC settings.
 * Ensures concurrent modifications (UI toggles, imports, single exception adds)
 * execute strictly sequentially without lost updates or race conditions.
 *
 * @param {(currentRawMods: object) => (object | Promise<object>)} mutator
 * @returns {Promise<object>}
 */
export function updatePacMods(mutator, context = {}) {
  if (_mutationsPaused) return Promise.reject(new Error(t("msg_settings_are_being_reset_3089ff9b", "Выполняется сброс настроек")));
  if (typeof mutator !== 'function') {
    return Promise.reject(new TypeError('mutator must be a function'));
  }

  const generation = _mutationGeneration;
  const ensureWritable = () => {
    if (_mutationsPaused || generation !== _mutationGeneration) throw new Error(t("msg_settings_are_being_reset_try_changing_this_ag_31c856be", "Выполняется сброс настроек. Повторите изменение после завершения."));
  };
  const run = async () => {
    ensureWritable();
    const currentRaw = await loadRawMods();
    ensureWritable();
    // Copy-on-write mutators replace each changed branch and return the input
    // unchanged to skip a write. Preserve untouched
    // metadata/history instead of cloning and normalizing them for every CDN.
    // Other callers retain the isolated deep snapshot they have always used.
    const cloned = context.preferencesOnly || context.copyOnWrite
      ? { ...currentRaw }
      : JSON.parse(JSON.stringify(currentRaw || {}));
    const mutated = await mutator(cloned);
    ensureWritable();
    if (!mutated || typeof mutated !== 'object') {
      throw new Error('mutator must return an object');
    }
    if (context.copyOnWrite && mutated === cloned) return pacKitchen.getPacMods();
    return pacKitchen.savePacMods(mutated, context);
  };

  const next = _mutationQueue.then(run, run);
  _mutationQueue = next.catch(() => {});
  return next;
}

export const pacKitchen = {
  async beginReset() {
    _mutationsPaused = true;
    _mutationGeneration++;
    await Promise.all([_mutationQueue, _loadPromise?.catch(() => {})]);
  },
  endReset() { _mutationsPaused = false; },
  async getPacMods() {
    if (_cachedParsedMods) {
      return _cachedParsedMods;
    }
    const rawMods = await loadRawMods();
    if (_cachedParsedMods) return _cachedParsedMods;
    if (rawMods !== _cachedRawMods) return pacKitchen.getPacMods();
    const newCredsMap = buildProxyCredentialsMap(rawMods.customProxyStringRaw || '');
    commitProxyCredentials(newCredsMap);
    const [, mods] = createPacModifiers(rawMods);
    _cachedParsedMods = mods || getDefaults();
    _cachedStats = calculateExceptionStats(rawMods.exceptions, rawMods.whitelist);
    snapshotStats.set(_cachedParsedMods, _cachedStats);
    return _cachedParsedMods;
  },

  async getRawPacMods() {
    return loadRawMods();
  },

  /**
   * P1-3: Persist-first savePacMods with transactional credentials consistency.
   * Validates input, persists all storage items, and ONLY updates RAM caches if storage write succeeds.
   */
  async savePacMods(newMods, context = {}) {
    const previous = await loadRawMods();
    const sameRules = newMods.exceptions === previous.exceptions && newMods.whitelist === previous.whitelist;
    const rules = sameRules ? { exceptions: previous.exceptions || {}, whitelist: previous.whitelist || [] } :
      sanitizeRuleCollections(newMods.exceptions, newMods.whitelist);
    newMods = Object.assign({}, newMods, rules);
    newMods = recordRuleChange(previous, newMods, context);
    const [err, parsedMods] = createPacModifiers(newMods);
    if (err) {
      throw err;
    }
    const newStats = sameRules && _cachedStats ? _cachedStats : calculateExceptionStats(newMods.exceptions, newMods.whitelist);
    const newCredsMap = buildProxyCredentialsMap(newMods.customProxyStringRaw || '');
    const oldCredsMap = getPersistentCredentialsMap();
    const credentialsChanged = JSON.stringify(oldCredsMap) !== JSON.stringify(newCredsMap);

    // A single canonical snapshot prevents partially committed related keys.
    // Credentials and statistics are derived into RAM from this object.
    await storage.set(MODS_KEY, encodeSettings(newMods));
    await Promise.allSettled([
      storage.remove('proxy-credentials-map'),
      storage.remove('pac-exception-stats'),
    ]);

    // 2. Only on success, publish to in-memory caches
    _cacheGeneration++;
    _loadPromise = null;
    _cachedRawMods = newMods;
    _cachedParsedMods = parsedMods;
    _cachedStats = newStats;
    snapshotStats.set(parsedMods, newStats);
    commitProxyCredentials(newCredsMap);
    if (credentialsChanged) {
      await clearProxyAuthAttempts().catch((err) => {
        console.warn('[Proxy Auth] Failed to clear retry state after credentials update:', err);
      });
    }

    return parsedMods;
  },

  /** Replace a fully validated portable snapshot without reconciling IDs against
   * the destination catalog. Publish RAM only after the multi-key commit verifies.
   * The caller owns the RPC/reset/coordinator barrier and revision allocation. */
  async replacePortableSettings(candidate, persist) {
    if (_mutationsPaused) throw new Error('Settings replacement is already in progress');
    await this.beginReset();
    try {
      const raw = typeof candidate === 'function' ? await candidate() : candidate;
      const [error, parsed] = createPacModifiers(raw);
      if (error) throw error;
      const stats = calculateExceptionStats(raw.exceptions, raw.whitelist);
      const credentials = buildProxyCredentialsMap(raw.customProxyStringRaw || '');
      await persist();
      this.invalidateCache();
      _cachedRawMods = raw;
      _cachedParsedMods = parsed;
      _cachedStats = stats;
      snapshotStats.set(parsed, stats);
      commitProxyCredentials(credentials);
      return parsed;
    } finally { this.endReset(); }
  },

  updatePacMods,

  getCachedStats() {
    if (_cachedStats) return _cachedStats;
    if (_cachedParsedMods) {
      _cachedStats = calculateExceptionStats(_cachedParsedMods.exceptions, _cachedParsedMods.whitelist);
      return _cachedStats;
    }
    return { includedCount: 0, excludedCount: 0, whitelistCount: 0 };
  },

  async getSnapshot() {
    const mods = await this.getPacMods();
    return { mods, stats: snapshotStats.get(mods) || calculateExceptionStats(mods.exceptions, mods.whitelist), revision: mods.revision || 0 };
  },

  invalidateCache() {
    clearSettingsCodecCache();
    _cacheGeneration++;
    _loadPromise = null;
    _cachedRawMods = null;
    _cachedParsedMods = null;
    _cachedStats = null;
  },

  // P0.3: Public accessor for block-informer and other consumers needing sync access to parsed mods
  getCachedMods() {
    return _cachedParsedMods;
  },

};
