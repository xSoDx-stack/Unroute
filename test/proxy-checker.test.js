'use strict';

import { expect } from 'chai';
import vm from 'vm';
import { generateHealthCheckPac } from '../src/common/core/proxy-checker.js';

describe('Proxy Health Check PAC Wrapper (generateHealthCheckPac)', () => {
  const originalPacScript = `
function FindProxyForURL(url, host) {
  if (host === 'normal.example' || host.endsWith('.normal.example')) {
    return 'PROXY original.example:8080';
  }
  if (host === 'blocked.example') {
    return 'HTTPS antizapret.example:443';
  }
  return 'DIRECT';
}
`;

  const testProxyScheme = 'HTTPS testproxy.example:443';

  it('should route probe endpoints to TEST_PROXY and normal traffic to ORIGINAL_PROXY without recursion', () => {
    const layeredPac = generateHealthCheckPac(originalPacScript, testProxyScheme);

    // Evaluate in fresh V8 VM sandbox simulating Chromium PAC environment
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(layeredPac, sandbox);

    expect(sandbox.FindProxyForURL).to.be.a('function');

    // 1. Probe endpoints must route via candidate test proxy
    expect(sandbox.FindProxyForURL('https://1.1.1.1/cdn-cgi/trace', '1.1.1.1')).to.equal(testProxyScheme);
    expect(sandbox.FindProxyForURL('https://cloudflare.com/', 'cloudflare.com')).to.equal('DIRECT');
    expect(sandbox.FindProxyForURL('https://cp.cloudflare.com/generate_204', 'cp.cloudflare.com')).to.equal('DIRECT');
    expect(sandbox.FindProxyForURL('https://connectivitycheck.gstatic.com/generate_204', 'connectivitycheck.gstatic.com')).to.equal('DIRECT');
    expect(sandbox.FindProxyForURL('https://dns.google/resolve', 'dns.google')).to.equal('DIRECT');

    // 2. Normal traffic MUST be routed through the original PAC without DIRECT leakage
    expect(sandbox.FindProxyForURL('http://normal.example/path', 'normal.example')).to.equal('PROXY original.example:8080');
    expect(sandbox.FindProxyForURL('https://sub.normal.example/', 'sub.normal.example')).to.equal('PROXY original.example:8080');
    expect(sandbox.FindProxyForURL('https://blocked.example/video', 'blocked.example')).to.equal('HTTPS antizapret.example:443');

    // 3. Unproxied general traffic still returns DIRECT from original PAC
    expect(sandbox.FindProxyForURL('https://random-site.com/', 'random-site.com')).to.equal('DIRECT');
  });

  it('should not throw recursion or stack overflow on repeated and parallel calls', () => {
    const layeredPac = generateHealthCheckPac(originalPacScript, testProxyScheme);

    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(layeredPac, sandbox);

    // 1,000 rapid calls to verify call stack integrity
    for (let i = 0; i < 1000; i++) {
      const probeRes = sandbox.FindProxyForURL('https://1.1.1.1/cdn-cgi/trace', '1.1.1.1');
      const normalRes = sandbox.FindProxyForURL('http://normal.example/', 'normal.example');
      expect(probeRes).to.equal(testProxyScheme);
      expect(normalRes).to.equal('PROXY original.example:8080');
    }
  });

  it('should handle empty or fallback base PAC gracefully', () => {
    const layeredPac = generateHealthCheckPac('', testProxyScheme);

    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(layeredPac, sandbox);

    expect(sandbox.FindProxyForURL('https://1.1.1.1/', '1.1.1.1')).to.equal(testProxyScheme);
    expect(sandbox.FindProxyForURL('https://example.com/', 'example.com')).to.equal('DIRECT');
  });
});

describe('Proxy Health Check: Concurrency & State Race Protection (P1-1)', () => {
  let appliedProxyConfigs = [];
  let originalFetch;

  before(() => {
    originalFetch = globalThis.fetch;
    if (!globalThis.chrome) globalThis.chrome = {};
    if (!globalThis.chrome.runtime) globalThis.chrome.runtime = { lastError: null };
    if (!globalThis.chrome.storage) {
      globalThis.chrome.storage = {
        local: {
          get: (k, cb) => cb({}),
          set: (i, cb) => cb && cb(),
          remove: (k, cb) => cb && cb(),
        },
      };
    }
    globalThis.chrome.proxy = {
      settings: {
        set: (opts, cb) => {
          appliedProxyConfigs.push(opts.value);
          if (cb) cb();
        },
        clear: (opts, cb) => {
          appliedProxyConfigs.push({ mode: 'direct' });
          if (cb) cb();
        },
        get: (opts, cb) => {
          cb && cb({ levelOfControl: 'controlled_by_this_extension' });
        },
      },
    };
    globalThis.chrome.action = {
      setIcon: () => {},
      setTitle: () => {},
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    appliedProxyConfigs = [];
  });

  it('should not overwrite newer PAC configuration if provider changed during health check', async () => {
    const { pacSync } = await import('../src/common/core/pac-sync.js');
    const { checkProxyHealth } = await import('../src/common/core/proxy-checker.js');

    // 1. Initial state: Antizapret
    pacSync.resetRuntimeState();
    pacSync.currentPacProviderKey = 'Антизапрет';
    pacSync.cookedPacData = 'function FindProxyForURL(url, host) { return "PROXY antizapret:443"; }';
    pacSync.rawPacData = pacSync.cookedPacData;
    pacSync.revision = 1;

    // 2. Mock fetch: during probe fetch, user changes provider to Anticensority
    let providerSwitch;
    globalThis.fetch = async () => {
      // A real provider switch uses the same global proxy-settings lock.
      pacSync.currentPacProviderKey = 'Антицензорити';
      providerSwitch = pacSync.applyPacData(
        'function FindProxyForURL(url, host) { return "PROXY anticensority:443"; }'
      );

      return { status: 200 };
    };

    // 3. Run health check
    const res = await checkProxyHealth('HTTP 1.2.3.4:8080');
    await providerSwitch;
    expect(res.ok).to.be.true;

    // 4. Verify that final applied config is Anticensority and NOT the old Antizapret or probe PAC
    const lastConfig = appliedProxyConfigs[appliedProxyConfigs.length - 1];
    expect(lastConfig.pacScript.data).to.include('anticensority:443');
    expect(lastConfig.pacScript.data).to.not.include('1.2.3.4:8080');
    expect(pacSync.currentPacProviderKey).to.equal('Антицензорити');
  });

  it('serializes concurrent health checks through the real probe queue', async () => {
    const { checkProxyHealth } = await import('../src/common/core/proxy-checker.js');
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { status: 200 };
    };
    const results = await Promise.all([
      checkProxyHealth('HTTPS valid-1.example:443'),
      checkProxyHealth('SOCKS5 127.0.0.1:9050'),
    ]);
    expect(results.every(result => result.ok)).to.be.true;
    expect(maxActive).to.equal(1);
  });

  it('cancels active and queued probes on reset, restores native state, and removes temporary credentials', async () => {
    const { checkProxyHealth, cancelProxyChecks } = await import('../src/common/core/proxy-checker.js');
    const { getTemporaryCredentialsMap } = await import('../src/common/core/proxy-auth.js');
    const { pacSync } = await import('../src/common/core/pac-sync.js');
    const previousConfig = { mode: 'pac_script', pacScript: {
      data: 'function FindProxyForURL(){return "HTTPS previous.example:443";}', mandatory: true,
    } };
    const originalGet = chrome.proxy.settings.get;
    chrome.proxy.settings.get = (_options, callback) => callback({
      levelOfControl: 'controlled_by_this_extension', value: previousConfig,
    });
    try {
      let started;
      let fetches = 0;
      const ready = new Promise(resolve => { started = resolve; });
      globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
        fetches++;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        started();
      });
      const first = checkProxyHealth('HTTPS user:secret@active.test:443').catch(error => error);
      await ready;
      const queued = checkProxyHealth('HTTPS other:secret@queued.test:443').catch(error => error);
      cancelProxyChecks();
      expect(await first).to.be.an('error').with.property('message', 'Проверка прокси отменена сбросом настроек');
      expect(await queued).to.be.an('error');
      expect(fetches).to.equal(1);
      expect(getTemporaryCredentialsMap()).to.deep.equal({});
      expect(appliedProxyConfigs[appliedProxyConfigs.length - 1]).to.deep.equal(previousConfig);
      await pacSync.clearPac({ persist: false });
      expect(appliedProxyConfigs[appliedProxyConfigs.length - 1]).to.deep.equal({ mode: 'direct' });
    } finally { chrome.proxy.settings.get = originalGet; }
  });

  it('should reject an unknown proxy protocol without throwing', async () => {
    const { checkProxyHealth } = await import('../src/common/core/proxy-checker.js');
    const result = await checkProxyHealth('BANANA proxy.example:1234');

    expect(result).to.deep.equal({ ok: false, error: 'Не указан хост или порт' });
  });

  it('rejects SOCKS authentication with an actionable explanation', async () => {
    const { checkProxyHealth } = await import('../src/common/core/proxy-checker.js');
    const { getTemporaryCredentialsMap } = await import('../src/common/core/proxy-auth.js');
    const result = await checkProxyHealth('SOCKS5 user:password@socks.example:1080');

    expect(result.ok).to.equal(false);
    expect(result.error).to.include('не поддерживает авторизацию');
    expect(getTemporaryCredentialsMap()).to.deep.equal({});
  });

  it('cleans temporary credentials when a preflight operation fails', async () => {
    const { checkProxyHealth } = await import('../src/common/core/proxy-checker.js');
    const { pacKitchen } = await import('../src/common/core/pac-kitchen.js');
    const { getTemporaryCredentialsMap } = await import('../src/common/core/proxy-auth.js');
    const originalGetPacMods = pacKitchen.getPacMods;
    pacKitchen.getPacMods = async () => {
      throw new Error('preflight failed');
    };

    try {
      let error;
      try {
        await checkProxyHealth('HTTPS user:password@proxy.example:443');
      } catch (err) {
        error = err;
      }
      expect(error).to.be.an('error').with.property('message', 'preflight failed');
      expect(getTemporaryCredentialsMap()).to.deep.equal({});
    } finally {
      pacKitchen.getPacMods = originalGetPacMods;
    }
  });
});

