// Real source options modules in Chrome, controlled RPC boundary; not native backend integration.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--allow-file-access-from-files']});
const failures=[];
async function scenario(name, run) {
 const page=await browser.newPage();
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.setJavaScriptEnabled(false);
  await page.goto(pathToFileURL(path.resolve('src/common/pages/options/index.html')).href);
  await page.setJavaScriptEnabled(true);
  await page.evaluate(async()=>{
   const p=window.proof={messages:[],fail:null,held:[],hold:null,revision:1,lists:[
    {id:'a',name:'A',proxyId:'p1',enabled:true,domains:['a.test']},
    {id:'b',name:'B',proxyId:'p1',enabled:true,domains:['b.test']},
    {id:'c',name:'C',proxyId:'p1',enabled:true,domains:['c.test']}],
    mods:{proxyCatalog:[],customProxyStringRaw:'',ifProxyHttpsUrlsOnly:false,ifProxyOrDie:true},
    notifications:{'pac-error':true},sync:{currentPacProviderKey:'Антизапрет',isControlled:true,providers:{},customPacUrl:'https://old.test/proxy.pac'},logs:[]};
   p.catalog=[{id:'p1',name:'Alpha',enabled:true}];
   window.confirm=()=>true;
   chrome={runtime:{getManifest:()=>({version:'2.2.30'}),sendMessage(m,done){
    p.messages.push(structuredClone(m));
    if(p.hold===m.action){p.held.push({m,done});return;}
    if(p.fail===m.action)return done({success:false,error:'Simulated '+m.action+' failure'});
    const summary=()=>({lists:p.lists.map(({domains,...l})=>({...l,count:domains.length})),revision:p.revision,proxyCatalog:p.catalog,defaultProxyId:'p1'});
    if(m.action==='GET_STATE')return done({success:true,data:{pacMods:structuredClone(p.mods),syncState:structuredClone(p.sync),notifications:{...p.notifications},proxyHealthMap:p.proxyHealthMap},settingsState:{pending:false}});
    if(m.action==='GET_LOGS')return done({success:true,data:{logs:p.logs,stats:{total:p.logs.length}}});
    if(m.action==='GET_RULE_HISTORY')return done({success:true,data:p.history||[]});
    if(m.action==='EXPORT_LOGS')return done({success:true,data:{text:'Unroute test log',count:1}});
    if(m.action==='GET_DOMAIN_LISTS')return done({success:true,data:summary()});
    if(m.action==='GET_DOMAIN_LIST')return done({success:true,data:{list:structuredClone(p.lists.find(l=>l.id===m.listId)),revision:p.revision,proxyCatalog:p.catalog}});
    if(m.action==='GET_EXCEPTIONS')return done({success:true,data:{exceptions:{'manual.test':true},pacBypassDomains:[],whitelist:[],revision:p.revision,proxyCatalog:p.catalog,defaultProxyId:'p1'}});
    if(m.action==='DELETE_DOMAIN_LIST'){p.lists=p.lists.filter(l=>l.id!==m.listId);p.revision++;return done({success:true});}
    if(m.action==='RESET_SETTINGS'){p.mods={proxyCatalog:[],customProxyStringRaw:''};p.sync={currentPacProviderKey:'none',providers:{}};p.notifications={};p.lists=[];p.logs=[];p.history=[];p.revision++;return done({success:true});}
    if(m.action==='SAVE_MODS'){Object.assign(p.mods,m.mods);return done({success:true,data:structuredClone(p.mods),settingsState:{pending:p.pending===true}});}
    if(m.action==='SET_NOTIFICATION_OPTION'){p.notifications[m.key]=m.enabled;return done({success:true});}
    if(m.action==='CLEAR_PAC'){p.sync.currentPacProviderKey='none';return done({success:true,data:{...p.sync}});}
    if(m.action==='INSTALL_PAC'){p.sync.currentPacProviderKey=m.key;p.sync.customPacUrl=m.customPacUrl;return done({success:true,data:{...p.sync}});}
    done({success:true,data:{}});
   }},storage:{local:{get:(_keys,done)=>done({})},onChanged:{addListener(listener){p.storageChanged=listener;}}}};
   await import('./app.js');
  });
  await page.waitForFunction(()=>proof.messages.some(m=>m.action==='GET_DOMAIN_LISTS'));
  await run(page);
  assert.deepEqual(errors,[],'no uncaught source errors');
  console.log('PASS '+name);
 }catch(error){failures.push(name+': '+error.message);console.error('FAIL '+name+': '+error.message);}
 finally{await page.close();}
}
const click=async(page,id)=>page.$eval(id,e=>e.click());
const input=async(page,id,value)=>page.$eval(id,(e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));},value);
try {
 await scenario('Custom PAC apply and card use backend loopback-only policy',async page=>{
  await click(page,'[data-tab="pac"]');
  for(const url of ['http://192.168.1.10/p.pac','http://10.0.0.1/p.pac','http://172.16.0.1/p.pac','http://169.254.1.1/p.pac','https://u:p@example.test/p.pac','file:///p.pac']){
   await input(page,'#customPacUrlInput',url);
   const before=await page.evaluate(()=>proof.messages.filter(m=>m.action==='INSTALL_PAC').length);
   await click(page,'#saveCustomPacUrlBtn');
   assert.equal(await page.evaluate(()=>proof.messages.filter(m=>m.action==='INSTALL_PAC').length),before,'invalid apply must not send RPC: '+url);
   await click(page,'[data-provider="customPacUrl"]');
   assert.equal(await page.evaluate(()=>proof.messages.filter(m=>m.action==='INSTALL_PAC').length),before,'invalid card must not send RPC: '+url);
  }
  for(const url of ['http://localhost/p.pac','http://127.12.0.1/p.pac','http://[::1]/p.pac','https://example.test/p.pac']){
   await input(page,'#customPacUrlInput',url);await click(page,'#saveCustomPacUrlBtn');
   assert.equal(await page.evaluate(()=>proof.messages.filter(m=>m.action==='INSTALL_PAC').at(-1).customPacUrl),url);
  }
 });
 await scenario('open proxy editor retains focus and selection on health refresh',async page=>{
  await page.evaluate(()=>{
   proof.mods.customProxyStringRaw='HTTP one.test:8080';
   proof.mods.proxyCatalog=[{id:'p1',name:'First',endpoint:'HTTP one.test:8080',enabled:true}];
   window.dispatchEvent(new Event('focus'));
  });
  await click(page,'[data-tab="proxies"]');
  await page.waitForSelector('.edit-proxy-btn:enabled',{timeout:3000});
  await click(page,'.edit-proxy-btn');
  await page.$eval('.proxy-connection-editor [name=name]',e=>{
   e.focus(); e.setSelectionRange(1,3); proof.editorInput=e;
   proof.proxyHealthMap={'HTTP one.test:8080':{ok:true,latency:123,checkedAt:Date.now()}};
   window.dispatchEvent(new Event('focus'));
  });
  await page.waitForFunction(()=>document.querySelector('.proxy-status-tag')?.textContent.includes('123'),{timeout:3000});
  assert.equal(await page.evaluate(()=>document.activeElement===proof.editorInput && proof.editorInput.selectionStart===1 && proof.editorInput.selectionEnd===3),true);
 });
 await scenario('PAC dialog closes via Escape and restores focus',async page=>{
  await click(page,'[data-tab="tools"]');
  await page.click('#viewPacScriptBtn');
  await page.waitForSelector('#pacScriptModal[open]');
  assert.equal(await page.$eval('#pacScriptModal',e=>e.matches(':modal')),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#pacScriptModal',e=>e.open),false);
  assert.equal(await page.$eval('#viewPacScriptBtn',e=>document.activeElement===e),true);
 });
 await scenario('missing proxy choices stay explicit',async page=>{
  await page.evaluate(()=>{
   Object.assign(proof.mods,{defaultProxyId:'missing-main',fallbackProxyId:'missing-backup'});
   window.dispatchEvent(new Event('focus'));
  });
  await page.waitForFunction(()=>proof.messages.filter(m=>m.action==='GET_STATE').length>1,{timeout:3000});
  for(const [id,value] of [['defaultProxySelect','missing-main'],['proxyFailoverSelect','missing-backup']]) {
   assert.deepEqual(await page.$eval('#'+id,e=>[e.value,e.selectedOptions[0]?.disabled]),[value,true]);
  }
 });
 await scenario('credential fields use credential-specific autofill hints',async page=>{
  assert.equal(await page.$eval('#proxyUser',e=>e.autocomplete),'off');
  assert.equal(await page.$eval('#proxyPass',e=>e.autocomplete),'new-password');
 });
 await scenario('external deletion removes the active scoped editor',async page=>{
  await click(page,'[data-open="a"]');
  await page.waitForSelector('[data-list-scope="a"]');
  await page.evaluate(()=>{
   proof.lists=proof.lists.filter(list=>list.id!=='a');
   proof.revision++;
   window.dispatchEvent(new Event('focus'));
  });
  await page.waitForFunction(()=>!document.querySelector('[data-list-scope="a"]'),{timeout:3000});
  assert.equal(await page.$eval('#domainListsOverview',e=>e.hidden),false);
 });
 await scenario('reset restores diagnostic and proxy add controls',async page=>{
  await click(page,'[data-tab="tools"]');
  await page.evaluate(()=>{proof.hold='TEST_CONNECTION';});
  await click(page,'#testConnBtn');
  await page.waitForFunction(()=>proof.held.length===1);
  await page.evaluate(()=>{
   document.querySelector('#proxyProtocol').value='HTTPS';
   const auth=document.querySelector('#proxyAuthCheck');
   auth.checked=true;auth.dispatchEvent(new Event('change'));
   proof.hold='GET_DOMAIN_LISTS';
  });
  await click(page,'#resetSettingsBtn');
  await page.waitForFunction(()=>proof.held.some(entry=>entry.m.action==='GET_DOMAIN_LISTS'));
  await page.evaluate(()=>{
   proof.hold=null;
   proof.storageChanged({'pac-kitchen-mods':{oldValue:{_revision:1}}},'local');
   proof.held.find(entry=>entry.m.action==='GET_DOMAIN_LISTS').done({success:true,data:{lists:[],revision:proof.revision,proxyCatalog:[]}});
  });
  await page.waitForFunction(()=>!document.querySelector('#resetSettingsBtn').disabled);
  assert.equal(await page.$eval('#domainListsRetry',e=>e.hidden),true,'reset storage event must not cancel its own readback');
  await page.evaluate(()=>proof.held[0].done({success:true,latency:42}));
  assert.deepEqual(await page.evaluate(()=>[document.querySelector('#testConnBtn').disabled,
   document.querySelector('#connResult').textContent,document.querySelector('#proxyProtocol').selectedIndex,
   document.querySelector('#proxyAuthCheck').checked,document.querySelector('#proxyAuthFields').style.display]),
   [false,'',0,false,'none']);
 });
 await scenario('scoped IDs unique after deletion',async page=>{
  for(const id of ['a','b']) {
   await click(page,`[data-open="${id}"]`);
   await page.waitForSelector(`[data-list-scope="${id}"] .domain-name`);
   await click(page,'#domainListsBack');
  }
  await click(page,'[data-list-id="a"] .btn-danger');
  await page.waitForSelector('dialog[open]');await click(page,'dialog .btn-primary');
  await page.waitForFunction(()=>!document.querySelector('[data-list-id="a"]'));
  await click(page,'[data-open="c"]');await page.waitForSelector('[data-list-scope="c"] .domain-name');
  assert.deepEqual(await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return ids.filter((id,i)=>ids.indexOf(id)!==i);}),[]);
 });
 for(const [selector,action,oldValue] of [['#httpsOnlyToggle','SAVE_MODS',false],['#notifPacErrorToggle','SET_NOTIFICATION_OPTION',true]]) {
  await scenario(`${action} failed toggle rolls back truthfully`,async page=>{
   await page.evaluate(a=>{proof.fail=a;},action);
   await page.$eval(selector,e=>{e.checked=!e.checked;e.dispatchEvent(new Event('change'));});
   await page.waitForFunction(a=>proof.messages.some(m=>m.action===a),{},action);
   assert.equal(await page.$eval(selector,e=>e.checked),oldValue);
   assert.match(await page.$eval('#toast',e=>e.textContent),/Simulated/);
   assert.equal(await page.$eval(selector,e=>e.disabled),false);
  });
 }
 await scenario('CLEAR_PAC failure restores radio and reports error',async page=>{
  await page.evaluate(()=>{proof.fail='CLEAR_PAC';});
  await click(page,'[data-provider="none"] input');
  await page.waitForFunction(()=>proof.messages.some(m=>m.action==='CLEAR_PAC'));
  assert.match(await page.$eval('#toast',e=>e.textContent),/Simulated/);
  assert.equal(await page.$eval('[data-provider="none"] input',e=>e.checked),false);
 });
 await scenario('RESET_SETTINGS failure preserves draft and reports error',async page=>{
  await input(page,'#customProxyText','HTTP draft.test:8080');
  await page.evaluate(()=>{proof.fail='RESET_SETTINGS';});await click(page,'#resetSettingsBtn');
  await page.waitForFunction(()=>proof.messages.some(m=>m.action==='RESET_SETTINGS'));
  assert.match(await page.$eval('#toast',e=>e.textContent),/Simulated/);
  assert.equal(await page.$eval('#customProxyText',e=>e.value),'HTTP draft.test:8080');
 });
 await scenario('reset clears drafts despite failed readback',async page=>{
  await input(page,'#customProxyText','HTTP draft.test:8080');
  await input(page,'#customPacUrlInput','https://draft.test/proxy.pac');
  await input(page,'#logsSearchInput','old search');
  await click(page,'[data-open="a"]');await page.waitForSelector('[data-list-scope="a"] .domain-name');
  await page.evaluate(()=>{proof.fail='GET_STATE';});await click(page,'#resetSettingsBtn');
  await page.waitForFunction(()=>proof.messages.some(m=>m.action==='RESET_SETTINGS'));
  assert.equal(await page.$eval('#customProxyText',e=>e.value),'');
  assert.equal(await page.$eval('#customPacUrlInput',e=>e.value),'');
  assert.equal(await page.$eval('#logsSearchInput',e=>e.value),'');
  assert.equal(await page.$$eval('[data-list-scope]',es=>es.length),0);
  assert.match(await page.$eval('#toast',e=>e.textContent),/обнов|refresh/i);
 });
 await scenario('download uses current product name',async page=>{
  const download=await page.evaluate(async()=>{
   let filename;const click=HTMLAnchorElement.prototype.click;
   HTMLAnchorElement.prototype.click=function(){filename=this.download;};
   document.getElementById('exportLogsBtn').click();
   await new Promise(r=>setTimeout(r,10));HTMLAnchorElement.prototype.click=click;return filename;
  });
  assert.match(download,/^unroute-logs-\d{4}-\d{2}-\d{2}\.txt$/);
 });
 await scenario('log controls share filters and render 150 entries in one list mutation',async page=>{
  const result=await page.evaluate(async()=>{
   const list=document.getElementById('logsContainer');
   proof.logs=Array.from({length:150},(_,i)=>({title:`Entry ${i}`,level:'warn',category:'rules',timestamp:Date.now(),details:{i}}));
   let mutations=0;
   const measured=new MutationObserver(records=>{mutations+=records.length;});
   measured.observe(list,{childList:true});
   document.querySelector('[data-category="rules"]').click();
   await new Promise(r=>setTimeout(r,0));
   measured.disconnect();
   const select=document.getElementById('logsLevelSelect');
   select.value='warn';
   select.dispatchEvent(new Event('change'));
   const search=document.getElementById('logsSearchInput');
   search.value='  Entry ';
   search.dispatchEvent(new Event('input'));
   const start=proof.messages.length;
   const anchorClick=HTMLAnchorElement.prototype.click;
   HTMLAnchorElement.prototype.click=()=>{};
   try {
    document.getElementById('refreshLogsBtn').click();
    document.getElementById('copyLogsBtn').click();
    document.getElementById('exportLogsBtn').click();
    await new Promise(r=>setTimeout(r,0));
   } finally {HTMLAnchorElement.prototype.click=anchorClick;}
   const hint=list.querySelector('.log-expand-hint');
   hint.click();
   return {mutations, cards:list.childElementCount, selected:document.querySelector('[data-category="rules"]').getAttribute('aria-pressed'),
    native:select instanceof HTMLSelectElement, named:Boolean(select.getAttribute('aria-label')),
    help:hint.getAttribute('aria-description'), expanded:hint.getAttribute('aria-expanded'), messages:proof.messages.slice(start)};
  });
  assert.equal(result.mutations,1);
  assert.equal(result.cards,150);
  assert.equal(result.selected,'true');
  assert.ok(result.native && result.named && result.help);
  assert.equal(result.expanded,'true');
  const filters={category:'rules',level:'warn',search:'Entry'};
  assert.deepEqual(result.messages,[{action:'GET_LOGS',...filters,limit:150},{action:'EXPORT_LOGS',...filters},{action:'EXPORT_LOGS',...filters}]);
 });
 await scenario('reset rejects stale raw-save readback and old log replies',async page=>{
  await input(page,'#customProxyText','HTTP stale.test:8080');
  await page.evaluate(()=>{proof.hold='GET_STATE';});
  await click(page,'#saveProxiesBtn');
  await page.waitForFunction(()=>proof.held.length===1);
  await page.evaluate(()=>{proof.hold='GET_LOGS';});
  await click(page,'#refreshLogsBtn');
  await page.waitForFunction(()=>proof.held.length===2);
  await page.evaluate(()=>{proof.hold=null;});await click(page,'#resetSettingsBtn');
  await page.waitForFunction(()=>!document.getElementById('resetSettingsBtn').disabled);
  const toast=await page.$eval('#toast',e=>e.textContent);
  await page.evaluate(()=>{
   proof.held[0].done({success:true,data:{pacMods:{customProxyStringRaw:'HTTP stale.test:8080',proxyCatalog:[]},syncState:{currentPacProviderKey:'customPacUrl',customPacUrl:'https://stale.test',providers:{}}}});
   proof.held[1].done({success:true,data:{logs:[{message:'stale log',category:'system',timestamp:Date.now()}],stats:{total:1}}});
  });
  await page.waitForFunction(()=>!document.getElementById('saveProxiesBtn').disabled);
  assert.equal(await page.$eval('#customProxyText',e=>e.value),'');
  assert.equal(await page.$eval('#customPacUrlInput',e=>e.value),'');
  assert.equal(await page.$eval('#toast',e=>e.textContent),toast,'old continuation cannot overwrite reset acknowledgement');
  assert.doesNotMatch(await page.$eval('#logsContainer',e=>e.textContent),/stale log/);
  assert.doesNotMatch(await page.$eval('#proxyDraftHint',e=>e.textContent),/Не сохранено|изменился/);
 });
 await scenario('pending modifiers remain saved-not-applied and old toggle failure cannot undo reset',async page=>{
  await page.evaluate(()=>{proof.pending=true;});
  await page.$eval('#httpsOnlyToggle',e=>{e.checked=true;e.dispatchEvent(new Event('change'));});
  assert.equal(await page.$eval('#httpsOnlyToggle',e=>e.checked),true);
  assert.match(await page.$eval('#toast',e=>e.textContent),/ожидает|waiting/);
  assert.equal(await page.$eval('#applicationBanner',e=>e.hidden),false);
  await page.evaluate(()=>{proof.hold='SAVE_MODS';});
  await page.$eval('#httpsOnlyToggle',e=>{e.checked=false;e.dispatchEvent(new Event('change'));});
  assert.equal(await page.$eval('#httpsOnlyToggle',e=>e.disabled),true);
  await page.evaluate(()=>{proof.hold=null;});await click(page,'#resetSettingsBtn');
  await page.waitForFunction(()=>!document.getElementById('resetSettingsBtn').disabled);
  const toast=await page.$eval('#toast',e=>e.textContent);
  await page.evaluate(()=>proof.held[0].done({success:false,error:'stale failure'}));
  await page.waitForFunction(()=>!document.getElementById('httpsOnlyToggle').disabled);
  assert.equal(await page.$eval('#httpsOnlyToggle',e=>e.checked),false);
  assert.equal(await page.$eval('#toast',e=>e.textContent),toast);
 });
 await scenario('RPC transport exceptions restore toggle and PAC controls',async page=>{
  await page.evaluate(()=>{const send=chrome.runtime.sendMessage;chrome.runtime.sendMessage=(m,done)=>{if(['SAVE_MODS','INSTALL_PAC','CLEAR_PAC'].includes(m.action))throw new Error('Transport failure');return send(m,done);};});
  await page.$eval('#httpsOnlyToggle',e=>{e.checked=true;e.dispatchEvent(new Event('change'));});
  await page.waitForFunction(()=>!document.getElementById('httpsOnlyToggle').disabled);
  assert.equal(await page.$eval('#httpsOnlyToggle',e=>e.checked),false);
  await input(page,'#customPacUrlInput','https://example.test/proxy.pac');await click(page,'#saveCustomPacUrlBtn');
  await page.waitForFunction(()=>!document.getElementById('saveCustomPacUrlBtn').disabled,{timeout:1000});
  assert.match(await page.$eval('#toast',e=>e.textContent),/Transport failure/);
 });
 await scenario('reset discards profile editor and manual raw draft, late PAC result cannot return',async page=>{
  await page.evaluate(()=>{
   proof.mods.customProxyStringRaw='HTTP proxy.test:8080';
   proof.mods.proxyCatalog=[{id:'p1',name:'Alpha',enabled:true,endpoint:'HTTP proxy.test:8080'}];
   window.dispatchEvent(new Event('focus'));
  });
  await page.waitForSelector('.edit-proxy-btn');await click(page,'.edit-proxy-btn');
  await input(page,'.proxy-profile-editor input','Discard me');
  await click(page,'#manualRulesLink');await page.waitForSelector('#manualSitesEditor .domain-name');
  await click(page,'#manualSitesEditor #modeToggleBtn');
  await input(page,'#manualSitesEditor #rawTextEditor','old-manual.test');
  await page.evaluate(()=>{proof.hold='INSTALL_PAC';});
  await input(page,'#customPacUrlInput','https://old-install.test/proxy.pac');await click(page,'#saveCustomPacUrlBtn');
  await page.waitForFunction(()=>proof.held.length===1);
  await page.evaluate(()=>{proof.hold=null;});await click(page,'#resetSettingsBtn');
  await page.waitForFunction(()=>!document.getElementById('resetSettingsBtn').disabled);
  const toast=await page.$eval('#toast',e=>e.textContent);
  await page.evaluate(()=>proof.held[0].done({success:true,data:{currentPacProviderKey:'customPacUrl',customPacUrl:'https://old-install.test/proxy.pac',providers:{}},settingsState:{pending:true}}));
  await page.waitForFunction(()=>!document.getElementById('saveCustomPacUrlBtn').disabled);
  assert.equal(await page.$$eval('.proxy-profile-editor',es=>es.length),0);
  assert.equal(await page.$eval('#manualSitesEditor #rawTextEditor',e=>e.value),'');
  assert.equal(await page.$eval('[data-provider="none"] input',e=>e.checked),true);
  assert.equal(await page.$eval('#applicationBanner',e=>e.hidden),true);
  assert.equal(await page.$eval('#toast',e=>e.textContent),toast);
  assert.equal(await page.evaluate(()=>proof.messages.filter(m=>['SAVE_MODS','MUTATE_DOMAIN_RULES'].includes(m.action)).length),0,'reset cancels unsent old autosave');
 });
 await scenario('reset cancels old multi-proxy health sequence and completion toast',async page=>{
  await page.evaluate(()=>{proof.mods.customProxyStringRaw='HTTP one.test:8080; HTTP two.test:8080';window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>document.querySelectorAll('.proxy-item').length===2);
  await page.evaluate(()=>{proof.hold='CHECK_PROXY_HEALTH';});await click(page,'#recheckAllProxiesBtn');
  await page.waitForFunction(()=>proof.held.length===1);
  await page.evaluate(()=>{proof.hold=null;});await click(page,'#resetSettingsBtn');
  await page.waitForFunction(()=>!document.getElementById('resetSettingsBtn').disabled);
  const toast=await page.$eval('#toast',e=>e.textContent);
  await page.evaluate(()=>proof.held[0].done({success:true,data:{ok:true,checkedAt:Date.now(),latency:1}}));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(await page.evaluate(()=>proof.messages.filter(m=>m.action==='CHECK_PROXY_HEALTH').length),1);
  assert.equal(await page.$eval('#toast',e=>e.textContent),toast);
 });
 await scenario('late pre-reset list write cannot unlock current list write',async page=>{
  await page.evaluate(()=>{proof.hold='DELETE_DOMAIN_LIST';});
  await click(page,'[data-list-id="a"] .btn-danger');await page.waitForSelector('dialog[open]');await click(page,'dialog .btn-primary');
  await page.waitForFunction(()=>proof.held.length===1);
  await page.evaluate(()=>{proof.hold=null;});await click(page,'#resetSettingsBtn');
  await page.waitForFunction(()=>!document.getElementById('resetSettingsBtn').disabled);
  await click(page,'#domainListAdd');await input(page,'#domainListName','Current generation');
  await page.evaluate(()=>{proof.hold='SAVE_DOMAIN_LIST';});await click(page,'#domainListSave');
  await page.waitForFunction(()=>proof.held.length===2);
  await page.evaluate(()=>proof.held[0].done({success:false,error:'old write failure'}));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(await page.$eval('#domainListSave',e=>e.disabled),true,'old finally must not release current generation busy state');
 });
 await scenario('late pre-reset retry cannot unlock current list write',async page=>{
  await page.evaluate(()=>{proof.fail='DELETE_DOMAIN_LIST';});
  await click(page,'[data-list-id="a"] .btn-danger');await page.waitForSelector('dialog[open]');await click(page,'dialog .btn-primary');
  await page.waitForFunction(()=>!document.getElementById('domainListsRetry').hidden);
  await page.evaluate(()=>{proof.fail=null;proof.hold='GET_DOMAIN_LISTS';});await click(page,'#domainListsRetry');
  await page.waitForFunction(()=>proof.held.length===1);
  await page.evaluate(()=>{proof.hold=null;});await click(page,'#resetSettingsBtn');
  await page.waitForFunction(()=>!document.getElementById('resetSettingsBtn').disabled);
  await click(page,'#domainListAdd');await input(page,'#domainListName','Current generation');
  await page.evaluate(()=>{proof.hold='SAVE_DOMAIN_LIST';});await click(page,'#domainListSave');
  await page.waitForFunction(()=>proof.held.length===2);
  await page.evaluate(()=>proof.held[0].done({success:true,data:{lists:[],revision:1,proxyCatalog:proof.catalog}}));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(await page.$eval('#domainListSave',e=>e.disabled),true,'old retry finally must not release current generation busy state');
 });
 await scenario('invalid custom PAC card leaves the confirmed provider radio selected',async page=>{
  await input(page,'#customPacUrlInput','http://192.168.1.10/p.pac');
  await click(page,'[data-provider="customPacUrl"] input');
  assert.equal(await page.$eval('[data-provider="Антизапрет"] input',e=>e.checked),true);
  assert.equal(await page.$eval('[data-provider="customPacUrl"] input',e=>e.checked),false);
  assert.equal(await page.evaluate(()=>proof.messages.some(m=>m.action==='INSTALL_PAC')),false);
 });
 await scenario('rejected preset install leaves the confirmed provider radio selected',async page=>{
  await page.evaluate(()=>{proof.fail='INSTALL_PAC';});await click(page,'[data-provider="Антицензорити"] input');
  await page.waitForFunction(()=>proof.messages.some(m=>m.action==='INSTALL_PAC'));
  assert.equal(await page.$eval('[data-provider="Антизапрет"] input',e=>e.checked),true);
  assert.equal(await page.$eval('[data-provider="Антицензорити"] input',e=>e.checked),false);
 });
 await scenario('reset clears history and rejects old history readback',async page=>{
  await page.evaluate(()=>{proof.history=[{id:'old',kind:'manual',count:1,at:Date.now()}];});
  await click(page,'[data-tab="history"]');await page.waitForSelector('#historyList .history-row');
  await page.evaluate(async()=>{
   proof.hold='GET_RULE_HISTORY';
   const {renderHistory}=await import('../shared/history.js');
   void renderHistory(document.getElementById('historyList'));
  });
  await page.waitForFunction(()=>proof.held.length===1);
  await page.evaluate(()=>{proof.hold=null;});await click(page,'#resetSettingsBtn');
  await page.waitForFunction(()=>!document.getElementById('resetSettingsBtn').disabled);
  assert.equal(await page.$$eval('#historyList .history-row',rows=>rows.length),0,'reset clears displayed history');
  await page.evaluate(()=>proof.held[0].done({success:true,data:[{id:'old',kind:'manual',count:1,at:Date.now()}]}));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(await page.$$eval('#historyList .history-row',rows=>rows.length),0,'late history cannot restore old undo controls');
 });
 await scenario('raw site sections preserve equals signs in URLs and comments',async page=>{
  await click(page,'#manualRulesLink');
  await page.waitForSelector('#manualSitesEditor .domain-name');
  await click(page,'#manualSitesEditor #modeToggleBtn');
  await input(page,'#manualSitesEditor #rawTextEditor',
   '# list = main\r\nhttps://query.test/?a=1\r\nnext.test\r\n ==== \r\ndirect.test\r\n====\r\nallowed.test');
  await page.waitForFunction(()=>proof.messages.some(m=>m.action==='SAVE_MODS' && m.mods.exceptions));
  const mods=await page.evaluate(()=>proof.messages.find(m=>m.action==='SAVE_MODS' && m.mods.exceptions).mods);
  assert.deepEqual(mods,{exceptions:{'query.test':true,'next.test':true,'direct.test':false},whitelist:['allowed.test']});
 });
 await scenario('late history clear does not reload history after settings reset',async page=>{
  await page.evaluate(()=>{proof.hold='CLEAR_RULE_HISTORY';});
  await click(page,'#clearHistoryBtn');
  await page.waitForFunction(()=>proof.held.length===1);
  await page.evaluate(()=>{proof.hold=null;});
  await click(page,'#resetSettingsBtn');
  await page.waitForFunction(()=>!document.getElementById('resetSettingsBtn').disabled);
  const reads=()=>page.evaluate(()=>proof.messages.filter(m=>m.action==='GET_RULE_HISTORY').length);
  const before=await reads();
  const resetToast=await page.$eval('#toast',e=>e.textContent);
  await page.evaluate(async()=>{
   proof.held[0].done({success:true});
   await new Promise(resolve=>setTimeout(resolve,0));
  });
  assert.equal(await reads(),before,'a stale clear must not trigger a new read');
  assert.equal(await page.$eval('#toast',e=>e.textContent),resetToast,'a stale clear must not replace the reset notification');
 });
} finally { await browser.close(); }
if(failures.length)throw new Error(failures.join('\n'));
