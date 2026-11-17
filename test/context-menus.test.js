'use strict';

import { expect } from 'chai';
import { setupContextMenus, createContextMenuItems } from '../src/common/core/context-menus.js';

describe('Cross-browser context menus', () => {
  let originalChrome;

  before(() => {
    originalChrome = globalThis.chrome;
  });

  after(() => {
    globalThis.chrome = originalChrome;
  });

  it('registers and handles clicks when Firefox omits Event.hasListeners()', () => {
    let listener = null;
    const openedTabs = [];
    let cleared = false;
    const createdMenus = [];
    globalThis.chrome = {
      runtime: { lastError: null },
      contextMenus: {
        removeAll: callback => { cleared = true; callback(); },
        create: (item, callback) => { expect(cleared).to.equal(true); createdMenus.push(item.id); callback(); },
        onClicked: {
          addListener: (callback) => {
            listener = callback;
          },
          hasListener: () => false,
        },
      },
      tabs: {
        create: (details) => openedTabs.push(details),
      },
    };

    expect(() => setupContextMenus()).not.to.throw();
    expect(listener).to.be.a('function');
    createContextMenuItems();
    expect(createdMenus).to.deep.equal(['google-translate']);
    listener({ menuItemId: 'docs-support' }, { url: 'https://example.com/path' });
    listener({ menuItemId: 'web-archive' }, { url: 'https://example.com/path' });
    listener({ menuItemId: 'rublacklist-check' }, { url: 'https://example.com/path' });
    expect(openedTabs).to.deep.equal([]);
    listener({ menuItemId: 'google-translate' }, { url: 'https://example.com/path' });
    expect(openedTabs).to.deep.equal([{
      url: 'https://translate.google.com/translate?hl=ru&sl=auto&tl=ru&anno=2&sandbox=1&u=https%3A%2F%2Fexample.com%2Fpath',
    }]);
  });

  it('does not register the same listener twice when hasListener is available', () => {
    let listener = null;
    let registrations = 0;
    globalThis.chrome = {
      contextMenus: {
        onClicked: {
          addListener: (callback) => {
            listener = callback;
            registrations += 1;
          },
          hasListener: (callback) => callback === listener,
        },
      },
      tabs: { create: () => {} },
    };

    setupContextMenus();
    setupContextMenus();
    expect(registrations).to.equal(1);
  });
});
