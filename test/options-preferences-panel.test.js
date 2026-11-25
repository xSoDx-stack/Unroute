import assert from 'node:assert/strict';

async function fixture(id, state) {
  const { initPreferencesPanel } = await import('../src/common/pages/options/preferences-panel.js');
  const toggle = Object.assign(new EventTarget(), { checked: false, disabled: false });
  const calls = [];
  const errors = [];
  let settle;
  let refreshes = 0;
  const panel = initPreferencesPanel({ getElementById: key => key === id ? toggle : null }, {
    appState: state,
    sendMessage(message) {
      calls.push(message);
      return new Promise(resolve => { settle = resolve; });
    },
    showToast() {}, showResponseError: error => errors.push(error),
    isResetBusy: () => false, invalidateStateRead() {}, onModifiersSettled: () => { ++refreshes; },
  });
  panel.bindEvents();
  panel.render();
  return { toggle, calls, errors, finish: async response => { settle(response); await Promise.resolve(); }, refreshes: () => refreshes };
}

describe('Settings preferences panel', () => {
  it('restores the confirmed modifier after a failed autosave and refreshes the proxy list', async () => {
    const { toggle, calls, errors, finish, refreshes } = await fixture('proxyOrDieToggle', { pacMods: {}, notifications: {} });
    assert.equal(toggle.checked, true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    assert.deepEqual(calls, [{ action: 'SAVE_MODS', mods: { ifProxyOrDie: false } }]);
    assert.equal(toggle.disabled, true);
    const failure = { success: false, error: 'failed' };
    await finish(failure);
    assert.deepEqual(errors, [failure]);
    assert.equal(toggle.checked, true);
    assert.equal(toggle.disabled, false);
    assert.equal(refreshes(), 1);
  });

  it('ignores a stale notification response and restores the latest confirmed value', async () => {
    const state = { pacMods: {}, notifications: { 'pac-error': false } };
    const { toggle, calls, errors, finish } = await fixture('notifPacErrorToggle', state);
    assert.equal(toggle.checked, false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    assert.deepEqual(calls, [{ action: 'SET_NOTIFICATION_OPTION', key: 'pac-error', enabled: true }]);
    await finish({ success: true, stale: true });
    assert.equal(state.notifications['pac-error'], false);
    assert.equal(toggle.checked, false);
    assert.equal(toggle.disabled, false);
    assert.deepEqual(errors, []);
  });
});
