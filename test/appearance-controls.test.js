import { expect } from 'chai';

class Element {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.className = ''; this.dataset = {}; this.classList = { add: name => { this.className += ' ' + name; } }; }
  set innerHTML(_value) { throw Error('Unsafe HTML rendering'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  dispatch(name) { this.listeners[name]?.({ target: this }); }
  setCustomValidity(value) { this.validationMessage = value; }
}
function fixture() {
  const doc = { createElement: tag => new Element(tag, doc) };
  const container = doc.createElement('div');
  let state = { appearance: { theme: 'system', accent: 'mint', customColor: '#78c6b0' }, status: 'idle', errorKind: '', error: '' };
  let notify, updates = [], retries = 0;
  const controller = {
    getState: () => state,
    subscribe(fn) { notify = fn; fn(state); },
    update(patch) { updates.push(patch); state = { ...state, appearance: { ...state.appearance, ...patch }, status: 'saving' }; notify(state); },
    flush() { retries++; },
  };
  return { container, controller, updates, retries: () => retries,
    state(value) { state = { ...state, ...value }; notify(state); } };
}

describe('Appearance settings controls', () => {
  it('uses safe DOM, localized labels, accessible feedback and idempotent initialization', async () => {
    const { initAppearanceControls } = await import('../src/common/pages/shared/appearance-controls.js');
    const f = fixture();
    const c = initAppearanceControls(f.container, f.controller);
    expect(initAppearanceControls(f.container, f.controller)).equal(c);
    expect(c.theme.value).equal('system'); expect(c.presets.mint.getAttribute('aria-pressed')).equal('true');
    expect(c.status.getAttribute('aria-live')).equal('polite');
    expect(c.hex.getAttribute('aria-describedby')).include(c.validation.id);
    c.theme.value = 'dark'; c.theme.dispatch('change');
    c.presets.blue.dispatch('click');
    expect(c.theme.id).equal('appearanceTheme');
    expect(c.color.id).equal('appearanceColor'); expect(c.hex.id).equal('appearanceHex');
    for (const [name, button] of Object.entries(c.presets)) expect(button.getAttribute('data-accent')).equal(name);
    expect(f.updates).deep.equal([{ theme: 'dark' }, { accent: 'blue' }]);
    expect(c.status.textContent).not.equal('');
  });
  it('validates hex drafts without saving invalid input, and preserves custom on theme changes', async () => {
    const { initAppearanceControls } = await import('../src/common/pages/shared/appearance-controls.js');
    const f = fixture(); const c = initAppearanceControls(f.container, f.controller);
    c.presets.custom.dispatch('click');
    c.hex.value = '#12<svg>'; c.hex.dispatch('input');
    expect(c.hex.getAttribute('aria-invalid')).equal('true');
    expect(c.hex.validationMessage).not.equal('');
    expect(f.updates).length(1);
    c.hex.value = '#AbC'; c.hex.dispatch('input');
    expect(c.hex.getAttribute('aria-invalid')).equal('false');
    expect(f.updates[1]).deep.equal({ accent: 'custom', customColor: '#aabbcc' });
    c.theme.value = 'light'; c.theme.dispatch('change');
    expect(c.color.value).equal('#aabbcc');
    c.color.value = '#123456'; c.color.dispatch('input');
    expect(c.hex.value).equal('#123456');
    expect(f.updates.at(-1)).deep.equal({ accent: 'custom', customColor: '#123456' });
  });
  it('disables initial loading, shows genuine write/read failures and permits retry', async () => {
    const { initAppearanceControls } = await import('../src/common/pages/shared/appearance-controls.js');
    const f = fixture(); const c = initAppearanceControls(f.container, f.controller);
    f.state({ status: 'loading' }); expect(c.theme.disabled).equal(true);
    f.state({ status: 'error', errorKind: 'save', error: '<quota>' });
    expect(c.theme.disabled).equal(false); expect(c.status.textContent).include('<quota>');
    expect(c.retry.hidden).equal(false); c.retry.dispatch('click'); expect(f.retries()).equal(1);
    f.state({ status: 'saved', error: '' }); expect(c.retry.hidden).equal(true);
    f.state({ status: 'error', errorKind: 'load', error: 'read failed' });
    expect(c.status.textContent).include('read failed');
  });
});
