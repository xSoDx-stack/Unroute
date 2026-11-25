import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
const read = name => readFileSync(new URL(`../src/common/${name}`, import.meta.url), 'utf8');
const keys = ['proxyEditConnection', 'proxyConnectionName', 'proxyConnectionProtocol', 'proxyConnectionHost', 'proxyConnectionPort', 'proxyConnectionAuth', 'proxyConnectionUsername', 'proxyConnectionPassword', 'proxyConnectionHint', 'proxyConnectionSaving', 'proxyConnectionSave', 'proxyConnectionCancel', 'proxyConnectionInvalidName', 'proxyConnectionSocksAuth', 'proxyConnectionInvalidAddress', 'proxyConnectionSaveFailed', 'proxyConnectionInvalidSaved'];
describe('proxy connection editor localization', () => {
  it('provides matching nonempty Russian and English messages for every editor label and error', () => {
    const source = read('pages/options/proxy-connection-editor.js');
    for (const locale of ['ru', 'en']) {
      const catalog = JSON.parse(read(`_locales/${locale}/messages.json`));
      for (const key of keys) {
        assert.equal(typeof catalog[key]?.message, 'string', `${locale}:${key}`);
        assert.ok(catalog[key].message.trim());
        assert.ok(source.includes(`t('${key}'`), key);
      }
    }
  });
});
