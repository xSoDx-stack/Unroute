'use strict';

import { expect } from 'chai';

describe('Proxy Authentication: durable MV3 retry state', () => {
  let sessionStorage;
  let previousChrome;

  beforeEach(() => {
    previousChrome = globalThis.chrome;
    sessionStorage = {};
    globalThis.chrome = {
      runtime: { lastError: null },
      storage: {
        session: {
          get: (key, cb) => cb({ [key]: sessionStorage[key] }),
          set: (items, cb) => {
            Object.assign(sessionStorage, items);
            if (cb) cb();
          },
          remove: (keys, cb) => {
            const keyList = Array.isArray(keys) ? keys : [keys];
            keyList.forEach((key) => delete sessionStorage[key]);
            if (cb) cb();
          },
        },
      },
    };
  });

  afterEach(() => {
    globalThis.chrome = previousChrome;
  });

  it('keeps the retry limit after the service-worker module is recreated', async () => {
    const firstWorker = await import(`../src/common/core/proxy-auth.js?worker=first-${Date.now()}`);

    expect((await firstWorker.consumeProxyAuthAttempt('request-42', 1000)).allowed).to.be.true;
    expect((await firstWorker.consumeProxyAuthAttempt('request-42', 2000)).allowed).to.be.true;
    expect((await firstWorker.consumeProxyAuthAttempt('request-42', 3000)).allowed).to.be.true;

    // A query suffix creates a fresh module instance, modelling a new MV3
    // service worker while chrome.storage.session remains intact.
    const secondWorker = await import(`../src/common/core/proxy-auth.js?worker=second-${Date.now()}`);
    const fourthAttempt = await secondWorker.consumeProxyAuthAttempt('request-42', 4000);

    expect(fourthAttempt).to.deep.equal({ allowed: false, tries: 3 });
    expect(JSON.stringify(sessionStorage)).to.not.include('hostname');
    expect(JSON.stringify(sessionStorage)).to.not.include('password');
  });

  it('expires stale attempts and allows retry after the TTL', async () => {
    const auth = await import('../src/common/core/proxy-auth.js');
    await auth.clearProxyAuthAttempts();

    await auth.consumeProxyAuthAttempt('expiring-request', 1000);
    await auth.consumeProxyAuthAttempt('expiring-request', 2000);
    await auth.consumeProxyAuthAttempt('expiring-request', 3000);

    const afterTtl = await auth.consumeProxyAuthAttempt('expiring-request', 64_000);
    expect(afterTtl).to.deep.equal({ allowed: true, tries: 1 });
  });

  it('keeps the session retry budget for active requests at capacity', async () => {
    const auth = await import('../src/common/core/proxy-auth.js');
    for (let i = 0; i < 500; i++) await auth.consumeProxyAuthAttempt(`active-${i}`, 1000 + i);
    expect(await auth.consumeProxyAuthAttempt('new-request', 2000)).to.deep.equal({ allowed: false, tries: 0 });
    expect(await auth.consumeProxyAuthAttempt('active-0', 2000)).to.deep.equal({ allowed: true, tries: 2 });
  });

  it('clears attempts when credentials are changed', async () => {
    const auth = await import('../src/common/core/proxy-auth.js');
    await auth.consumeProxyAuthAttempt('credential-change-request', 1000);
    await auth.consumeProxyAuthAttempt('credential-change-request', 2000);
    await auth.consumeProxyAuthAttempt('credential-change-request', 3000);

    await auth.updateProxyCredentialsFromRaw('HTTPS user:new-password@proxy.example:443');
    const afterChange = await auth.consumeProxyAuthAttempt('credential-change-request', 4000);

    expect(afterChange).to.deep.equal({ allowed: true, tries: 1 });
  });

  it('matches both IPv6 hostname forms while keeping the port scoped', async () => {
    const auth = await import('../src/common/core/proxy-auth.js');
    auth.registerTemporaryCredentials('[2001:db8::1]', 8443, 'fixture', 'dummy');
    try {
      expect(auth.findCredentials('2001:db8::1', 8443)?.username).to.equal('fixture');
      expect(auth.findCredentials('[2001:db8::1]', 8443)?.username).to.equal('fixture');
      expect(auth.findCredentials('2001:db8::1', 9443)).to.equal(null);
    } finally { auth.unregisterTemporaryCredentials('2001:db8::1', 8443); }
    expect(auth.findCredentials('[2001:db8::1]', 8443)).to.equal(null);
  });
});
