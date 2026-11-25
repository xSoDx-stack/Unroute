import assert from 'node:assert/strict';

async function setup(response) {
  const { bindDiagnosticsPanel } = await import('../src/common/pages/options/diagnostics-panel.js');
  const element = () => Object.assign(new EventTarget(), {
    style: {}, children: [], appendChild(child) { this.children.push(child); },
  });
  const elements = Object.fromEntries(['testConnBtn', 'connResult', 'viewPacScriptBtn', 'pacScriptModal',
    'pacScriptContent', 'closePacModalBtn'].map(id => [id, element()]));
  Object.assign(elements.pacScriptModal, { open: false, showModal() { this.open = true; }, close() { this.open = false; } });
  const calls = [];
  bindDiagnosticsPanel({ getElementById: id => elements[id], createElement: element }, {
    request: async message => { calls.push(message); return response; },
  });
  return { ...elements, calls };
}

const click = element => element.dispatchEvent(new Event('click'));

describe('Settings diagnostics panel', () => {
  it('shows the connection latency and re-enables the button', async () => {
    const { testConnBtn, connResult, calls } = await setup({ success: true, latency: 42 });
    click(testConnBtn);
    assert.equal(testConnBtn.disabled, true);
    await Promise.resolve();
    assert.deepEqual(calls, [{ action: 'TEST_CONNECTION' }]);
    assert.equal(testConnBtn.disabled, false);
    assert.equal(connResult.children[0].style.color, 'var(--success)');
    assert.match(connResult.children[0].textContent, /42/);
  });

  it('renders PAC preview as text and closes the dialog', async () => {
    const script = '// fixture <tag>';
    const { viewPacScriptBtn, pacScriptModal, pacScriptContent, closePacModalBtn, calls } = await setup({
      success: true, data: { scriptKind: 'preview', cookedPacData: script },
    });
    click(viewPacScriptBtn);
    await Promise.resolve();
    assert.deepEqual(calls, [{ action: 'GET_PAC_SCRIPT' }]);
    assert.equal(pacScriptModal.open, true);
    assert.match(pacScriptContent.textContent, /^\/\/ .+\n/);
    assert.ok(pacScriptContent.textContent.endsWith(script));
    click(closePacModalBtn);
    assert.equal(pacScriptModal.open, false);
  });

  it('does not reopen the dialog on a stale PAC response', async () => {
    const { viewPacScriptBtn, pacScriptModal, pacScriptContent } = await setup({
      success: true, stale: true, data: { cookedPacData: '// outdated' },
    });
    click(viewPacScriptBtn);
    await Promise.resolve();
    assert.equal(pacScriptContent.textContent, undefined);
    assert.equal(pacScriptModal.open, false);
  });
});
