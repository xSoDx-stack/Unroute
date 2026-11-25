'use strict';

import { expect } from 'chai';
import {
  describeHealthCheckTarget,
  diagnoseBrowserProxyError,
  diagnoseNavigationProxyFailure,
  sanitizeProxyEndpointInfo,
} from '../src/common/core/proxy-diagnostics.js';
import { reconcileProxyProfiles } from '../src/common/core/proxy-profiles.js';
import { createPacModifiers } from '../src/common/core/pac-modifiers.js';

describe('Proxy and PAC concrete journal diagnostics', () => {
  function buildMods(overrides = {}) {
    const raw = reconcileProxyProfiles({
      customProxyStringRaw: 'HTTPS userA:superSecretPass@203.0.113.10:443\nSOCKS5 198.51.100.20:1080',
      proxyProfiles: [
        { id: 'custom:00000000-0000-4000-8000-000000000001', name: 'Нидерланды', endpoint: 'HTTPS 203.0.113.10:443', enabled: true },
        { id: 'custom:00000000-0000-4000-8000-000000000002', name: 'Резерв DE', endpoint: 'SOCKS5 198.51.100.20:1080', enabled: true },
      ],
      ...overrides,
    });
    const [err, mods] = createPacModifiers(raw);
    expect(err).to.equal(null);
    return mods;
  }

  it('strips credentials from endpoints while preserving protocol, IP/host and port', () => {
    const info = sanitizeProxyEndpointInfo('HTTPS login:topSecret123@203.0.113.10:443');
    expect(info).to.deep.equal({
      scheme: 'HTTPS',
      host: '203.0.113.10',
      port: '443',
      hostPort: '203.0.113.10:443',
      display: 'HTTPS 203.0.113.10:443',
    });
    expect(JSON.stringify(info)).to.not.match(/login|topSecret123/);
  });

  it('identifies the exact named user proxy, IP:port and list rule on navigation failure without leaking secrets', () => {
    const mods = buildMods({
      domainLists: [{
        id: 'list-ai',
        name: 'AI сервисы',
        enabled: true,
        proxyId: 'custom:00000000-0000-4000-8000-000000000001',
        domains: ['openai.com'],
      }],
    });

    const diag = diagnoseNavigationProxyFailure({
      domain: 'chat.openai.com',
      error: 'net::ERR_PROXY_CONNECTION_FAILED',
      mods,
      pacProviderKey: 'Антизапрет',
    });

    expect(diag.title).to.include('«Нидерланды» (HTTPS 203.0.113.10:443)');
    expect(diag.title).to.include('chat.openai.com');
    expect(diag.message).to.include('лист «AI сервисы»');
    expect(diag.details).to.include({
      routeSource: 'own',
      proxy: '«Нидерланды» (HTTPS 203.0.113.10:443)',
      domain: 'chat.openai.com',
    });
    expect(JSON.stringify(diag)).to.not.match(/userA|superSecretPass/);
  });

  it('reports both primary and reserve proxy profiles when both fail on an own route', () => {
    const mods = buildMods({
      exceptions: { 'example.org': true },
      domainProxyIds: { 'example.org': 'custom:00000000-0000-4000-8000-000000000001' },
      fallbackProxyId: 'custom:00000000-0000-4000-8000-000000000002',
    });

    const diag = diagnoseNavigationProxyFailure({
      domain: 'example.org',
      error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
      mods,
      pacProviderKey: 'Антизапрет',
    });

    expect(diag.title).to.include('Сбой основного и резервного прокси');
    expect(diag.message).to.include('«Нидерланды» (HTTPS 203.0.113.10:443)');
    expect(diag.message).to.include('«Резерв DE» (SOCKS5 198.51.100.20:1080)');
    expect(diag.details.reserveProxy).to.equal('«Резерв DE» (SOCKS5 198.51.100.20:1080)');
  });

  it('explains fail-closed blocking when an assigned proxy is filtered out by secure-only mode', () => {
    const mods = buildMods({
      ifUseSecureProxiesOnly: true,
      exceptions: { 'blocked-socks.test': true },
      domainProxyIds: { 'blocked-socks.test': 'custom:00000000-0000-4000-8000-000000000002' },
    });

    const diag = diagnoseNavigationProxyFailure({
      domain: 'blocked-socks.test',
      error: 'net::ERR_PROXY_CONNECTION_FAILED',
      proxyInfo: { type: 'http', host: '127.0.0.1', port: 9 },
      mods,
    });

    expect(diag.title).to.include('Заблокировано');
    expect(diag.title).to.include('«Резерв DE»');
    expect(diag.details.routeSource).to.equal('blocked');
  });

  it('clearly attributes PAC-routed failures to the active PAC provider without exposing custom PAC URL secrets', () => {
    const mods = buildMods({ ifUseOwnProxiesOnlyForOwnSites: true });

    const azDiag = diagnoseNavigationProxyFailure({
      domain: 'rutracker.org',
      error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
      proxyInfo: { type: 'https', host: 'proxy.antizapret.prostovpn.org', port: 8443 },
      mods,
      pacProviderKey: 'Антизапрет',
    });
    expect(azDiag.title).to.include('PAC «Антизапрет»');
    expect(azDiag.title).to.include('proxy.antizapret.prostovpn.org:8443');
    expect(azDiag.details.routeSource).to.equal('pac');

    const customPacDiag = diagnoseNavigationProxyFailure({
      domain: 'news.example.com',
      error: 'net::ERR_PROXY_CONNECTION_FAILED',
      mods,
      pacProviderKey: 'customPacUrl',
      customPacUrl: 'https://pacUser:pacSecret@corp-pac.example.net:8443/private/path.pac?token=xyz987',
    });
    expect(customPacDiag.title).to.include('Свой PAC (corp-pac.example.net:8443)');
    expect(JSON.stringify(customPacDiag)).to.not.match(/pacUser|pacSecret|private\/path|xyz987/);
  });

  it('distinguishes PAC script runtime errors from proxy connection errors in onProxyError and names health-check targets', () => {
    const mods = buildMods();

    const pacErr = diagnoseBrowserProxyError({
      safeDetails: { error: 'net::ERR_PAC_SCRIPT_FAILED', details: 'line 4: Uncaught ReferenceError', fatal: true },
      mods,
      pacProviderKey: 'Антицензорити',
    });
    expect(pacErr.category).to.equal('pac');
    expect(pacErr.title).to.include('PAC «Антицензорити»');

    const proxyErr = diagnoseBrowserProxyError({
      safeDetails: { error: 'net::ERR_PROXY_CONNECTION_FAILED', details: 'Failed to connect to 203.0.113.10:443', fatal: false },
      mods,
      pacProviderKey: 'Антизапрет',
    });
    expect(proxyErr.category).to.equal('proxy');
    expect(proxyErr.title).to.include('«Нидерланды» (HTTPS 203.0.113.10:443)');

    const healthTarget = describeHealthCheckTarget(
      { type: 'HTTPS', hostname: '203.0.113.10', port: '443', username: 'userA', password: 'superSecretPass' },
      mods,
    );
    expect(healthTarget.label).to.equal('«Нидерланды» (HTTPS 203.0.113.10:443)');
    expect(JSON.stringify(healthTarget)).to.not.match(/userA|superSecretPass/);
  });
});
