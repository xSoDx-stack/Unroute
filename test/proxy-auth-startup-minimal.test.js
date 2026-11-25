import { expect } from 'chai';
import { appState } from '../src/common/core/app-state.js';
import { blockInformer } from '../src/common/core/block-informer.js';
import { errorHandlers } from '../src/common/core/error-handlers.js';
import { ipToHost } from '../src/common/core/ip-to-host.js';
import { logger } from '../src/common/core/logger.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { pacSync } from '../src/common/core/pac-sync.js';
import { proxyBackend } from '../src/common/core/proxy-backend.js';
import { resetProxyCredentialsState, clearProxyAuthAttempts } from '../src/common/core/proxy-auth.js';
import { siteResources } from '../src/common/core/site-resources.js';
import { storage } from '../src/common/core/storage.js';
import { tabProxyRouter } from '../src/common/core/tab-proxy-router.js';
import { toolbarBadge } from '../src/common/core/toolbar-badge.js';

const details = {
  isProxy: true, incognito: true, requestId: 'startup-auth', challenger: { host: 'proxy.test', port: 8080 },
};
const credentials = { authCredentials: { username: 'user', password: 'pass' } };

async function withWorker(test) {
  const originals = [];
  const stub = (object, key, value) => {
    originals.push([object, key, object[key]]);
    object[key] = value;
  };
  const calls = [];
  const freshEvent = () => ({ addListener() {} });
  let authListener, errorListener, storedAttempts, sessionError;
  const storedMods = { customProxyStringRaw: 'PROXY user:pass@proxy.test:8080' };
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { onMessage: freshEvent(), onInstalled: freshEvent(), onStartup: freshEvent() },
    alarms: { onAlarm: freshEvent() },
    webRequest: { onAuthRequired: { addListener: callback => { authListener = callback; } } },
    storage: { session: {
      get(key, callback) { calls.push('session:get'); callback({ [key]: storedAttempts }); },
      set(values, callback) {
        calls.push('session:set');
        chrome.runtime.lastError = sessionError;
        if (!sessionError) [storedAttempts] = Object.values(values);
        callback();
        delete chrome.runtime.lastError;
      },
      remove(key, callback) { storedAttempts = undefined; callback(); },
    } },
  };

  for (const [object, method] of [[blockInformer, 'init'], [siteResources, 'setup'],
    [tabProxyRouter, 'setup'], [toolbarBadge, 'setup'],
    [proxyBackend, 'addSettingsChangeListener']]) stub(object, method, () => {});
  stub(errorHandlers, '_listenersRegistered', false);
  stub(errorHandlers, 'handleProxyError', () => { calls.push('proxyError'); });
  stub(proxyBackend, 'addErrorListener', callback => { errorListener = callback; });
  for (const [object, method, name] of [[logger, 'init', 'logger'], [ipToHost, 'init', 'ipToHost'],
    [errorHandlers, 'init', 'errors'], [pacSync, 'init', 'pacSync']]) {
    stub(object, method, async () => { calls.push(name); });
  }
  stub(storage, 'restrictLocalAccess', async () => { calls.push('restrict'); });
  stub(storage, 'get', async key => { calls.push(key); return storedMods; });
  stub(storage, 'set', async key => { calls.push(`write:${key}`); });
  const getPacMods = pacKitchen.getPacMods;
  stub(pacKitchen, 'getPacMods', (...args) => { calls.push('compiledMods'); return getPacMods(...args); });

  appState.reset();
  pacKitchen.invalidateCache();
  try {
    await import(`../src/common/service-worker.js?minimal-auth=${Math.random()}`);
    await test({ calls, stub, reportError: () => errorListener({ error: 'test' }),
      challenge: (overrides = {}) => new Promise(resolve => authListener({ ...details, ...overrides }, resolve)),
      failSessionWrite: () => { sessionError = { message: 'cannot persist attempt' }; } });
  } finally {
    await appState.settlePendingInitialization();
    appState.reset();
    pacKitchen.invalidateCache();
    resetProxyCredentialsState();
    await clearProxyAuthAttempts();
    for (const [object, key, original] of originals.reverse()) object[key] = original;
    globalThis.chrome = previousChrome;
  }
}

describe('Service worker proxy authentication on cold start', () => {
  it('restores canonical credentials without warming unrelated state and persists the retry before responding', async () => {
    await withWorker(async ({ calls, challenge }) => {
      expect(await challenge()).to.deep.equal(credentials);
      expect(calls).to.deep.equal(['restrict', 'pac-kitchen-mods', 'write:pac-kitchen-mods', 'session:get', 'session:set']);
      expect(appState.isRequestStateInitialized).to.equal(false);
    });
  });

  it('does not send credentials if session storage rejects the retry write', async () => {
    await withWorker(async ({ calls, challenge, failSessionWrite }) => {
      failSessionWrite();
      expect(await challenge()).to.deep.equal({ cancel: true });
      expect(calls.slice(-2)).to.deep.equal(['session:get', 'session:set']);
    });
  });

  it('shares cold settings restoration and caps concurrent challenges for one request', async () => {
    await withWorker(async ({ calls, challenge }) => {
      expect(await Promise.all(Array.from({ length: 4 }, () => challenge()))).to.deep.equal([
        credentials, credentials, credentials, { cancel: true },
      ]);
      expect(calls.filter(call => call === 'pac-kitchen-mods')).to.have.length(1);
      expect(calls.filter(call => call === 'session:set')).to.have.length(3);
    });
  });

  it('retries after a transient cold settings read failure', async () => {
    await withWorker(async ({ stub, challenge }) => {
      const get = storage.get;
      let fail = true;
      stub(storage, 'get', async key => {
        if (fail) { fail = false; throw new Error('temporary local storage failure'); }
        return get(key);
      });
      expect(await challenge()).to.deep.equal({ cancel: true });
      expect(await challenge()).to.deep.equal(credentials);
    });
  });

  it('authenticates without waiting for existing logs to load', async () => {
    await withWorker(async ({ calls, stub, challenge }) => {
      let resume;
      const pending = new Promise(resolve => { resume = resolve; });
      stub(logger, 'init', () => pending);
      stub(logger, 'info', () => { calls.push('authLog'); });
      try {
        expect(await challenge({ incognito: false })).to.deep.equal(credentials);
        expect(calls).not.to.include('authLog');
      } finally { resume(); }
      await appState.settlePendingInitialization();
      expect(calls).to.include('authLog');
    });
  });

  it('restores diagnostics before processing a cold proxy error', async () => {
    await withWorker(async ({ calls, reportError }) => {
      await reportError();
      expect(calls).to.deep.equal(['restrict', 'logger', 'errors', 'proxyError']);
    });
  });
});
