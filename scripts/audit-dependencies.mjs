import { spawnSync } from 'node:child_process';
import { findBlockingVulnerabilities } from './audit-policy.mjs';

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

let blocking;
try {
  blocking = findBlockingVulnerabilities(report, audit.status);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (blocking.length > 0) {
  console.error('npm audit found high/critical vulnerabilities:');
  for (const [name, vulnerability] of blocking) {
    console.error(`- ${name}: ${vulnerability.severity}`);
  }
  process.exit(1);
}

console.log('Dependency audit passed: no high/critical vulnerabilities (no exceptions).');
