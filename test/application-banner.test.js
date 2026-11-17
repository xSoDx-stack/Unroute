import { expect } from 'chai';
import { renderApplicationBanner } from '../src/common/pages/shared/application-banner.js';

describe('Settings application feedback', () => {
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
