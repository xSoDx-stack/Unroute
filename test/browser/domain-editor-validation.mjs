// Real Chromium source DOM; controlled RPC, not a native extension/backend proof.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
const out = process.env.DOMAIN_VALIDATION_OUT || path.resolve('artifacts/domain-editor-validation');
await fs.mkdir(out, {recursive:true});
const browser = await puppeteer.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--allow-file-access-from-files']});
const failures=[];
function check(condition, message) { if (!condition) failures.push(message); }
try {
 for (const theme of ['light','dark']) for (const scope of ['list','manual','pac']) {
  const page=await browser.newPage(); await page.setViewport({width:360,height:780});
  await page.setJavaScriptEnabled(false);
  await page.goto(pathToFileURL(path.resolve('src/common/pages/options/index.html')).href);
  await page.setJavaScriptEnabled(true);
  await page.evaluate(async (theme) => {
   document.documentElement.dataset.theme=theme;
   window.fixture={domains:['original.test'],revision:1,writes:[],conflict:false};
   window.chrome={runtime:{sendMessage(message,done) {
    const f=window.fixture, catalog=[{id:'p1',name:'Alpha',enabled:true}];
    if(message.action==='GET_DOMAIN_LISTS') return done({success:true,data:{revision:f.revision,lists:[{id:'a',name:'Test',proxyId:'p1',enabled:true,count:f.domains.length}],proxyCatalog:catalog,defaultProxyId:'p1'}});
    if(message.action==='GET_DOMAIN_LIST') return done({success:true,data:{revision:f.revision,list:{id:'a',domains:f.domains},proxyCatalog:catalog}});
    if(message.action==='GET_EXCEPTIONS') return done({success:true,data:{revision:f.revision,exceptions:f.exceptions || {'original.test':true},whitelist:[],pacBypassDomains:f.pacBypassDomains || ['original.test'],proxyCatalog:catalog,defaultProxyId:'p1'}});
    f.writes.push(structuredClone(message));
    if(f.conflict) return done({success:false,error:{code:'RULES_CONFLICT',message:'Conflict'}});
    f.domains=message.domains || message.mods?.pacBypassDomains || Object.keys(message.mods?.exceptions || {});f.revision++;
    done({success:true,settingsState:{pending:false}});
   }}};
   const {initSitesEditor}=await import('./sites-editor.js');
   document.querySelector('#tab-exceptions').classList.add('active');
   window.editor=initSitesEditor(document.querySelector('#tab-exceptions'),{notify(){},onApplicationState(){},navigate(){}});
   await window.editor.activate();
  },theme);
  await page.click(scope==='list'?'[data-open="a"]':'#manualRulesLink');
  const base=scope==='list'?'[data-list-scope="a"]':'#manualSitesEditor';
  await page.waitForFunction(base=>!document.querySelector(`${base} button[id$="modeToggleBtn"]`).disabled,{},base);
  if(scope==='pac') await page.click(`${base} [data-subtab="pac"]`);
  await page.click(`${base} button[id$="modeToggleBtn"]`);
  const draft=['# comment','https://Example.COM/path',...Array.from({length:20},(_,i)=>`include:${i===0?'anthropic':`group${i}`}`),'ordinary.test','<img src=x onerror=alert(1)>',''].join('\n');
  await page.$eval(`${base} textarea`,(node,text)=>{node.value=text;node.dispatchEvent(new Event('input'));},draft);
  const result=await page.evaluate(()=>window.editor.flush());
  const metrics=await page.$eval(base,node=>({
   value:node.querySelector('textarea').value,invalid:node.querySelector('textarea').getAttribute('aria-invalid'),
   errors:[...node.querySelectorAll('.raw-line-error')].map(line=>Number(line.dataset.line)),
   status:node.querySelector('[id$="editorStatusText"]').textContent,
   retryHidden:node.querySelector('[id$="rawRetrySave"]').hidden,
   injected:node.querySelectorAll('.raw-highlight-content img').length,
   overflow:document.documentElement.scrollWidth>innerWidth,writes:window.fixture.writes.length,
  }));
  const label=`${theme}/${scope}/360`;
  check(result===false,`${label}: invalid flush blocked`);
  check(metrics.writes===0,`${label}: no partial persistence`);
  check(metrics.value===draft,`${label}: exact draft retained`);
  check(metrics.invalid==='true' && metrics.errors.join(',')===Array.from({length:21},(_,i)=>i<20?i+3:24).join(','),`${label}: exact invalid source lines highlighted`);
  check(/include:.*geosite/i.test(metrics.status),`${label}: explicit unsupported reference diagnostic`);
  check(metrics.status.length<300,`${label}: concise status instead of raw error dump`);
  check(metrics.retryHidden,`${label}: validation is not a transport retry`);
  check(!metrics.injected && !metrics.overflow,`${label}: no injection or page overflow`);
  await page.$eval(`${base} textarea`,node=>{node.scrollTop=120;node.scrollLeft=50;node.dispatchEvent(new Event('scroll'));});
  check(await page.$eval(base,node=>{const text=node.querySelector('textarea'),mirror=node.querySelector('.raw-highlight-content');return Boolean(mirror) && mirror.style.transform===`translate(${-text.scrollLeft}px, ${-text.scrollTop}px)`;}),`${label}: synchronized native scrolling`);
  await page.screenshot({path:`${out}/${theme}-${scope}-invalid.png`,fullPage:true});
  await page.evaluate(()=>{window.fixture.conflict=true;});
  await page.$eval(`${base} textarea`,node=>{node.value='https://Example.COM/path';node.dispatchEvent(new Event('input'));});
  await page.evaluate(()=>window.editor.flush());
  const retry=await page.$eval(base,node=>{
   const button=node.querySelector('[id$="rawRetrySave"]'),status=node.querySelector('[id$="editorStatusText"]');
   const b=button.getBoundingClientRect(),s=status.getBoundingClientRect(),style=getComputedStyle(button);
   return {hidden:button.hidden,height:b.height,lineHeight:parseFloat(style.lineHeight),padding:parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+2,
    fits:b.left>=0 && b.right<=innerWidth,apart:b.bottom<=s.top+1 || s.bottom<=b.top+1 || b.right<=s.left+1 || s.right<=b.left+1};
  });
  check(!retry.hidden && retry.fits && retry.apart && retry.height<=retry.lineHeight+retry.padding+1,`${label}: retry one line, fits, does not overlap status`);
  await page.screenshot({path:`${out}/${theme}-${scope}-retry.png`,fullPage:true});
  await page.$eval(`${base} textarea`,node=>{node.value='include:anthropic';node.dispatchEvent(new Event('input'));});
  check(await page.$eval(`${base} button[id$="rawRetrySave"]`,node=>node.hidden),`${label}: invalid edit hides conflict retry`);
  await page.$eval(`${base} textarea`,node=>{node.value='https://Example.COM/path';node.dispatchEvent(new Event('input'));});
  check(await page.$eval(`${base} button[id$="rawRetrySave"]`,node=>!node.hidden),`${label}: correcting invalid draft restores conflict recovery`);
  if (await page.$eval(`${base} button[id$="rawRetrySave"]`,node=>node.hidden)) { await page.close(); continue; }
  await page.evaluate(()=>{window.fixture.conflict=false;});
  await page.click(`${base} button[id$="rawRetrySave"]`);
  await page.waitForFunction(base=>document.querySelector(`${base} button[id$="rawRetrySave"]`).hidden,{},base);
  check(await page.evaluate(()=>window.fixture.domains.join(',')==='example.com'),`${label}: URL normalization preserved after retry`);
  check(await page.$eval(`${base} textarea`,node=>node.getAttribute('aria-invalid'))==='false',`${label}: corrected errors cleared`);
  if(scope!=='list') {
   await page.evaluate(async scope=>{
    window.fixture.exceptions=scope==='manual'?{'include:anthropic':true}:{'replacement.test':true};
    window.fixture.pacBypassDomains=scope==='pac'?['include:anthropic']:['replacement.test'];
    window.fixture.revision++;await window.editor.refresh();
   },scope);
   check(await page.$eval(base,node=>node.querySelector('textarea').getAttribute('aria-invalid')==='true' && Boolean(node.querySelector('.raw-line-error'))),`${label}: programmatic category refresh recomputes diagnostics`);
   // Tabs are hidden in raw mode; exercise the programmatic switch handler,
   // not an impossible physical click on a hidden native control.
   await page.$eval(`${base} [data-subtab="${scope==='manual'?'pac':'included'}"]`,node=>node.click());
   check(await page.$eval(base,node=>node.querySelector('textarea').getAttribute('aria-invalid')==='false' && !node.querySelector('.raw-line-error') && !/geosite/.test(node.querySelector('[id$="editorStatusText"]').textContent)),`${label}: category switch clears stale diagnostics and status`);
  }
  if(scope==='list') {
   await page.evaluate(async()=>{window.fixture.domains=['include:anthropic'];window.fixture.revision++;await window.editor.refresh();});
   check(await page.$eval(base,node=>node.querySelector('textarea').getAttribute('aria-invalid')==='true' && node.querySelector('.raw-line-error')?.dataset.line==='1'),`${label}: programmatic fill recomputes diagnostics`);
   await page.evaluate(async()=>{window.fixture.domains=['replacement.test'];window.fixture.revision++;await window.editor.refresh();});
   check(await page.$eval(base,node=>node.querySelector('textarea').value==='replacement.test' && node.querySelector('textarea').getAttribute('aria-invalid')==='false' && !node.querySelector('.raw-line-error')),`${label}: programmatic replacement clears stale diagnostics`);
   if(theme==='light') {
    const large=await page.$eval(base,async node=>{
     const text=node.querySelector('textarea'),mirror=node.querySelector('.raw-highlight-content');
     const lines=Array.from({length:99998},(_,i)=>`d${i}.test`);lines.push('include:anthropic');
     text.value=lines.join('\n');
     const start=performance.now();text.dispatchEvent(new Event('input'));const inputMs=performance.now()-start;
     await window.editor.flush();
     const nodes=mirror.querySelectorAll('*').length;
     text.scrollTop=text.scrollHeight;text.dispatchEvent(new Event('scroll'));
     const marker=mirror.querySelector('[data-line="99999"]'),style=getComputedStyle(text);
     const expected=text.getBoundingClientRect().top+parseFloat(style.borderTopWidth)+parseFloat(style.paddingTop)+99998*parseFloat(style.lineHeight)-text.scrollTop;
     const offset=marker?Math.abs(marker.getBoundingClientRect().top-expected):null;
     text.value+='\n';const secondStart=performance.now();text.dispatchEvent(new Event('input'));const secondInputMs=performance.now()-secondStart;
     await window.editor.flush();
     const afterEditNodes=mirror.querySelectorAll('*').length;
     text.value=Array(99999).fill('include:anthropic').join('\n');text.dispatchEvent(new Event('input'));
     await window.editor.flush();
     text.scrollTop=text.scrollHeight;text.dispatchEvent(new Event('scroll'));
     const allInvalidNodes=mirror.querySelectorAll('*').length;
     text.value=lines.slice(0,-1).join('\n');text.dispatchEvent(new Event('input'));
     const allValidNodes=mirror.querySelectorAll('*').length;
     return {lines:lines.length,inputMs,secondInputMs,nodes,afterEditNodes,allInvalidNodes,allValidNodes,offset};
    });
    console.log('LARGE sparse',JSON.stringify(large));
    check(large.inputMs<200 && large.secondInputMs<200,`${label}: large-list typing does not synchronously reparse 100k rows`);
    check(large.nodes<=64 && large.afterEditNodes<=64,`${label}: 99999 lines never create line-count DOM`);
    check(large.allInvalidNodes>0 && large.allInvalidNodes<=64 && large.allValidNodes===0,`${label}: bounded DOM even for 99999 errors, zero nodes for valid lines`);
    await page.evaluate(()=>window.editor.invalidate());
    check(large.offset!==null && large.offset<1,`${label}: far-end source line offset is exact after native scroll`);
   }
  }
  // Importing include references must never silently save a valid subset.
  check(await page.evaluate(async()=>{
   const {readListFile}=await import('./domain-lists-editor.js');
   try {await readListFile(new File(['ok.test\ninclude:anthropic'],'domains.txt'));return false;}
   catch(error) {return /include:.*geosite/i.test(error.message);}
  }),`${label}: collection import rejects unsupported references`);
  if(scope==='manual') {
   const before=await page.evaluate(()=>window.fixture.writes.length);
   await page.$eval(`${base} input[id$="fileImportInput"]`,input=>{const transfer=new DataTransfer();transfer.items.add(new File(['ok.test\ninclude:anthropic'],'domains.txt'));input.files=transfer.files;input.dispatchEvent(new Event('change'));});
   // FileReader completion + input reset provides a deterministic completion barrier.
   await page.waitForFunction(base=>document.querySelector(`${base} input[id$="fileImportInput"]`).value==='',{},base);
   check(await page.evaluate(()=>window.fixture.writes.length)===before,`${label}: manual import rejects reference without partial save`);
   for (const kind of ['invalid UTF-8', 'too many lines']) {
    await page.$eval(`${base} input[id$="fileImportInput"]`,(input,kind)=>{
     const parts=kind==='invalid UTF-8'?['# comment ',new Uint8Array([255]),'\nok.test']:['ok.test\n'+'#\n'.repeat(100000)];
     const transfer=new DataTransfer();transfer.items.add(new File(parts,'domains.txt'));
     input.files=transfer.files;input.dispatchEvent(new Event('change'));
    },kind);
    await page.waitForFunction(base=>document.querySelector(`${base} input[id$="fileImportInput"]`).files.length===0,{},base);
    check(await page.evaluate(()=>window.fixture.writes.length)===before,`${label}: manual import rejects ${kind}`);
   }
  }
  await page.evaluate(async()=>{window.editor.reset();await window.editor.activate();});
  await page.click('#manualRulesLink');
  await page.waitForFunction(()=>!document.querySelector('#manualSitesEditor #modeToggleBtn').disabled);
  // Reset the controlled snapshot to valid state before entering the fresh editor.
  await page.evaluate(async()=>{window.fixture.exceptions={'reset.test':true};window.fixture.pacBypassDomains=[];window.fixture.revision++;await window.editor.refresh();});
  await page.click('#manualSitesEditor #modeToggleBtn');
  check(await page.$eval('#manualSitesEditor',node=>node.querySelector('textarea').getAttribute('aria-invalid')==='false' && !node.querySelector('.raw-line-error')),`${label}: reset creates a clean native editor`);
  await page.close();
 }
 console.log(JSON.stringify({failures},null,2));
 assert.deepEqual(failures,[]);
 console.log('PASS domain editor validation: light/dark, 360px, list/manual/PAC, 20 include references, exact highlights, scroll, draft/no partial saves, retry geometry, URL normalization, imports');
} finally {await browser.close();}
