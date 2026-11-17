import assert from 'node:assert/strict';
import fs from 'node:fs';
const html = fs.readFileSync('src/common/pages/options/index.html', 'utf8');
describe('options 01 fidelity structure', () => {
 it('retains the approved fixed U-exit image instead of drawing the letter B', () => {
  assert.match(html, /<img[^>]*class="brand-logo"[^>]*src="\.\.\/\.\.\/icons\/default-128\.png"/);
 });
 it('preserves the complete functional control surface', () => {
  for (const id of ['applicationBanner','extVersion','headerStatus','statusText','syncBtn','syncDate','syncBtnIcon','customPacUrlBox','customPacUrlInput','saveCustomPacUrlBtn','proxyProtocol','proxyHost','proxyPort','proxyUser','proxyPass','proxyAuthCheck','proxyAuthFields','torToggle','warpToggle','ownOnlyToggle','httpsOnlyToggle','secureProxiesOnlyToggle','prohibitDnsToggle','proxyOrDieToggle','moreDomainsToggle','notifPacErrorToggle','notifExtErrorToggle','notifNoControlToggle','newDomainInput','sourceFilter','rawTextEditor','fileImportInput','importFileBtn','exportFileBtn','modeToggleBtn','saveStatusText','retrySitesLoad','includedCount','excludedCount','whitelistCount','searchDomainInput','clearListBtn','historyList','clearHistoryBtn','logsContainer','logsFilterGroup','logsSearchInput','refreshLogsBtn','copyLogsBtn','exportLogsBtn','clearLogsBtn','testConnBtn','viewPacScriptBtn','resetSettingsBtn','pacScriptModal','pacScriptContent','closePacModalBtn','toast']) assert.ok(html.includes(`id="${id}"`), id);
 });
 it('uses the complete 01 navigation order plus user-requested appearance', () => {
  const nav = html.match(/<nav class="nav-tabs"[\s\S]*?<\/nav>/)[0];
  assert.deepEqual([...nav.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]), ['pac','exceptions','proxies','mods','logs','history','tools','notifications','appearance']);
  assert.ok(nav.indexOf('nav-separator') > nav.indexOf('data-tab="mods"'));
  assert.ok(!nav.includes('id="extVersion"'), 'version is below navigation, in the statusbar');
 });
 it('places the unique runtime version before the autosave hint in the statusbar', () => {
  const footer = html.match(/<footer class="statusbar"[\s\S]*?<\/footer>/)[0];
  assert.equal([...html.matchAll(/id="extVersion"/g)].length, 1);
  assert.ok(footer.includes('id="extVersion"'));
  assert.ok(footer.indexOf('id="extVersion"') < footer.indexOf('data-i18n="fidelity_footer_hint"'));
 });
 it('retains disable provider and structured + raw proxy entry', () => {
  for (const value of ['data-provider="none"','id="proxyFormView"','id="proxyRawView"','id="proxyDraftHint"','id="proxyAdvanced"']) assert.ok(html.includes(value), value);
 });
});
