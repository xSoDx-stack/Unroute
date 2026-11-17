import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

// Deliberately open the browser action, not its HTML in a fixed-width tab.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = process.env.TMPDIR || 'C:/Users/User/AppData/Local/hermes/cache/scratch';
const temp = await fs.mkdtemp(path.join(scratch, 'unroute-native-popup-'));
let browser, timeout, finish;
const result = new Promise(resolve => { finish = resolve; });
const samples = [];
const server = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const data = JSON.parse(body);
  console.log('Native popup:', JSON.stringify(data));
  response.end('ok');
  samples.push(data);
  if (data.error || samples.filter(item => item.theme).length === 2) finish(samples);
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const reportUrl = `http://127.0.0.1:${server.address().port}/`;
  const extension = path.join(temp, 'extension');
  await fs.cp(path.join(root, 'dist/firefox'), extension, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  manifest.background.scripts = ['native-popup-bootstrap.js'];
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(extension, 'native-popup-bootstrap.js'), `
    const api = globalThis.browser || chrome;
    const report = data => fetch(${JSON.stringify(reportUrl)}, {method:'POST',body:JSON.stringify(data)});
    try {
      await api.storage.local.set({antiCensorRu:{currentPacProviderKey:'none',customPacUrl:'',rawPacData:''},'ui-appearance':{theme:'dark',accent:'mint'}});
      await import('./service-worker.js');
      await api.action.openPopup();
    } catch(error) { await report({error:error.message}); }
  `);
  const popupPath = path.join(extension, 'pages/popup');
  const html = await fs.readFile(path.join(popupPath, 'index.html'), 'utf8');
  await fs.writeFile(path.join(popupPath, 'index.html'), html.replace('</body>', '<script type="module" src="native-popup-check.js"></script></body>'));
  await fs.writeFile(path.join(popupPath, 'native-popup-check.js'), `
    const browser = globalThis.browser || chrome;
    const report = data => fetch(${JSON.stringify(reportUrl)}, {method:'POST',body:JSON.stringify(data)});
    const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
    try {
      for(const theme of ['dark','light']) {
        await browser.storage.local.set({'ui-appearance':{theme,accent:'mint'}});
        await delay(700);
        const brand=document.querySelector('.brand').getBoundingClientRect(),status=document.querySelector('#status').getBoundingClientRect();
        await report({theme, actualTheme:document.documentElement.dataset.theme,
          native:browser.extension.getViews({type:'popup'}).includes(window),
          width:innerWidth, body:document.body.getBoundingClientRect().width,
          root:document.documentElement.getBoundingClientRect().width,scroll:document.documentElement.scrollWidth,
          bodyScroll:document.body.scrollWidth, height:innerHeight,
          overlap:brand.right>status.left,
          footerWidth:document.querySelector('footer').getBoundingClientRect().width,
          footerActions:document.querySelectorAll('footer [data-section]').length});
      }
    } catch(error) {await report({error:error.message});}
  `);
  browser = await puppeteer.launch({ browser: 'firefox', headless: !process.argv.includes('--headful'),
    executablePath: process.env.FIREFOX_BIN || 'C:/Program Files/Mozilla Firefox/firefox.exe',
    userDataDir: path.join(temp, 'profile'),
    extraPrefsFirefox: { 'intl.locale.requested': 'ru', 'extensions.allowPrivateBrowsingByDefault': true,
      'network.dns.disablePrefetch': true, 'network.prefetch-next': false },
  });
  await browser.connection.send('webExtension.install', {
    extensionData: { type: 'path', path: extension }, 'moz:allowPrivateBrowsing': true,
  });
  const outcome = await Promise.race([result, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(Error('Native popup did not report within 30 seconds')), 30000);
  })]);
  for (const sample of outcome) {
    assert.equal(sample.error, undefined);
    assert.equal(sample.native, true, 'Must exercise a real browser-action popup');
    assert.equal(sample.actualTheme, sample.theme);
    assert.equal(sample.width, 360, 'Native popup must negotiate its own 360px viewport');
    assert.equal(sample.body, 360);
    assert.equal(sample.scroll, 360, 'No root horizontal scrollbar');
    assert.ok(sample.bodyScroll <= 360, 'No body horizontal overflow');
    assert.equal(sample.overlap, false, 'Brand and status must not overlap');
    assert.ok(sample.footerWidth >= 320);
    assert.equal(sample.footerActions, 2, 'Connection/settings actions must match design 01');
    assert.ok(sample.height <= 580);
  }
  console.log('Firefox native browser-action popup passed: 360px, light/dark, no horizontal overflow or header overlap.');
} finally {
  clearTimeout(timeout);
  try {
    if (browser) await browser.close();
  } finally {
    try {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    } finally {
      await fs.rm(temp, { recursive: true, force: true, maxRetries: 5 });
    }
  }
}
