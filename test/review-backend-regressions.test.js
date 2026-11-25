import { expect } from 'chai';
import vm from 'node:vm';
import { proxyBackend as firefox } from './firefox-proxy-backend-fixture.js';
import { cookPac } from '../src/common/core/pac-script.js';
import { pacSync } from '../src/common/core/pac-sync.js';
import { setupMessageBus } from '../src/common/core/message-bus.js';
import { appState } from '../src/common/core/app-state.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { settingsCoordinator } from '../src/common/core/settings-coordinator.js';
import { proxyBackend } from '../src/common/core/proxy-backend.js';
import { checkProxyHealth } from '../src/common/core/proxy-checker.js';

const pac = 'function FindProxyForURL(){ return "PROXY original.test:443"; }';
async function rejection(promise) { try { await promise; } catch (error) { return error; } }

describe('Review backend regressions', () => {
  it('localizes visible uncoded message errors', async () => {
    const original = { chrome: globalThis.chrome, init: appState.ensureLocalStateInitialized };
    let listener;
    globalThis.chrome = { runtime: { id: 'review', getURL: () => 'moz-extension://review/',
      onMessage: { addListener: fn => { listener = fn; } } },
      i18n: { getMessage: key => key === 'msg_invalid_domain_import' ? 'Translated import error' : '' } };
    appState.ensureLocalStateInitialized = async () => {};
    try {
      setupMessageBus();
      const result = await new Promise(resolve => listener({ action: 'IMPORT_EXCEPTIONS_BATCH', target: 'invalid' }, { id: 'review', url: 'moz-extension://review/pages/options/index.html' }, resolve));
      expect(result.error).to.equal('Translated import error');
    } finally { globalThis.chrome = original.chrome; appState.ensureLocalStateInitialized = original.init; }
  });
  it('does not start a probe over an unrestorable owned Firefox blob', async () => {
    const get = proxyBackend.getSettings, apply = proxyBackend.applyPac, mods = pacKitchen.getPacMods;
    let writes = 0;
    proxyBackend.getSettings = async () => ({ levelOfControl: 'controlled_by_this_extension',
      backendSnapshot: { wasControlledByThisExtension: true, pacData: '',
        nativeValue: { proxyType: 'autoConfig', autoConfigUrl: 'blob:expired' } } });
    proxyBackend.applyPac = async () => { writes++; };
    pacKitchen.getPacMods = async () => ({});
    try {
      expect(await rejection(checkProxyHealth('HTTPS probe.test:443'))).to.be.an('error');
      expect(writes).to.equal(0);
    } finally { proxyBackend.getSettings = get; proxyBackend.applyPac = apply; pacKitchen.getPacMods = mods; }
  });
  describe('Firefox snapshot provenance', () => {
    let originalChrome, create, revoke, value, level, calls;
    beforeEach(async () => {
      originalChrome = globalThis.chrome; create = URL.createObjectURL; revoke = URL.revokeObjectURL;
      let serial = 0;
      URL.createObjectURL = () => `blob:review-${++serial}`;
      URL.revokeObjectURL = () => {};
      value = { proxyType: 'system' }; level = 'controllable_by_this_extension'; calls = [];
      globalThis.chrome = { runtime: {}, extension: { isAllowedIncognitoAccess: cb => cb(true) },
        proxy: { settings: {
          get: (_, cb) => cb({ value, levelOfControl: level }),
          set: (details, cb) => { calls.push(details.value); value = details.value; level = 'controlled_by_this_extension'; cb(); },
          clear: (_, cb) => { value = { proxyType: 'system' }; level = 'controllable_by_this_extension'; cb(); },
        } } };
      await firefox.clear();
    });
    afterEach(() => { globalThis.chrome = originalChrome; URL.createObjectURL = create; URL.revokeObjectURL = revoke; });
    it('rejects an owned blob without captured source instead of reviving it or clearing', async () => {
      value = { proxyType: 'autoConfig', autoConfigUrl: 'blob:expired-event-page' };
      level = 'controlled_by_this_extension';
      const snapshot = await firefox.getSettings();
      await firefox.applyPac(pac);
      expect(await rejection(firefox.restore(snapshot))).to.be.an('error');
      expect(calls).to.have.length(1);
      expect(value.autoConfigUrl).not.to.equal('blob:expired-event-page');
    });
    it('does not attach stale in-memory PAC to a foreign or changed native value', async () => {
      await firefox.applyPac(pac, { mandatory: true });
      value = { proxyType: 'autoConfig', autoConfigUrl: 'https://foreign.test/proxy.pac' };
      level = 'controlled_by_other_extensions';
      const snapshot = await firefox.getSettings();
      expect(snapshot.backendSnapshot.pacData).to.equal('');
      expect(snapshot.backendSnapshot.mandatory).to.equal(false);
    });
    it('does not replace another extension settings during restore', async () => {
      await firefox.applyPac(pac);
      const snapshot = await firefox.getSettings();
      level = 'controlled_by_other_extensions';
      expect(await rejection(firefox.restore(snapshot))).to.be.an('error');
      expect(calls).to.have.length(1);
    });
    it('retains the logical mandatory flag in owned rollback snapshots', async () => {
      await firefox.applyPac(pac, { mandatory: true });
      const snapshot = await firefox.getSettings();
      await firefox.applyPac(pac + '\n// temporary', { mandatory: false });
      await firefox.restore(snapshot);
      expect((await firefox.getSettings()).backendSnapshot.mandatory).to.equal(true);
    });
  });

  it('installs the DNS prohibition once before any routing/early return', () => {
    const context = vm.createContext({ dnsResolve: () => '192.0.2.1' });
    vm.runInContext(cookPac(pac, { ifProhibitDns: true, ifProxyOrDie: true }), context);
    const stub = context.dnsResolve;
    expect(stub('example.test')).to.equal(null);
    context.FindProxyForURL('https://example.test/', 'example.test');
    expect(context.dnsResolve).to.equal(stub);
    expect(cookPac(pac, { ifProxyOrDie: true })).not.to.include('directIfAllowed');
  });

  for (const fails of [false, true]) it(`releases download controller after ${fails ? 'failure' : 'success'}`, async () => {
    const download = pacSync.downloadPacFromProvider;
    const state = pacSync._downloadController;
    pacSync.downloadPacFromProvider = async () => { if (fails) throw new Error('Download failed'); return pac; };
    // Deliberately supersede immediately after downloading: no native or storage writes.
    const original = pacSync.downloadPacFromProvider;
    pacSync.downloadPacFromProvider = async (...args) => { const result = await original(...args); pacSync._syncGeneration++; return result; };
    try {
      await rejection(pacSync._performSync({ key: 'Антизапрет', ifUnattended: false }));
      expect(pacSync._downloadController).to.equal(null);
    } finally { pacSync.downloadPacFromProvider = download; pacSync._downloadController = state; }
  });

  it('old download cleanup cannot release a newer controller', async () => {
    const download = pacSync.downloadPacFromProvider;
    const state = pacSync._downloadController;
    const newer = new AbortController();
    pacSync.downloadPacFromProvider = async () => { pacSync._downloadController = newer; pacSync._syncGeneration++; return pac; };
    try {
      await rejection(pacSync._performSync({ key: 'Антизапрет', ifUnattended: false }));
      expect(pacSync._downloadController).to.equal(newer);
    } finally { pacSync.downloadPacFromProvider = download; pacSync._downloadController = state; }
  });

  it('reset reaches its existing mutation barrier even when local init is broken', async () => {
    const original = { chrome: globalThis.chrome, init: appState.ensureLocalStateInitialized,
      begin: pacKitchen.beginReset, end: pacKitchen.endReset, drain: settingsCoordinator.drainForReset,
      finish: settingsCoordinator.finishReset };
    let listener, entered = false, finished = 0;
    globalThis.chrome = { runtime: { id: 'review', getURL: () => 'moz-extension://review/',
      onMessage: { addListener: fn => { listener = fn; } } } };
    appState.ensureLocalStateInitialized = async () => { throw new Error('Corrupt local state'); };
    settingsCoordinator.drainForReset = async () => {};
    pacKitchen.beginReset = async () => { entered = true; throw new Error('Barrier reached'); };
    pacKitchen.endReset = () => { finished++; };
    settingsCoordinator.finishReset = () => { finished++; };
    try {
      setupMessageBus();
      const result = await new Promise(resolve => listener({ action: 'RESET_SETTINGS' }, { id: 'review', url: 'moz-extension://review/pages/options/index.html' }, resolve));
      expect(entered).to.equal(true);
      expect(result.error).to.equal('Barrier reached');
      expect(finished).to.equal(2);
    } finally {
      globalThis.chrome = original.chrome; appState.ensureLocalStateInitialized = original.init;
      pacKitchen.beginReset = original.begin; pacKitchen.endReset = original.end;
      settingsCoordinator.drainForReset = original.drain; settingsCoordinator.finishReset = original.finish;
    }
  });
});
