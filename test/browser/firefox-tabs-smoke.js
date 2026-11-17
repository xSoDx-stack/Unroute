import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = process.env.TMPDIR || os.tmpdir();
const temp = await fs.mkdtemp(path.join(scratch, 'unroute-firefox-tabs-'));
const extension = path.join(temp, 'extension');
const privateDenied = process.env.UNROUTE_TEST_PRIVATE_DENIED === '1';
let browser;
let finish;
let finishUi;
const result = new Promise(resolve => { finish = resolve; });
const uiResult = new Promise(resolve => { finishUi = resolve; });
const control = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const data = JSON.parse(body);
  const { image, ...summary } = data;
  console.log('Firefox harness:', JSON.stringify(summary));
  if (image?.startsWith('data:image/png;base64,')) {
    const output = path.resolve('artifacts/ui-check');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'firefox-settings-proxies.png'), Buffer.from(image.split(',')[1], 'base64'));
  }
  res.end('ok');
  if (data.stage === 'domain-lists-native-pass') {
    const output = path.resolve('artifacts/browser');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, `firefox-domain-lists-${data.locale}.json`), JSON.stringify({ ...data, received: received.filter(item => item.url.includes('/domain-lists-')) }, null, 2));
  }
  if (data.uiDone) { finishUi(data); return; }
  if (data.done || data.error) finish(data);
});
const origin = http.createServer((req, res) => {
  received.push({ target: 'origin-direct', url: `http://${req.headers.host}${req.url}` });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.end('origin-direct');
});
const received = [];
const proxy = http.createServer((req, res) => {
  received.push({ target: 'own-proxy', url: req.url });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.end('own-proxy');
});
const secondProxy = http.createServer((req, res) => {
  received.push({ target: 'second-proxy', url: req.url });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.end('second-proxy');
});
let timeout;
try {
  await Promise.all([control, origin, proxy, secondProxy].map(server =>
    new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  await fs.cp(path.join(project, 'dist/firefox'), extension, { recursive: true });
  const checkerPath = path.join(extension, 'core', 'proxy-checker.js');
  // Native PAC routing against an offline HTTP proxy, without external TLS/HSTS.
  await fs.writeFile(checkerPath, (await fs.readFile(checkerPath, 'utf8'))
    .replaceAll('1.1.1.1', 'health-probe.localhost').replace('https://health-probe.localhost', 'http://health-probe.localhost'));
  // Generated test-only bootstrap; production files are unchanged.
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.background.scripts = ['test-harness.js'];
  manifest.permissions.push('scripting');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const controlUrl = `http://127.0.0.1:${control.address().port}/`;
  const port = origin.address().port;
  const proxyPort = proxy.address().port;
  const helpers = await fs.readFile(new URL('./firefox-integration-helpers.js', import.meta.url), 'utf8');
  const uiSource = helpers + '\n' + (await fs.readFile(new URL('./sites-editor-checks.js', import.meta.url), 'utf8')).replace('const send = message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve));', 'const send = sendFirefoxFixtureMessage;') + '\n' + (await fs.readFile(new URL('./domain-lists-native-checks.js', import.meta.url), 'utf8')) + '\n' + (await fs.readFile(new URL('./limits-help-checks.js', import.meta.url), 'utf8')) + '\n' + (await fs.readFile(new URL('./firefox-ui-runner.js', import.meta.url), 'utf8'));
  for (const surface of ['options', 'popup', ...(privateDenied ? ['firefox-private-browsing'] : [])]) {
    const pagePath = path.join(extension, 'pages', surface);
    await fs.writeFile(path.join(pagePath, 'ui-test.js'), `${uiSource}\nrunFirefoxUiChecks(${JSON.stringify(controlUrl)}, ${JSON.stringify(`HTTP 127.0.0.1:${proxyPort}`)}, ${JSON.stringify(process.env.UNROUTE_TEST_LOCALE || 'ru')}, ${JSON.stringify({port,proxyPort,secondProxyPort:secondProxy.address().port})});`);
    const html = await fs.readFile(path.join(pagePath, 'index.html'), 'utf8');
    await fs.writeFile(path.join(pagePath, 'index.html'), html.replace('</body>', '<script type="module" src="ui-test.js"></script></body>'));
  }
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
      if (${privateDenied}) {
        const {proxyBackend} = await import('./core/proxy-backend.js');
        let denial;
        try { await proxyBackend.applyPac('function FindProxyForURL(){return "DIRECT";}'); }
        catch(error) { denial = error; }
        if(denial?.code !== 'FIREFOX_PRIVATE_BROWSING_REQUIRED') throw new Error('Expected native private-window permission denial');
        if(denial.message !== browser.i18n.getMessage('firefoxPrivateBrowsingRequired')) throw new Error('Permission error was not localized: '+denial.message);
        await browser.tabs.create({url:browser.runtime.getURL('pages/firefox-private-browsing/index.html')});
        await report({done:true,privatePermissionDenied:true,errorCode:denial.code});
      } else {
      const {createContextMenuItems} = await import('./core/context-menus.js');
      createContextMenuItems();
      const menuMissing = id => new Promise(resolve => chrome.contextMenus.update(id,{visible:true},()=>resolve(Boolean(chrome.runtime.lastError))));
      for(let i=0;await menuMissing('google-translate');i++) {
        if(i>100)throw new Error('Context menus did not initialize');
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if(!await menuMissing('docs-support') || !await menuMissing('web-archive') || !await menuMissing('rublacklist-check')) throw new Error('Retired menu still present');
      await pacKitchen.updatePacMods(current => ({...current, ifMindExceptions:true,
        ifUseSecureProxiesOnly:false, customProxyStringRaw:'HTTP 127.0.0.1:${proxyPort}',
        exceptions:{'proxy.test':true,'direct.test':false}}));
      await pacKitchen.updatePacMods(current => ({...current,
        exceptions:{...current.exceptions,'cdn.test':true}}), {source:'auto',site:'proxy.test'});
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
      await pacKitchen.updatePacMods(current => ({...current,ifProxyHttpsUrlsOnly:true}));
      await pacSync.reapplyCurrentPac();
      if(await probe(proxied) !== 'origin-direct') throw new Error('HTTPS-only was bypassed by tab routing');
      await pacKitchen.updatePacMods(current => ({...current,ifProxyHttpsUrlsOnly:false,
        ifMindWhitelist:true,whitelist:['proxy.test','direct.test']}));
      await pacSync.reapplyCurrentPac();
      if(await probe(proxied) !== 'origin-direct') throw new Error('Whitelist was bypassed by tab routing');
      await pacKitchen.updatePacMods(current => ({...current,
        whitelist:['proxy.test','direct.test','cdn.test']}));
      await pacSync.reapplyCurrentPac();
      if(await probe(proxied) !== 'own-proxy') throw new Error('Whitelisted resource did not follow tab routing');
      await pacKitchen.updatePacMods(current => ({...current,customProxyStringRaw:'',
        ifUseLocalTor:false,ifUseLocalWarp:false,ifMindWhitelist:false,
        exceptions:{'proxy.test':true,'direct.test':false}}));
      await pacSync.reapplyCurrentPac();
      // Explicit DIRECT remains direct without own proxies; a neutral tab
      // exercises the standard native PAC fallback independently of that rule.
      if(await probe(direct) !== 'origin-direct') throw new Error('Explicit DIRECT without own proxies was bypassed');
      const neutral = await open('route-a.test');
      const withoutOwn = await probe(neutral);
      await browser.tabs.remove(neutral.id);
      if(withoutOwn !== 'own-proxy') throw new Error('Standard PAC changed: '+withoutOwn);
      await new Promise(async resolve => {
        const done = message => {
          if (message.firefoxMultiProxyDone) {
            browser.runtime.onMessage.removeListener(done);
            resolve();
          }
        };
        browser.runtime.onMessage.addListener(done);
        await browser.tabs.create({url:browser.runtime.getURL('multiproxy-test.html')});
      });
      await browser.tabs.create({url:browser.runtime.getURL('pages/options/index.html#pac')});
      await report({done:true,routes,withoutOwn,baseUrl:browser.runtime.getURL('')});
      }
    } catch(error) { await report({error:error.message,stack:error.stack}); }
  `);
  await fs.copyFile(new URL('./firefox-integration-helpers.js', import.meta.url), path.join(extension, 'firefox-integration-helpers.js'));
  await fs.writeFile(path.join(extension, 'multiproxy-test.html'), '<!doctype html><script type="module" src="multiproxy-test.js"></script>');
  await fs.writeFile(path.join(extension, 'multiproxy-test.js'), `
    import {checkFirefoxMultiProxy, sendFirefoxFixtureMessage as send} from './firefox-integration-helpers.js';
    const report = data => fetch(${JSON.stringify(controlUrl)}, {method:'POST',body:JSON.stringify(data)});
    try {
      const multiproxy = await checkFirefoxMultiProxy({port:${port},proxyPort:${proxyPort},secondProxyPort:${secondProxy.address().port},report});
      await report({stage:'multiproxy-complete',multiproxy});
      const call = async message => {
        const response = await send(message);
        if (!response.success) throw new Error(message.action+': '+JSON.stringify(response));
        return response.data;
      };
      await call({action:'SAVE_MODS',mods:{customProxyStringRaw:'HTTP 127.0.0.1:${proxyPort}\\nHTTP 127.0.0.1:${secondProxy.address().port}'}});
      const catalog = (await call({action:'GET_EXCEPTIONS'})).proxyCatalog;
      const a = catalog.find(profile=>profile.endpoint==='PROXY 127.0.0.1:${proxyPort}').id;
      const b = catalog.find(profile=>profile.endpoint==='PROXY 127.0.0.1:${secondProxy.address().port}').id;
      await call({action:'MUTATE_DOMAIN_RULES',operations:[{domain:'route-a.test',mode:'proxy',proxyId:a}]});
      const siteUrl='http://route-a.test:${port}/multiproxy-popup-main';
      const site = await browser.tabs.create({url:siteUrl});
      try {
        for(let i=0;;i++) {
          const current=await browser.tabs.get(site.id);
          if(current.status==='complete' && current.url===siteUrl)break;
          if(i>100) throw new Error('Popup resource fixture tab did not load');
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        const initial = (await browser.scripting.executeScript({target:{tabId:site.id},
          func:async url=>(await fetch(url,{cache:'no-store'})).text(),
          args:['http://popup-cdn.test:${port}/multiproxy-popup-initial-A']}))[0].result;
        if(initial!=='own-proxy') throw new Error('Popup initial resource did not use A: '+initial);
        await new Promise((resolve,reject)=>{
          let popupId, stopReload=()=>{};
          const cleanup=()=>{
            stopReload();
            browser.runtime.onMessage.removeListener(done);
          };
          const done=message=>{
            if(message.resourceProxyPopupReload){
              let loading=false, complete=false, closed=false;
              const finish=()=>{
                if(!complete || !closed)return;
                cleanup();
                report({stage:'multiproxy-popup-resource-ux',manualSameProfile:true,reset:'site/wildcard/DIRECT',reload:'actual-navigation-and-close'}).then(resolve,reject);
              };
              const updated=(id,change,tab)=>{
                if(id!==site.id)return;
                if(change.status==='loading')loading=true;
                if(loading && change.status==='complete'){
                  if(tab.url!==siteUrl){
                    cleanup();
                    reject(new Error('Popup reload changed URL: '+tab.url));
                    return;
                  }
                  complete=true;
                }
                finish();
              };
              const removed=id=>{if(id===popupId){closed=true;finish();}};
              const timer=setTimeout(()=>{
                cleanup();
                reject(new Error('Popup reload timeout: '+JSON.stringify({loading,complete,closed})));
              },15000);
              stopReload=()=>{
                clearTimeout(timer);
                browser.tabs.onUpdated.removeListener(updated);
                browser.tabs.onRemoved.removeListener(removed);
              };
              browser.tabs.onUpdated.addListener(updated);
              browser.tabs.onRemoved.addListener(removed);
              return Promise.resolve({ready:true});
            }
            if(!message.resourceProxyPopupDone)return;
            cleanup();
            if(message.error)reject(new Error(message.error));else resolve();
          };
          browser.runtime.onMessage.addListener(done);
          const query=new URLSearchParams({resourceProxyTest:'1',tabId:String(site.id),a,b});
          browser.tabs.create({url:browser.runtime.getURL('pages/popup/index.html')+'?'+query,active:false}).then(tab=>{popupId=tab.id;},error=>{cleanup();reject(error);});
        });
      } finally {
        await browser.tabs.remove(site.id);
        await call({action:'MUTATE_DOMAIN_RULES',operations:['route-a.test','popup-cdn.test','manual.route-a.test','*.route-a.test'].map(domain=>({domain,mode:'pac'}))});
        await call({action:'SAVE_MODS',mods:{customProxyStringRaw:''}});
      }
      await browser.runtime.sendMessage({firefoxMultiProxyDone:true});
      window.close();
    } catch(error) {await report({error:error.message,stack:error.stack});}
  `);
  console.log('Launching isolated Firefox...');
  browser = await puppeteer.launch({ browser: 'firefox', headless: true,
    executablePath: process.env.FIREFOX_BIN || 'C:/Program Files/Mozilla Firefox/firefox.exe',
    userDataDir: path.join(temp, 'profile'),
    extraPrefsFirefox: {
      'intl.locale.requested': process.env.UNROUTE_TEST_LOCALE || 'ru',
      'extensions.allowPrivateBrowsingByDefault': !privateDenied,
      'network.dns.localDomains': 'proxy.test,direct.test,cdn.test,route-a.test,route-b.test,shared-cdn.test,popup-cdn.test,health-probe.localhost,unassigned.popup-inherit.test,late.popup-inherit.test,off.popup-inherit.test,wild.route-a.test,shared.native-list-a.test,wild.native-list-a.test,native-list-b.test,www.native-list-b.test,native-list-cdn.test',
      'network.proxy.allow_hijacking_localhost': true,
      'network.dns.disablePrefetch': true, 'network.prefetch-next': false,
    },
  });
  const sizingTab = await browser.newPage();
  await sizingTab.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
  await browser.connection.send('webExtension.install', {
    extensionData: { type: 'path', path: extension }, 'moz:allowPrivateBrowsing': !privateDenied,
  });
  const outcome = await Promise.race([result, new Promise(resolve => {
    timeout = setTimeout(() => resolve({ error: 'Firefox harness timed out' }), 180000);
  })]);
  assert.equal(outcome.error, undefined, JSON.stringify(outcome));
  clearTimeout(timeout);
  if (!privateDenied) {
    const proof = received.filter(item => item.url.includes('/multiproxy-'));
    const expectedTargets = {
      'A-to-A': 'own-proxy', 'B-to-B': 'second-proxy',
      'shared-from-A': 'own-proxy', 'shared-from-B': 'second-proxy',
      'explicit-B-over-tab-A': 'second-proxy', 'explicit-A-over-tab-B': 'own-proxy',
      'manual-CDN-B-over-tab-A': 'second-proxy', 'moved-CDN-A-over-tab-B': 'own-proxy',
      'manual-direct-over-tab-A': 'origin-direct', 'manual-direct-over-tab-B': 'origin-direct',
      'popup-initial': 'own-proxy', 'popup-selected-B': 'second-proxy',
    };
    for (const [label, target] of Object.entries(expectedTargets)) {
      const actual = proof.filter(item => item.url.includes(`/multiproxy-${label}-`));
      assert.ok(actual.length, `${label}: no request arrived at a local target`);
      assert.ok(actual.every(item => item.target === target), `${label}: request arrived at wrong target`);
    }
    const output = path.join(project, 'artifacts/browser');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'firefox-multiproxy-requests.json'), JSON.stringify(proof, null, 2));
  }
  const ui = await Promise.race([uiResult, new Promise(resolve => {
    timeout = setTimeout(() => resolve({ error: 'Firefox UI checks timed out' }), 180000);
  })]);
  assert.equal(ui.error, undefined, JSON.stringify(ui));
  console.log(`Firefox ${privateDenied ? 'private-permission localization' : 'tab routing'} passed with ${await browser.version()}.`);
} finally {
  clearTimeout(timeout);
  if (browser) await browser.close();
  await Promise.all([control, origin, proxy, secondProxy].map(server => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  }));
  assert.equal(path.dirname(temp), path.resolve(scratch));
  assert.ok(path.basename(temp).startsWith('unroute-firefox-tabs-'));
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5 });
}
