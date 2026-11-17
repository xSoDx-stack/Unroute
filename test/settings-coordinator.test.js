import { expect } from 'chai';
import { settingsCoordinator } from '../src/common/core/settings-coordinator.js';
import { applicationState } from '../src/common/core/application-state.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { pacSync } from '../src/common/core/pac-sync.js';
import { storage } from '../src/common/core/storage.js';

describe('Desired and applied settings', () => {
  let original;
  let saved;
  let desired;
  beforeEach(async () => {
    await applicationState.reset();
    original = { get: storage.get, set: storage.set, raw: pacKitchen.getRawPacMods,
      load: pacSync.loadLocalState, apply: pacSync.reapplyCurrentPac, key: pacSync.currentPacProviderKey };
    saved = {};
    desired = 7;
    storage.get = async (key, fallback) => saved[key] || fallback;
    storage.set = async (key, value) => { saved[key] = structuredClone(value); };
    pacKitchen.getRawPacMods = async () => ({ _revision: desired });
    pacSync.loadLocalState = async () => {};
    pacSync.currentPacProviderKey = 'onlyOwnSites';
  });
  afterEach(async () => {
    settingsCoordinator.finishReset();
    await applicationState.reset();
    storage.get = original.get; storage.set = original.set;
    pacKitchen.getRawPacMods = original.raw;
    pacSync.loadLocalState = original.load; pacSync.reapplyCurrentPac = original.apply;
    pacSync.currentPacProviderKey = original.key;
  });
  it('distinguishes an in-progress apply from a pending failure', async () => {
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    pacSync.reapplyCurrentPac = async () => {
      started();
      await new Promise(resolve => { release = resolve; });
      await applicationState.applied(desired);
    };
    const applying = settingsCoordinator.apply();
    await ready;
    expect(await settingsCoordinator.state()).to.include({ pending: true, applying: true });
    release();
    expect(await applying).to.include({ pending: false, applying: false });
  });
  it('retains pending edits after native failure and retries successfully after restart', async () => {
    pacSync.reapplyCurrentPac = async () => { throw new Error('Browser denied proxy settings'); };
    const failed = await settingsCoordinator.apply();
    expect(failed).to.include({ pending: true, desiredRevision: 7, appliedRevision: 0, error: 'Browser denied proxy settings' });
    await applicationState.reset();
    expect(await settingsCoordinator.state()).to.include({ pending: true, error: failed.error });
    pacSync.reapplyCurrentPac = async () => applicationState.applied(desired);
    expect(await settingsCoordinator.apply()).to.include({ pending: false, appliedRevision: 7, error: '' });
  });
  it('keeps a newer edit pending when only an older revision was applied', async () => {
    pacSync.reapplyCurrentPac = async () => { await applicationState.applied(desired); desired++; };
    expect(await settingsCoordinator.apply()).to.include({ pending: true, appliedRevision: 7, desiredRevision: 8 });
  });
  it('records disabled-provider edits without installing a PAC', async () => {
    pacSync.currentPacProviderKey = 'none';
    pacSync.reapplyCurrentPac = async () => {};
    expect(await settingsCoordinator.apply()).to.include({ pending: false, appliedRevision: 7 });
  });
  it('drains an in-flight apply and skips queued old work before reset', async () => {
    let release;
    let started;
    let calls = 0;
    const ready = new Promise(resolve => { started = resolve; });
    pacSync.reapplyCurrentPac = async () => {
      calls++;
      started();
      await new Promise(resolve => { release = resolve; });
      await applicationState.applied(desired);
    };
    const first = settingsCoordinator.apply();
    await ready;
    const queued = settingsCoordinator.apply();
    const draining = settingsCoordinator.drainForReset();
    expect(await settingsCoordinator.apply().catch(error => error)).to.be.an('error').with.property('message', 'Выполняется сброс настроек');
    release();
    await Promise.all([first, queued, draining]);
    expect(calls).to.equal(1);
    settingsCoordinator.finishReset();
    await applicationState.reset();
    delete saved['settings-application'];
    desired = 0;
    expect(await settingsCoordinator.state()).to.include({ appliedRevision: 0, pending: false, error: '' });
  });
  it('waits for checkpoint writes before clearing runtime state', async () => {
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    storage.set = async (key, value) => {
      started();
      await new Promise(resolve => { release = resolve; });
      saved[key] = value;
    };
    const save = applicationState.applied(99);
    await ready;
    let resetFinished = false;
    const reset = applicationState.reset().then(() => { resetFinished = true; });
    await Promise.resolve();
    expect(resetFinished).to.equal(false);
    release();
    await Promise.all([save, reset]);
    delete saved['settings-application'];
    expect(await applicationState.get(0)).to.include({ appliedRevision: 0, pending: false });
  });
});
