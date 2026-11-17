'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { verifySiteResources } from './site-resources-scenario.js';
import { verifySettingsLayout } from './ui-layout-scenario.js';
import { verifyLocalization } from './localization-scenario.js';
import { verifyAppearance } from './appearance-scenario.js';
import { checkSitesEditor } from './sites-editor-checks.js';
import { verifySettingsWakeup, verifyLargeRuleHydration } from './settings-wakeup-scenario.js';
import { verifyProxyAddition } from './proxy-add-scenario.js';
import { verifyResourceBatch } from './resource-batch-scenario.js';
import { verifyExtensionEnable } from './extension-enable-scenario.js';
import { verifyBuiltUILayout } from './ui-fidelity-scenario.js';
import { sendChromeMessage } from './chrome-rpc.js';
import { verifyMultiproxyRouting } from './multiproxy-scenario.js';
import { checkLimitsAndHelp } from './limits-help-checks.js';
import { verifyDomainListsNative } from './domain-lists-native-scenario.js';

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(TEST_ROOT, '..', '..', 'dist', 'chromium');
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
      response.end('<!doctype html><title>Unroute request stress</title>');
      return;
    }
    // Reuse sockets so this measures extension request handling rather than
    // exhausting Windows ephemeral ports with thousands of TCP closes.
    response.writeHead(204, {
      'Cache-Control': 'no-store',
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
  const marker = 'unroute-browser-auth-ok';
  const server = http.createServer((request, response) => {
    const authorization = request.headers['proxy-authorization'] || null;
    requests.push({ authorization, url: request.url });
    request.resume();
    if (authorization !== expectedAuthorization) {
      response.writeHead(407, {
        'Connection': 'close',
        'Content-Length': '0',
        'Proxy-Authenticate': 'Basic realm="unroute-smoke"',
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
      'Proxy-Authenticate': 'Basic realm="unroute-worker-restart"',
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
      `--lang=${process.env.UNROUTE_TEST_LOCALE || 'ru'}`,
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      ...(process.env.UNROUTE_ENABLE_HEADFUL === '1' ? [] : ['--disable-gpu']),
      '--disable-backgrounding-occluded-windows',
      ...(process.env.UNROUTE_ENABLE_STRESS_ONLY === '1' ? ['--disable-background-timer-throttling'] : []),
      '--disable-sync',
      '--host-resolver-rules=MAP shared.native-list-a.test 127.0.0.1, MAP wild.native-list-a.test 127.0.0.1, MAP native-list-b.test 127.0.0.1, MAP www.native-list-b.test 127.0.0.1, MAP native-list-cdn.test 127.0.0.1, MAP *.example.test 127.0.0.1, MAP *.cdn.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE 127.0.0.2, EXCLUDE localhost',
      '--metrics-recording-only',
      '--no-default-browser-check',
      '--no-first-run',
    ],
    enableExtensions: true,
    executablePath,
    protocolTimeout: process.env.UNROUTE_ENABLE_STRESS_ONLY === '1' ? 30000 : undefined,
    headless: process.env.UNROUTE_ENABLE_HEADFUL !== '1',
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
  page.on('pageerror', error => console.error('Options page error:', error.stack || error.message));
  await page.goto(`chrome-extension://${extensionId}/pages/options/index.html`, {
    timeout: TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  return page;
}

const sendMessage = sendChromeMessage;

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
  const helperRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unroute-owner-'));
  fs.writeFileSync(path.join(helperRoot, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Unroute proxy owner smoke helper',
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
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'unroute-chrome-'));
  const helperRoot = createProxyOwnerHelper();
  const instrumentedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unroute-instrumented-'));
  const username = 'browser-smoke-user';
  const password = `browser-smoke-${Date.now()}`;
  const authProxy = await createAuthenticatedProxy(username, password);
  const wrongAuthProxy = await createInterruptedWrongAuthProxy();
  const requestBurst = await createRequestBurstServer();
  let browser = null;

  try {
    fs.cpSync(EXTENSION_ROOT, instrumentedRoot, { recursive: true });
    if (process.env.UNROUTE_ENABLE_STRESS_ONLY === '1') {
      const bootstrap = path.join(instrumentedRoot, 'service-worker.js');
      fs.writeFileSync(bootstrap, `
        globalThis.enableTimings = [];
        for (const [owner, names] of [[pacSync, ['init', 'loadLocalState', 'applyPacData', 'updateControlState']],
          [proxyBackend, ['applyPac', 'getSettings']], [testPacKitchen, ['getPacMods']],
          [testStorage, ['get', 'restrictLocalAccess']], [appState, ['ensureRequestStateInitialized']],
          [errorHandlers, ['init', 'handleProxyError', 'handleExtensionError']],
          [testLogger, ['init', 'add', 'queueSave']]]) {
          for (const name of names) {
            const original = owner[name];
            owner[name] = function(...args) {
              const started = performance.now();
              const finish = () => enableTimings.push({ name: name === 'get' ? name + ':' + args[0] : name,
                ms: Math.round(performance.now() - started) });
              try {
                const result = original.apply(this, args);
                if (result && typeof result.finally === 'function') return result.then(value => {
                  if (name === 'get' && args[0] === 'pac-kitchen-mods') {
                    globalThis.enableStoredSnapshot = { schema: value?._schemaVersion || 0,
                      packedChars: value?._ruleData?.length || 0,
                      legacyRules: Object.keys(value?.exceptions || {}).length };
                  }
                  return value;
                }).finally(finish);
                finish(); return result;
              } catch (error) { finish(); throw error; }
            };
          }
        }
      ` + fs.readFileSync(bootstrap, 'utf8'));
    }
    fs.appendFileSync(path.join(instrumentedRoot, 'service-worker.js'),
      '\n// Temporary native-test access to the existing static module bindings.\n' +
      "import { pacKitchen as testPacKitchen } from './core/pac-kitchen.js';\n" +
      "import { storage as testStorage } from './core/storage.js';\n" +
      "import { logger as testLogger } from './core/logger.js';\n" +
      'globalThis.__proxyTestHooks = { proxyBackend, pacSync, appState, whenProxySettingsIdle, pacKitchen: testPacKitchen, storage: testStorage };\n');
    const checkerPath = path.join(instrumentedRoot, 'core', 'proxy-checker.js');
    // Keep the native probe route but target the offline HTTP fixture, without
    // Cloudflare TLS/HSTS. Production source and store builds are untouched.
    fs.writeFileSync(checkerPath, fs.readFileSync(checkerPath, 'utf8')
      .replaceAll('1.1.1.1', 'health-probe.test').replace('https://health-probe.test', 'http://health-probe.test'));
    // Seed an offline provider, then restart Chrome. This prevents the default
    // provider download from making the smoke test depend on external network.
    console.log('Launching Chrome for offline state seed...');
    browser = await launchChrome(chromeExecutable, profilePath);
    const firstSession = await installAndGetWorker(browser, instrumentedRoot);
    await seedOfflineProvider(firstSession.worker);
    console.log('Offline provider seeded; restarting Chrome...');
    await browser.close();

    if (process.env.UNROUTE_ENABLE_STORAGE_PROFILE) {
      const { path: source, extensionId } = JSON.parse(process.env.UNROUTE_ENABLE_STORAGE_PROFILE);
      assert.match(extensionId, /^[a-p]{32}$/);
      const from = path.join(source, 'Local Extension Settings', extensionId);
      const destination = path.join(profilePath, 'Default', 'Local Extension Settings', firstSession.extensionId);
      fs.mkdirSync(destination, { recursive: true });
      for (const name of fs.readdirSync(from)) {
        if (name !== 'LOCK') fs.copyFileSync(path.join(from, name), path.join(destination, name));
      }
      console.log('Copied the selected extension storage into the isolated profile.');
    }

    browser = await launchChrome(chromeExecutable, profilePath);
    const session = await installAndGetWorker(browser, instrumentedRoot);
    assert.equal(session.extensionId, firstSession.extensionId);
    const optionsPage = await openExtensionPage(browser, session.extensionId);

    if (process.env.UNROUTE_ENABLE_STRESS_ONLY === '1') {
      await verifyExtensionEnable(browser, { ...session, options: optionsPage }, authProxy,
        requestBurst.port, { username, password });
      return;
    }

    const initialState = await sendMessage(optionsPage, { action: 'GET_STATE' });
    assert.equal(initialState && initialState.success, true);
    assert.equal(initialState.data.syncState.currentPacProviderKey, 'onlyOwnSites');
    // Local UI requests can finish before the independent startup PAC apply.
    await optionsPage.waitForFunction(() => new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'GET_STATE' }, response => resolve(response?.data?.syncState.hasPacData));
    }), { polling: 100, timeout: TIMEOUT_MS });
    await optionsPage.waitForFunction(() => new Promise(resolve => {
      chrome.contextMenus.update('google-translate', { visible: true }, () => resolve(!chrome.runtime.lastError));
    }), { polling: 100, timeout: TIMEOUT_MS });
    const removedMenus = await optionsPage.evaluate(() => Promise.all(['docs-support', 'web-archive', 'rublacklist-check'].map(id =>
      new Promise(resolve => chrome.contextMenus.update(id, { visible: true }, () => resolve(Boolean(chrome.runtime.lastError)))))));
    assert.deepEqual(removedMenus, [true, true, true], 'Retired external-service menu items must be absent');
    if (process.env.UNROUTE_LIMIT_HELP_ONLY === '1') {
      await optionsPage.bringToFront();
      console.log('Chrome limits/help:', await optionsPage.evaluate(checkLimitsAndHelp));
      return;
    }
    if (process.env.UNROUTE_DOMAIN_LISTS_ONLY === '1') {
      await verifyDomainListsNative(browser, optionsPage);
      return;
    }
    if (process.env.UNROUTE_MULTIPROXY_ONLY === '1') {
      await verifyMultiproxyRouting(browser, optionsPage, session.worker);
      console.log(`Chrome multiproxy installed-build smoke passed with ${await browser.version()}.`);
      return;
    }
    await verifyAppearance(browser, optionsPage, session.extensionId);
    if (process.env.UNROUTE_APPEARANCE_ONLY === '1') return;
    await verifyLocalization(browser, optionsPage, session.extensionId);
    await verifyBuiltUILayout(optionsPage);
    // Persist the empty setup snapshot before editor writes. A virgin profile
    // has no pac-kitchen-mods key; its first storage event is initialization.
    assert.equal((await sendMessage(optionsPage, { action: 'SAVE_MODS', mods: { exceptions: {}, whitelist: [] } })).success, true);
    await optionsPage.reload();
    await optionsPage.waitForFunction(() => document.getElementById('extVersion').textContent, { timeout: TIMEOUT_MS });
    const editorFailure = await browser.newPage();
    await editorFailure.evaluateOnNewDocument(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.restoreEditorMessages = () => { chrome.runtime.sendMessage = original; };
      chrome.runtime.sendMessage = (message, callback) => message.action === 'GET_EXCEPTIONS'
        ? callback({ success: false, error: 'Simulated initial load failure' }) : original(message, callback);
    });
    try {
      await editorFailure.goto(`chrome-extension://${session.extensionId}/pages/options/index.html#exceptions`);
      await editorFailure.waitForFunction(() => !document.getElementById('manualRulesLink').disabled);
    await editorFailure.click('#manualRulesLink');
      await editorFailure.waitForFunction(() => !document.getElementById('retrySitesLoad').hidden);
      assert.equal(await editorFailure.$eval('#addDomainBtn', button => button.disabled), true, 'Failed initial load must prevent empty-list writes');
      await editorFailure.evaluate(() => { window.restoreEditorMessages(); document.getElementById('retrySitesLoad').click(); });
      await editorFailure.waitForFunction(() => !document.getElementById('newDomainInput').disabled);
    } finally { await editorFailure.close(); }
    await optionsPage.bringToFront();
    await optionsPage.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
    console.log('Chrome sites editor passed:', await optionsPage.evaluate(checkSitesEditor));
    await optionsPage.screenshot({ path: path.resolve('artifacts/ui-check/chrome-settings-sites.png') });
    if (process.env.UNROUTE_UI_ONLY === '1') {
      await verifySettingsLayout(optionsPage, `chrome-extension://${session.extensionId}/`);
      console.log(`Chrome UI smoke passed with ${await browser.version()}.`);
      return;
    }

    await verifyMultiproxyRouting(browser, optionsPage, session.worker);
    await verifyDomainListsNative(browser, optionsPage);

    console.log('Chrome limits/help:', await optionsPage.evaluate(checkLimitsAndHelp));

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
    await verifyLargeRuleHydration(optionsPage, session.worker);
    let wakeupFailure = null;
    try { await verifySettingsWakeup(browser, optionsPage); }
    catch (error) {
      wakeupFailure = error;
      console.error('Chrome settings wakeup failed (continuing independent routing/auth checks):', error.stack);
    }
    // Use a separate endpoint so the browser's proxy-auth cache cannot hide
    // the initial HTTP 407 challenge asserted by the later auth scenario.
    const additionProxy = await createAuthenticatedProxy(username, password);
    try {
      await verifyProxyAddition(optionsPage, session.worker, additionProxy, { username, password });
    } finally {
      await closeServer(additionProxy.server);
    }
    await verifyResourceBatch(browser, optionsPage, session.worker);

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
    const stressStarted = Date.now();
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
    console.log(`Routing stress: ${stressRequestCount} requests, 33001 rules, ${Date.now() - stressStarted} ms (network and browser overhead included).`);
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
    if (process.env.UNROUTE_ROUTING_STRESS_ONLY === '1') {
      console.log(`Chrome routing stress passed with ${await browser.version()}.`);
      return;
    }

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
    assert.match(blockedClear.error, /контролируются другим расширением|политикой браузера|controlled by another extension|browser policy/i);

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

    if (wakeupFailure) throw wakeupFailure;
    console.log(`Chrome MV3 smoke passed with ${await browser.version()}.`);
    console.log('Verified PAC apply, HTTP 407 auth, ownership protection, and automatic control recovery.');
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    wrongAuthProxy.releaseChallenge();
    await closeServer(authProxy.server).catch(() => undefined);
    await closeServer(wrongAuthProxy.server).catch(() => undefined);
    await closeServer(requestBurst.server).catch(() => undefined);
    removeTemporaryDirectory(helperRoot, 'unroute-owner-');
    removeTemporaryDirectory(instrumentedRoot, 'unroute-instrumented-');
    removeTemporaryDirectory(profilePath, 'unroute-chrome-');
  }
}

runChromeSmoke().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
