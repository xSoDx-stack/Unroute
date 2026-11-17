// No package or advisory exceptions: every high/critical issue blocks CI.
export function findBlockingVulnerabilities(report, exitStatus = 0) {
  if (!report || report.auditReportVersion !== 2 || !report.vulnerabilities ||
      typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    throw new Error('Invalid npm audit report');
  }
  const entries = Object.entries(report.vulnerabilities);
  for (const [, vulnerability] of entries) {
    if (!vulnerability || !['info', 'low', 'moderate', 'high', 'critical'].includes(vulnerability.severity)) {
      throw new Error('Invalid npm audit vulnerability severity');
    }
  }
  const blocking = entries.filter(([, vulnerability]) => ['high', 'critical'].includes(vulnerability.severity));
  if (exitStatus === 1 && blocking.length === 0) {
    throw new Error('Invalid npm audit result: nonzero exit status without high/critical vulnerabilities');
  }
  return blocking;
}
