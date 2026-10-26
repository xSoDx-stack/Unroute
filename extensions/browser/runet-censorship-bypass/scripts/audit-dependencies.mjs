import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAllowedAuditEntry } from './audit-policy.mjs';

const severityRank = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

const npmCli = process.env.npm_execpath;
const auditCommand = npmCli ? process.execPath : 'npm';
const auditArgs = npmCli
  ? [npmCli, 'audit', '--json', '--audit-level=high']
  : ['audit', '--json', '--audit-level=high'];
const audit = spawnSync(auditCommand, auditArgs, {
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024,
});

if (audit.error) throw audit.error;

let report;
try {
  report = JSON.parse(audit.stdout || '{}');
} catch {
  process.stderr.write(audit.stderr || audit.stdout || 'npm audit returned invalid JSON\n');
  process.exit(1);
}

if (report.error || (audit.status !== 0 && audit.status !== 1)) {
  process.stderr.write(JSON.stringify(report.error || report, null, 2));
  process.exit(1);
}

const relevant = Object.entries(report.vulnerabilities || {}).filter(([, vulnerability]) =>
  severityRank[vulnerability.severity] >= severityRank.high
);

const unapproved = relevant.filter(([name, vulnerability]) => !isAllowedAuditEntry(name, vulnerability, lock));
if (unapproved.length > 0) {
  console.error('npm audit found unapproved high/critical vulnerabilities:');
  for (const [name, vulnerability] of unapproved) {
    console.error(`- ${name}: ${vulnerability.severity}`);
  }
  process.exit(1);
}

if (relevant.length > 0) {
  console.warn('Acknowledged GHSA-86w9-cpqp-85rv in the pinned, unused Android adbkit authentication chain; no patched node-forge release exists.');
}
console.log('Dependency audit passed: no unapproved high/critical vulnerabilities.');
