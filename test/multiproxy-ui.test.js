import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
const read = name => readFileSync(new URL(`../src/common/pages/options/${name}`, import.meta.url), 'utf8');
describe('multi-proxy options contract', () => {
  it('manages profiles through real catalog RPCs without constructing IDs', () => {
    const app = read('app.js');
    for (const action of ['RENAME_PROXY_PROFILE', 'DELETE_PROXY_PROFILE', 'SET_DEFAULT_PROXY']) assert.ok(app.includes(`action: '${action}'`), action);
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
