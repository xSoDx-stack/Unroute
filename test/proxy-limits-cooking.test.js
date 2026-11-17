import { expect } from 'chai';
import { createPacModifiers } from '../src/common/core/pac-modifiers.js';
import { reconcileProxyProfiles } from '../src/common/core/proxy-profiles.js';

// The cooking layer consumes already reconciled settings. It must not apply a
// second context-free count cap that breaks grandfathered stored catalogs.
describe('Grandfathered proxy catalog cooking', () => {
  it('cooks 120 stored profiles and unrelated preference edits without a second hard cap', () => {
    const raw = Array.from({ length: 120 }, (_, i) => `HTTPS legacy-${i}.test:443`).join('; ');
    const stored = reconcileProxyProfiles({ customProxyStringRaw: raw });
    for (const value of [stored, reconcileProxyProfiles({ ...stored, ifProxyOrDie: false }, stored)]) {
      const [error, mods] = createPacModifiers(value);
      expect(error).to.equal(null);
      expect(mods.customProxyArray).to.have.length(stored.proxyProfiles.length);
      expect(mods.proxyProfiles).to.deep.equal(stored.proxyProfiles);
    }
  });
  it('does not mistake duplicate stored lines for more user profiles during cooking', () => {
    const stored = reconcileProxyProfiles({ customProxyStringRaw: Array(120).fill('HTTPS one.test:443').join('; ') });
    expect(stored.proxyProfiles).to.have.length(1);
    const [error, mods] = createPacModifiers(stored);
    expect(error).to.equal(null);
    expect(mods.proxyProfiles).to.have.length(1);
  });
});
