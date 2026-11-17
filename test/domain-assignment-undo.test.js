import { expect } from 'chai';
import { migrateSettings, recordRuleChange, undoRuleChange } from '../src/common/core/settings-schema.js';
import { deleteProxyProfile } from '../src/common/core/proxy-profiles.js';

describe('Assignment selective undo ownership', () => {
  it('does not undo a later explicit same-proxy decision through an older assignment', () => {
    const domain = 'chosen.test';
    let raw = migrateSettings({ customProxyStringRaw: 'HTTP first.test:8080; HTTP second.test:8080', exceptions: { [domain]: true } });
    const [first, second] = raw.proxyProfiles;
    const context = { source: 'manual', touchedProxyDomains: [domain] };
    raw = recordRuleChange(raw, { ...raw, domainProxyIds: { [domain]: first.id } }, context);
    raw = recordRuleChange(raw, { ...raw, domainProxyIds: { [domain]: second.id } }, context);
    const earlierMove = raw.ruleHistory[0].id;
    raw = recordRuleChange(raw, { ...raw, domainProxyIds: { ...raw.domainProxyIds } }, context);
    const undone = undoRuleChange(raw, earlierMove);
    expect(undone.settings.domainProxyIds[domain]).to.equal(second.id);
    expect(undone.skipped).to.be.greaterThan(0);
  });

  it('does not turn DIRECT into an unassigned legacy route when the original proxy was deleted', () => {
    const domain = 'private.test';
    let raw = migrateSettings({ customProxyStringRaw: 'HTTP first.test:8080; HTTP second.test:8080', exceptions: { [domain]: true } });
    const [first, second] = raw.proxyProfiles;
    raw = recordRuleChange(raw, { ...raw, domainProxyIds: { [domain]: first.id } }, { source: 'manual' });
    raw = recordRuleChange(raw, { ...raw, exceptions: { [domain]: false }, domainProxyIds: {} }, { source: 'manual' });
    const directOperation = raw.ruleHistory[0].id;
    raw = recordRuleChange(raw, deleteProxyProfile(raw, first.id, second.id), { source: 'manual' });
    const undone = undoRuleChange(raw, directOperation);
    expect(undone.settings.exceptions[domain]).to.equal(false);
    expect(undone.settings.domainProxyIds).not.to.have.property(domain);
    expect(undone.skipped).to.be.greaterThan(0);
  });
});
