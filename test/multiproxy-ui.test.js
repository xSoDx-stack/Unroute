import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
const read = name => readFileSync(new URL(`../src/common/pages/options/${name}`, import.meta.url), 'utf8');
describe('multi-proxy options contract', () => {
  it('offers one pencil editor for both name and connection, without a duplicate rename button', () => {
    const app = read('proxies-panel.js');
    assert.equal(app.includes('rename-proxy-btn'), false);
    assert.equal(app.includes("mode: 'rename'"), false);
    assert.match(app, /edit-proxy-btn/);
    assert.match(read('proxy-connection-editor.js'), /field\('name',/);
  });
  it('offers block, DIRECT and an explicitly selected reserve without changing unrelated sites or inheriting PAC Proxy Or Die', () => {
    assert.ok(read('index.html').includes('id="proxyFailoverSelect"'));
    const app = read('proxies-panel.js');
    assert.match(app, /fallbackProxyId/);
    assert.match(app, /fallbackProxyId:.*\?/);
    assert.equal(app.includes('ownProxyOrDie ?? appState.pacMods.ifProxyOrDie'), false);
    assert.match(app, /appState\.pacMods\.ownProxyOrDie === false \? 'direct' : 'block'/);
  });
  it('manages profiles through real catalog RPCs without constructing IDs', () => {
    const app = read('proxies-panel.js');
    for (const action of ['UPDATE_PROXY_PROFILE', 'DELETE_PROXY_PROFILE', 'SET_DEFAULT_PROXY']) assert.ok(app.includes(`action: '${action}'`), action);
    assert.match(app, /proxyEndpointKey\(proxy\.endpoint\) === proxyEndpointKey\(item\)/);
    assert.match(app, /name: el\.proxyName/);
    assert.ok(read('index.html').includes('id="defaultProxySelect"'));
  });
  it('uses atomic revision-checked rule mutations and explicit profile targets', () => {
    const sites = read('sites-editor.js');
    assert.match(sites, /action: 'MUTATE_DOMAIN_RULES'/);
    assert.match(sites, /action: 'ASSIGN_DOMAIN_PROXIES'/);
    assert.match(sites, /expectedRevision: dataRevision/);
    assert.match(sites, /reassignExisting: false/);
    for (const id of ['newRuleProxy', 'proxyFilter', 'bulkProxy', 'selectAllFiltered', 'rawRetrySave']) assert.ok(read('index.html').includes(`id="${id}"`), id);
  });
});
