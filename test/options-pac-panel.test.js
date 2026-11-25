import assert from 'node:assert/strict';

async function setup(request, cards = []) {
  const { initPacPanel } = await import('../src/common/pages/options/pac-panel.js');
  const input = Object.assign(new EventTarget(), { value: '' });
  const save = new EventTarget();
  const fields = { customPacUrlInput: input, saveCustomPacUrlBtn: save };
  const root = { getElementById: id => fields[id], querySelectorAll: () => cards };
  let state = { currentPacProviderKey: 'customPacUrl', customPacUrl: 'https://saved.example/proxy.pac', providers: {} };
  const toasts = [];
  const errors = [];
  const panel = initPacPanel(root, {
    getSyncState: () => state, setSyncState: value => { state = value; },
    sendMessage: request, showToast: value => toasts.push(value), showResponseError: value => errors.push(value), render() {},
  });
  panel.bindEvents();
  return { panel, input, save, toasts, errors, getState: () => state, replaceState: value => { state = value; } };
}

describe('Settings PAC panel', () => {
  it('handles native radio changes without requiring a label click', async () => {
    const radio = Object.assign(new EventTarget(), { checked: true });
    const card = { dataset: { provider: 'none' }, querySelector: selector => selector.startsWith('input') ? radio : null,
      classList: { toggle() {} } };
    const calls = [];
    const { getState } = await setup(async message => {
      calls.push(message);
      return { success: true, data: { currentPacProviderKey: 'none' } };
    }, [card]);
    radio.dispatchEvent(new Event('change'));
    await Promise.resolve();
    assert.deepEqual(calls, [{ action: 'CLEAR_PAC' }]);
    assert.equal(getState().currentPacProviderKey, 'none');
  });
  it('preserves a draft when the provider state refreshes and clears it on reset', async () => {
    const { panel, input } = await setup(() => assert.fail('Unexpected request'));
    panel.render();
    assert.equal(input.value, 'https://saved.example/proxy.pac');
    input.value = 'https://draft.example/proxy.pac';
    panel.render();
    assert.equal(input.value, 'https://draft.example/proxy.pac');
    panel.reset();
    assert.equal(input.value, '');
  });

  it('does not replace current provider state with a stale install response', async () => {
    let finish;
    const messages = [];
    const { input, save, getState, replaceState } = await setup(message => {
      messages.push(message);
      return new Promise(resolve => { finish = resolve; });
    });
    input.value = ' https://draft.example/proxy.pac ';
    save.dispatchEvent(new Event('click'));
    assert.deepEqual(messages, [{ action: 'INSTALL_PAC', key: 'customPacUrl', customPacUrl: 'https://draft.example/proxy.pac' }]);
    assert.equal(save.disabled, true);
    const reset = { currentPacProviderKey: 'none' };
    replaceState(reset);
    finish({ stale: true, success: true, data: { currentPacProviderKey: 'customPacUrl' } });
    await Promise.resolve();
    assert.equal(getState(), reset);
    assert.equal(save.disabled, false);
  });

  for (const success of [false, true]) it(`ignores an older ${success ? 'success' : 'failure'} after a newer provider selection`, async () => {
    const radio = Object.assign(new EventTarget(), { checked: true });
    const card = { dataset: { provider: 'none' }, querySelector: selector => selector.startsWith('input') ? radio : null,
      classList: { toggle() {} } };
    const pending = [];
    const { input, save, toasts, errors, getState } = await setup(() => new Promise(resolve => pending.push(resolve)), [card]);
    input.value = 'https://draft.example/proxy.pac';
    save.dispatchEvent(new Event('click'));
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    const latest = { currentPacProviderKey: 'none' };
    pending[1]({ success: true, data: latest });
    await new Promise(resolve => setImmediate(resolve));
    const toastCount = toasts.length;
    pending[0]({ success, data: { currentPacProviderKey: 'customPacUrl' }, error: 'cancelled' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getState(), latest);
    assert.equal(toasts.length, toastCount);
    assert.deepEqual(errors, []);
    assert.equal(save.disabled, false);
  });
});
