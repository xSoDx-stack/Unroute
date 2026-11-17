import assert from 'node:assert/strict';
import { copyText } from '../src/common/pages/options/logs-view.js';
import { createAppearanceController } from '../src/common/pages/shared/appearance.js';

describe('Compatibility fallback contracts', () => {
  let navigatorDescriptor, originalDocument;
  beforeEach(() => {
    navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    originalDocument = globalThis.document;
  });
  afterEach(() => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });

  it('prefers the standard Clipboard API when it is available', async () => {
    const copied = [];
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      clipboard: { writeText: async text => { copied.push(text); } },
    } });
    globalThis.document = { createElement: () => { throw new Error('Fallback must not run'); } };
    await copyText('clipboard content');
    assert.deepEqual(copied, ['clipboard content']);
  });

  it('keeps copy functional without Clipboard API and removes its temporary field', async () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    let selected = false, appended, removed;
    const field = { style: {}, setAttribute: () => {}, select: () => { selected = true; } };
    globalThis.document = {
      createElement: type => { assert.equal(type, 'textarea'); return field; },
      body: { appendChild: node => { appended = node; }, removeChild: node => { removed = node; } },
      execCommand: command => { assert.equal(command, 'copy'); assert.equal(selected, true); return true; },
    };
    await copyText('fallback content');
    assert.equal(field.value, 'fallback content');
    assert.equal(appended, field);
    assert.equal(removed, field);
  });

  it('prefers modern media events and uses the old listener only when necessary', async () => {
    const api = { runtime: {}, storage: { local: { get: (_keys, done) => done({}) },
      onChanged: { addListener: () => {} } } };
    let modern = 0, legacy = 0;
    const controller = createAppearanceController({ chrome: api, root: null, media: {
      matches: false,
      addEventListener: type => { assert.equal(type, 'change'); modern++; },
      addListener: () => { legacy++; },
    } });
    await controller.ready;
    assert.equal(modern, 1); assert.equal(legacy, 0);
    const fallback = createAppearanceController({ chrome: api, root: null,
      media: { matches: false, addListener: () => { legacy++; } } });
    await fallback.ready;
    assert.equal(legacy, 1);
  });
});
