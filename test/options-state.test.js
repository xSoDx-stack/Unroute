import assert from 'node:assert/strict';

async function setup() {
  const { createOptionsState } = await import('../src/common/pages/options/options-state.js');
  const pending = [];
  const applied = [];
  const appState = { pacMods: { proxyCatalog: [] }, syncState: { currentPacProviderKey: 'confirmed' } };
  const state = createOptionsState({
    appState, request: message => new Promise(resolve => pending.push({ message, resolve })),
    applySettingsState: value => applied.push(value), render: () => {}, preloadLogStats: async () => {}, formatVersion: version => version,
  });
  return { state, appState, pending, applied };
}

describe('Options state', () => {
  it('does not apply a partial snapshot while its catalog read is pending', async () => {
    const { state, appState, pending, applied } = await setup();
    const loading = state.refresh();
    assert.deepEqual(pending[0].message, { action: 'GET_STATE', includeExceptions: false });
    pending[0].resolve({ success: true, data: { pacMods: {}, syncState: { currentPacProviderKey: 'outdated' } }, settingsState: { pending: true } });
    await new Promise(resolve => setImmediate(resolve));
    const catalog = pending[1];
    assert.deepEqual(catalog.message, { action: 'GET_EXCEPTIONS' });
    assert.equal(appState.syncState.currentPacProviderKey, 'confirmed');
    assert.deepEqual(applied, []);
    state.invalidateRead();
    catalog.resolve({ success: true, data: { proxyCatalog: [{ id: 'old' }] }, settingsState: { pending: true } });
    assert.equal(await loading, false);
    assert.deepEqual(appState.pacMods.proxyCatalog, []);
    assert.deepEqual(applied, []);
  });

  it('does not overwrite a newer operation status while resolving the fallback catalog', async () => {
    const { state, appState, pending, applied } = await setup();
    const loading = state.refresh();
    pending[0].resolve({ success: true, data: { pacMods: {} }, settingsState: { pending: true } });
    await new Promise(resolve => setImmediate(resolve));
    const saving = state.sendMessage({ action: 'INSTALL_PAC' });
    pending[2].resolve({ success: true, settingsState: { pending: false } });
    await saving;
    pending[1].resolve({ success: true, data: { proxyCatalog: [{ id: 'current' }] } });
    assert.equal(await loading, true);
    assert.deepEqual(appState.pacMods.proxyCatalog, [{ id: 'current' }]);
    assert.deepEqual(applied, [{ pending: false }]);
  });

  it('preserves a newly selected PAC provider while an older snapshot finishes', async () => {
    const { state, appState, pending } = await setup();
    const loading = state.refresh();
    pending[0].resolve({ success: true, data: { pacMods: {}, syncState: { currentPacProviderKey: 'old' } } });
    await new Promise(resolve => setImmediate(resolve));
    state.setSyncState({ currentPacProviderKey: 'none' });
    pending[1].resolve({ success: true, data: { proxyCatalog: [{ id: 'current' }] } });
    assert.equal(await loading, true);
    assert.equal(appState.syncState.currentPacProviderKey, 'none');
    assert.deepEqual(appState.pacMods.proxyCatalog, [{ id: 'current' }]);
  });

  it('ignores an RPC completion from before a reset', async () => {
    const { state, pending } = await setup();
    const saving = state.sendMessage({ action: 'SAVE_MODS' });
    state.reset();
    pending[0].resolve({ success: true, settingsState: { pending: true } });
    assert.deepEqual(await saving, { success: false, stale: true });
  });

  it('does not publish a superseded PAC action status', async () => {
    const { state, pending, applied } = await setup();
    let current = true;
    const installation = state.sendMessage({ action: 'INSTALL_PAC' }, () => current);
    current = false;
    pending[0].resolve({ success: true, settingsState: { pending: true } });
    assert.deepEqual(await installation, { success: false, stale: true });
    assert.deepEqual(applied, []);
  });

  it('defers external reads while busy and coalesces them after the editor is available', async () => {
    const { state, pending } = await setup();
    const document = Object.assign(new EventTarget(), { defaultView: new EventTarget(), visibilityState: 'visible' });
    const sites = [];
    let busy = true;
    let changed;
    state.watchExternal({ document, changesEvent: { addListener: listener => { changed = listener; } },
      isBusy: () => busy, isSitesActive: () => true,
      sitesEditor: { cancelRead: () => sites.push('cancel'), refresh: () => sites.push('refresh') },
    });
    const changes = { 'pac-kitchen-mods': { oldValue: { _revision: 1 }, newValue: { _revision: 2 } } };
    changed(changes, 'session');
    changed(changes, 'local');
    assert.deepEqual(sites, ['cancel']);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(pending.length, 0);
    busy = false;
    state.resumeExternalRefresh();
    document.defaultView.dispatchEvent(new Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.deepEqual(pending.map(entry => entry.message.action), ['GET_STATE']);
    assert.deepEqual(sites, ['cancel', 'refresh']);
    pending[0].resolve({ success: false });
  });
});
