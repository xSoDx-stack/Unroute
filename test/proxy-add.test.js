import { expect } from 'chai';
import { setupMessageBus } from '../src/common/core/message-bus.js';
import { appState } from '../src/common/core/app-state.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { settingsCoordinator } from '../src/common/core/settings-coordinator.js';
import { loadProxyHealthCache } from '../src/common/core/proxy-health-cache.js';

describe('Checked proxy addition', () => {
  let original;
  let listener;
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
    settingsCoordinator.apply = async () => ({ pending: false });
    settingsCoordinator.state = async () => ({ pending: false });
    pacKitchen.invalidateCache();
  });
  afterEach(() => {
    globalThis.chrome = original.chrome;
    appState.ensureLocalStateInitialized = original.local;
    settingsCoordinator.apply = original.apply;
    settingsCoordinator.state = original.state;
    pacKitchen.invalidateCache();
  });
  const add = proxy => new Promise(resolve => listener({ action: 'ADD_PROXY', proxy }, { id: 'test' }, resolve));

  it('merges a checked candidate into the latest list and persists its health', async () => {
    let release;
    let started;
    const checking = new Promise(resolve => { started = resolve; });
    setupMessageBus({ checkHealth: () => { started(); return new Promise(resolve => { release = resolve; }); } });
    const adding = add('HTTP candidate.example:8080');
    await checking;
    await pacKitchen.updatePacMods(current => ({ ...current, customProxyStringRaw: 'HTTPS added-elsewhere.example:443' }), { preferencesOnly: true });
    expect(await loadProxyHealthCache([])).to.deep.equal({});
    release({ ok: true, latency: 12 });
    const response = await adding;
    expect(response.success).to.equal(true);
    expect(response.data.pacMods.customProxyStringRaw).to.include('added-elsewhere.example:443').and.include('candidate.example:8080');
    expect(response.data.health).to.include({ ok: true, latency: 12 });
    expect((await loadProxyHealthCache(['HTTP candidate.example:8080']))['HTTP candidate.example:8080']).to.include({ ok: true, latency: 12 });
  });

  it('does not save an unavailable proxy or repeat checks for an existing endpoint', async () => {
    let checks = 0;
    setupMessageBus({ checkHealth: async () => { checks++; return { ok: false, error: 'Unavailable' }; } });
    expect((await add('HTTP failed.example:8080')).success).to.equal(false);
    expect((await pacKitchen.getPacMods()).customProxyStringRaw).to.equal('');
    await pacKitchen.updatePacMods(current => ({ ...current, customProxyStringRaw: 'HTTP existing.example:8080' }), { preferencesOnly: true });
    expect((await add('HTTP existing.example:8080')).success).to.equal(false);
    expect(checks).to.equal(1);
  });
  it('does not let an older list save prune the health of a concurrently added proxy', async () => {
    let release;
    let started;
    let calls = 0;
    const ready = new Promise(resolve => { started = resolve; });
    settingsCoordinator.apply = async () => {
      if (++calls === 1) { started(); await new Promise(resolve => { release = resolve; }); }
      return { pending: false };
    };
    setupMessageBus({ checkHealth: async () => ({ ok: true, latency: 8 }) });
    const saving = new Promise(resolve => listener({ action: 'SAVE_MODS', mods: {
      customProxyStringRaw: 'HTTP saved.example:8080',
    } }, { id: 'test' }, resolve));
    await ready;
    expect((await add('HTTP candidate.example:8080')).success).to.equal(true);
    release();
    expect((await saving).success).to.equal(true);
    expect((await loadProxyHealthCache(['HTTP candidate.example:8080']))['HTTP candidate.example:8080'].ok).to.equal(true);
  });
});
