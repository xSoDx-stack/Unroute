import { expect } from 'chai';
import { findBlockingVulnerabilities } from '../scripts/audit-policy.mjs';

describe('Dependency audit policy without exceptions', () => {
  const report = vulnerabilities => ({ auditReportVersion: 2, vulnerabilities });

  it('rejects high and critical issues, including previously acknowledged dependencies', () => {
    const result = findBlockingVulnerabilities(report({
      'node-forge': { severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-86w9-cpqp-85rv' }] },
      'web-ext': { severity: 'critical', via: ['node-forge'] },
      'other-package': { severity: 'moderate' },
    }));
    expect(result.map(([name]) => name)).to.deep.equal(['node-forge', 'web-ext']);
  });

  it('passes a valid empty report and permits issues below the configured threshold', () => {
    expect(findBlockingVulnerabilities(report({}))).to.deep.equal([]);
    expect(findBlockingVulnerabilities(report({ sample: { severity: 'low' } }))).to.deep.equal([]);
  });

  it('fails closed on incomplete reports and unknown severities', () => {
    for (const invalid of [{}, null, { auditReportVersion: 2 }, report([]), report({ sample: {} }),
      report({ sample: { severity: 'unknown' } })]) {
      expect(() => findBlockingVulnerabilities(invalid)).to.throw('Invalid npm audit');
    }
  });

  it('rejects a nonzero audit result without a vulnerability meeting the configured threshold', () => {
    expect(() => findBlockingVulnerabilities(report({}), 1)).to.throw('Invalid npm audit result');
    expect(() => findBlockingVulnerabilities(report({ sample: { severity: 'moderate' } }), 1))
      .to.throw('Invalid npm audit result');
    expect(findBlockingVulnerabilities(report({ sample: { severity: 'high' } }), 1)).to.have.length(1);
  });
});
