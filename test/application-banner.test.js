import { expect } from 'chai';
import { renderApplicationBanner } from '../src/common/pages/shared/application-banner.js';
import { sendMessage } from '../src/common/pages/shared/client.js';

describe('Settings application feedback', () => {
  it('restores the retry button when refresh rejects', async () => {
    const original = { document: globalThis.document, chrome: globalThis.chrome };
    globalThis.chrome = { runtime: { sendMessage: (_, reply) => reply({ success: true }) } };
    let click;
    globalThis.document = { createElement: () => ({ addEventListener: (_, fn) => { click = fn; } }) };
    const container = { replaceChildren() {}, append(_, button) { this.button = button; } };
    try {
      renderApplicationBanner(container, { pending: true }, async () => { throw new Error('Readback failed'); });
      const label = container.button.textContent;
      await click();
      expect(container.button.disabled).to.equal(false);
      expect(container.button.textContent).to.equal(label);
    } finally { Object.assign(globalThis, original); }
  });

  it('returns a failure response when the runtime transport throws synchronously', async () => {
    const original = globalThis.chrome;
    globalThis.chrome = { runtime: { sendMessage() { throw new Error('Context invalidated'); } } };
    try {
      expect(await sendMessage({ action: 'GET_STATE' })).to.deep.equal({ success: false, error: 'Context invalidated' });
    } finally { globalThis.chrome = original; }
  });
  it('hides transient in-progress state and keeps genuine pending failures visible', () => {
    const original = { document: globalThis.document, chrome: globalThis.chrome };
    globalThis.chrome = {};
    globalThis.document = { createElement: () => ({ addEventListener() {} }) };
    const container = { hidden: false, children: [], replaceChildren() { this.children = []; },
      append(...children) { this.children.push(...children); } };
    try {
      renderApplicationBanner(container, { pending: true, applying: true }, () => {});
      expect(container.hidden).to.equal(true);
      renderApplicationBanner(container, { pending: true, applying: false, error: 'Native apply failed' }, () => {});
      expect(container.hidden).to.equal(false);
      expect(container.children[0].textContent).to.include('Native apply failed');
      renderApplicationBanner(container, { pending: false, applying: false }, () => {});
      expect(container.hidden).to.equal(true);
    } finally {
      globalThis.document = original.document;
      globalThis.chrome = original.chrome;
    }
  });
});
