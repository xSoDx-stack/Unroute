'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { verifySiteResources } from './site-resources-scenario.js';

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(TEST_ROOT, '..', '..', 'build', 'extension-chromium');
const SERVICE_WORKER_PATH = '/service-worker.js';
const TIMEOUT_MS = 20_000;

function resolveChromeExecutable() {
  const override = String(process.env.CHROME_BIN || '').trim();
  const candidates = override ? [override] : process.platform === 'win32' ? [
    process.env.PROGRAMFILES && path.join(
      process.env.PROGRAMFILES,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    process.env['PROGRAMFILES(X86)'] && path.join(
      process.env['PROGRAMFILES(X86)'],
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    process.env.LOCALAPPDATA && path.join(
      process.env.LOCALAPPDATA,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ] : [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];

  const executable = candidates
    .filter(Boolean)
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  assert.ok(executable, 'Google Chrome Stable не найден. Укажите CHROME_BIN.');
  return executable;
}

function assertBuiltExtension() {
  const manifestPath = path.join(EXTENSION_ROOT, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), `Сначала соберите расширение: ${EXTENSION_ROOT}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background && manifest.background.service_worker, 'service-worker.js');
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  });
}

function createBarrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function withTimeout(promise, message, timeoutMs = TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function createRequestBurstServer() {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    request.resume();
    if (request.url === '/') {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
      });
      response.end('<!doctype html><title>AntiCheburnet request stress</title>');
      return;
    }
    response.writeHead(204, {
      'Cache-Control': 'no-store',
      'Connection': 'close',
    });
    response.end();
  });
  const port = await listen(server, '127.0.0.2');
  return {
    get requests() { return requests; },
    port,
    server,
  };
}

async function createAuthenticatedProxy(username, password) {
  const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const requests = [];
  const marker = 'anticheburnet-browser-auth-ok';
  const server = http.createServer((request, response) => {
    const authorization = request.headers['proxy-authorization'] || null;
    requests.push({ authorization, url: request.url });
    request.resume();
    if (authorization !== expectedAuthorization) {
      response.writeHead(407, {
        'Connection': 'close',
        'Content-Length': '0',
        'Proxy-Authenticate': 'Basic realm="anticheburnet-smoke"',
      });
      response.end();
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Connection': 'close',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end(marker);
  });
  return { marker, port: await listen(server), requests, server };
}

async function createInterruptedWrongAuthProxy() {
  const requests = [];
  const firstCredential = createBarrier();
  const releaseChallenge = createBarrier();
  let ifFirstCredential = true;
  const challenge = (response) => {
    if (response.destroyed || response.headersSent) return;
    response.writeHead(407, {
      'Connection': 'close',
      'Content-Length': '0',
      'Proxy-Authenticate': 'Basic realm="anticheburnet-worker-restart"',
    });
    response.end();
  };
  const server = http.createServer((request, response) => {
    const authorization = request.headers['proxy-authorization'] || null;
    requests.push({ authorization, url: request.url });
    request.resume();
    if (authorization && ifFirstCredential) {
      ifFirstCredential = false;
      firstCredential.release();
      releaseChallenge.promise.then(() => challenge(response));
      return;
    }
    challenge(response);
  });
  return {
    firstCredential: firstCredential.promise,
    port: await listen(server),
    releaseChallenge: releaseChallenge.release,
    requests,
    server,
  };
}

async function launchChrome(executablePath, profilePath) {
  return puppeteer.launch({
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-gpu',
      '--disable-sync',
      '--host-resolver-rules=MAP *.example.test 127.0.0.1, MAP *.cdn.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE 127.0.0.2, EXCLUDE localhost',
      '--metrics-recording-only',
      '--no-default-browser-check',
      '--no-first-run',
    ],
    enableExtensions: true,
    executablePath,
    headless: true,
    userDataDir: profilePath,
  });
}

async function installAndGetWorker(browser, extensionRoot = EXTENSION_ROOT) {
  console.log(`Installing unpacked extension from ${path.basename(extensionRoot)}...`);
  const extensionId = await browser.installExtension(extensionRoot);
  console.log(`Installed extension ${extensionId}; waiting for service worker...`);
  const workerUrl = `chrome-extension://${extensionId}${SERVICE_WORKER_PATH}`;
  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === 'service_worker' && candidate.url() === workerUrl,
    { timeout: TIMEOUT_MS }
  );
  const worker = await target.worker();
  assert.ok(worker, 'Не удалось подключиться к service worker расширения.');
  return { extensionId, worker };
}

async function seedOfflineProvider(worker) {
  await worker.evaluate(() => new Promise((resolve, reject) => {
    chrome.storage.local.set({
      antiCensorRu: {
        currentPacProviderKey: 'onlyOwnSites',
        customPacUrl: '',
        lastPacUpdateStamp: 0,
        providerUpdateStamps: {},
        rawPacData: '',
      },
    }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  }));
}

async function openExtensionPage(browser, extensionId) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/pages/options/index.html`, {
    timeout: TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  return page;
}

async function sendMessage(page, message) {
  return page.evaluate((payload) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  }), message);
}

async function readProxySettings(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    chrome.proxy.settings.get({}, (details) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(details);
    });
  }));
}

async function stopExtensionWorker(browser, observerPage, extensionId) {
  const scriptUrl = `chrome-extension://${extensionId}${SERVICE_WORKER_PATH}`;
  const workerTarget = browser.targets().find((target) =>
    target.type() === 'service_worker' && target.url() === scriptUrl
  );
  assert.ok(workerTarget, 'Service worker target для принудительной остановки не найден.');

  const protocol = await observerPage.createCDPSession();
  const targetInfos = await protocol.send('Target.getTargets');
  const workerTargetInfo = targetInfos.targetInfos.find((targetInfo) =>
    targetInfo.type === 'service_worker' && targetInfo.url === scriptUrl
  );
  assert.ok(workerTargetInfo, 'CDP target service worker не найден.');

  const runningVersion = createBarrier();
  const stoppedVersion = createBarrier();
  let versionId = null;
  const observeVersions = (event) => {
    for (const version of event.versions || []) {
      if (version.scriptURL !== scriptUrl) continue;
      if (version.targetId === workerTargetInfo.targetId && version.runningStatus === 'running') {
        runningVersion.release(version);
      }
      if (versionId && version.versionId === versionId && version.runningStatus === 'stopped') {
        stoppedVersion.release(version);
      }
    }
  };
  protocol.on('ServiceWorker.workerVersionUpdated', observeVersions);

  try {
    await protocol.send('ServiceWorker.enable');
    const running = await withTimeout(
      runningVersion.promise,
      'CDP не сообщил о запущенной версии service worker.'
    );
    versionId = running.versionId;

    const attachedWorker = await workerTarget.worker();
    assert.ok(attachedWorker && attachedWorker.client, 'CDP-сессия service worker недоступна.');
    await attachedWorker.client.detach();
    await protocol.send('ServiceWorker.stopWorker', { versionId });
    await withTimeout(
      stoppedVersion.promise,
      'Service worker не подтвердил остановку.'
    );
  } finally {
    protocol.off('ServiceWorker.workerVersionUpdated', observeVersions);
    await protocol.detach().catch(() => undefined);
  }
}

function createProxyOwnerHelper() {
  const helperRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'anticheburnet-owner-'));
  fs.writeFileSync(path.join(helperRoot, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'AntiCheburnet proxy owner smoke helper',
    version: '1.0.0',
    permissions: ['proxy'],
    background: { service_worker: 'service-worker.js' },
  }), 'utf8');
  fs.writeFileSync(path.join(helperRoot, 'service-worker.js'), "'use strict';\n", 'utf8');
  return helperRoot;
}

function removeTemporaryDirectory(directory, prefix) {
  if (!directory) return;
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith(prefix));
  fs.rmSync(resolved, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
}

async function runChromeSmoke() {
  assertBuiltExtension();
  const chromeExecutable = resolveChromeExecutable();
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'anticheburnet-chrome-'));
  const helperRoot = createProxyOwnerHelper();
  const username = 'browser-smoke-user';
  const password = `browser-smoke-${Date.now()}`;
  const authProxy = await createAuthenticatedProxy(username, password);
  const wrongAuthProxy = await createInterruptedWrongAuthProxy();
  const requestBurst = await createRequestBurstServer();
  let browser = null;

  try {
    // Seed an offline provider, then restart Chrome. This prevents the default
    // provider download from making the smoke test depend on external network.
    console.log('Launching Chrome for offline state seed...');
    browser = await launchChrome(chromeExecutable, profilePath);
    const firstSession = await installAndGetWorker(browser);
    await seedOfflineProvider(firstSession.worker);
    console.log('Offline provider seeded; restarting Chrome...');
    await browser.close();

    browser = await launchChrome(chromeExecutable, profilePath);
    const session = await installAndGetWorker(browser);
    assert.equal(session.extensionId, firstSession.extensionId);
    const optionsPage = await openExtensionPage(browser, session.extensionId);

    const initialState = await sendMessage(optionsPage, { action: 'GET_STATE' });
    assert.equal(initialState && initialState.success, true);
    assert.equal(initialState.data.syncState.currentPacProviderKey, 'onlyOwnSites');
    assert.equal(initialState.data.syncState.hasPacData, true);

    // Regression coverage for a large user-maintained domain list. The
    // request observer must perform direct key lookups rather than enumerate
    // the full collection for every browser request.
    const largeExceptions = { '127.0.0.2': false };
    for (let i = 0; i < 33000; i++) {
      largeExceptions[`domain-${i}.example.com`] = true;
    }
    const largeRulesResult = await sendMessage(optionsPage, {
      action: 'SAVE_MODS',
      mods: { exceptions: largeExceptions },
    });
    assert.equal(largeRulesResult && largeRulesResult.success, true);

    await session.worker.evaluate(() => {
      const originalObjectKeys = Object.keys;
      const originalHasOwnProperty = Object.prototype.hasOwnProperty;
      globalThis.__blockInformerPerf = {
        largeEnumerations: 0,
        largeEnumerationStacks: [],
        requestPathLargeEnumerations: 0,
        matchChecks: 0,
        originalHasOwnProperty,
        originalObjectKeys,
      };
      Object.keys = function(value) {
        const result = originalObjectKeys(value);
        if (result.length > 10000) {
          const stack = new Error().stack;
          globalThis.__blockInformerPerf.largeEnumerations++;
          if (globalThis.__blockInformerPerf.largeEnumerationStacks.length < 5) {
            globalThis.__blockInformerPerf.largeEnumerationStacks.push(stack);
          }
          if (stack.includes('/core/block-informer.js')) {
            globalThis.__blockInformerPerf.requestPathLargeEnumerations++;
          }
        }
        return result;
      };
      Object.prototype.hasOwnProperty = function(key) {
        if (key === '127.0.0.2') {
          globalThis.__blockInformerPerf.matchChecks++;
        }
        return originalHasOwnProperty.call(this, key);
      };
    });

    const stressPage = await browser.newPage();
    await stressPage.goto(`http://127.0.0.2:${requestBurst.port}/`, {
      timeout: TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });
    const stressRequestCount = 2000;
    await stressPage.evaluate(async (count) => {
      const batchSize = 100;
      for (let offset = 0; offset < count; offset += batchSize) {
        await Promise.all(Array.from(
          { length: Math.min(batchSize, count - offset) },
          (_, index) => fetch(`/resource-${offset + index}?nonce=${Math.random()}`, {
            cache: 'no-store',
          })
        ));
      }
    }, stressRequestCount);
    await stressPage.close();

    const observerDeadline = Date.now() + TIMEOUT_MS;
    let observerStats = null;
    do {
      observerStats = await session.worker.evaluate(() => ({
        largeEnumerations: globalThis.__blockInformerPerf.largeEnumerations,
        largeEnumerationStacks: globalThis.__blockInformerPerf.largeEnumerationStacks,
        requestPathLargeEnumerations:
          globalThis.__blockInformerPerf.requestPathLargeEnumerations,
        matchChecks: globalThis.__blockInformerPerf.matchChecks,
      }));
      if (observerStats.matchChecks >= stressRequestCount) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < observerDeadline);

    await session.worker.evaluate(() => {
      Object.keys = globalThis.__blockInformerPerf.originalObjectKeys;
      Object.prototype.hasOwnProperty = globalThis.__blockInformerPerf.originalHasOwnProperty;
      delete globalThis.__blockInformerPerf;
    });
    assert.ok(observerStats.matchChecks >= stressRequestCount);
    assert.equal(
      observerStats.requestPathLargeEnumerations,
      0,
      `Request-path Object.keys calls:\n${observerStats.largeEnumerationStacks.join('\n---\n')}`
    );
    assert.ok(requestBurst.requests >= stressRequestCount);

    const clearLargeRulesResult = await sendMessage(optionsPage, {
      action: 'SAVE_MODS',
      mods: { exceptions: {} },
    });
    assert.equal(clearLargeRulesResult && clearLargeRulesResult.success, true);

    const saveResult = await sendMessage(optionsPage, {
      action: 'SAVE_MODS',
      mods: {
        customProxyStringRaw: `HTTP ${username}:${password}@127.0.0.1:${authProxy.port}`,
        ifProxyOrDie: true,
      },
    });
    assert.equal(saveResult && saveResult.success, true);

    const token = `route-${Date.now()}`;
    const rawPac = 'function FindProxyForURL(url, host) {' +
      ` return "PROXY 127.0.0.1:${authProxy.port}"; }`;
    const pacResult = await sendMessage(optionsPage, {
      action: 'SET_RAW_PAC',
      pacData: rawPac,
    });
    assert.equal(pacResult && pacResult.success, true);

    const controlled = await readProxySettings(optionsPage);
    assert.equal(controlled.levelOfControl, 'controlled_by_this_extension');
    assert.equal(controlled.value.mode, 'pac_script');

    const routedPage = await browser.newPage();
    const response = await routedPage.goto(`http://auth-smoke.test/${token}`, {
      timeout: TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });
    assert.ok(response);
    assert.equal(await response.text(), authProxy.marker);
    await routedPage.close();

    const routedRequests = authProxy.requests.filter((entry) => entry.url.includes(token));
    assert.ok(routedRequests.some((entry) => entry.authorization === null));
    assert.ok(routedRequests.some((entry) => entry.authorization !== null));

    const wrongToken = `worker-restart-${Date.now()}`;
    const wrongSave = await sendMessage(optionsPage, {
      action: 'SAVE_MODS',
      mods: {
        customProxyStringRaw: `HTTP wrong-user:wrong-password@127.0.0.1:${wrongAuthProxy.port}`,
        ifProxyOrDie: true,
      },
    });
    assert.equal(wrongSave && wrongSave.success, true);
    const wrongPacResult = await sendMessage(optionsPage, {
      action: 'SET_RAW_PAC',
      pacData: 'function FindProxyForURL(url, host) {' +
        ` return "PROXY 127.0.0.1:${wrongAuthProxy.port}"; }`,
    });
    assert.equal(wrongPacResult && wrongPacResult.success, true);

    const wrongPage = await browser.newPage();
    const wrongNavigation = wrongPage.goto(`http://auth-worker-restart.test/${wrongToken}`, {
      timeout: TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    }).catch((error) => error);
    await withTimeout(
      wrongAuthProxy.firstCredential,
      'Прокси не получил первую попытку с неправильными credentials.'
    );
    await stopExtensionWorker(browser, optionsPage, session.extensionId);
    wrongAuthProxy.releaseChallenge();
    await wrongNavigation;
    await wrongPage.close();

    const wrongRequests = wrongAuthProxy.requests.filter((entry) => entry.url.includes(wrongToken));
    const credentialedWrongRequests = wrongRequests.filter((entry) => entry.authorization !== null);
    assert.equal(wrongRequests[0] && wrongRequests[0].authorization, null);
    assert.equal(
      credentialedWrongRequests.length,
      3,
      'Перезапуск service worker не должен сбрасывать лимит из трёх попыток.'
    );

    const helper = await installAndGetWorker(browser, helperRoot);
    await helper.worker.evaluate(() => new Promise((resolve, reject) => {
      chrome.proxy.settings.set({
        scope: 'regular',
        value: { mode: 'direct' },
      }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    }));

    const externalControl = await readProxySettings(optionsPage);
    assert.equal(externalControl.levelOfControl, 'controlled_by_other_extensions');
    const blockedClear = await sendMessage(optionsPage, { action: 'CLEAR_PAC' });
    assert.equal(blockedClear && blockedClear.success, false);
    assert.match(blockedClear.error, /контролируются другим расширением|политикой браузера/i);

    const helperControl = await helper.worker.evaluate(() => new Promise((resolve) => {
      chrome.proxy.settings.get({}, resolve);
    }));
    assert.equal(helperControl.levelOfControl, 'controlled_by_this_extension');
    assert.equal(helperControl.value.mode, 'direct');

    await helper.worker.evaluate(() => new Promise((resolve) => {
      chrome.proxy.settings.clear({ scope: 'regular' }, resolve);
    }));

    const recoveryDeadline = Date.now() + TIMEOUT_MS;
    let recoveredControl = null;
    while (Date.now() < recoveryDeadline) {
      recoveredControl = await readProxySettings(optionsPage);
      if (recoveredControl.levelOfControl === 'controlled_by_this_extension' &&
          recoveredControl.value?.mode === 'pac_script') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(recoveredControl?.levelOfControl, 'controlled_by_this_extension');
    assert.equal(recoveredControl?.value?.mode, 'pac_script');
    await verifySiteResources(browser, optionsPage, authProxy, { username, password });
    await optionsPage.close();

    console.log(`Chrome MV3 smoke passed with ${await browser.version()}.`);
    console.log('Verified PAC apply, HTTP 407 auth, ownership protection, and automatic control recovery.');
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    wrongAuthProxy.releaseChallenge();
    await closeServer(authProxy.server).catch(() => undefined);
    await closeServer(wrongAuthProxy.server).catch(() => undefined);
    await closeServer(requestBurst.server).catch(() => undefined);
    removeTemporaryDirectory(helperRoot, 'anticheburnet-owner-');
    removeTemporaryDirectory(profilePath, 'anticheburnet-chrome-');
  }
}

runChromeSmoke().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
