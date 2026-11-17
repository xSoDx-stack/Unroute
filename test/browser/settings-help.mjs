// Source browser DOM + explicit RPC/storage fixtures, NOT installed-extension/network integration.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const root = path.resolve('src/common');
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try { res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream'); res.end(readFileSync(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const executablePath = process.env.CHROME_BIN || process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
try {
 for (const lang of ['ru', 'en']) {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const catalog = JSON.parse(readFileSync(path.join(root, '_locales', lang, 'messages.json'), 'utf8'));
  await page.evaluateOnNewDocument((catalog, lang) => {
   window.calls = []; window.fixture = { storage: {} };
   const profiles = [{id:'custom:a',name:'Alpha',endpoint:'HTTP user:secret@127.0.0.1:8080',enabled:true}, {id:'custom:b',name:'Beta',endpoint:'HTTPS proxy.test:443',enabled:true}];
   const snapshot = { revision:1, exceptions:Object.fromEntries(Array.from({length:205}, (_,i)=>[`site-${String(i).padStart(3,'0')}.test`,true]).concat([['direct.test',false]])), whitelist:['allow.test'], proxyCatalog:profiles, defaultProxyId:'custom:a',domainProxyIds:{},ruleMeta:{} };
   window.fixture.snapshot = snapshot;
   const history = [{id:'h1',at:Date.now(),count:1,source:'manual'}, {id:'h2',at:Date.now(),count:60000,truncated:true}];
   window.chrome = {
    i18n:{getUILanguage:()=>lang,getMessage:(key, values=[]) => {
     const entry = catalog[key];
     return (entry?.message || '').replace(/\$([a-z_0-9]+)\$/gi, (match, name)=>entry.placeholders?.[name.toLowerCase()]?.content || match).replace(/\$(\d+)/g, (_, n)=>values[Number(n)-1] ?? '');
    }},
    storage:{onChanged:{addListener(){}},local:{get:(_keys,cb)=>cb(structuredClone(window.fixture.storage)),set:(value,cb)=>{Object.assign(window.fixture.storage,value);cb();}}},
    tabs:{query:async()=>[{url:'https://example.com'}],create:async()=>{}},
    runtime:{getManifest:()=>({version:'2.2.30'}),onMessage:{addListener(){}},sendMessage:(message,cb)=>{
     window.calls.push(structuredClone(message)); let data = {};
     if (message.action === 'GET_STATE') data = {syncState:{currentPacProviderKey:'customPacUrl',customPacUrl:'https://user:secret@example.test/pac',isControlled:true},pacMods:{...snapshot,customProxyStringRaw:profiles.map(p=>p.endpoint).join(';')},notifications:{},proxyHealthMap:{}};
     if (message.action === 'GET_EXCEPTIONS') data = snapshot;
     if (message.action === 'GET_DOMAIN_LISTS') data = { lists: [], revision: snapshot.revision, proxyCatalog: profiles, defaultProxyId: 'custom:a' };
     if (message.action === 'GET_RULE_HISTORY') data = history;
     if (message.action === 'UNDO_RULE_CHANGE') {history[0].undoneAt=Date.now();data={restored:1,skipped:0};}
     if (message.action === 'GET_LOGS') data = {logs:[{timestamp:Date.now(),title:'Fixture',category:'network',details:{fixture:true}}],stats:{total:1}};
     if (message.action === 'GET_PAC_SCRIPT') data = {scriptKind:'preview',cookedPacData:'// fixture'};
     if (message.action === 'RENAME_PROXY_PROFILE') profiles.find(p=>p.id===message.proxyId).name=message.name;
     cb({success:true,data:structuredClone(data)});
    }}
   };
  }, catalog, lang);
  await page.goto(`http://127.0.0.1:${server.address().port}/pages/options/index.html`);
  await page.click('[data-tab=exceptions]'); await page.click('#manualRulesLink');
  await page.waitForSelector('#manualSitesEditor .domain-card', {visible:true});
  // This exhaustive scan deliberately includes disabled and currently hidden settings:
  // they become visible through navigation, expansion, auth, modal and retry states.
  const coverage = async label => {
   const result = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('button,input:not([type=file]):not([type=hidden]),select,textarea,summary,a[href],[role=button],[role=switch],[role=tab],.provider-card,.log-card:has(.log-details-block)')];
    return { count:controls.length, titles:controls.map(e=>e.title), missing:controls.filter(e=>!e.title.trim() || !e.getAttribute('aria-description')?.trim()).map(e=>e.id || e.outerHTML.slice(0,180)), secrets:controls.filter(e=>/secret|user:|127\.0\.0\.1:8080|example\.test\/pac/.test(e.title)).map(e=>e.title) };
   });
   assert.deepEqual(result.missing, [], `${lang} ${label}: controls without help`);
   assert.deepEqual(result.secrets, [], 'help must not interpolate credentials/endpoints');
   const translated = new Set(Object.entries(catalog).filter(([key])=>key.startsWith('settings_help_')).map(([,entry])=>entry.message));
   assert.ok(result.titles.every(title=>translated.has(title)), `${lang}: every help text must come from this locale's catalog`);
   return result.count;
  };
  const initial = await coverage('initial');
  await page.evaluate(async () => {
   const { renderApplicationBanner } = await import('./../shared/application-banner.js');
   renderApplicationBanner(document.getElementById('applicationBanner'), {pending:true}, async()=>{});
  });
  await coverage('application retry banner');
  // Attribute-only help must not alter geometry, typography, focus/validation references.
  for (const tab of ['pac','exceptions','proxies','mods','logs','history','tools','notifications','appearance']) {
   await page.click(`[data-tab=${tab}]`);
   const unchanged = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('body,.app-header,.nav-tabs,.statusbar,.tab-content.active,.tab-content.active button,.tab-content.active input,.tab-content.active select,.tab-content.active textarea')];
    const measure = ()=>nodes.map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return [r.x,r.y,r.width,r.height,s.padding,s.fontSize,s.lineHeight];});
    const before = measure();
    const attrs = [...document.querySelectorAll('[aria-description]')].map(e=>[e,e.getAttribute('title'),e.getAttribute('aria-description'),e.getAttribute('aria-label')]);
    for(const [e] of attrs) {e.removeAttribute('title');e.removeAttribute('aria-description');e.removeAttribute('aria-label');}
    const after = measure();
    for(const [e,title,description,label] of attrs) {e.setAttribute('title',title);e.setAttribute('aria-description',description);if(label!==null)e.setAttribute('aria-label',label);}
    return JSON.stringify(before)===JSON.stringify(after);
   });
   assert.ok(unchanged, `${tab}: help attributes must preserve geometry`);
   await coverage(tab);
  }
  await page.click('[data-tab=appearance]');
  await page.click('[data-accent=custom]'); await coverage('custom appearance');
  await page.click('[data-tab=proxies]');
  await page.click('#proxyAuthCheck'); await coverage('authentication fields');
  await page.click('[data-tab=proxies]');
  await page.click('.rename-proxy-btn'); await coverage('rename editor');
  await page.$eval('.proxy-profile-editor input', e=>{e.value='Renamed';e.dispatchEvent(new Event('input'));});
  await page.click('.proxy-profile-editor button');
  await page.waitForFunction(()=>document.querySelector('.proxy-profile-name')?.textContent==='Renamed');
  await coverage('rename readback');
  await page.click('.delete-btn'); await coverage('replacement editor');
  await page.click('.proxy-profile-editor button:last-of-type');
  await page.click('[data-tab=history]'); await page.waitForSelector('.history-row'); await coverage('history');
  await page.click('.history-row button');
  await page.waitForFunction(()=>document.querySelector('.history-row button')?.disabled); await coverage('undo rerender');
  await page.click('[data-tab=logs]'); await page.waitForSelector('.log-copy-btn'); await coverage('logs');
  await page.click('[data-tab=tools]'); await page.click('#viewPacScriptBtn'); await coverage('PAC modal'); await page.click('#closePacModalBtn');
  await page.click('[data-tab=exceptions]'); await page.click('#manualRulesLink'); await page.waitForSelector('#manualSitesEditor .domain-card', {visible:true});
  await page.$eval('#domainListContainer',e=>{e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'));});
  await page.waitForFunction(()=>document.querySelectorAll('.domain-card').length>=200); await coverage('next chunk');
  await page.$eval('#domainListContainer',e=>{e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'));});
  await page.waitForFunction(()=>document.querySelectorAll('.domain-card').length===205); await coverage('last chunk');
  await page.$eval('#searchDomainInput',e=>{e.value='site-001';e.dispatchEvent(new Event('input'));});
  await coverage('filtered rerender');
  await page.$eval('#searchDomainInput',e=>{e.value='';e.dispatchEvent(new Event('input'));});
  await page.click('.domain-select');
  assert.equal(await page.$eval('#selectAllFiltered',e=>e.indeterminate),true); await coverage('tristate selection');
  await page.click('#clearSelection'); await coverage('deselected rerender');
  await page.click('[data-subtab=excluded]'); await coverage('direct list');
  await page.click('[data-subtab=whitelist]'); await coverage('allowlist');
  await page.click('#modeToggleBtn'); await coverage('raw editor');
  assert.ok(await page.evaluate(()=>window.calls.some(m=>m.action==='RENAME_PROXY_PROFILE')));
  assert.deepEqual(errors, [], 'no startup/render errors');
  console.log(`PASS ${lang}: ${initial} initial controls; full DOM help scan after profile/history/log/site rerenders, chunking, tristate, tabs, raw editor and modal (RPC fixtures).`);
  await page.close();
 }
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
