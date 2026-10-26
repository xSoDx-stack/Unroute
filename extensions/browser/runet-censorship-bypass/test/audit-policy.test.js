import { expect } from 'chai';
import { isAllowedAuditEntry } from '../scripts/audit-policy.mjs';

describe('Dependency audit policy', () => {
  let lock;
  let entry;
  beforeEach(() => {
    lock = { packages: {
      'node_modules/web-ext': { version: '10.8.0' },
      'node_modules/@devicefarmer/adbkit': { version: '3.3.9', dependencies: { 'node-forge': '^1.4.0' } },
      'node_modules/node-forge': { version: '1.4.0' },
    } };
    entry = { severity: 'high', nodes: ['node_modules/node-forge'], via: [{
      name: 'node-forge', severity: 'high', url: 'https://github.com/advisories/GHSA-86w9-cpqp-85rv',
    }] };
  });
  it('accepts only the reviewed advisory and its exact locked dependency chain', () => {
    expect(isAllowedAuditEntry('node-forge', entry, lock)).to.equal(true);
    for (const [name, via] of [['@devicefarmer/adbkit', 'node-forge'], ['web-ext', '@devicefarmer/adbkit']]) {
      expect(isAllowedAuditEntry(name, { severity: 'high', nodes: [`node_modules/${name}`], via: [via] }, lock)).to.equal(true);
    }
  });
  it('rejects new advisories or higher severity in an acknowledged package', () => {
    entry.via.push({ ...entry.via[0], url: 'https://github.com/advisories/new-issue' });
    expect(isAllowedAuditEntry('node-forge', entry, lock)).to.equal(false);
    entry.via.pop();
    entry.severity = 'critical';
    expect(isAllowedAuditEntry('node-forge', entry, lock)).to.equal(false);
  });
  it('requires re-review when versions, locations or consumers change', () => {
    lock.packages['node_modules/node-forge'].version = '1.4.1';
    expect(isAllowedAuditEntry('node-forge', entry, lock)).to.equal(false);
    lock.packages['node_modules/node-forge'].version = '1.4.0';
    lock.packages['node_modules/new-consumer'] = { dependencies: { 'node-forge': '*' } };
    expect(isAllowedAuditEntry('node-forge', entry, lock)).to.equal(false);
    delete lock.packages['node_modules/new-consumer'];
    entry.nodes.push('node_modules/other/node_modules/node-forge');
    expect(isAllowedAuditEntry('node-forge', entry, lock)).to.equal(false);
  });
  it('rejects unrelated high/critical vulnerabilities and the old image-size exception', () => {
    for (const name of ['image-size', 'addons-linter', 'shell-quote', 'puppeteer-core']) {
      expect(isAllowedAuditEntry(name, { severity: 'high', nodes: [`node_modules/${name}`], via: ['node-forge'] }, lock)).to.equal(false);
    }
    expect(isAllowedAuditEntry('web-ext', { severity: 'high', nodes: ['node_modules/web-ext'],
      via: ['@devicefarmer/adbkit', 'fx-runner'] }, lock)).to.equal(false);
  });
});
