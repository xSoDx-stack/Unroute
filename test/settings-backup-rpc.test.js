import { expect } from 'chai';
import { setupMessageBus, captureSettingsGeneration } from '../src/common/core/message-bus.js';
import { appState } from '../src/common/core/app-state.js';
import { settingsBackup, createSettingsBackup } from '../src/common/core/settings-backup.js';
import { settingsCoordinator } from '../src/common/core/settings-coordinator.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { pacSync } from '../src/common/core/pac-sync.js';
import { applicationState } from '../src/common/core/application-state.js';
import { fixture } from './settings-backup.test.js';

describe('Portable settings RPC', () => {
  let originalChrome, initialize, originalExport, originalImport, state, listener;
  const sender = { id: 'portable-test', url: 'chrome-extension://portable-test/pages/options/index.html' };
  const request = (message, source = sender) => new Promise(resolve => { if (listener(message, source, resolve) === false) resolve(undefined); });
  beforeEach(() => {
    originalChrome = globalThis.chrome; initialize = appState.ensureLocalStateInitialized;
    originalExport = settingsBackup.exportSettings; originalImport = settingsBackup.importSettings;
    globalThis.chrome = { runtime: { id: 'portable-test', getURL: () => 'chrome-extension://portable-test/',
      onMessage: { addListener: fn => { listener = fn; } } } };
    appState.ensureLocalStateInitialized = async () => {};
    state = settingsCoordinator.state; settingsCoordinator.state = async () => ({ pending: true });
    setupMessageBus();
  });
  afterEach(() => { globalThis.chrome = originalChrome; appState.ensureLocalStateInitialized = initialize;
    settingsBackup.exportSettings = originalExport; settingsBackup.importSettings = originalImport; settingsCoordinator.state = state; });
  it('ignores requests without both the current extension ID and an extension page URL', async () => {
    let initializations = 0;
    appState.ensureLocalStateInitialized = async () => { initializations++; };
    for (const metadata of [null, {}, { id: sender.id }, { url: sender.url },
      { ...sender, id: 'another-extension' }, { ...sender, url: 'https://example.test/' },
      { ...sender, origin: 'https://example.test' }]) {
      expect(await request({ action: 'NOT_AN_RPC_ACTION' }, metadata)).to.equal(undefined);
    }
    expect(initializations).to.equal(0);
  });

  it('accepts extension-page metadata from Chromium and Firefox', async () => {
    settingsBackup.exportSettings = async () => createSettingsBackup(fixture());
    const chromium = { ...sender, origin: 'chrome-extension://portable-test' };
    expect(await request({ action: 'EXPORT_SETTINGS' }, chromium)).to.include({ success: true });
    chrome.runtime.id = 'unroute@example.test';
    chrome.runtime.getURL = () => 'moz-extension://11111111-1111-4111-8111-111111111111/';
    const firefox = { id: chrome.runtime.id, url: `${chrome.runtime.getURL('')}pages/popup/index.html` };
    expect(await request({ action: 'EXPORT_SETTINGS' }, firefox)).to.include({ success: true });
  });
  it('rejects invalid imports before cold-worker initialization can migrate local storage', async () => {
    let initializations = 0, imports = 0;
    appState.ensureLocalStateInitialized = async () => { initializations++; };
    settingsBackup.importSettings = async () => { imports++; };
    const unsupported = createSettingsBackup(fixture()); unsupported.formatVersion = 999;
    for (const backup of ['{', unsupported]) {
      const response = await request({ action: 'IMPORT_SETTINGS', backup });
      expect(response).to.include({ success: false, errorCode: 'BACKUP_INVALID' });
    }
    expect(initializations).to.equal(0);
    expect(imports).to.equal(0);
  });
  it('exports full backup and returns saved-versus-applied state, rejecting untrusted origins', async () => {
    const backup = createSettingsBackup(fixture());
    settingsBackup.exportSettings = async () => backup;
    settingsBackup.importSettings = async () => ({ saved: true, applied: false, pending: true, settingsState: { pending: true } });
    const exported = await request({ action: 'EXPORT_SETTINGS' });
    expect(exported).to.deep.equal({ success: true, data: backup, settingsState: { pending: true } });
    const imported = await request({ action: 'IMPORT_SETTINGS', backup: JSON.stringify(backup) });
    expect(imported.success).to.equal(true); expect(imported.data).to.include({ saved: true, pending: true, applied: false });
    const untrusted = await request({ action: 'EXPORT_SETTINGS' }, { id: 'external', url: 'https://example.test' });
    expect(untrusted).to.equal(undefined);
  });
  it('blocks reset and other messages while a validated import owns the generation barrier', async () => {
    let release; const pending = new Promise(resolve => { release = resolve; });
    settingsBackup.importSettings = async () => { await pending; return { saved: true, applied: false, pending: true }; };
    const importing = request({ action: 'IMPORT_SETTINGS', backup: createSettingsBackup(fixture()) });
    await new Promise(resolve => setTimeout(resolve, 0));
    const busy = await request({ action: 'RESET_SETTINGS' });
    release(); await importing;
    expect(busy.success).to.equal(false);
    expect(busy.error).to.match(/сброс|reset/i);
  });
  it('drains an active CLEAR_PAC checkpoint before import replaces settings', async () => {
    const original = { clear: pacSync.clearPac, raw: pacKitchen.getRawPacMods, applied: applicationState.applied };
    const events = [];
    let entered, release, enteredImport;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const importing = new Promise(resolve => { enteredImport = resolve; });
    pacSync.clearPac = async () => { events.push('clear'); };
    pacKitchen.getRawPacMods = async () => ({ _revision: 1 });
    applicationState.applied = async () => { entered(); await gate; events.push('checkpoint'); };
    settingsBackup.importSettings = async () => {
      enteredImport();
      try {
        await settingsCoordinator.drainForReset();
        events.push('replacement');
        return { saved: true };
      } finally { settingsCoordinator.finishReset(); }
    };
    try {
      const clearing = request({ action: 'CLEAR_PAC' });
      await started;
      const replacing = request({ action: 'IMPORT_SETTINGS', backup: createSettingsBackup(fixture()) });
      await importing;
      const busy = await request({ action: 'CLEAR_PAC' });
      release();
      expect((await Promise.all([clearing, replacing])).every(response => response.success)).to.equal(true);
      expect(busy).to.include({ success: false });
      expect(events).to.deep.equal(['clear', 'checkpoint', 'replacement']);
    } finally {
      release();
      pacSync.clearPac = original.clear;
      pacKitchen.getRawPacMods = original.raw;
      applicationState.applied = original.applied;
    }
  });
  it('can import into broken local state without replacing a committed response with a status error', async () => {
    appState.ensureLocalStateInitialized = async () => { throw new Error('Broken local state'); };
    settingsCoordinator.state = async () => { throw new Error('Status read failed'); };
    settingsBackup.importSettings = async () => ({ saved: true, settingsState: { pending: false } });
    const response = await request({ action: 'IMPORT_SETTINGS', backup: createSettingsBackup(fixture()) });
    expect(response).to.include({ success: true });
    expect(response.settingsState).to.deep.equal({ pending: false });
  });
  it('keeps a successful response when optional status read fails', async () => {
    settingsBackup.exportSettings = async () => createSettingsBackup(fixture());
    settingsCoordinator.state = async () => { throw new Error('Status read failed'); };
    expect(await request({ action: 'EXPORT_SETTINGS' })).to.include({ success: true });
  });
  it('rejects settings patches outside the typed preferences contract', async () => {
    for (const mods of [{ unknownField: true }, { ifUseLocalTor: 'false' }]) {
      const response = await request({ action: 'SAVE_MODS', mods });
      expect(response.success).to.equal(false);
      expect(response.error).to.match(/dedicated|отдельн|специальн/i);
    }
  });
  it('invalidates pending exports and background preflights when settings are replaced', async () => {
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    settingsBackup.exportSettings = () => { started(); return pending; };
    const beforeImport = captureSettingsGeneration();
    const exporting = request({ action: 'EXPORT_SETTINGS' });
    await ready;
    let duringImport;
    settingsBackup.importSettings = async () => {
      duringImport = captureSettingsGeneration();
      return { saved: true, settingsState: { pending: false } };
    };
    const backup = createSettingsBackup(fixture());
    expect((await request({ action: 'IMPORT_SETTINGS', backup })).success).to.equal(true);
    release(backup);
    expect((await exporting).success).to.equal(false);
    expect(beforeImport()).to.equal(false);
    expect(duringImport()).to.equal(false);
    expect(captureSettingsGeneration()()).to.equal(true);
  });

  it('cancels a queued legacy rule edit before it can touch replacement settings', async () => {
    const originalUpdate = pacKitchen.updatePacMods;
    const originalApply = settingsCoordinator.apply;
    let runMutation, queued;
    const ready = new Promise(resolve => { queued = resolve; });
    let applied = false;
    const replacement = { exceptions: {}, ifMindExceptions: true };
    pacKitchen.updatePacMods = mutator => new Promise((resolve, reject) => {
      runMutation = () => {
        try { resolve(mutator(replacement)); } catch (error) { reject(error); }
      };
      queued();
    });
    settingsCoordinator.apply = async () => { applied = true; };
    settingsBackup.importSettings = async () => ({ saved: true });
    try {
      const editing = request({ action: 'SET_SINGLE_EXCEPTION', domain: 'queued.test', isProxy: false });
      await ready;
      const imported = await request({ action: 'IMPORT_SETTINGS', backup: createSettingsBackup(fixture()) });
      runMutation();
      expect(imported.success).to.equal(true);
      expect((await editing).success).to.equal(false);
      expect(applied).to.equal(false);
    } finally {
      pacKitchen.updatePacMods = originalUpdate;
      settingsCoordinator.apply = originalApply;
    }
  });
});
