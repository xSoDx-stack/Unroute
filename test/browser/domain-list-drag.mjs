// Source DOM regression with controlled RPC. This is NOT native extension/backend proof.
// Run: node test/browser/domain-list-drag.mjs [optional case-name substring]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const out = process.env.DOMAIN_LIST_DRAG_OUT || path.join(process.env.LOCALAPPDATA || process.env.HOME, 'hermes/cache/scratch/domain-list-drag');
await fs.mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--allow-file-access-from-files'] });
const row = id => `.domain-list-row[data-list-id="${id}"]`;
const handle = id => `${row(id)} button.domain-list-handle, ${row(id)} .domain-list-handle button`;
const original = ['a', 'b', 'c'];
const moved = ['b', 'c', 'a'];
const results = [];

async function fixture() {
 const page = await browser.newPage();
 page.setDefaultTimeout(3500);
 await page.setViewport({ width: 900, height: 700 });
 const errors = [];
 page.on('pageerror', error => errors.push(error.message));
 await page.setJavaScriptEnabled(false);
 await page.goto(pathToFileURL(path.resolve('src/common/pages/options/index.html')).href);
 await page.setJavaScriptEnabled(true);
 await page.evaluate(async () => {
  const p = window.dragProof = {
   revision: 17, messages: [], notifications: [], held: null, holdWrite: false, holdRead: false, failWrite: false, failRead: false,
   lists: [
    { id: 'a', name: 'Alpha', proxyId: 'p1', enabled: true, domains: ['a.test'] },
    { id: 'b', name: 'Beta', proxyId: 'p1', enabled: false, domains: ['b.test'] },
    { id: 'c', name: 'ОченьДлинноеИмя😀漢字'.repeat(3) + '<img src=x onerror=alert(1)>', proxyId: 'p1', enabled: true, domains: [] }
   ]
  };
  document.addEventListener('pointerdown', event => { p.pointerId = event.pointerId; }, true);
  const catalog = [{ id: 'p1', name: 'Safe profile', enabled: true }, { id: 'p2', name: 'Other profile', enabled: true }];
  p.answer = (m, done) => {
   if (m.action === 'GET_DOMAIN_LISTS') return done(p.failRead ? { success: false, error: { message: 'Readback failed' } } : { success: true, data: { lists: p.lists.map(({ domains, ...list }) => ({ ...list, count: domains.length })), revision: p.revision, proxyCatalog: catalog, defaultProxyId: 'p1' } });
   if (m.action === 'GET_DOMAIN_LIST') return done({ success: true, data: { list: structuredClone(p.lists.find(l => l.id === m.listId)), revision: p.revision, proxyCatalog: catalog } });
   if (m.action === 'GET_EXCEPTIONS') return done({ success: true, data: { exceptions: {}, whitelist: [], pacBypassDomains: [], revision: p.revision, proxyCatalog: catalog, defaultProxyId: 'p1' } });
   if (p.failWrite || m.expectedRevision !== p.revision) return done({ success: false, error: { code: 'RULES_CONFLICT', message: 'Revision conflict' } });
   if (m.action === 'REORDER_DOMAIN_LISTS') {
    if (m.listIds.length !== p.lists.length || new Set(m.listIds).size !== p.lists.length || m.listIds.some(id => !p.lists.some(l => l.id === id))) return done({ success: false, error: { message: 'Invalid permutation' } });
    p.lists = m.listIds.map(id => p.lists.find(l => l.id === id));
   } else if (m.action === 'SAVE_DOMAIN_LIST') Object.assign(p.lists.find(l => l.id === m.listId), Object.fromEntries(Object.entries(m).filter(([key]) => ['name', 'enabled', 'proxyId'].includes(key))));
   else throw new Error(`Unexpected RPC ${m.action}`);
   p.revision++;
   done({ success: true, settingsState: { pending: false } });
  };
  p.release = () => { const held = p.held; p.held = null; p.answer(held.message, held.done); };
  window.chrome = { runtime: { sendMessage(message, done) {
   p.messages.push(structuredClone(message));
   if ((p.holdWrite && message.action === 'REORDER_DOMAIN_LISTS') || (p.holdRead && message.action === 'GET_DOMAIN_LISTS')) { p.held = { message: structuredClone(message), done }; return; }
   p.answer(message, done);
  } } };
  const { initSitesEditor } = await import('./sites-editor.js');
  const root = document.querySelector('#tab-exceptions'); root.classList.add('active');
  p.editor = initSitesEditor(root, { notify: text => p.notifications.push(text), onApplicationState: () => {}, navigate: () => {} });
  await p.editor.activate();
 });
 await page.waitForSelector(row('c'));
 return { page, errors };
}
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const order = page => page.$$eval('.domain-list-row[data-list-id]', es => es.map(e => e.dataset.listId));
const backend = page => page.evaluate(() => window.dragProof.lists.map(l => l.id));
const writes = page => page.evaluate(() => window.dragProof.messages.filter(m => m.action === 'REORDER_DOMAIN_LISTS'));
async function requireHandles(page) {
 assert.equal(await page.$$(handle('a')).then(es => es.length), 1, 'each card needs one dedicated grab button (.domain-list-handle)');
}
async function beginDrag(page, id = 'a', target = 'c') {
 if (process.env.DOMAIN_LIST_DRAG_TRACE) await page.evaluate(() => {
  window.dragProof.trace = [];
  for (const type of ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture','pointercancel']) {
   document.addEventListener(type, e => window.dragProof.trace.push({type,target:e.target.className?.baseVal ?? e.target.className,
    y:e.clientY,order:[...document.querySelectorAll('.domain-list-row')].map(r=>r.dataset.listId),
    sorting:document.querySelector('#domainListsRows').classList.contains('is-sorting')}),true);
  }
 });
 await requireHandles(page);
 const source = await page.$(handle(id)); await source.scrollIntoView();
 const a = await source.boundingBox();
 const b = await (await page.$(row(target))).boundingBox();
 await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
 await page.mouse.down();
 await page.mouse.move(a.x + a.width / 2, b.y + b.height - 3, { steps: 14 });
 await frames(page);
}
async function confirmed(page, ids = moved) {
 await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('.domain-list-row[data-list-id]')].map(e => e.dataset.listId)) === JSON.stringify(expected) && !document.querySelector('.domain-list-row select')?.disabled, {}, ids);
 assert.deepEqual(await backend(page), ids);
 assert.deepEqual(await order(page), ids);
 assert.deepEqual(await page.$$eval('.domain-list-priority', es => es.map(e => e.textContent.trim())), ['1', '2', '3']);
}
async function blocked(page) {
 assert.equal(await page.$$eval('.domain-list-row button,.domain-list-row input,.domain-list-row select', es => es.every(e => e.disabled)), true, 'all row controls disabled while pending/failed');
}
async function recovery(page, ids = original) {
 await page.waitForSelector('#domainListsRetry', { visible: true });
 assert.deepEqual(await order(page), ids, 'failure retains last confirmed DOM order');
 await blocked(page);
}
const cases = [
 ['compact-safe-responsive-cards', async page => {
  await requireHandles(page);
  assert.equal(await page.$$eval('.domain-list-name img', es => es.length), 0, 'names must use textContent');
  assert.equal(await page.$eval(`${row('c')} .domain-list-name`, e => e.textContent), await page.evaluate(() => window.dragProof.lists[2].name));
  for (const theme of ['light', 'dark']) for (const width of [900, 360]) {
   await page.setViewport({ width, height: 700 });
   await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}: no horizontal document overflow`);
   const geometry = await page.$$eval('.domain-list-row', es => es.map(e => {
    const r = e.getBoundingClientRect();
    return { height: r.height, left: r.left, right: r.right, centers: [...e.querySelectorAll('button,input,select')].map(c => { const b = c.getBoundingClientRect(); return b.y + b.height / 2; }), actions: e.querySelectorAll('.domain-list-actions button').length };
   }));
   for (const g of geometry) {
    assert.equal(g.actions, 4, 'retain up/down/rename/delete');
    assert.ok(g.left >= 0 && g.right <= width, 'row within viewport');
    if (width >= 900) { assert.ok(g.height <= 64, `compact row height ${g.height} <= 64`); assert.ok(Math.max(...g.centers) - Math.min(...g.centers) <= 12, 'all controls share main row'); }
   }
   await page.screenshot({ path: path.join(out, `cards-${theme}-${width}.png`), fullPage: true });
  }
 }],
 ['mouse-drag-single-revision-guarded-write', async page => {
  await beginDrag(page);
  assert.equal(await page.$eval(handle('a'), e => e.hasPointerCapture(window.dragProof.pointerId)), true,
   'moving cards must retain physical pointer capture until release');
  assert.deepEqual(await backend(page), original, 'pointer preview cannot mutate canonical backend');
  assert.deepEqual(await writes(page), [], 'no RPC before release');
  await page.screenshot({ path: path.join(out, 'drag-preview.png'), fullPage: true });
  await page.mouse.up(); await confirmed(page);
  const commands = await writes(page); assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], { action: 'REORDER_DOMAIN_LISTS', listIds: moved, expectedRevision: 17 });
  assert.ok(await page.evaluate(() => { const ms = window.dragProof.messages; return ms.slice(ms.findIndex(m => m.action === 'REORDER_DOMAIN_LISTS') + 1).some(m => m.action === 'GET_DOMAIN_LISTS'); }), 'success requires readback');
  await page.screenshot({ path: path.join(out, 'drag-confirmed.png'), fullPage: true });
 }],
 ['click-and-unchanged-drop-do-not-write', async page => {
  await requireHandles(page); await page.click(handle('a')); await frames(page);
  const box = await (await page.$(handle('a'))).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2 + 1); await page.mouse.up(); await frames(page);
  assert.deepEqual(await writes(page), []); assert.deepEqual(await order(page), original);
 }],
 ['unrelated-pointercancel-keeps-active-drag', async page => {
  await beginDrag(page);
  await page.$eval(handle('a'), e => e.dispatchEvent(new PointerEvent('pointercancel', {
   bubbles: true, pointerId: window.dragProof.pointerId + 1, pointerType: 'touch'
  })));
  assert.equal(await page.$eval('#domainListsRows', e => e.classList.contains('is-sorting')), true,
   'another pointer cannot cancel the captured mouse');
  await page.mouse.up(); await confirmed(page);
  assert.equal((await writes(page)).length, 1);
 }],
 ...['Escape', 'pointercancel', 'lostpointercapture', 'outside'].map(kind => [`cancel-${kind}-does-not-write`, async page => {
  await beginDrag(page);
  if (kind === 'Escape') await page.keyboard.press('Escape');
  else if (kind === 'outside') await page.mouse.move(899, 1, { steps: 5 });
  else if (kind === 'lostpointercapture') {
   await page.$eval(handle('a'), e => e.releasePointerCapture(window.dragProof.pointerId));
   await page.mouse.move(100, 400);
  } else await page.$eval(handle('a'), e => e.dispatchEvent(new PointerEvent('pointercancel', {
   bubbles: true, pointerId: window.dragProof.pointerId, pointerType: 'mouse'
  })));
  await page.mouse.up(); await frames(page);
  assert.deepEqual(await writes(page), [], `${kind} must cancel, not commit`); assert.deepEqual(await order(page), original);
 }]),
 ...['refresh', 'cancelRead', 'invalidate'].map(method => [`external-${method}-cancels-drag`, async page => {
  await beginDrag(page);
  await page.evaluate(async action => { await window.dragProof.editor[action](); }, method);
  await page.mouse.up(); await frames(page);
  assert.deepEqual(await writes(page), [], 'no stale commands after editor lifecycle boundary');
  assert.deepEqual(await backend(page), original); assert.deepEqual(await order(page), original);
 }]),
 ['pending-write-blocks-duplicate-commands', async page => {
  await page.evaluate(() => { window.dragProof.holdWrite = true; });
  await beginDrag(page); await page.mouse.up();
  await page.waitForFunction(() => Boolean(window.dragProof.held)); await blocked(page);
  assert.deepEqual(await backend(page), original);
  await page.focus(handle('b')); await page.keyboard.down('Alt'); await page.keyboard.press('ArrowDown'); await page.keyboard.up('Alt');
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: window.dragProof.pointerId })));
  assert.equal((await writes(page)).length, 1);
  await page.evaluate(() => { window.dragProof.holdWrite = false; window.dragProof.release(); });
  await confirmed(page); assert.equal((await writes(page)).length, 1);
 }],
 ['readback-pending-and-failure-never-replay-write', async page => {
  await page.evaluate(() => { window.dragProof.holdRead = true; });
  await beginDrag(page); await page.mouse.up();
  await page.waitForFunction(() => window.dragProof.held?.message.action === 'GET_DOMAIN_LISTS');
  await blocked(page); assert.equal((await writes(page)).length, 1);
  await page.evaluate(() => { window.dragProof.failRead = true; window.dragProof.holdRead = false; window.dragProof.release(); });
  await recovery(page);
  await page.evaluate(() => { window.dragProof.failRead = false; }); await page.click('#domainListsRetry');
  await confirmed(page); assert.equal((await writes(page)).length, 1, 'retry verifies committed write, never resends');
 }],
 ['revision-conflict-restores-confirmed-order', async page => {
  await beginDrag(page);
  await page.evaluate(() => { window.dragProof.revision++; });
  await page.mouse.up(); await recovery(page);
  assert.deepEqual(await backend(page), original);
  const commands = await writes(page); assert.equal(commands.length, 1); assert.equal(commands[0].expectedRevision, 17, 'revision captured at pointerdown');
  await page.click('#domainListsRetry'); await confirmed(page, original);
  assert.equal((await writes(page)).length, 1, 'conflict retry does not auto-replay stale reorder');
 }],
 ['background-refresh-during-drop-readback', async page => {
  await page.evaluate(() => { window.dragProof.holdRead = true; });
  await beginDrag(page); await page.mouse.up();
  await page.waitForFunction(() => window.dragProof.held?.message.action === 'GET_DOMAIN_LISTS');
  await page.evaluate(() => {
   const p = window.dragProof;
   p.ownRead = p.held; p.held = null;
   void p.editor.refresh();
  });
  await page.waitForFunction(() => Boolean(window.dragProof.held));
  await page.evaluate(() => {
   const p = window.dragProof; p.holdRead = false;
   p.release(); // Newer background read succeeds first.
   p.answer(p.ownRead.message, p.ownRead.done); // Owned read is now superseded.
  });
  await confirmed(page);
  assert.equal((await writes(page)).length, 1, 'background refresh never replays the reorder');
 }],
 ['keyboard-alt-arrows-focus-and-fallback-buttons', async page => {
  await requireHandles(page); await page.focus(handle('b'));
  await page.keyboard.down('Alt'); await page.keyboard.press('ArrowUp'); await page.keyboard.up('Alt');
  await confirmed(page, ['b', 'a', 'c']);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-list-id]')?.dataset.listId), 'b', 'focus restored to moved list');
  assert.equal(await page.evaluate(() => document.activeElement?.matches('button.domain-list-handle, .domain-list-handle button')), true, 'grab button remains focused after render');
  await page.evaluate(() => window.dragProof.editor.refresh());
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-list-id]')?.dataset.listId), 'b',
   'background refresh preserves the focused grab handle');
  assert.equal((await writes(page))[0].expectedRevision, 17);
  await page.keyboard.down('Alt'); await page.keyboard.press('ArrowUp'); await page.keyboard.up('Alt'); await frames(page);
  assert.equal((await writes(page)).length, 1, 'boundary shortcut is no-op');
  await page.click(`${row('b')} .domain-list-actions button:nth-child(2)`); await confirmed(page, original);
  assert.equal((await writes(page)).length, 2, 'existing down button still works');
  assert.equal((await writes(page))[1].expectedRevision, 18);
 }],
 ['retry-readback-superseded-before-background-success', async page => {
  await page.evaluate(() => { window.dragProof.holdRead = true; });
  await beginDrag(page); await page.mouse.up();
  await page.waitForFunction(() => Boolean(window.dragProof.held));
  await page.evaluate(() => {
   const p = window.dragProof; p.failRead = true; p.holdRead = false; p.release();
  });
  await recovery(page);
  await page.evaluate(() => { const p = window.dragProof; p.failRead = false; p.holdRead = true; });
  await page.click('#domainListsRetry');
  await page.waitForFunction(() => Boolean(window.dragProof.held));
  await page.evaluate(() => {
   const p = window.dragProof; p.retryRead = p.held; p.held = null; void p.editor.refresh();
  });
  await page.waitForFunction(() => Boolean(window.dragProof.held));
  await page.evaluate(() => {
   const p = window.dragProof; p.backgroundRead = p.held; p.held = null; p.holdRead = false;
   p.answer(p.retryRead.message, p.retryRead.done);
  });
  await frames(page);
  await page.evaluate(() => {
   const p = window.dragProof; p.answer(p.backgroundRead.message, p.backgroundRead.done);
  });
  await confirmed(page);
  assert.equal((await writes(page)).length, 1, 'retry after read failure never replays the mutation');
 }],
 ['nonhandle-controls-never-start-pointer-reorder', async page => {
  await requireHandles(page);
  for (const suffix of ['.domain-list-name', 'select', 'input[type=checkbox]', '.domain-list-actions button:nth-child(3)', '.domain-list-actions button:nth-child(4)']) {
   const a = await (await page.$(`${row('a')} ${suffix}`)).boundingBox();
   const b = await (await page.$(row('c'))).boundingBox();
   await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
   await page.mouse.move(a.x + a.width / 2, b.y + b.height - 3, { steps: 10 }); await page.mouse.up();
   await page.keyboard.press('Escape'); await frames(page);
   assert.deepEqual(await writes(page), [], `${suffix} is not a drag handle`);
  }
  assert.deepEqual(await order(page), original);
 }]
];
try {
 for (const [name, test] of cases.filter(([name]) => !process.argv[2] || name.includes(process.argv[2]))) {
  let page;
  try {
   const setup = await fixture(); page = setup.page;
   await test(page); assert.deepEqual(setup.errors, [], 'no unhandled page errors');
   results.push({ name, status: 'PASS' }); console.log(`PASS ${name}`);
  } catch (error) {
   if (page && process.env.DOMAIN_LIST_DRAG_TRACE) console.error(JSON.stringify(await page.evaluate(() => window.dragProof.trace)));
   const screenshot = path.join(out, `${name}-failure.png`);
   if (page) await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
   results.push({ name, status: 'FAIL', error: error.stack, screenshot }); console.error(`FAIL ${name}: ${error.message}`);
  } finally { if (page) await page.close(); }
 }
 assert.ok(results.length, 'case filter must match at least one test');
 await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ scope: 'source DOM + controlled RPC; not native extension proof', results }, null, 2));
 const failures = results.filter(r => r.status === 'FAIL').length;
 console.log(`${results.length - failures}/${results.length} PASS; screenshots and report: ${out}`);
 if (failures) process.exitCode = 1;
} finally { await browser.close(); }
