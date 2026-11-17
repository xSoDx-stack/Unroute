import { expect } from 'chai';
import fs from 'node:fs';

describe('Browser manifest parity', () => {
  it('keeps product identity, UI entry points, permissions, and CSP in sync', () => {
    const common = JSON.parse(fs.readFileSync(new URL('../src/common/manifest.json', import.meta.url)));
    const firefox = JSON.parse(fs.readFileSync(new URL('../src/firefox/manifest.json', import.meta.url)));
    for (const field of ['manifest_version', 'name', 'version', 'description', 'icons', 'action', 'host_permissions', 'content_security_policy']) {
      expect(firefox[field], field).to.deep.equal(common[field]);
    }
    expect(firefox.permissions).to.deep.equal(common.permissions);
    expect(common.action.default_popup).to.equal('/pages/popup/index.html');
    // Keep the explicit Unroute identity consistent across signed Firefox builds.
    expect(firefox.browser_specific_settings.gecko.id).to.equal('unroute@xsodx-stack.github.io');
    for (const locale of ['ru', 'en']) {
      const messages = JSON.parse(fs.readFileSync(new URL(`../src/common/_locales/${locale}/messages.json`, import.meta.url)));
      expect(messages.extName.message).to.equal('Unroute');
    }
  });
});
