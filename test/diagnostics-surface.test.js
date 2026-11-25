import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'acorn';

const read = file => fs.readFileSync(file, 'utf8');

describe('Local diagnostics surface', () => {
  it('loads local settings without sampling or caching the active tab address', () => {
    const app = read('src/common/pages/options/app.js');
    assert.doesNotMatch(app, /chrome\.tabs\.query|currentSiteDomain/);
  });
  it('retains diagnostics and adds portable settings without automatic page scripts', () => {
    const html = read('src/common/pages/options/index.html');
    const tools = html.match(/<section[^>]+id="tab-tools"[\s\S]*?<\/section>/)[0];
    assert.deepEqual([...tools.matchAll(/<button[^>]+id="([^"]+)"/g)].map(match => match[1]),
      ['portable-export', 'portable-import', 'testConnBtn', 'viewPacScriptBtn', 'resetSettingsBtn']);
    assert.match(tools, /id="portable-warning"[^>]*role="note"/);
    for (const target of ['src/common/manifest.json', 'src/firefox/manifest.json']) {
      const manifest = JSON.parse(read(target));
      assert.deepEqual(manifest.content_scripts || [], []);
      for (const permission of ['proxy', 'storage', 'tabs', 'webRequest', 'webRequestAuthProvider']) {
        assert.ok(manifest.permissions.includes(permission), `${target}: shared routing permission ${permission}`);
      }
      assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
    }
  });
  it('preserves every PAC mode and uses neutral localized preset descriptions', () => {
    const html = read('src/common/pages/options/index.html');
    const ast = parse(read('src/common/core/pac-providers.js'), { ecmaVersion: 'latest', sourceType: 'module' });
    const declaration = ast.body.find(node => node.type === 'ExportNamedDeclaration' &&
      node.declaration?.declarations?.[0].id.name === 'PAC_PROVIDERS');
    const providers = new Map(declaration.declaration.declarations[0].init.properties.map(node => [node.key.name || node.key.value, node.value]));
    assert.deepEqual([...providers.keys()], ['Антизапрет', 'Антицензорити', 'onlyOwnSites', 'customPacUrl']);
    for (const provider of [...providers.keys(), 'none']) assert.ok(html.includes(`data-provider="${provider}"`));
    for (const [provider, key, ru, en] of [
      ['Антизапрет', 'pac_provider_antizapret_description', 'PAC-скрипт проекта «Антизапрет».', 'PAC script from the Antizapret project.'],
      ['Антицензорити', 'pac_provider_anticensority_description', 'PAC-скрипт проекта «Антицензорити».', 'PAC script from the Anticensority project.'],
    ]) {
      const description = providers.get(provider).properties.find(node => node.key.name === 'desc').value;
      assert.equal(description.arguments[0].value, key);
      assert.equal(description.arguments[1].value, ru);
      assert.ok(html.includes(`data-i18n="${key}"`));
      for (const [locale, text] of [['ru', ru], ['en', en]]) {
        assert.equal(JSON.parse(read(`src/common/_locales/${locale}/messages.json`))[key].message, text);
      }
    }
  });
});
