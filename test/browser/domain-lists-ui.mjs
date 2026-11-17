// Source DOM + controlled RPC boundary; not a native extension/backend proof.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
const out = process.env.DOMAIN_LISTS_OUT || path.resolve('artifacts/domain-lists-ui');
await fs.mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--allow-file-access-from-files'] });
try {
 const page = await browser.newPage();
 const cdp=await page.createCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:out});
 const errors = [];
 page.on('pageerror', error => errors.push(error.message));
 await page.setJavaScriptEnabled(false);
 await page.goto(pathToFileURL(path.resolve('src/common/pages/options/index.html')).href);
 await page.setJavaScriptEnabled(true);
 await page.evaluate(async () => {
  window.proof = { messages: [], revision: 5, fail: null, pac:['bypass.test'], lists: [
   {id:'a',name:'Meta',proxyId:'p1',enabled:true,domains:['*.example.test','same.test']},
   {id:'b',name:'Media',proxyId:'missing:id',enabled:false,domains:['same.test']}
  ], catalog:[{id:'p1',name:'Alpha',enabled:true},{id:'p2',name:'Beta',enabled:true},{id:'off',name:'Off',enabled:false}] };
  window.chrome = { runtime: { sendMessage(m, done) {
   const p = window.proof; p.messages.push(structuredClone(m));
   if(p.pauseWrites && m.action==='SAVE_DOMAIN_LIST') {p.held={message:structuredClone(m),done};return;}
   const data = () => ({lists:p.lists.map(({domains,...l})=>({...l,count:domains.length})),revision:p.revision,proxyCatalog:p.catalog,defaultProxyId:'p1'});
   if(p.fail && (!p.fail.action || p.fail.action === m.action)) return done({success:false,error:{code:'RULES_CONFLICT',message:'Conflict'}});
   if(m.action==='GET_DOMAIN_LISTS') return done({success:true,data:data()});
   if(m.action==='GET_DOMAIN_LIST') return done({success:true,data:{list:structuredClone(p.lists.find(l=>l.id===m.listId)),revision:p.revision,proxyCatalog:p.catalog}});
   if(m.action==='GET_EXCEPTIONS') return done({success:true,data:{exceptions:{'manual.test':true},pacBypassDomains:[...p.pac],whitelist:[],revision:p.revision,proxyCatalog:p.catalog,defaultProxyId:'p1'}});
   if(m.expectedRevision !== p.revision) return done({success:false,error:{code:'RULES_CONFLICT',message:'Conflict'}});
   if(m.action==='SAVE_DOMAIN_LIST') {
    if(m.listId) Object.assign(p.lists.find(l=>l.id===m.listId),Object.fromEntries(Object.entries(m).filter(([k])=>['name','proxyId','enabled','domains'].includes(k))));
    else p.lists.push({id:'new'+p.revision,name:m.name,proxyId:m.proxyId,enabled:m.enabled,domains:m.domains||[]});
   } else if(m.action==='DELETE_DOMAIN_LIST') p.lists=p.lists.filter(l=>l.id!==m.listId);
   else if(m.action==='REORDER_DOMAIN_LISTS') p.lists=m.listIds.map(id=>p.lists.find(l=>l.id===id));
   else if(m.action==='SAVE_MODS') {p.manual=m.mods;if(m.mods.pacBypassDomains)p.pac=[...m.mods.pacBypassDomains];}
   else if(m.action==='MUTATE_DOMAIN_RULES') for(const operation of m.operations) {
    if(operation.mode==='pac-bypass' && !p.pac.includes(operation.domain)) p.pac.push(operation.domain);
    if(operation.mode==='pac') p.pac=p.pac.filter(domain=>domain!==operation.domain);
   }
   p.revision++; done({success:true,settingsState:{pending:false}});
  } } };
  const {initSitesEditor} = await import('./sites-editor.js');
  document.querySelector('#tab-exceptions').classList.add('active');
  window.proof.editor=initSitesEditor(document.querySelector('#tab-exceptions'),{notify:()=>{},onApplicationState:()=>{},navigate:()=>{}});
  await window.proof.editor.activate();
 });
 assert.equal(await page.$$eval('.domain-list-row', rows=>rows.length),2,'Sites opens the list catalog, not manual rules');
 assert.equal(await page.$eval('[data-list-id="b"] select',e=>e.value),'missing:id');
 assert.equal(await page.$eval('[data-list-id="b"] select',e=>e.selectedOptions[0].disabled),true);
 for (const theme of ['light','dark']) for (const [width,height] of [[1200,900],[1200,600],[900,900],[600,900],[360,780]]) {
  await page.setViewport({width,height});
  await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${theme} overflow ${width}`);
  if(width >= 900) {
   const metrics=await page.$$eval('.domain-list-row',rows=>rows.map(row=>{
    const box=row.getBoundingClientRect(),name=row.querySelector('.domain-list-name').getBoundingClientRect(),
      proxy=row.querySelector('select').getBoundingClientRect(),actions=row.querySelector('.domain-list-actions').getBoundingClientRect();
    return {height:box.height,aligned:Math.abs((proxy.top+proxy.height/2)-(actions.top+actions.height/2))<1,
      nameFits:name.right<=proxy.left};
   }));
   assert.ok(metrics.every(m=>m.height<=64),`${theme}: list cards must be compact, one-row desktop controls (${JSON.stringify(metrics)})`);
   assert.ok(metrics.every(m=>m.aligned && m.nameFits),`${theme}: symmetric aligned columns without overlaps`);
  }
  await page.screenshot({path:`${out}/catalog-${theme}-${width}x${height}.png`,fullPage:true});
 }
 await page.setViewport({width:1200,height:900});
 await page.click('.domain-list-row [data-open="a"]');
 await page.waitForSelector('[data-list-scope="a"] .domain-name');
 assert.equal(await page.$$eval('[data-list-scope="a"] .domain-name',es=>es.map(e=>e.textContent).join(',')),'*.example.test,same.test');
 assert.equal(await page.$$eval('[data-list-scope="a"] .domain-proxy-select',es=>es.length),0,'whole-list proxy only');
 for(const theme of ['light','dark']) for(const [width,height] of [[1200,900],[1200,600],[600,600],[360,780]]) {
  await page.setViewport({width,height});await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`${out}/domains-${theme}-${width}x${height}.png`,fullPage:true});
 }
 await page.setViewport({width:1200,height:900});
 const scoped='[data-list-scope="a"]';
 await page.type(`${scoped} input[id$="newDomainInput"]`,'https://added.test/path');
 await page.click(`${scoped} button[id$="addDomainBtn"]`);
 await page.waitForFunction(()=>window.proof.lists[0].domains.includes('added.test'));
 assert.deepEqual(await page.evaluate(()=>window.proof.lists[1].domains),['same.test'],'duplicate membership independent');
 let lastWrite=await page.evaluate(()=>window.proof.messages.filter(m=>m.action==='SAVE_DOMAIN_LIST').at(-1));
 assert.equal(lastWrite.listId,'a'); assert.equal(lastWrite.expectedRevision,5); assert.equal(lastWrite.proxyId,undefined);
 const upload = async (selector,text,name='domains.txt') => page.$eval(selector,(input,content,filename)=>{
  const transfer=new DataTransfer(); transfer.items.add(new File([content],filename,{type:'text/plain'})); input.files=transfer.files;input.dispatchEvent(new Event('change'));
 },text,name);
 await upload(`${scoped} input[id$="fileImportInput"]`,'replacement.test\nnot a domain\n');
 await page.waitForSelector('dialog[open]');
 assert.match(await page.$eval('dialog p',e=>e.textContent),/1.*1/,'preview includes invalid row count before save');
 await page.screenshot({path:`${out}/replace-preview.png`,fullPage:true});
 await page.click('dialog .btn-primary');
 await page.waitForFunction(()=>window.proof.lists[0].domains.length===1 && window.proof.lists[0].domains[0]==='replacement.test');
 await upload(`${scoped} input[id$="fileImportInput"]`,'invalid row');
 await page.waitForFunction(()=>!document.querySelector('[data-list-scope="a"] input[id$="fileImportInput"]').value);
 assert.deepEqual(await page.evaluate(()=>window.proof.lists[0].domains),['replacement.test'],'invalid file cannot erase list');
 await page.type(`${scoped} input[id$="newDomainInput"]`,'keep.test');await page.click(`${scoped} button[id$="addDomainBtn"]`);
 await page.waitForFunction(()=>document.querySelector('[data-list-scope="a"] button[id$="addDomainBtn"]').disabled===false);
 await page.type(`${scoped} input[id$="searchDomainInput"]`,'replacement');
 await page.click(`${scoped} input[id$="selectAllFiltered"]`);await page.click(`${scoped} button[id$="bulkDelete"]`);
 await page.waitForSelector('dialog[open]');await page.click('dialog .btn-primary');
 await page.waitForFunction(()=>window.proof.lists[0].domains.length===1 && window.proof.lists[0].domains[0]==='keep.test');
 await page.$eval(`${scoped} input[id$="searchDomainInput"]`,e=>{e.value='';e.dispatchEvent(new Event('input'));});
 await fs.rm(`${out}/proxied-domains.txt`,{force:true});
 await page.click(`${scoped} button[id$="exportFileBtn"]`);
 let exported;
 for(let attempt=0;attempt<100;attempt++) {try {exported=await fs.readFile(`${out}/proxied-domains.txt`,'utf8');break;}catch {await new Promise(resolve=>setTimeout(resolve,50));}}
 assert.equal(exported,'keep.test\n','actual browser download contains only the selected list, not manual/all-list rules');
 await page.click(`${scoped} button[id$="modeToggleBtn"]`);
 await page.waitForFunction(()=>document.querySelector('[data-list-scope="a"] textarea').offsetHeight>0);
 await page.$eval(`${scoped} textarea`,e=>{e.value='raw.test\n*.raw.test';e.dispatchEvent(new Event('input'));});
 assert.equal(await page.evaluate(()=>window.proof.editor.flush()),true);
 await page.click('#domainListsBack');
 await page.waitForFunction(()=>!document.querySelector('#domainListsOverview').hidden);
 await page.click('#domainListAdd'); await page.type('#domainListName','Empty'); await page.select('#domainListProxy','p2');
 await page.click('#domainListSave');
 await page.waitForFunction(()=>window.proof.lists.length===3);
 assert.deepEqual(await page.evaluate(()=>window.proof.lists[2].domains),[]);
 await page.waitForFunction(()=>document.querySelector('#domainListForm').hidden);
 await page.click('#domainListImport'); await page.type('#domainListName','Imported');
 await upload('#domainListFile','https://import.test/path\n*.import.test\ninvalid row');
 await page.waitForFunction(()=>!document.querySelector('#domainListSave').disabled);
 assert.match(await page.$eval('#domainListPreview',e=>e.textContent),/2.*1/);
 await page.click('#domainListSave');
 await page.waitForFunction(()=>window.proof.lists.length===4);
 await page.waitForFunction(()=>document.querySelector('#domainListForm').hidden);
 assert.deepEqual(await page.evaluate(()=>window.proof.lists[3].domains),['import.test','*.import.test']);
 await page.click('[data-list-id="b"] input[type=checkbox]');
 await page.waitForFunction(()=>window.proof.lists[1].enabled);
 assert.equal(await page.$eval('[data-list-id="b"] select',e=>e.value),'missing:id','toggling retains missing proxy ID');
 await page.click('[data-list-id="b"] button[aria-label^="Выше"]');
 await page.waitForFunction(()=>window.proof.lists[0].id==='b');
 await page.click('[data-open="a"]');
 await page.waitForSelector(`${scoped} textarea`,{visible:true});
 assert.equal(await page.$eval(`${scoped} textarea`,e=>e.value),'raw.test\n*.raw.test','cached editor retains its own raw state');
 await page.evaluate(()=>{window.proof.fail={action:'SAVE_DOMAIN_LIST'};});
 await page.$eval(`${scoped} textarea`,e=>{e.value='conflicted.test';e.dispatchEvent(new Event('input'));});
 assert.equal(await page.evaluate(()=>window.proof.editor.flush()),false);
 await page.click('#domainListsBack');
 assert.equal(await page.$eval('#domainListsOverview',e=>e.hidden),true,'conflict blocks navigation and retains draft');
 assert.equal(await page.$eval(`${scoped} textarea`,e=>e.value),'conflicted.test');
 await page.evaluate(()=>{window.proof.fail=null;window.proof.revision++;});
 await page.click(`${scoped} button[id$="rawRetrySave"]`);
 await page.waitForFunction(()=>document.querySelector('[data-list-scope="a"] button[id$="rawRetrySave"]').hidden);
 assert.deepEqual(await page.evaluate(()=>window.proof.lists.find(l=>l.id==='a').domains),['conflicted.test']);
 for (const theme of ['light','dark']) for (const width of [1200,600,360]) {
  await page.setViewport({width,height:600}); await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`${out}/scoped-${theme}-${width}x600.png`,fullPage:true});
 }
 await page.setViewport({width:1200,height:900});
 await page.click('#domainListsBack'); await page.waitForFunction(()=>!document.querySelector('#domainListsOverview').hidden);
 await page.click('#manualRulesLink'); await page.waitForSelector('#manualSitesEditor .domain-name',{visible:true});
 assert.equal(await page.$eval('#manualSitesEditor .domain-name',e=>e.textContent),'manual.test');
 await page.click('#manualSitesEditor [data-subtab="pac"]');
 assert.equal(await page.$eval('#manualSitesEditor .domain-name',e=>e.textContent),'bypass.test');
 await page.type('#manualSitesEditor #newDomainInput','another-bypass.test'); await page.click('#manualSitesEditor #addDomainBtn');
 await page.waitForFunction(()=>window.proof.messages.some(m=>m.action==='MUTATE_DOMAIN_RULES' && m.operations.some(o=>o.mode==='pac-bypass')));
 await page.waitForFunction(()=>document.querySelector('#manualSitesEditor #newDomainInput').value==='');
 await page.click('#manualSitesEditor #modeToggleBtn');
 await page.$eval('#manualSitesEditor #rawTextEditor',e=>{e.value='raw-bypass.test';e.dispatchEvent(new Event('input'));});
 assert.equal(await page.evaluate(()=>window.proof.editor.flush()),true);
 assert.deepEqual(await page.evaluate(()=>window.proof.pac),['raw-bypass.test']);
 assert.deepEqual(await page.evaluate(()=>window.proof.messages.filter(m=>m.action==='SAVE_MODS').at(-1).mods),{pacBypassDomains:['raw-bypass.test']},'PAC raw is an independent revision-guarded patch');
 await page.click('#domainListsBack'); await page.waitForFunction(()=>!document.querySelector('#domainListsOverview').hidden);
 await page.click('[data-list-id="a"] .domain-list-actions button:nth-child(3)');
 await page.$eval('#domainListName',e=>{e.value='Renamed';}); await page.click('#domainListSave');
 await page.waitForFunction(()=>document.querySelector('#domainListForm').hidden);
 assert.equal(await page.evaluate(()=>window.proof.lists.find(l=>l.id==='a').name),'Renamed');
 await page.click('[data-list-id="b"] .btn-danger'); await page.waitForSelector('dialog[open]');
 await page.click('dialog .btn-secondary'); assert.equal(await page.evaluate(()=>window.proof.lists.some(l=>l.id==='b')),true);
 await page.click('[data-list-id="b"] .btn-danger'); await page.waitForSelector('dialog[open]'); await page.click('dialog .btn-primary');
 await page.waitForFunction(()=>!document.querySelector('[data-list-id="b"]'));
 await page.click('#domainListAdd'); await page.type('#domainListName','Readback retained');
 await page.evaluate(()=>{window.proof.fail={action:'GET_DOMAIN_LISTS'};window.proof.beforeCreate=window.proof.messages.filter(m=>m.action==='SAVE_DOMAIN_LIST' && !m.listId).length;});
 await page.click('#domainListSave'); await page.waitForSelector('#domainListsRetry',{visible:true});
 assert.equal(await page.$eval('#domainListSave',e=>e.disabled),true,'readback failure disables replay of committed create');
 assert.equal(await page.$eval('#domainListName',e=>e.value),'Readback retained');
 await page.evaluate(()=>{window.proof.fail=null;}); await page.click('#domainListsRetry');
 await page.waitForFunction(()=>document.querySelector('#domainListForm').hidden);
 assert.equal(await page.evaluate(()=>window.proof.messages.filter(m=>m.action==='SAVE_DOMAIN_LIST' && !m.listId).length-window.proof.beforeCreate),1,'readback retry never duplicates creation');
 await page.click('#manualRulesLink'); await page.waitForSelector('#manualSitesEditor #rawTextEditor',{visible:true});
 assert.equal(await page.$eval('#manualSitesEditor #rawTextEditor',e=>e.value),'raw-bypass.test','manual raw cache survives list rename/delete/create');
 await page.click('#manualSitesEditor #modeToggleBtn');
 await page.waitForSelector('#manualSitesEditor .delete-domain-btn',{visible:true}); await page.click('#manualSitesEditor .delete-domain-btn');
 await page.waitForFunction(()=>window.proof.pac.length===0);
 assert.equal(await page.evaluate(()=>window.proof.messages.filter(m=>m.action==='MUTATE_DOMAIN_RULES').at(-1).operations[0].mode),'pac');
 await page.waitForFunction(()=>document.querySelector('#manualSitesEditor #addDomainBtn').disabled===false);
 await page.click('#domainListsBack');await page.waitForFunction(()=>!document.querySelector('#domainListsOverview').hidden);
 await page.click('[data-open="a"]');await page.waitForSelector(`${scoped} textarea`,{visible:true});
 await page.evaluate(()=>{window.proof.pauseWrites=true;});
 await page.$eval(`${scoped} textarea`,e=>{e.value='reset-draft.test';e.dispatchEvent(new Event('input'));});
 await page.evaluate(()=>{window.proof.inflight=window.proof.editor.flush();});
 await page.waitForFunction(()=>Boolean(window.proof.held));
 await page.evaluate(()=>{const p=window.proof;p.editor.invalidate();p.revision++;p.pauseWrites=false;p.afterInvalidate=p.messages.length;p.held.done({success:false,error:{code:'RULES_CONFLICT',message:'Reset'}});});
 assert.equal(await page.evaluate(()=>window.proof.inflight),false,'generation invalidates in-flight writes');
 assert.equal(await page.$eval(`${scoped} textarea`,e=>e.value),'reset-draft.test');
 assert.equal(await page.evaluate(()=>window.proof.messages.slice(window.proof.afterInvalidate).some(m=>m.action==='SAVE_DOMAIN_LIST')),false,'reset does not auto-replay the cached raw draft');
 assert.equal(await page.evaluate(()=>window.proof.held.message.listId),'a','write captures immutable list ID');
 await page.click(`${scoped} button[id$="rawRetrySave"]`);
 await page.waitForFunction(()=>window.proof.lists.find(l=>l.id==='a').domains[0]==='reset-draft.test');
 assert.equal(await page.evaluate(()=>window.proof.messages.some(m=>m.action==='GET_DOMAIN_LISTS' && 'domains' in m)),false);
 assert.deepEqual(errors,[]);
 await fs.writeFile(`${out}/proof.json`,JSON.stringify(await page.evaluate(()=>({messages:window.proof.messages,lists:window.proof.lists})),null,2));
 console.log('PASS source DOM: collections CRUD/reorder/profiles, shared scoped editor/raw/conflict/import/independent memberships, manual PAC category; light/dark responsive screenshots. Controlled RPC only, not native proof.');
} finally { await browser.close(); }
