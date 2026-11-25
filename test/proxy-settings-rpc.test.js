import { expect } from 'chai';
import { setupMessageBus } from '../src/common/core/message-bus.js';
import { appState } from '../src/common/core/app-state.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { settingsCoordinator } from '../src/common/core/settings-coordinator.js';
import { getPersistentCredentialsMap } from '../src/common/core/proxy-auth.js';

describe('Proxy connection and failover settings RPC', () => {
  let original, listener, applications;
  const send = message => new Promise(resolve => listener(message, { id: 'test', url: 'chrome-extension://test/pages/options/index.html' }, resolve));
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
    setupMessageBus();
  });
  afterEach(() => {
    globalThis.chrome = original.chrome;
    appState.ensureLocalStateInitialized = original.local;
    settingsCoordinator.apply = original.apply;
    settingsCoordinator.state = original.state;
    pacKitchen.invalidateCache();
  });

  it('saves and serializes the reserve, block and explicitly opted-in DIRECT policy', async () => {
    expect((await send({ action: 'SAVE_MODS', mods: { customProxyStringRaw: 'HTTPS a.test:443; HTTP b.test:8080' } })).success).to.equal(true);
    const before = await pacKitchen.getRawPacMods();
    const reserve = before.proxyProfiles[1].id;
    const saved = await send({ action: 'SAVE_MODS', mods: { fallbackProxyId: reserve, ifProxyOrDie: true } });
    expect(saved.success, saved.error).to.equal(true);
    expect(saved.data.fallbackProxyId).to.equal(reserve);
    expect((await pacKitchen.getPacMods()).fallbackProxyChain).to.equal('PROXY b.test:8080');
    const invalid = await send({ action: 'SAVE_MODS', mods: { fallbackProxyId: 'custom:missing' } });
    expect(invalid.success).to.equal(false);
    expect((await pacKitchen.getRawPacMods()).fallbackProxyId).to.equal(reserve);
    for (const ifProxyOrDie of [false, true]) {
      const response = await send({ action: 'SAVE_MODS', mods: { fallbackProxyId: null, ifProxyOrDie } });
      expect(response.success, response.error).to.equal(true);
      expect(response.data).to.include({ fallbackProxyId: null, ifProxyOrDie, ownProxyOrDie: true });
    }
    const scoped = await send({ action: 'SAVE_MODS', mods: { ownProxyOrDie: false } });
    expect(scoped.success, scoped.error).to.equal(true);
    expect(scoped.data).to.include({ ownProxyOrDie: false, ifProxyOrDie: true });
    expect((await send({ action: 'SAVE_MODS', mods: { ownProxyOrDie: 'false' } })).success).to.equal(false);
  });

  it('edits the endpoint and credentials while retaining the bound profile ID and refreshing runtime auth', async () => {
    expect((await send({ action: 'SAVE_MODS', mods: { customProxyStringRaw: 'HTTPS old:test-old@a.test:443; HTTPS b.test:443' } })).success).to.equal(true);
    const first = (await pacKitchen.getRawPacMods()).proxyProfiles[0];
    await send({ action: 'SET_DEFAULT_PROXY', proxyId: first.id });
    await send({ action: 'MUTATE_DOMAIN_RULES', operations: [{ domain: 'bound.test', mode: 'proxy', proxyId: first.id }] });
    await send({ action: 'SAVE_MODS', mods: { fallbackProxyId: first.id } });
    const beforeApplications = applications;
    const response = await send({ action: 'UPDATE_PROXY_PROFILE', proxyId: first.id,
      proxy: 'HTTPS updated:test-new@changed.test:8443', name: 'Edited proxy' });
    expect(response.success, response.error).to.equal(true);
    const after = await pacKitchen.getRawPacMods();
    expect(after.proxyProfiles[0]).to.include({ id: first.id, endpoint: 'HTTPS changed.test:8443', name: 'Edited proxy' });
    expect(after.domainProxyIds['bound.test']).to.equal(first.id);
    expect(after.defaultProxyId).to.equal(first.id);
    expect(after.fallbackProxyId).to.equal(first.id);
    expect(applications).to.equal(beforeApplications + 1);
    expect(getPersistentCredentialsMap()['changed.test:8443']).to.deep.equal({ username: 'updated', password: 'test-new' });
    expect(getPersistentCredentialsMap()).not.to.have.property('a.test:443');
  });

  it('rejects a duplicate endpoint or malformed edit atomically without exposing credentials', async () => {
    await send({ action: 'SAVE_MODS', mods: { customProxyStringRaw: 'HTTPS a.test:443; HTTPS b.test:443' } });
    const before = await pacKitchen.getRawPacMods();
    const beforeApplications = applications;
    for (const proxy of ['HTTPS fixture-user:fixture-secret@b.test:443', 'SOCKS5 fixture-user:fixture-secret@c.test:1080', 'HTTP fixture-user:fixture-secret@c.test:0']) {
      const response = await send({ action: 'UPDATE_PROXY_PROFILE', proxyId: before.proxyProfiles[0].id, proxy, name: 'Edited' });
      expect(response.success).to.equal(false);
      expect(response.error).not.to.match(/fixture-user|fixture-secret/);
      expect(await pacKitchen.getRawPacMods()).to.deep.equal(before);
      expect(applications).to.equal(beforeApplications);
    }
  });
});
