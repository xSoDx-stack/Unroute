// Source-module DOM/RPC fixture proof, not installed-extension/network integration.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const root = path.resolve('src/common');
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const executablePath = process.env.CHROME_BIN || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(existsSync);
let browser;
try {
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  for (const lang of ['ru', 'en']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const messages = JSON.parse(readFileSync(path.join(root, '_locales', lang, 'messages.json'), 'utf8'));
    await page.evaluateOnNewDocument((messages, lang) => {
      const profiles = [
        { id:'custom:a', name:'Primary', endpoint:'HTTPS primary.example:443', enabled:true },
        { id:'custom:b', name:'Offline', endpoint:'HTTPS backup.example:8443', enabled:true },
        { id:'custom:c', name:'Stale', endpoint:'HTTP old.example:8080', enabled:true },
        { id:'custom:d', name:'Unchecked', endpoint:'HTTPS unknown.example:443', enabled:true },
        { id:'custom:e', name:'Long profile name '.repeat(4), endpoint:`HTTPS ${'long-host.'.repeat(12)}example:65535`, enabled:true },
      ];
      const snapshot = { revision:1,exceptions:{},whitelist:[],proxyCatalog:profiles,proxyProfiles:profiles,
        defaultProxyId:profiles[0].id,domainProxyIds:{},ruleMeta:{},customProxyStringRaw:profiles.map(p=>p.endpoint).join('; ') };
      const health = {
        [profiles[0].endpoint]:{ok:true,latency:32,checkedAt:Date.now()},
        [profiles[1].endpoint]:{ok:false,error:'Fixture unavailable',checkedAt:Date.now()},
        [profiles[2].endpoint]:{ok:true,latency:125,checkedAt:1},
      };
      window.fixture = { calls:[], finish:null };
      window.chrome = {
        i18n:{getUILanguage:()=>lang,getMessage:(key,values=[])=>{
          const entry=messages[key];return (entry?.message||'').replace(/\$([a-z_0-9]+)\$/gi,(match,name)=>entry.placeholders?.[name.toLowerCase()]?.content||match).replace(/\$(\d+)/g,(_,n)=>values[Number(n)-1]??'');
        }},
        storage:{onChanged:{addListener(){}},local:{get:(_keys,cb)=>cb({}),set:(_items,cb)=>cb?.()}},
        tabs:{query:async()=>[],create:async()=>{}},
        runtime:{getManifest:()=>({version:'fixture'}),onMessage:{addListener(){}},sendMessage:(message,cb)=>{
          window.fixture.calls.push(message);
          if(message.action==='CHECK_PROXY_HEALTH'){
            window.fixture.finish=result=>{health[message.proxy]={...result,checkedAt:Date.now()};cb({success:true,data:health[message.proxy]});};return;
          }
          let data={};
          if(message.action==='GET_STATE')data={version:'fixture',syncState:{providers:{},isControlled:true},pacMods:snapshot,defaultConfigs:{},notifications:{},proxyHealthMap:health,history:[]};
          if(message.action==='GET_EXCEPTIONS')data=snapshot;
          if(message.action==='GET_RULE_HISTORY')data=[];
          if(message.action==='GET_LOGS')data={logs:[],stats:{total:0}};
          cb({success:true,data});
        }},
      };
    }, messages, lang);
    await page.setViewport({width:900,height:700});
    await page.goto(`http://127.0.0.1:${server.address().port}/pages/options/index.html#proxies`);
    await page.waitForSelector('.proxy-item .recheck-btn svg');
    assert.equal(await page.$$eval('.proxy-item', rows=>rows.length),5);
    assert.deepEqual(await page.$$eval('.proxy-status-tag',nodes=>nodes.map(n=>n.className.split(' ').at(-1))),['online','offline','stale','unchecked','unchecked']);
    for (const theme of ['light','dark']) for (const width of [360,640,900,1200]) {
      await page.setViewport({width,height:800});
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      const geometry = await page.$$eval('.proxy-item', rows=>rows.map(row=>{
        const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
        return {info:rect(row.querySelector('.proxy-info')),status:rect(row.querySelector('.proxy-status-tag')),actions:rect(row.querySelector('.proxy-actions')),row:rect(row)};
      }));
      for (const {info,status,actions,row} of geometry) {
        if(width>640) assert.ok(status.left-info.right>=15,'desktop status needs a distinct column gap');
        else assert.ok(status.top-info.bottom>=9,'narrow status needs a distinct row gap');
        assert.ok(actions.left-status.right>=10,'status must not touch actions');
        assert.ok(actions.right<=row.right+1 && info.left>=row.left-1,'row content must fit its container');
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no page-level horizontal overflow');
    }
    await page.setViewport({width:900,height:800});
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
    await page.click('.recheck-btn');
    await page.waitForSelector('.recheck-btn.is-checking[disabled][aria-busy="true"]');
    assert.equal(await page.$eval('.recheck-btn',button=>Boolean(button.getAttribute('aria-label'))),true);
    assert.notEqual(await page.$eval('.recheck-btn svg',icon=>getComputedStyle(icon).animationName),'none');
    await page.$eval('.recheck-btn',button=>button.click());
    assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.action==='CHECK_PROXY_HEALTH').length),1,'no duplicate check while pending');
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    assert.equal(await page.$eval('.recheck-btn svg',icon=>getComputedStyle(icon).animationName),'none','reduced motion must stop checking rotation');
    await page.evaluate(()=>window.fixture.finish({ok:true,latency:0}));
    await page.waitForFunction(()=>document.querySelector('.proxy-status-tag').classList.contains('online') && !document.querySelector('.recheck-btn').disabled);
    assert.match(await page.$eval('.proxy-status-tag',node=>node.textContent),/^0\s/,'zero latency remains a valid numeric result');
    assert.equal(await page.$eval('.recheck-btn',button=>button.getAttribute('aria-busy')),'false');
    await page.click('.recheck-btn');
    await page.waitForSelector('.recheck-btn.is-checking');
    await page.evaluate(()=>window.fixture.finish({ok:false,error:'Fixture unavailable'}));
    await page.waitForSelector('.proxy-status-tag.offline');
    assert.equal(await page.$eval('.recheck-btn',button=>button.disabled),false,'failure must allow retry');
    assert.deepEqual(errors,[]);
    console.log(`PASS ${lang}: 5 health states, 360/640/900/1200 × light/dark gaps, long names/hosts, SVG, busy/duplicate guard, reduced motion, zero latency, failure/retry (RPC fixture).`);
    await page.close();
  }
} finally { if(browser)await browser.close();await new Promise(resolve=>server.close(resolve)); }
