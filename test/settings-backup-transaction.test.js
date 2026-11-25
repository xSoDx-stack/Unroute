import { expect } from 'chai';
import { fixture } from './settings-backup.test.js';
import * as backup from '../src/common/core/settings-backup.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { storage } from '../src/common/core/storage.js';
import { decodeSettings, encodeSettings } from '../src/common/core/settings-codec.js';
import { getPersistentCredentialsMap, resetProxyCredentialsState } from '../src/common/core/proxy-auth.js';

const OTHER = 'custom:22222222-2222-4222-8222-222222222222';
describe('Portable persist-first settings transaction', () => {
  let original, saved, writes, service, sync, notifications, application, coordinator, authClears, runtimeCalls, ipFailures;
  beforeEach(() => {
    original = { get: storage.get, set: storage.set, remove: storage.remove };
    saved = { 'pac-kitchen-mods': encodeSettings({ _schemaVersion: 3, _revision: 12, _rulesRevision: 12,
      customProxyStringRaw: 'HTTPS old:fixture@proxy.test:443', exceptions: {}, whitelist: [],
      proxyProfiles: [{ id: OTHER, name: 'Old', endpoint: 'HTTPS proxy.test:443' }],
      defaultProxyId: OTHER, fallbackProxyId: null }), unrelated: { keep: true } };
    writes = []; authClears = 0; runtimeCalls = []; ipFailures = 0;
    storage.get = async (key, fallback) => Array.isArray(key) ? Object.fromEntries(key.map(k => [k, structuredClone(saved[k])])) : structuredClone(saved[key] ?? fallback);
    storage.set = async (key, value) => { const patch = typeof key === 'string' ? { [key]: value } : key; writes.push(structuredClone(patch)); Object.assign(saved, structuredClone(patch)); };
    storage.remove = async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete saved[key]; };
    pacKitchen.invalidateCache();
    sync = { currentPacProviderKey: 'none', customPacUrl: '', rawPacData: '', loadLocalState: async () => {},
      async drainPendingSync() {}, resetRuntimeState() {}, updateTitle() {}, setupAlarms() {},
      async updateControlState(options) { runtimeCalls.push(['control', options]); } };
    notifications = { notificationsEnabled: { 'pac-error': true, 'ext-error': true, 'no-control': true } };
    application = { reset: async () => {} };
    coordinator = { drainForReset: async () => {}, finishReset() {},
      state: async () => ({ pending: true, desiredRevision: decodeSettings(saved['pac-kitchen-mods'])._revision, appliedRevision: 0, error: '' }),
      apply: async () => { throw new Error('Unexpected network/apply'); } };
    if (backup.createSettingsBackupService) service = backup.createSettingsBackupService({ storage, pacKitchen, pacSync: sync,
      errorHandlers: notifications, applicationState: application, settingsCoordinator: coordinator,
      appearanceLock: operation => operation(), cancelChecks() {}, clearAuthAttempts: async () => { authClears++; },
      proxyIpMap: { reset: () => runtimeCalls.push('reset-ip'), persistData: async () => {
        runtimeCalls.push('persist-ip');
        if (ipFailures > 0) { ipFailures--; throw new Error('Temporary IP cache write failure'); }
      } },
      routeObserver: { clearRoutes: async () => runtimeCalls.push('clear-routes') } });
  });
  afterEach(() => { Object.assign(storage, original); pacKitchen.endReset(); pacKitchen.invalidateCache(); resetProxyCredentialsState(); });
  it('validates export with only one backup clone and does not expose the live settings', async () => {
    const clone = globalThis.structuredClone;
    let backupClones = 0;
    globalThis.structuredClone = value => {
      if (value?.format === backup.BACKUP_FORMAT) backupClones++;
      return clone(value);
    };
    try {
      const exported = await service.exportSettings();
      expect(backupClones).to.equal(1);
      exported.settings.proxyProfiles[0].name = 'Changed outside service';
      const next = await service.exportSettings();
      expect(next.settings.proxyProfiles[0].name).to.equal('Old');
    } finally { globalThis.structuredClone = clone; }
  });
  it('uses an isolated, single-use preflight snapshot without parsing or cloning the backup again', async () => {
    const input = backup.createSettingsBackup(fixture());
    expect(backup.prepareSettingsBackupImport).to.be.a('function');
    const prepared = backup.prepareSettingsBackupImport(input);
    input.settings.customProxyStringRaw = 'not a proxy';
    const clone = globalThis.structuredClone;
    let backupClones = 0;
    globalThis.structuredClone = value => {
      if (value?.format === backup.BACKUP_FORMAT) backupClones++;
      return clone(value);
    };
    try {
      expect(await service.importSettings(prepared, { apply: false })).to.include({ saved: true });
      expect(backupClones).to.equal(0);
      expect(decodeSettings(saved['pac-kitchen-mods']).customProxyStringRaw).to.equal(fixture().settings.customProxyStringRaw);
      for (const invalid of [prepared, {}, { validated: true }]) {
        let error;
        try { await service.importSettings(invalid); } catch (cause) { error = cause; }
        expect(error?.code).to.equal('BACKUP_INVALID');
      }
      expect(writes).to.have.length(1);
    } finally { globalThis.structuredClone = clone; }
  });
  it('clears local PAC freshness in the same transaction and restores it on failure', async () => {
    const previous = { lastPacUpdateStamp: 42, providerUpdateStamps: { Антизапрет: 42 } };
    saved.antiCensorPacFreshness = previous;
    const set = storage.set;
    let fail = true;
    storage.set = async (...args) => { await set(...args); if (fail) { fail = false; throw new Error('Write failed'); } };
    const input = backup.createSettingsBackup(fixture());
    const rejected = await service.importSettings(input, { apply: false }).catch(error => error);
    expect(rejected.code).to.equal('BACKUP_STORAGE_FAILED');
    expect(saved.antiCensorPacFreshness).to.deep.equal(previous);
    expect(runtimeCalls).to.deep.equal([]);
    await service.importSettings(input, { apply: false });
    expect(saved.antiCensorPacFreshness).to.equal(null);
  });
  it('invalidates old routes and native PAC confirmation after a pending import', async () => {
    sync.isExpectedPacApplied = true;
    const result = await service.importSettings(backup.createSettingsBackup(fixture()), { apply: false });
    expect(result).to.include({ saved: true, pending: true, applied: false });
    expect(sync.isExpectedPacApplied).to.equal(false);
    expect(runtimeCalls).to.deep.equal(['reset-ip', 'persist-ip', 'clear-routes', ['control', { reportControlState: false }]]);
  });
  it('retries a transient cache write failure without undoing the committed import', async () => {
    ipFailures = 1;
    const result = await service.importSettings(backup.createSettingsBackup(fixture()), { apply: false });
    expect(result).to.include({ saved: true, pending: true });
    expect(runtimeCalls.filter(call => call === 'persist-ip')).to.have.length(2);
    expect(runtimeCalls.filter(call => call === 'reset-ip')).to.have.length(1);
  });
  it('exports a restorable snapshot from legacy stored settings without rewriting notification flags', async () => {
    saved['pac-kitchen-mods'] = { customProxyStringRaw: 'HTTPS legacy.test:443', exceptions: {}, whitelist: [] };
    saved['handlers-state'] = { 'pac-error': false };
    const result = await service.exportSettings();
    expect(result.settings.proxyProfiles).to.have.length(1);
    expect(result.settings.proxyProfiles[0].endpoint).to.equal('HTTPS legacy.test:443');
    expect(result.notifications).to.deep.equal({ 'pac-error': false, 'ext-error': true, 'no-control': true });
    expect(saved['handlers-state']).to.deep.equal({ 'pac-error': false });
    expect(writes.every(write => Object.keys(write).every(key => key === 'pac-kitchen-mods'))).to.equal(true);
  });
  it('verifies imports and rollback with recursively reordered storage dictionaries but preserves array and credential order', async () => {
    const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, reorder(value[key])])) : value;
    const set = storage.set;
    storage.set = async (key, value) => typeof key === 'string' ? set(key, reorder(value)) : set(reorder(key));
    const input = backup.createSettingsBackup(fixture());
    input.settings.domainLists[0].domains = ['z.work.test', 'a.work.test'];
    input.settings.proxyProfiles.push({ id: 'custom:33333333-3333-4333-8333-333333333333', name: 'Second', endpoint: 'HTTPS second.test:443' });
    input.settings.customProxyStringRaw += ';\nHTTPS second.test:443';
    const result = await service.importSettings(input, { apply: false });
    expect(result).to.include({ saved: true, pending: true, applied: false });
    expect(writes).to.have.length(1);
    expect((await service.exportSettings()).settings.domainLists[0].domains).to.deep.equal(['z.work.test', 'a.work.test']);
    expect(decodeSettings(saved['pac-kitchen-mods']).customProxyStringRaw).to.equal(input.settings.customProxyStringRaw);
    // A real ordered-array mutation must still be rejected and rolled back.
    const previous = structuredClone(saved);
    let corrupt = true;
    storage.set = async (...args) => {
      await (typeof args[0] === 'string' ? set(args[0], reorder(args[1])) : set(reorder(args[0])));
      if (corrupt) { corrupt = false; saved['pac-kitchen-mods'].proxyProfiles.reverse(); }
    };
    const failure = await service.importSettings(input, { apply: false }).catch(error => error);
    expect(failure).to.have.property('code', 'BACKUP_STORAGE_FAILED');
    expect(saved['pac-kitchen-mods']).to.deep.equal(previous['pac-kitchen-mods']);
    expect(saved.antiCensorRu).to.deep.equal(previous.antiCensorRu);
    expect(saved['ui-appearance']).to.deep.equal(previous['ui-appearance']);
  });
  it('persists and returns the localized pending message for an English backend', async () => {
    const originalChrome = globalThis.chrome;
    globalThis.chrome = { ...(originalChrome || {}), i18n: { getMessage: key => key === 'portable_settings_pending'
      ? 'Settings saved; PAC application is pending a retry.' : '' } };
    try {
      const result = await service.importSettings(backup.createSettingsBackup(fixture()), { apply: false });
      expect(result.settingsState.error).to.equal('Settings saved; PAC application is pending a retry.');
      expect(saved['settings-application'].error).to.equal(result.settingsState.error);
    } finally { globalThis.chrome = originalChrome; }
  });
  it('can replace corrupt local packed settings and reports a durable save despite postcommit state-read failure', async () => {
    expect(service).to.be.an('object');
    saved['pac-kitchen-mods'] = { _ruleData: '{corrupt-local' };
    coordinator.state = async () => { throw new Error('fixture-secret read error'); };
    const result = await service.importSettings(backup.createSettingsBackup(fixture()), { apply: false });
    expect(result).to.include({ saved: true, pending: true, applied: false });
    expect(result.settingsState.error).not.to.include('fixture-secret');
    expect(decodeSettings(saved['pac-kitchen-mods']).proxyProfiles[0].id).not.to.equal(OTHER);
  });
  it('rolls back partial persistence and read-back mismatch without publishing RAM or credentials', async () => {
    expect(service).to.be.an('object');
    const previous = structuredClone(saved);
    const set = storage.set;
    let fail = true;
    storage.set = async (...args) => { await set(...args); if (fail) { fail = false; throw new Error('fixture-secret storage failure'); } };
    const result = await service.importSettings(backup.createSettingsBackup(fixture())).catch(e => e);
    expect(result).to.have.property('code', 'BACKUP_STORAGE_FAILED');
    expect(result.message).not.to.include('fixture-secret');
    expect(saved['pac-kitchen-mods']).to.deep.equal(previous['pac-kitchen-mods']);
    expect(saved['antiCensorRu']).to.equal(undefined);
    expect(saved['ui-appearance-reset']).to.be.a('string');
    expect(sync.currentPacProviderKey).to.equal('none');
    expect(notifications.notificationsEnabled['pac-error']).to.equal(true);
    // Simulate storage success returning a different exact target on verification.
    storage.set = set; const get = storage.get; let corrupt = true;
    storage.get = async (...args) => { const result = await get(...args); if (corrupt && Array.isArray(args[0]) && writes.length >= 3) { corrupt = false; result['antiCensorRu'] = {}; } return result; };
    const mismatch = await service.importSettings(backup.createSettingsBackup(fixture())).catch(e => e);
    expect(mismatch).to.have.property('code', 'BACKUP_STORAGE_FAILED');
    expect(saved['pac-kitchen-mods']).to.deep.equal(previous['pac-kitchen-mods']);
  });
  it('does not turn an application failure into false success and never fetches a missing PAC', async () => {
    expect(service).to.be.an('object');
    let attempts = 0;
    coordinator.apply = async () => { attempts++; return { pending: true, desiredRevision: 13, appliedRevision: 12, error: 'control conflict' }; };
    const result = await service.importSettings(backup.createSettingsBackup(fixture()));
    expect(result).to.include({ saved: true, pending: true, applied: false }); expect(attempts).to.equal(1);
    expect(decodeSettings(saved['pac-kitchen-mods']).domainLists[0].domains).to.deep.equal(['*.work.test']);
    const absent = backup.createSettingsBackup(fixture()); absent.pac.rawPacData = '';
    await service.importSettings(absent); expect(attempts).to.equal(1);
  });
  it('serializes imports and invalidates pending appearance writes under the shared lock', async () => {
    expect(service).to.be.an('object');
    const first = backup.createSettingsBackup(fixture()), second = structuredClone(first);
    second.appearance.theme = 'light'; second.settings.ifUseLocalWarp = false;
    await Promise.all([service.importSettings(first, { apply: false }), service.importSettings(second, { apply: false })]);
    expect(writes).to.have.length(2);
    expect(writes[0]['ui-appearance-reset']).not.to.equal(writes[1]['ui-appearance-reset']);
    expect(saved['ui-appearance'].theme).to.equal('light');
    expect(decodeSettings(saved['pac-kitchen-mods'])._revision).to.equal(14);
  });
  it('restores authentication and application tracking from a durable import without using the old catalog IDs', async () => {
    expect(service).to.be.an('object');
    const input = backup.createSettingsBackup(fixture());
    await service.importSettings(input, { apply: false });
    const restored = await service.exportSettings();
    expect(restored.settings.proxyProfiles).to.deep.equal(input.settings.proxyProfiles);
    expect(restored.settings.customProxyStringRaw).to.equal(input.settings.customProxyStringRaw);
    expect(getPersistentCredentialsMap()['proxy.test:443']).to.deep.equal({ username: 'user', password: ' p@ss ' });
    expect(authClears).to.equal(1);
    expect(restored.notifications).to.deep.equal(input.notifications);
    expect(saved['settings-application'].appliedRevision).to.equal(-1);
  });
  it('validates before any read/write or barrier and commits one batch preserving IDs then exposes pending state without fetch', async () => {
    expect(service).to.be.an('object');
    let reads = 0; const get = storage.get;
    storage.get = async (...args) => { reads++; return get(...args); };
    const bad = backup.createSettingsBackup(fixture()); bad.settings.ifProxyOrDie = 'false';
    const error = await service.importSettings(bad).catch(e => e);
    expect(error).to.have.property('code', 'BACKUP_INVALID'); expect(reads).to.equal(0); expect(writes).to.have.length(0);
    const input = backup.createSettingsBackup(fixture()); input.settings.fallbackProxyId = input.settings.defaultProxyId;
    const result = await service.importSettings(input, { apply: false });
    expect(result).to.include({ saved: true, applied: false, pending: true });
    expect(writes).to.have.length(1);
    const actual = decodeSettings(saved['pac-kitchen-mods']);
    for (const [key, value] of Object.entries(input.settings)) expect(actual[key], key).to.deep.equal(value);
    expect(actual._revision).to.be.greaterThan(12);
    expect(saved['antiCensorRu']).to.include(input.pac);
    expect(saved['ui-appearance']).to.deep.equal(input.appearance);
    expect(saved['handlers-state'].notificationsEnabled).to.deep.equal(input.notifications);
    expect(saved.unrelated).to.deep.equal({ keep: true });
    expect(sync.currentPacProviderKey).to.equal(input.pac.currentPacProviderKey);
    expect(notifications.notificationsEnabled).to.deep.equal(input.notifications);
    expect((await pacKitchen.getRawPacMods()).proxyProfiles).to.deep.equal(input.settings.proxyProfiles);
  });
});
