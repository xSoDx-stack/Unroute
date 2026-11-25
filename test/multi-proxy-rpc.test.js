import { expect } from 'chai';
import { setupMessageBus } from '../src/common/core/message-bus.js';
import { appState } from '../src/common/core/app-state.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { settingsCoordinator } from '../src/common/core/settings-coordinator.js';
import { storage } from '../src/common/core/storage.js';
import { migrateSettings } from '../src/common/core/settings-schema.js';
import { encodeSettings } from '../src/common/core/settings-codec.js';
import { PROXY_HEALTH_CACHE_KEY } from '../src/common/core/proxy-health-cache.js';

describe('Atomic domain/proxy RPC', () => {
  let listener;
  let original;
  let applications;
  beforeEach(() => {
    original = { chrome: globalThis.chrome, local: appState.ensureLocalStateInitialized,
      apply: settingsCoordinator.apply, state: settingsCoordinator.state };
    const data = {};
    globalThis.chrome = { runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}`,
      onMessage: { addListener: callback => { listener = callback; } } }, storage: { local: {
      get: (key, callback) => callback({ [key]: data[key] }),
      set: (items, callback) => { Object.assign(data, items); callback(); },
      remove: (keys, callback) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; callback(); },
    } } };
    appState.ensureLocalStateInitialized = async () => {};
    applications = 0;
    settingsCoordinator.apply = async () => { applications++; return { pending: false }; };
    settingsCoordinator.state = async () => ({ pending: false });
    pacKitchen.invalidateCache();
    setupMessageBus({ checkHealth: async () => ({ ok: true, latency: 1 }) });
  });
  afterEach(() => {
    globalThis.chrome = original.chrome;
    appState.ensureLocalStateInitialized = original.local;
    settingsCoordinator.apply = original.apply;
    settingsCoordinator.state = original.state;
    pacKitchen.invalidateCache();
  });
  const send = message => new Promise(resolve => listener(message, { id: 'test', url: 'chrome-extension://test/pages/options/index.html' }, resolve));

  it('reports the effective list route after clearing legacy manual rules and their bindings', async () => {
    await pacKitchen.updatePacMods(raw => ({ ...raw, ifUseLocalTor: true, ifMindExceptions: true,
      exceptions: { 'page.test': true, '*.page.test': true, 'other.test': true },
      domainProxyIds: { 'page.test': 'builtin:tor', '*.page.test': 'builtin:tor', 'other.test': 'builtin:tor' },
      domainLists: [{ id: 'list:a', name: 'A', enabled: true, proxyId: 'builtin:tor', domains: ['page.test'] }],
    }));
    const response = await send({ action: 'SET_SINGLE_EXCEPTION', domain: 'page.test', isProxy: null });
    expect(response.success, response.error).to.equal(true);
    expect(response.data.removedRuleKeys).to.have.members(['page.test', '*.page.test']);
    expect(response.data.currentSiteMatch).to.include({ matched: true, listId: 'list:a', proxyId: 'builtin:tor' });
    expect((await pacKitchen.getRawPacMods()).domainProxyIds).to.deep.equal({ 'other.test': 'builtin:tor' });
  });

  it('does not report a committed profile edit as failed when health-cache pruning fails', async () => {
    await pacKitchen.updatePacMods(raw => ({ ...raw, customProxyStringRaw: 'HTTPS before.test:443' }));
    const [profile] = (await pacKitchen.getRawPacMods()).proxyProfiles;
    const get = storage.get;
    let pruneReads = 0;
    storage.get = async (key, fallback) => {
      if (key === PROXY_HEALTH_CACHE_KEY) { pruneReads++; throw new Error('Health cache unavailable'); }
      return get(key, fallback);
    };
    try {
      const response = await send({ action: 'UPDATE_PROXY_PROFILE', proxyId: profile.id, proxy: 'HTTPS after.test:443' });
      expect(response.success, response.error).to.equal(true);
      expect(pruneReads).to.equal(1);
      pacKitchen.invalidateCache();
      expect((await pacKitchen.getRawPacMods()).proxyProfiles[0]).to.include({ id: profile.id, endpoint: 'HTTPS after.test:443' });
    } finally { storage.get = get; }
  });

  it('preserves cold-loaded legacy names while enforcing the 32-point RPC write boundary atomically', async () => {
    const migrated = migrateSettings({ customProxyStringRaw: 'HTTPS a.test:443; HTTPS b.test:443', exceptions: {}, whitelist: [] });
    migrated.proxyProfiles[0].name = 'L'.repeat(80);
    await storage.set('pac-kitchen-mods', encodeSettings(migrated));
    pacKitchen.invalidateCache();
    const loaded = await pacKitchen.getRawPacMods();
    const [first, second] = loaded.proxyProfiles;
    expect(first.name).to.equal('L'.repeat(80));
    expect((await send({ action: 'SAVE_MODS', mods: { ifProxyOrDie: false } })).success).to.equal(true);
    expect((await send({ action: 'SET_DEFAULT_PROXY', proxyId: second.id })).success).to.equal(true);
    expect((await send({ action: 'RENAME_PROXY_PROFILE', proxyId: second.id, name: `  ${'😀'.repeat(32)}  ` })).success).to.equal(true);
    const before = await pacKitchen.getRawPacMods();
    const snapshot = structuredClone(before);
    const stored = await storage.get('pac-kitchen-mods');
    const beforeApplications = applications;
    for (const message of [
      { action: 'RENAME_PROXY_PROFILE', proxyId: first.id, name: first.name },
      { action: 'RENAME_PROXY_PROFILE', proxyId: second.id, name: '😀'.repeat(33) },
      { action: 'ADD_PROXY', proxy: 'HTTPS user:secret@c.test:443', name: 'x'.repeat(33) },
      { action: 'SAVE_MODS', mods: { proxyProfiles: before.proxyProfiles.map(p => p.id === first.id ? { ...p, name: 'x'.repeat(33) } : p) } },
      { action: 'SAVE_MODS', mods: { customProxyStringRaw: `${before.customProxyStringRaw}; HTTPS c.test:443`,
        proxyProfiles: [...before.proxyProfiles, { id: 'custom:12345678-1234-1234-1234-123456789012', endpoint: 'HTTPS c.test:443', name: 'x'.repeat(33) }] } },
    ]) {
      const response = await send(message);
      expect(response.success).to.equal(false);
      if (message.action === 'SAVE_MODS') expect(response.error).to.equal('Use the dedicated proxy and domain operations.');
      else expect(response.errorCode).to.equal('PROXY_INVALID_NAME');
      expect(response.error).not.to.match(/user|secret/);
      expect(await pacKitchen.getRawPacMods()).to.equal(before);
      expect(before).to.deep.equal(snapshot);
      expect(await storage.get('pac-kitchen-mods')).to.deep.equal(stored);
      expect(applications).to.equal(beforeApplications);
    }
    expect(before.proxyProfiles[0]).to.deep.equal(first);
    expect(before.proxyProfiles[1]).to.include({ id: second.id, name: '😀'.repeat(32) });
    expect(before._rulesRevision).to.equal(loaded._rulesRevision);
    expect(before.domainProxyIds).to.deep.equal(loaded.domainProxyIds);
    pacKitchen.invalidateCache();
    expect((await pacKitchen.getRawPacMods()).proxyProfiles).to.deep.equal(before.proxyProfiles);
  });

  it('atomically rejects raw/editor SAVE_MODS and checked ADD_PROXY beyond 50 saved profiles', async () => {
    const raw = Array.from({ length: 50 }, (_, i) => `HTTPS p${i}.test:443`).join('; ');
    expect((await send({ action: 'SAVE_MODS', mods: { customProxyStringRaw: raw,
      ifUseLocalTor: true, ifUseLocalWarp: true, ifUseSecureProxiesOnly: true } })).success).to.equal(true);
    const first = (await pacKitchen.getRawPacMods()).proxyProfiles[0];
    await send({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'bound.test', mode: 'proxy', proxyId: first.id }] });
    const before = await pacKitchen.getRawPacMods();
    const snapshot = structuredClone(before);
    const stored = await storage.get('pac-kitchen-mods');
    const parsed = await pacKitchen.getPacMods();
    const beforeApplications = applications;
    for (const message of [
      { action: 'SAVE_MODS', mods: { customProxyStringRaw: `${raw}; HTTP disabled.test:8080`, ifProxyOrDie: false } },
      { action: 'SAVE_MODS', ruleSource: 'import', mods: { customProxyStringRaw: `${raw}; HTTPS imported.test:443` } },
      { action: 'ADD_PROXY', proxy: 'HTTPS checked.test:443', name: 'Extra' },
    ]) {
      const response = await send(message);
      expect(response.success).to.equal(false);
      expect(response.errorCode).to.equal('PROXY_LIMIT');
      expect(response.error).to.include('50');
      expect(await pacKitchen.getRawPacMods()).to.equal(before);
      expect(before).to.deep.equal(snapshot);
      expect(await storage.get('pac-kitchen-mods')).to.deep.equal(stored);
      expect(await pacKitchen.getPacMods()).to.equal(parsed);
      expect(applications).to.equal(beforeApplications);
    }
  });

  it('allows legacy RPC metadata edits, replacement/deletion and 56 to 55, but rejects regrowth to 56', async () => {
    const raw = Array.from({ length: 56 }, (_, i) => `HTTPS p${i}.test:443`).join('; ');
    await storage.set('pac-kitchen-mods', encodeSettings(migrateSettings({ customProxyStringRaw: raw, exceptions: {}, whitelist: [] })));
    pacKitchen.invalidateCache();
    const [first, second] = (await pacKitchen.getRawPacMods()).proxyProfiles;
    for (const message of [
      { action: 'RENAME_PROXY_PROFILE', proxyId: first.id, name: 'Legacy' },
      { action: 'SET_DEFAULT_PROXY', proxyId: second.id },
      { action: 'SAVE_MODS', mods: { customProxyStringRaw: raw.split('; ').reverse().join('; ') } },
      { action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'bound.test', mode: 'proxy', proxyId: first.id }] },
      { action: 'DELETE_PROXY_PROFILE', proxyId: first.id, replacementProxyId: second.id },
    ]) {
      const response = await send(message);
      expect(response.success, response.error).to.equal(true);
    }
    const reduced = await pacKitchen.getRawPacMods();
    expect(reduced.proxyProfiles).to.have.length(55);
    expect(reduced.defaultProxyId).to.equal(second.id);
    expect(reduced.domainProxyIds['bound.test']).to.equal(second.id);
    const response = await send({ action: 'SAVE_MODS', mods: {
      customProxyStringRaw: `${reduced.customProxyStringRaw}; HTTPS new.test:443` } });
    expect(response.errorCode).to.equal('PROXY_LIMIT');
    expect(await pacKitchen.getRawPacMods()).to.equal(reduced);
  });

  it('rechecks checked ADD_PROXY inside the mutation queue when two views fill the final slot', async () => {
    const customProxyStringRaw = Array.from({ length: 49 }, (_, i) => `HTTPS p${i}.test:443`).join('; ');
    expect((await send({ action: 'SAVE_MODS', mods: { customProxyStringRaw } })).success).to.equal(true);
    const before = await pacKitchen.getRawPacMods();
    const responses = await Promise.all(['one', 'two'].map(name => send({ action: 'ADD_PROXY', proxy: `HTTPS ${name}.test:443` })));
    expect(responses.filter(response => response.success)).to.have.length(1);
    expect(responses.find(response => !response.success).errorCode).to.equal('PROXY_LIMIT');
    const after = await pacKitchen.getRawPacMods();
    expect(after.proxyProfiles).to.have.length(50);
    expect(after.proxyProfiles.slice(0, 49)).to.deep.equal(before.proxyProfiles);
    expect(after._revision).to.equal(before._revision + 1);
  });

  it('rejects an unversioned IMPORT_SETTINGS payload without bypassing catalog validation', async () => {
    const before = await pacKitchen.getRawPacMods();
    const response = await send({ action: 'IMPORT_SETTINGS', settings: {
      customProxyStringRaw: Array.from({ length: 51 }, (_, i) => `HTTPS p${i}.test:443`).join('; ') } });
    expect(response.success).to.equal(false);
    expect(response.errorCode).to.equal('BACKUP_INVALID');
    expect(await pacKitchen.getRawPacMods()).to.equal(before);
  });

  it('merges separate domain operations into the latest snapshot instead of replacing lists', async () => {
    const responses = await Promise.all(['one.test', 'two.test'].map(domain => send({
      action: 'MUTATE_DOMAIN_RULES', operations: [{ domain, mode: 'proxy' }],
    })));
    for (const response of responses) expect(response.success, response.error).to.equal(true);
    expect((await pacKitchen.getPacMods()).exceptions).to.include({ 'one.test': true, 'two.test': true });
    expect(applications).to.equal(2);
  });

  it('pins an exact popup resource without changing its wildcard, main site, siblings or default', async () => {
    await send({ action: 'ADD_PROXY', proxy: 'HTTP first.test:8080' });
    await send({ action: 'ADD_PROXY', proxy: 'HTTP second.test:8080' });
    const [first, second] = (await pacKitchen.getRawPacMods()).proxyProfiles;
    await pacKitchen.updatePacMods(raw => ({ ...raw,
      exceptions: { 'site.test': true, '*.cdn.test': true, 'other.test': true },
      domainProxyIds: { 'site.test': first.id, '*.cdn.test': first.id, 'other.test': first.id } }), { source: 'manual' });
    const snapshot = (await send({ action: 'GET_EXCEPTIONS' })).data;
    const response = await send({ action: 'MUTATE_DOMAIN_RULES', expectedRevision: snapshot.revision,
      operations: [{ domain: 'img.cdn.test', mode: 'proxy', proxyId: second.id }] });
    expect(response.success, response.error).to.equal(true);
    const raw = await pacKitchen.getRawPacMods();
    expect(raw.domainProxyIds).to.deep.equal({ 'site.test': first.id, '*.cdn.test': first.id,
      'other.test': first.id, 'img.cdn.test': second.id });
    expect(raw.defaultProxyId).to.equal(first.id);
    expect(raw.ruleMeta['exception:img.cdn.test'].source).to.equal('manual');
  });

  it('renames a checked profile without applying PAC or changing its ID', async () => {
    const created = await send({ action: 'ADD_PROXY', proxy: 'HTTP first.test:8080', name: 'Первый' });
    expect(created.success, created.error).to.equal(true);
    const first = created.data.pacMods.proxyProfiles[0];
    const before = applications;
    const renamed = await send({ action: 'RENAME_PROXY_PROFILE', proxyId: first.id, name: 'Офис' });
    expect(renamed.success, renamed.error).to.equal(true);
    expect(renamed.data.pacMods.proxyProfiles[0]).to.include({ id: first.id, name: 'Офис' });
    expect(applications).to.equal(before);
  });

  it('requires revision on raw replacement and does not overwrite a newer domain', async () => {
    await send({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'new.test', mode: 'proxy' }] });
    const response = await send({ action: 'SAVE_MODS', mods: { exceptions: {} } });
    expect(response.success).to.equal(false);
    expect((await pacKitchen.getPacMods()).exceptions['new.test']).to.equal(true);
  });

  it('returns catalog metadata even when the rules snapshot is unchanged', async () => {
    const original = await send({ action: 'GET_EXCEPTIONS' });
    const second = await send({ action: 'GET_EXCEPTIONS', knownRevision: original.data.revision });
    expect(second.data.unchanged).to.equal(true);
    expect(second.data.proxyCatalog).to.be.an('array');
    expect(second.data).to.have.property('defaultProxyId');
  });

  it('does not change automatic routing provenance when only whitelist membership changes', async () => {
    await send({ action: 'ADD_PROXY', proxy: 'HTTP first.test:8080' });
    const [profile] = (await pacKitchen.getRawPacMods()).proxyProfiles;
    await pacKitchen.updatePacMods(raw => ({ ...raw, exceptions: { 'cdn.test': true },
      domainProxyIds: { 'cdn.test': profile.id } }), { source: 'auto', site: 'page.test', copyOnWrite: true });
    const before = (await pacKitchen.getRawPacMods()).ruleMeta;
    for (const mode of ['whitelist-add', 'whitelist-remove']) {
      const rules = (await send({ action: 'GET_EXCEPTIONS' })).data;
      const response = await send({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'cdn.test', mode }], expectedRevision: rules.revision });
      expect(response.success, response.error).to.equal(true);
      const meta = (await pacKitchen.getRawPacMods()).ruleMeta;
      expect(meta['exception:cdn.test']).to.deep.equal(before['exception:cdn.test']);
      expect(meta['proxy:cdn.test']).to.deep.equal(before['proxy:cdn.test']);
    }
  });

  it('updates assignment provenance without relabeling an automatically discovered domain as manual', async () => {
    await send({ action: 'ADD_PROXY', proxy: 'HTTP first.test:8080' });
    await send({ action: 'ADD_PROXY', proxy: 'HTTP second.test:8080' });
    const [first, second] = (await pacKitchen.getRawPacMods()).proxyProfiles;
    await pacKitchen.updatePacMods(raw => ({ ...raw, exceptions: { 'cdn.test': true },
      domainProxyIds: { 'cdn.test': first.id } }), { source: 'auto', site: 'page.test', copyOnWrite: true });
    const rules = (await send({ action: 'GET_EXCEPTIONS' })).data;
    const moved = await send({ action: 'ASSIGN_DOMAIN_PROXIES', domains: ['cdn.test'], proxyId: second.id, expectedRevision: rules.revision });
    expect(moved.success, moved.error).to.equal(true);
    const raw = await pacKitchen.getRawPacMods();
    expect(raw.ruleMeta['exception:cdn.test'].source).to.equal('auto');
    expect(raw.ruleMeta['proxy:cdn.test'].source).to.equal('manual');
  });

  it('reports actual import changes instead of the number of input lines', async () => {
    const first = await send({ action: 'IMPORT_EXCEPTIONS_BATCH', target: 'included', domains: ['one.test', 'one.test'] });
    expect(first.success, first.error).to.equal(true);
    expect(first.data).to.include({ added: 1, changed: 0, unchanged: 0, count: 1 });
    const second = await send({ action: 'IMPORT_EXCEPTIONS_BATCH', target: 'included', domains: ['one.test'] });
    expect(second.data).to.include({ added: 0, changed: 0, unchanged: 1, count: 0 });
  });
});
