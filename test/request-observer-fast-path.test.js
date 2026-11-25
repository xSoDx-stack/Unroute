import assert from 'node:assert/strict';
import { appState } from '../src/common/core/app-state.js';
import { blockInformer } from '../src/common/core/block-informer.js';
import { SiteResources } from '../src/common/core/site-resources.js';

const HTTP = ['http://*/*', 'https://*/*'];

describe('Request observers', () => {
  it('filters diagnostics to HTTP(S) but keeps WebSocket resource discovery', () => {
    const originalChrome = global.chrome;
    const listeners = {};
    const event = name => ({ addListener(_listener, filter) { listeners[name] = filter; } });
    const siteResources = new SiteResources();
    siteResources.init = async () => {};
    const informer = new blockInformer.constructor();
    try {
      global.chrome = { webRequest: {
        onBeforeRequest: event('resources'), onResponseStarted: event('response'), onErrorOccurred: event('error'),
      } };
      siteResources.setup();
      informer.init();
      assert.deepEqual(listeners.response.urls, HTTP);
      assert.deepEqual(listeners.error.urls, HTTP);
      assert.deepEqual(listeners.resources.urls, [...HTTP, 'ws://*/*', 'wss://*/*']);
    } finally {
      if (originalChrome === undefined) delete global.chrome;
      else global.chrome = originalChrome;
    }
  });

  it('counts a subresource with browser-provided proxy info without waiting for request state', async () => {
    const informer = new blockInformer.constructor();
    const wasInitialized = appState.isRequestStateInitialized;
    const originalEnsure = appState.ensureRequestStateInitialized;
    const originalRouting = appState.ensureRoutingStateInitialized;
    let calls = 0;
    try {
      appState.isRequestStateInitialized = false;
      appState.ensureRequestStateInitialized = async () => { assert.fail('Diagnostics must not hydrate unrelated state'); };
      appState.ensureRoutingStateInitialized = async () => { calls++; };
      await informer.handleRequest({
        tabId: 1, type: 'image', url: 'https://cdn.example/image',
        proxyInfo: { type: 'https', host: 'proxy.example', port: 443 },
      });
      assert.deepEqual(informer.getTabStats(1), {
        count: 1, hosts: ['cdn.example'], proxies: ['proxy.example:443'],
      });
      assert.equal(calls, 0);
      await informer.handleRequest({ tabId: 1, type: 'image', url: 'https://other.example/image', ip: '195.201.201.32' });
      assert.equal(calls, 1, 'Chromium inference must still be able to use restored state');
    } finally {
      appState.isRequestStateInitialized = wasInitialized;
      appState.ensureRequestStateInitialized = originalEnsure;
      appState.ensureRoutingStateInitialized = originalRouting;
    }
  });
});
