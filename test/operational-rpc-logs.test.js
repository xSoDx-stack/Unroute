import { expect } from 'chai';
import { setupMessageBus, createErrorResponse } from '../src/common/core/message-bus.js';
import { appState } from '../src/common/core/app-state.js';
import { logger } from '../src/common/core/logger.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { pacSync } from '../src/common/core/pac-sync.js';
import { settingsBackup, createSettingsBackup } from '../src/common/core/settings-backup.js';
import { settingsCoordinator } from '../src/common/core/settings-coordinator.js';
import { fixture } from './settings-backup.test.js';

const sender = { id: 'test', url: 'chrome-extension://test/pages/options/index.html' };
const sensitive = 'private.test username:secret';
const failure = () => Object.assign(new Error(sensitive), { code: sensitive });

describe('Operational RPC logs', () => {
  let listener, entries, restore;
  const send = (message, source = sender) => new Promise(resolve => listener(message, source, resolve));
  const stub = (object, name, value) => {
    const previous = Object.getOwnPropertyDescriptor(object, name);
    restore.push(() => previous ? Object.defineProperty(object, name, previous) : delete object[name]);
    object[name] = value;
  };
  beforeEach(() => {
    entries = [];
    restore = [];
    stub(globalThis, 'chrome', { runtime: { id: 'test', getURL: () => 'chrome-extension://test/',
      onMessage: { addListener: fn => { listener = fn; } } } });
    stub(appState, 'ensureLocalStateInitialized', async () => {});
    stub(settingsCoordinator, 'state', async () => ({ pending: false }));
    stub(logger, 'add', entry => { entries.push(entry); });
    setupMessageBus({ checkHealth: async () => ({ ok: false, error: sensitive }) });
  });
  afterEach(() => { restore.reverse().forEach(fn => fn()); });

  it('captures thrown rule and proxy write failures without recording error text or codes from the exception', async () => {
    const error = failure();
    stub(pacKitchen, 'updatePacMods', async () => { throw error; });
    for (const [action, category] of [['SAVE_DOMAIN_LIST', 'rules'], ['UPDATE_PROXY_PROFILE', 'proxy']]) {
      expect(await send({ action, domain: sensitive, proxy: sensitive })).to.deep.equal(createErrorResponse(error));
      const { category: loggedCategory, title, message: code, details } = entries.pop();
      expect(loggedCategory).to.equal(category);
      expect(title).to.be.a('string').and.not.be.empty;
      expect(code).to.equal('OPERATION_FAILED');
      expect(details).to.deep.equal({ action });
      expect(JSON.stringify([title, code, details])).not.to.include(sensitive);
    }
  });

  it('captures a resolved backup failure and does not wait for the logger', async () => {
    stub(settingsBackup, 'exportSettings', async () => { throw failure(); });
    const add = logger.add;
    stub(logger, 'add', entry => { add(entry); return new Promise(() => {}); });
    expect(await send({ action: 'EXPORT_SETTINGS' })).to.include({ success: false, errorCode: 'BACKUP_EXPORT_FAILED' });
    expect(entries).to.deep.equal([{ level: 'error', category: 'backup', title: 'Не удалось выполнить операцию с резервной копией',
      message: 'BACKUP_EXPORT_FAILED', details: { action: 'EXPORT_SETTINGS' }, groupKey: 'EXPORT_SETTINGS' }]);
  });

  it('records a failed import across its own settings replacement barrier', async () => {
    stub(appState, 'settlePendingInitialization', async () => {});
    stub(pacSync, 'cancelPendingSync', () => {});
    stub(settingsBackup, 'importSettings', async () => { throw Object.assign(failure(), { code: 'BACKUP_STORAGE_FAILED' }); });
    const backup = createSettingsBackup(fixture());
    expect(await send({ action: 'IMPORT_SETTINGS', backup })).to.include({ success: false, errorCode: 'BACKUP_STORAGE_FAILED' });
    expect(entries[0].details).to.deep.equal({ action: 'IMPORT_SETTINGS' });
    expect(entries[0].message).to.equal('BACKUP_STORAGE_FAILED');
  });

  it('keeps different actions in the same category in separate groups', async () => {

    stub(pacKitchen, 'updatePacMods', async () => { throw failure(); });
    await send({ action: 'SAVE_DOMAIN_LIST' });
    await send({ action: 'DELETE_DOMAIN_LIST' });
    expect(entries.map(entry => entry.groupKey)).to.deep.equal(['SAVE_DOMAIN_LIST', 'DELETE_DOMAIN_LIST']);
  });

  it('captures a resolved application failure without changing saved/applied semantics', async () => {
    const state = { pending: true, error: sensitive };
    stub(settingsCoordinator, 'apply', async () => state);
    const response = await send({ action: 'RETRY_SETTINGS_APPLY' });
    expect(response).to.include({ success: true, data: state });
    expect(entries).to.deep.equal([{ level: 'error', category: 'settings', title: 'Не удалось применить настройки',
      message: 'SETTINGS_APPLY_FAILED', details: { action: 'RETRY_SETTINGS_APPLY' }, groupKey: 'RETRY_SETTINGS_APPLY' }]);
  });

  it('ignores already reported PAC errors and pending state without an error', async () => {
    const pacError = failure();
    stub(pacSync, 'lastError', pacError);
    const states = [{ pending: true, error: pacError.message }, { pending: true, error: '' }];
    stub(settingsCoordinator, 'apply', async () => states.shift());
    await send({ action: 'RETRY_SETTINGS_APPLY' });
    await send({ action: 'RETRY_SETTINGS_APPLY' });
    expect(entries).to.be.empty;
  });

  it('records only settings failures when toggling a local proxy service', async () => {
    const action = 'SET_LOCAL_PROXY_ENABLED';
    const request = { action, service: 'tor', enabled: false };
    stub(pacKitchen, 'updatePacMods', async () => { throw failure(); });
    expect((await send(request)).success).to.equal(false);
    stub(pacKitchen, 'updatePacMods', async () => ({}));
    stub(settingsCoordinator, 'apply', async () => ({ pending: true, error: sensitive }));
    expect((await send(request)).success).to.equal(true);
    expect((await send({ ...request, enabled: true })).success).to.equal(false);
    expect((await send({ ...request, service: 'unknown' })).success).to.equal(false);
    expect(entries.map(({ category, message, details }) => ({ category, message, details }))).to.deep.equal([
      { category: 'settings', message: 'OPERATION_FAILED', details: { action } },
      { category: 'settings', message: 'SETTINGS_APPLY_FAILED', details: { action } },
    ]);
  });

  it('ignores validation, conflicts, failed health checks and private or unclassified actions', async () => {
    stub(pacKitchen, 'getRawPacMods', async () => ({}));
    stub(pacKitchen, 'updatePacMods', async () => { throw Object.assign(failure(), { code: 'RULES_CONFLICT' }); });
    expect((await send({ action: 'MUTATE_DOMAIN_RULES' })).errorCode).to.equal('RULES_CONFLICT');
    expect((await send({ action: 'SAVE_MODS', mods: { ifUseLocalTor: 'bad' } })).success).to.equal(false);
    expect((await send({ action: 'IMPORT_SETTINGS', backup: '{' })).errorCode).to.equal('BACKUP_INVALID');
    expect((await send({ action: 'ADD_PROXY', proxy: 'HTTPS a.test:443' })).success).to.equal(false);
    stub(appState, 'ensureLocalStateInitialized', async () => { throw failure(); });
    for (const source of [{ ...sender, incognito: true }, { ...sender, tab: { incognito: true } },
      { ...sender, url: 'chrome-extension://test/pages/popup/index.html' }]) {
      expect((await send({ action: 'MUTATE_DOMAIN_RULES' }, source)).success).to.equal(false);
    }
    expect((await send({ action: 'OPEN_PRIVATE_BROWSING_SETTINGS' })).success).to.equal(false);
    expect(entries).to.be.empty;
  });

  it('does not report a resolved backup failure superseded by settings replacement', async () => {
    let rejectExport, startExport;
    const started = new Promise(resolve => { startExport = resolve; });
    stub(settingsBackup, 'exportSettings', () => new Promise((_, reject) => { rejectExport = reject; startExport(); }));
    const exporting = send({ action: 'EXPORT_SETTINGS' });
    await started;
    stub(appState, 'settlePendingInitialization', async () => {});
    stub(pacSync, 'cancelPendingSync', () => {});
    stub(settingsBackup, 'importSettings', async () => ({ saved: true }));
    expect((await send({ action: 'IMPORT_SETTINGS', backup: createSettingsBackup(fixture()) })).success).to.equal(true);
    rejectExport(failure());
    expect((await exporting).errorCode).to.equal('BACKUP_EXPORT_FAILED');
    expect(entries).to.be.empty;
  });

  it('exports logs with the level filter and preserves the localized empty report', async () => {
    // Stub the report boundary; its own tests cover filtering and formatting.
    let filters;
    const emptyText = '# Журнал ошибок и сбоев пуст.\n';
    stub(logger, 'exportReport', options => { filters = options; return { text: emptyText, count: 0 }; });
    const response = await send({ action: 'EXPORT_LOGS', category: 'rules', search: 'test', level: 'warn' });
    expect(filters).to.deep.equal({ category: 'rules', search: 'test', level: 'warn' });
    expect(response.data).to.deep.equal({ text: emptyText, count: 0 });
  });
});
