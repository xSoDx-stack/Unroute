import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'anticheburnet-firefox-tabs-'));
const extension = path.join(temp, 'extension');
let browser;
let finish;
const result = new Promise(resolve => { finish = resolve; });
const control = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  console.log('Firefox harness:', body);
  res.end('ok');
  const data = JSON.parse(body);
  if (data.done || data.error) finish(data);
});
const origin = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.end('origin-direct');
});
const proxy = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.end('own-proxy');
});
let timeout;
try {
  await Promise.all([control, origin, proxy].map(server =>
    new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  await fs.cp(path.join(project, 'build/extension-firefox'), extension, { recursive: true });
  // Generated test-only bootstrap; production files are unchanged.
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.background.scripts = ['test-harness.js'];
  manifest.permissions.push('scripting');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const controlUrl = `http://127.0.0.1:${control.address().port}/`;
  const port = origin.address().port;
  const proxyPort = proxy.address().port;
  await fs.writeFile(path.join(extension, 'test-harness.js'), `
    const report = data => fetch(${JSON.stringify(controlUrl)}, {method:'POST', body:JSON.stringify(data)});
    try {
      await report({stage:'started'});
      await browser.storage.local.set({antiCensorRu:{currentPacProviderKey:'none',customPacUrl:'',rawPacData:''}});
      await import('./service-worker.js');
      const {appState} = await import('./core/app-state.js');
      const {pacKitchen} = await import('./core/pac-kitchen.js');
      const {pacSync} = await import('./core/pac-sync.js');
      await appState.ensureInitialized();
      await pacKitchen.updatePacMods(current => ({...current, ifMindExceptions:true,
        ifUseSecureProxiesOnly:false, customProxyStringRaw:'HTTP 127.0.0.1:${proxyPort}',
        exceptions:{'proxy.test':true,'direct.test':false,'cdn.test':true}}));
      pacSync.currentPacProviderKey = 'onlyOwnSites';
      await pacSync.setRawPacData('function FindProxyForURL(url,host){if(host==="127.0.0.1")return "DIRECT";return "PROXY 127.0.0.1:${proxyPort}";}');
      await report({stage:'configured'});
      const open = async host => {
        const tab = await browser.tabs.create({url:'http://'+host+':${port}/'});
        for(let i=0;i<100;i++) {
          const current = await browser.tabs.get(tab.id);
          if(current.status === 'complete' && current.url === 'http://'+host+':${port}/') return tab;
          await new Promise(r=>setTimeout(r,100));
        }
        throw new Error('Tab load timeout: '+host);
      };
      const probe = async tab => (await browser.scripting.executeScript({target:{tabId:tab.id},
        func: async url => (await fetch(url)).text(), args:['http://cdn.test:${port}/asset']}))[0].result;
      const proxied = await open('proxy.test');
      const direct = await open('direct.test');
      const routes = [await probe(proxied),await probe(direct)];
      if(routes[0] !== 'own-proxy' || routes[1] !== 'origin-direct') throw new Error('Routes: '+routes);
      await pacKitchen.updatePacMods(current => ({...current,customProxyStringRaw:'',
        ifUseLocalTor:false,ifUseLocalWarp:false,exceptions:{'proxy.test':true,'direct.test':false}}));
      await pacSync.reapplyCurrentPac();
      const withoutOwn = await probe(direct);
      if(withoutOwn !== 'own-proxy') throw new Error('Standard PAC changed: '+withoutOwn);
      await report({done:true,routes,withoutOwn});
    } catch(error) { await report({error:error.message,stack:error.stack}); }
  `);
  console.log('Launching isolated Firefox...');
  browser = await puppeteer.launch({ browser: 'firefox', headless: true,
    executablePath: process.env.FIREFOX_BIN || 'C:/Program Files/Mozilla Firefox/firefox.exe',
    userDataDir: path.join(temp, 'profile'),
    extraPrefsFirefox: {
      'extensions.allowPrivateBrowsingByDefault': true,
      'network.dns.localDomains': 'proxy.test,direct.test,cdn.test',
      'network.proxy.allow_hijacking_localhost': true,
      'network.dns.disablePrefetch': true, 'network.prefetch-next': false,
    },
  });
  await browser.connection.send('webExtension.install', {
    extensionData: { type: 'path', path: extension }, 'moz:allowPrivateBrowsing': true,
  });
  const outcome = await Promise.race([result, new Promise(resolve => {
    timeout = setTimeout(() => resolve({ error: 'Firefox harness timed out' }), 45000);
  })]);
  assert.equal(outcome.error, undefined, JSON.stringify(outcome));
  console.log(`Firefox tab routing passed with ${await browser.version()}.`);
} finally {
  clearTimeout(timeout);
  if (browser) await browser.close();
  await Promise.all([control, origin, proxy].map(server => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  }));
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('anticheburnet-firefox-tabs-'));
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5 });
}
