import { expect } from 'chai';
import { setupMessageBus } from '../src/common/core/message-bus.js';
import { appState } from '../src/common/core/app-state.js';
import { pacSync } from '../src/common/core/pac-sync.js';
import { settingsCoordinator } from '../src/common/core/settings-coordinator.js';
import { applicationState } from '../src/common/core/application-state.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { logger } from '../src/common/core/logger.js';
import { storage } from '../src/common/core/storage.js';

describe('Local commands during network startup', () => {
  it('omits large rule collections only when the editor has the current revision', async () => {
    const original = { chrome: globalThis.chrome, local: appState.ensureLocalStateInitialized,
      get: pacKitchen.getPacMods, raw: pacKitchen.getRawPacMods, state: settingsCoordinator.state };
    let listener;
    const exceptions = { 'current.test': true };
    let revision = 12;
    let rulesRevision = 12;
    globalThis.chrome = { runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}`,
      onMessage: { addListener: fn => { listener = fn; } } } };
    appState.ensureLocalStateInitialized = async () => {};
    pacKitchen.getPacMods = async () => ({ exceptions, whitelist: [], revision, rulesRevision });
    pacKitchen.getRawPacMods = async () => ({ ruleMeta: {} });
    settingsCoordinator.state = async () => ({ pending: false });
    try {
      setupMessageBus();
      const send = knownRevision => new Promise(resolve => listener({ action: 'GET_EXCEPTIONS', knownRevision }, { id: 'test' }, resolve));
      const unchanged = (await send(12)).data;
      expect(unchanged).to.include({ unchanged: true, revision: 12, defaultProxyId: null, catalogRevision: 0 });
      expect(unchanged.proxyCatalog).to.be.an('array');
      expect(unchanged).not.to.have.property('exceptions');
      for (const value of [undefined, null, '12', 11]) {
        expect((await send(value)).data.exceptions).to.equal(exceptions);
      }
      revision++;
      expect((await send(12)).data).to.include({ unchanged: true, revision: 12 });
      rulesRevision++;
      expect((await send(12)).data).to.include({ exceptions, revision: 13 });
    } finally {
      globalThis.chrome = original.chrome;
      appState.ensureLocalStateInitialized = original.local;
      pacKitchen.getPacMods = original.get; pacKitchen.getRawPacMods = original.raw;
      settingsCoordinator.state = original.state;
    }
  });
  it('rejects new save messages while reset owns the mutation barrier and releases the gate on failure', async () => {
    const original = { chrome: globalThis.chrome, local: appState.ensureLocalStateInitialized,
      begin: pacKitchen.beginReset, end: pacKitchen.endReset, update: pacKitchen.updatePacMods,
      drain: settingsCoordinator.drainForReset, finish: settingsCoordinator.finishReset,
      cancel: pacSync.cancelPendingSync, state: settingsCoordinator.state, set: storage.set };
    let listener;
    let started;
    let release;
    let writes = 0;
    let finished = 0;
    let releaseHealth;
    let healthStarted;
    const checking = new Promise(resolve => { healthStarted = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    globalThis.chrome = { runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}`,
      onMessage: { addListener: fn => { listener = fn; } } } };
    appState.ensureLocalStateInitialized = async () => {};
    pacSync.cancelPendingSync = () => {};
    pacKitchen.beginReset = () => new Promise((_resolve, reject) => { release = () => reject(new Error('Reset interrupted')); started(); });
    pacKitchen.endReset = () => { finished++; };
    pacKitchen.updatePacMods = async () => { writes++; };
    settingsCoordinator.drainForReset = async () => {};
    settingsCoordinator.finishReset = () => { finished++; };
    settingsCoordinator.state = async () => ({ pending: false });
    storage.set = async () => { writes++; };
    try {
      setupMessageBus({ checkHealth: () => new Promise(resolve => {
        releaseHealth = () => resolve({ ok: true, latency: 1 }); healthStarted();
      }) });
      const send = message => new Promise(resolve => listener(message, { id: 'test' }, resolve));
      const health = send({ action: 'CHECK_PROXY_HEALTH', proxy: 'HTTPS user:secret@proxy.test:443' });
      await checking;
      const resetting = send({ action: 'RESET_SETTINGS' });
      await ready;
      const late = await send({ action: 'SAVE_MODS', mods: { ifProxyOrDie: false } });
      expect(late.success).to.equal(false);
      expect(late.error).to.include('сброс');
      expect(writes).to.equal(0);
      release();
      expect((await resetting).success).to.equal(false);
      expect(finished).to.equal(2);
      releaseHealth();
      const stale = await health;
      expect(stale.success).to.equal(false);
      expect(stale.error).to.include('сброса');
      expect(writes).to.equal(0);
      expect((await send({ action: 'UNKNOWN_AFTER_RESET' })).error).to.equal('Unknown action: UNKNOWN_AFTER_RESET');
    } finally {
      globalThis.chrome = original.chrome; appState.ensureLocalStateInitialized = original.local;
      pacKitchen.beginReset = original.begin; pacKitchen.endReset = original.end;
      pacKitchen.updatePacMods = original.update; settingsCoordinator.drainForReset = original.drain;
      settingsCoordinator.finishReset = original.finish; pacSync.cancelPendingSync = original.cancel;
      settingsCoordinator.state = original.state;
      storage.set = original.set;
    }
  });
  it('returns logs and clears PAC without awaiting the full initialization', async () => {
    const original = { chrome: globalThis.chrome, full: appState.ensureInitialized, local: appState.ensureLocalStateInitialized,
      clear: pacSync.clearPac, state: settingsCoordinator.state, applied: applicationState.applied,
      raw: pacKitchen.getRawPacMods, logs: logger.getLogs, stats: logger.getStats };
    let listener;
    let fullCalls = 0;
    let localCalls = 0;
    let cleared = false;
    globalThis.chrome = { runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}`,
      onMessage: { addListener: fn => { listener = fn; } } } };
    appState.ensureInitialized = () => { fullCalls++; return new Promise(() => {}); };
    appState.ensureLocalStateInitialized = async () => { localCalls++; };
    settingsCoordinator.state = async () => ({ pending: false });
    applicationState.applied = async () => {};
    pacKitchen.getRawPacMods = async () => ({ _revision: 0 });
    pacSync.clearPac = async () => { cleared = true; };
    logger.getLogs = () => [{ title: 'Available locally' }];
    logger.getStats = () => ({ total: 1 });
    try {
      setupMessageBus();
      const send = action => new Promise(resolve => listener({ action }, { id: 'test' }, resolve));
      expect((await send('GET_LOGS')).data.logs[0].title).to.equal('Available locally');
      expect((await send('CLEAR_PAC')).success).to.equal(true);
      expect(cleared).to.equal(true);
      expect(localCalls).to.equal(2);
      expect(fullCalls).to.equal(0);
    } finally {
      globalThis.chrome = original.chrome;
      appState.ensureInitialized = original.full; appState.ensureLocalStateInitialized = original.local;
      pacSync.clearPac = original.clear; settingsCoordinator.state = original.state;
      applicationState.applied = original.applied; pacKitchen.getRawPacMods = original.raw;
      logger.getLogs = original.logs; logger.getStats = original.stats;
    }
  });
});
