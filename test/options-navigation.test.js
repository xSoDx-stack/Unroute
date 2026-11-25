import assert from 'node:assert/strict';

async function setup() {
  const { initOptionsNavigation } = await import('../src/common/pages/options/navigation.js');
  const tabs = ['exceptions', 'logs', 'history'];
  const node = () => {
    const attributes = new Map();
    return Object.assign(new EventTarget(), {
      classList: { active: false, toggle(_name, active) { this.active = active; } },
      click() { this.dispatchEvent(new Event('click')); },
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: name => attributes.delete(name),
      getAttribute: name => attributes.get(name),
    });
  };
  const buttons = tabs.map(tab => Object.assign(node(), { dataset: { tab } }));
  const panels = tabs.map(tab => Object.assign(node(), { id: `tab-${tab}` }));
  const visited = [], hashes = [], pending = [];
  const navigation = initOptionsNavigation({
    querySelectorAll: selector => selector === '.nav-tab-btn' ? buttons : panels,
    defaultView: { history: { replaceState: (_state, _title, hash) => hashes.push(hash) } },
  }, {
    flushSites: () => new Promise(resolve => pending.push(resolve)),
    onActivate: tab => visited.push(tab),
  });
  return { navigation, buttons, panels, visited, hashes, pending };
}

describe('Settings navigation', () => {
  it('keeps the latest tab when multiple clicks wait on site drafts', async () => {
    const { navigation, buttons, panels, visited, hashes, pending } = await setup();
    navigation.open('logs');
    buttons[2].click();
    pending[1](true);
    await Promise.resolve();
    pending[0](true);
    await Promise.resolve();
    assert.equal(navigation.activeTab, 'history');
    assert.deepEqual(visited, ['history']);
    assert.deepEqual(hashes, ['#history']);
    assert.deepEqual(buttons.map(b => b.getAttribute('aria-current')), [undefined, undefined, 'page']);
    assert.deepEqual(panels.map(p => p.classList.active), [false, false, true]);
  });

  it('keeps Sites open on failed save and ignores a transition invalidated by reset', async () => {
    const { navigation, visited, hashes, pending } = await setup();
    navigation.open('logs');
    pending[0](false);
    await Promise.resolve();
    assert.equal(navigation.activeTab, 'exceptions');
    navigation.open('history');
    navigation.invalidate();
    pending[1](true);
    await Promise.resolve();
    assert.equal(navigation.activeTab, 'exceptions');
    assert.deepEqual(visited, []);
    assert.deepEqual(hashes, []);
  });

  it('restores a known hash and falls back to Sites for an unknown one', async () => {
    const { navigation, visited, hashes, pending } = await setup();
    navigation.restore('#history');
    pending[0](true);
    await Promise.resolve();
    navigation.restore('#unknown');
    assert.deepEqual(visited, ['history', 'exceptions']);
    assert.deepEqual(hashes, ['#history', '#exceptions']);
  });
});
