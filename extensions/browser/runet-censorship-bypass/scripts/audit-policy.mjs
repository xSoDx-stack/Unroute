// web-ext's Android runner uses adbkit -> node-forge. GHSA-86w9-cpqp-85rv
// has no patched npm release as of 2026-10-26. CI builds, lints and signs
// extensions; it never starts adbkit's TCP/USB authentication server. These
// development dependencies are not copied into browser extension packages.
// Accept only this advisory and this locked chain, not arbitrary forge issues.
export function isAllowedAuditEntry(name, vulnerability, lock) {
  const packages = lock.packages || {};
  const versions = {
    'web-ext': '10.8.0',
    '@devicefarmer/adbkit': '3.3.9',
    'node-forge': '1.4.0',
  };
  for (const [dependency, version] of Object.entries(versions)) {
    if (packages[`node_modules/${dependency}`]?.version !== version) return false;
  }
  const consumers = Object.entries(packages)
    .filter(([, pkg]) => pkg.dependencies?.['node-forge'])
    .map(([location]) => location);
  if (consumers.length !== 1 || consumers[0] !== 'node_modules/@devicefarmer/adbkit') return false;
  if (vulnerability.severity !== 'high' || vulnerability.nodes?.length !== 1 ||
      vulnerability.nodes[0] !== `node_modules/${name}` || vulnerability.via?.length !== 1) return false;
  const via = vulnerability.via[0];
  if (name === 'node-forge') {
    return typeof via === 'object' && via?.name === 'node-forge' && via.severity === 'high' &&
      via.url === 'https://github.com/advisories/GHSA-86w9-cpqp-85rv';
  }
  if (name === '@devicefarmer/adbkit') return via === 'node-forge';
  if (name === 'web-ext') return via === '@devicefarmer/adbkit';
  return false;
}
