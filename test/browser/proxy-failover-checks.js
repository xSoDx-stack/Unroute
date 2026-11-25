// Runs inside real extension documents in both browsers. All responses are
// local HTTP fixtures; routing is performed only by the installed extension.
export async function checkProxyFailover({ send, probe, select, port, refusedPort, proxyPort, secondProxyPort, suffix, proofs = [] }) {
  const call = async message => {
    const result = await send(message);
    if (!result?.success) throw new Error(message.action + ': ' + JSON.stringify(result));
    return result.data;
  };
  await call({ action: 'SAVE_MODS', mods: { exceptions: {}, whitelist: [],
    customProxyStringRaw: [refusedPort, proxyPort, secondProxyPort].map(value => `HTTP 127.0.0.1:${value}`).join('\n'),
    ifUseLocalTor: false, ifUseLocalWarp: false, ifUseSecureProxiesOnly: false,
    ifMindExceptions: true, ifMindWhitelist: false, ifProxyHttpsUrlsOnly: false,
    ifProxyOrDie: true, fallbackProxyId: null, ifUseOwnProxiesOnlyForOwnSites: true } });
  await call({ action: 'INSTALL_PAC', key: 'onlyOwnSites' });
  const catalog = (await call({ action: 'GET_EXCEPTIONS' })).proxyCatalog;
  const id = value => {
    const profile = catalog.find(item => item.endpoint === `PROXY 127.0.0.1:${value}`);
    if (!profile) throw new Error('Missing fixture proxy: ' + value);
    return profile.id;
  };
  const hosts = { failed: `failover.${suffix}`, healthy: `healthy.${suffix}`, reserve: `reserve.${suffix}`, direct: `direct.${suffix}` };
  await call({ action: 'MUTATE_DOMAIN_RULES', operations: [
    ...[['failed', refusedPort], ['healthy', secondProxyPort], ['reserve', proxyPort]].map(([key, value]) => ({ domain: hosts[key], mode: 'proxy', proxyId: id(value) })),
    { domain: hosts.direct, mode: 'direct' },
  ] });
  const choose = async value => {
    await select(value);
    const mods = (await call({ action: 'GET_STATE' })).pacMods;
    const expected = value === 'block' || value === 'direct' ? null : value;
    if ((mods.fallbackProxyId || null) !== expected || mods.ownProxyOrDie !== (value !== 'direct') || mods.ifProxyOrDie !== true) {
      throw new Error('Failover select did not persist: ' + JSON.stringify(mods));
    }
  };
  const failures = [];
  const check = async (label, host, expected) => {
    const url = `http://${host}:${port}/proxy-failover-${label}`;
    const result = await probe(url);
    proofs.push({ label, url, expected, ...result });
    if (expected === 'blocked') {
      if (!result.error || result.body) failures.push(label + ': expected browser network error: ' + JSON.stringify(result));
    } else if (result.error || result.body !== expected) {
      failures.push(label + ': ' + JSON.stringify(result) + ' !== ' + expected);
    }
  };
  await choose(id(proxyPort));
  await check('refused-to-reserve', hosts.failed, 'reserve-proxy');
  await check('direct-rule-unaffected', hosts.direct, 'origin-direct');
  await check('healthy-assignment-unaffected', hosts.healthy, 'healthy-proxy');
  await check('reserve-self-no-loop', hosts.reserve, 'reserve-proxy');
  await choose('block');
  await check('refused-block', hosts.failed, 'blocked');
  await check('block-direct-rule-unaffected', hosts.direct, 'origin-direct');
  await check('block-healthy-unaffected', hosts.healthy, 'healthy-proxy');
  await choose('direct');
  await check('refused-explicit-direct', hosts.failed, 'origin-direct');
  await check('direct-healthy-unaffected', hosts.healthy, 'healthy-proxy');
  if (failures.length) throw new Error(failures.join('\n'));
  return proofs;
}
