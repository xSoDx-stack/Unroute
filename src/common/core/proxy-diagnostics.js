'use strict';

import { t } from './i18n.js';
import { utils } from './utils.js';
import { ipToHost } from './ip-to-host.js';
import { matchConfiguredRule } from './domain-route-resolver.js';
import { sanitizeLogString } from './logger.js';
import { BUILTIN_PROXY_IDS } from './proxy-profiles.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function normalizeHost(rawHost = '') {
  let host = String(rawHost || '').trim().toLowerCase();
  if (!host) return '';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  return host;
}

function isLoopback(host = '') {
  return LOOPBACK_HOSTS.has(String(host || '').trim().toLowerCase());
}

function sameEndpointHostPort(aHost, aPort, bHost, bPort) {
  if (!aHost || !bHost || String(aPort) !== String(bPort)) return false;
  if (isLoopback(aHost) && isLoopback(bHost)) return true;
  return normalizeHost(aHost) === normalizeHost(bHost);
}

/**
 * Extracts strictly non-secret protocol + host:port display metadata.
 * Credentials, URL paths, and query parameters are never returned.
 */
export function sanitizeProxyEndpointInfo(value) {
  if (!value) return null;
  if (typeof value === 'object' && value.host) {
    const rawType = String(value.type || '').trim().toUpperCase();
    if (rawType === 'DIRECT') return null;
    const scheme = rawType === 'SOCKS' ? 'SOCKS5' : rawType === 'PROXY' ? 'HTTP' : rawType || 'PROXY';
    const host = normalizeHost(value.host);
    const port = Number(value.port);
    if (!host || !Number.isInteger(port) || port < 0 || port > 65535) return null;
    const hostPort = `${host}:${port}`;
    return { scheme, host, port: String(port), hostPort, display: `${scheme} ${hostPort}` };
  }

  let text = String(value || '').trim();
  if (!text || /^direct$/i.test(text)) return null;
  const parsed = utils.parseProxyScheme(text.replace(/^PROXY\s+/i, 'HTTP '));
  if (parsed && parsed.hostname && parsed.port) {
    const scheme = parsed.type === 'PROXY' ? 'HTTP' : parsed.type;
    const host = normalizeHost(parsed.hostname);
    const port = String(parsed.port);
    const hostPort = `${host}:${port}`;
    return { scheme, host, port, hostPort, display: `${scheme} ${hostPort}` };
  }

  // Fallback for bare host:port or [ipv6]:port without scheme (strip any userinfo@)
  if (text.includes('@')) text = text.slice(text.lastIndexOf('@') + 1).trim();
  text = text.replace(/^(?:https?|proxy|socks[45]?|quic)\s+/i, '').trim();
  const match = text.match(/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i);
  if (!match) return null;
  const host = normalizeHost(match[1]);
  const port = match[2];
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 0 || portNum > 65535) return null;
  const hostPort = `${host}:${port}`;
  return { scheme: '', host, port, hostPort, display: hostPort };
}

export function formatProxyIdentity(name, endpointDisplay, hostPort = '') {
  const cleanName = sanitizeLogString(String(name || '').trim());
  const cleanDisplay = sanitizeLogString(String(endpointDisplay || hostPort || '').trim());
  if (!cleanName) return cleanDisplay;
  const foldedName = cleanName.toLowerCase();
  if (!cleanDisplay || foldedName === cleanDisplay.toLowerCase() || (hostPort && foldedName === hostPort.toLowerCase())) {
    return cleanName;
  }
  return t('diag_proxy_named', '«$1» ($2)', [cleanName, cleanDisplay]);
}

export function describePacSource(providerKey = '', customPacUrl = '') {
  const key = String(providerKey || '').trim();
  if (!key || key === 'none') return { key: 'none', label: '' };
  if (key === 'Антизапрет') {
    return { key, label: t('diag_pac_antizapret', 'PAC «Антизапрет»') };
  }
  if (key === 'Антицензорити') {
    return { key, label: t('diag_pac_anticensority', 'PAC «Антицензорити»') };
  }
  if (key === 'onlyOwnSites') {
    return { key, label: t('diag_pac_only_own', 'Только свои сайты') };
  }
  if (key === 'customPacUrl') {
    let host = '';
    try {
      if (customPacUrl) host = new URL(String(customPacUrl).trim()).host.toLowerCase();
    } catch {
      host = '';
    }
    return {
      key,
      host,
      label: host
        ? t('diag_pac_custom_host', 'Свой PAC ($1)', [host])
        : t('diag_pac_custom', 'Свой PAC'),
    };
  }
  return { key, label: `PAC «${sanitizeLogString(key)}»` };
}

export function describeProfileById(proxyId, mods = null) {
  if (!proxyId) return null;
  if (proxyId === BUILTIN_PROXY_IDS.tor) {
    const endpoint = 'SOCKS5 127.0.0.1:9150 / 9050';
    return {
      id: proxyId,
      kind: 'tor',
      name: 'Tor',
      endpoint,
      hostPort: '127.0.0.1:9050',
      label: t('diag_proxy_local_tor', 'Локальный Tor ($1)', ['SOCKS5 127.0.0.1:9150 / 9050']),
      available: Boolean(mods?.ifUseLocalTor && mods?.proxyRoutes?.[proxyId]),
    };
  }
  if (proxyId === BUILTIN_PROXY_IDS.warp) {
    const endpoint = '127.0.0.1:40000';
    return {
      id: proxyId,
      kind: 'warp',
      name: 'Cloudflare WARP',
      endpoint,
      hostPort: endpoint,
      label: t('diag_proxy_local_warp', 'Cloudflare WARP ($1)', [endpoint]),
      available: Boolean(mods?.ifUseLocalWarp && mods?.proxyRoutes?.[proxyId]),
    };
  }

  const profile = (mods?.proxyProfiles || []).find(item => item && item.id === proxyId);
  if (!profile) {
    return {
      id: proxyId,
      kind: 'own',
      name: '',
      endpoint: '',
      hostPort: '',
      label: t('diag_proxy_deleted', 'удалённый профиль прокси'),
      available: false,
    };
  }
  const info = sanitizeProxyEndpointInfo(profile.endpoint);
  const display = info?.display || sanitizeLogString(profile.endpoint || '');
  const hostPort = info?.hostPort || '';
  return {
    id: profile.id,
    kind: 'own',
    name: sanitizeLogString(profile.name || ''),
    endpoint: display,
    hostPort,
    label: formatProxyIdentity(profile.name, display, hostPort),
    available: Boolean(mods?.proxyRoutes ? mods.proxyRoutes[profile.id] : profile.enabled !== false),
  };
}

export function identifyProxyEndpoint(endpointOrInfo, mods = null) {
  const info = sanitizeProxyEndpointInfo(endpointOrInfo);
  if (!info) return null;

  if (isLoopback(info.host) && info.port === '9') {
    return { kind: 'sinkhole_assigned', ...info, label: info.hostPort };
  }
  if (isLoopback(info.host) && info.port === '0') {
    return { kind: 'sinkhole_policy', ...info, label: info.hostPort };
  }

  for (const profile of mods?.proxyProfiles || []) {
    const pInfo = sanitizeProxyEndpointInfo(profile?.endpoint);
    if (!pInfo) continue;
    const schemeMatches = !info.scheme || !pInfo.scheme || info.scheme === pInfo.scheme;
    if (schemeMatches && sameEndpointHostPort(info.host, info.port, pInfo.host, pInfo.port)) {
      return {
        kind: 'own',
        id: profile.id,
        name: sanitizeLogString(profile.name || ''),
        ...pInfo,
        label: formatProxyIdentity(profile.name, pInfo.display, pInfo.hostPort),
      };
    }
  }

  if (isLoopback(info.host) && (info.port === '9050' || info.port === '9150')) {
    return {
      kind: 'tor',
      name: 'Tor',
      ...info,
      label: t('diag_proxy_local_tor', 'Локальный Tor ($1)', [`SOCKS5 ${info.hostPort}`]),
    };
  }
  if (isLoopback(info.host) && info.port === '40000') {
    return {
      kind: 'warp',
      name: 'Cloudflare WARP',
      ...info,
      label: t('diag_proxy_local_warp', 'Cloudflare WARP ($1)', [info.display]),
    };
  }

  for (const directive of String(mods?.filteredCustomsString || '').split(';')) {
    const cInfo = sanitizeProxyEndpointInfo(directive);
    if (cInfo && sameEndpointHostPort(info.host, info.port, cInfo.host, cInfo.port)) {
      return { kind: 'own', name: '', ...cInfo, label: cInfo.display };
    }
  }

  return { kind: 'pac', name: '', ...info, label: info.display };
}

export function describeHealthCheckTarget(parsed, mods = null) {
  const info = sanitizeProxyEndpointInfo(`${parsed?.type || ''} ${parsed?.hostname || ''}:${parsed?.port || ''}`);
  if (!info) return { label: '', name: '', endpoint: '', hostPort: '' };
  const matched = identifyProxyEndpoint(info.display, mods);
  if (matched && matched.kind === 'own' && matched.name) {
    return { label: matched.label, name: matched.name, endpoint: info.display, hostPort: info.hostPort };
  }
  return { label: info.display, name: '', endpoint: info.display, hostPort: info.hostPort };
}

function summarizeOwnPool(mods) {
  const seen = new Set();
  const labels = [];
  for (const part of String(mods?.filteredCustomsString || '').split(';')) {
    const matched = identifyProxyEndpoint(part, mods);
    if (matched && !seen.has(matched.label)) {
      seen.add(matched.label);
      labels.push(matched.label);
    }
  }
  return labels;
}

function describeRuleOrigin(match, mods) {
  if (!match?.matched) return '';
  if (match.listId) {
    const list = (mods?.domainLists || []).find(item => item && item.id === match.listId);
    if (list?.name) {
      return t('diag_rule_list_named', 'лист «$1» ($2)', [sanitizeLogString(list.name), match.ruleKey]);
    }
  }
  return t('diag_rule_manual', 'правило «$1»', [sanitizeLogString(match.ruleKey || '')]);
}

/**
 * Produces concrete, secret-free diagnostic title, message, details, and groupKey
 * for a failed top-level navigation (`webRequest.onErrorOccurred`).
 */
export function diagnoseNavigationProxyFailure({
  domain = '',
  error = '',
  proxyInfo = null,
  ip = '',
  mods = null,
  pacProviderKey = '',
  customPacUrl = '',
} = {}) {
  const cleanDomain = sanitizeLogString(String(domain || '').trim().toLowerCase());
  const cleanError = sanitizeLogString(String(error || '').trim());
  const pac = describePacSource(pacProviderKey, customPacUrl);
  const match = mods && cleanDomain ? matchConfiguredRule(cleanDomain, mods) : { matched: false };
  const ruleLabel = describeRuleOrigin(match, mods);

  let observed = proxyInfo ? identifyProxyEndpoint(proxyInfo, mods) : null;
  if (!observed && ip) {
    const mapped = ipToHost.get(ip);
    if (mapped && mapped.replace(/:\d+$/, '') !== cleanDomain && ip !== cleanDomain) {
      observed = identifyProxyEndpoint(mapped, mods);
    }
  }

  const assignedId = match.matched && match.isProxied && !match.isPac
    ? (match.proxyId ?? (Object.hasOwn(mods?.domainProxyIds || {}, match.ruleKey) ? mods.domainProxyIds[match.ruleKey] : undefined))
    : undefined;
  const assignedProfile = assignedId !== undefined ? describeProfileById(assignedId, mods) : null;
  const reserveProfile = mods?.fallbackProxyId ? describeProfileById(mods.fallbackProxyId, mods) : null;
  const activeReserve = reserveProfile && reserveProfile.available &&
    (!assignedProfile || reserveProfile.id !== assignedProfile.id) ? reserveProfile : null;

  // 1. Intentional fail-closed sinkhole for disabled/unavailable assigned profile (127.0.0.1:9)
  if (observed?.kind === 'sinkhole_assigned' || (assignedProfile && !assignedProfile.available)) {
    const targetLabel = assignedProfile?.label || t('diag_proxy_assigned_unavailable', 'назначенный профиль');
    return {
      title: t('diag_nav_blocked_assigned_title', 'Заблокировано: прокси $1 недоступен → $2', [targetLabel, cleanDomain]),
      message: t('diag_nav_blocked_assigned_msg',
        'Назначенный для «$1» прокси $2 отключён или отфильтрован настройкой шифрования ($3).',
        [cleanDomain, targetLabel, cleanError]),
      details: {
        error: cleanError,
        domain: cleanDomain,
        type: 'main_frame',
        routeSource: 'blocked',
        proxy: targetLabel,
        ...(ruleLabel ? { rule: ruleLabel } : {}),
      },
      groupKey: `blocked-assigned|${assignedProfile?.id || ''}|${cleanDomain}`,
    };
  }

  // 2. Intentional fail-closed policy sinkhole (127.0.0.1:0)
  if (observed?.kind === 'sinkhole_policy') {
    const scopeLabel = match.matched && !match.isPac ? (ruleLabel || cleanDomain) : (pac.label || 'PAC');
    return {
      title: t('diag_nav_blocked_policy_title', 'Заблокировано политикой отказа ($1) → $2', [scopeLabel, cleanDomain]),
      message: t('diag_nav_blocked_policy_msg',
        'Для «$1» не осталось доступных прокси после фильтрации; прямое соединение запрещено ($2).',
        [cleanDomain, cleanError]),
      details: {
        error: cleanError,
        domain: cleanDomain,
        type: 'main_frame',
        routeSource: 'blocked',
        ...(pac.label ? { pacProvider: pac.label } : {}),
        ...(ruleLabel ? { rule: ruleLabel } : {}),
      },
      groupKey: `blocked-policy|${cleanDomain}`,
    };
  }

  // 3. Browser reported the exact proxy endpoint that failed (Firefox proxyInfo or IP match)
  if (observed) {
    if (observed.kind === 'pac') {
      const pacTitle = pac.label || 'PAC';
      return {
        title: t('diag_nav_pac_endpoint_title', 'Сбой прокси $1 ($2) → $3', [pacTitle, observed.hostPort, cleanDomain]),
        message: t('diag_nav_pac_endpoint_msg',
          'Не удалось открыть «$1» через прокси из $2 ($3): $4. Это не означает, что весь PAC недоступен.',
          [cleanDomain, pacTitle, observed.display, cleanError]),
        details: {
          error: cleanError,
          domain: cleanDomain,
          type: 'main_frame',
          routeSource: 'pac',
          pacProvider: pacTitle,
          proxy: observed.display,
        },
        groupKey: `${cleanError}|pac|${observed.hostPort}|${cleanDomain}`,
      };
    }

    return {
      title: t('diag_nav_own_endpoint_title', 'Сбой прокси $1 → $2', [observed.label, cleanDomain]),
      message: t('diag_nav_own_endpoint_msg',
        'Не удалось открыть «$1» через прокси $2 ($3). Проверьте доступность этого прокси во вкладке «Прокси».',
        [cleanDomain, observed.label, cleanError]),
      details: {
        error: cleanError,
        domain: cleanDomain,
        type: 'main_frame',
        routeSource: observed.kind,
        proxy: observed.label,
        ...(ruleLabel ? { rule: ruleLabel } : {}),
      },
      groupKey: `${cleanError}|${observed.hostPort}|${cleanDomain}`,
    };
  }

  // 4. Chromium (no proxyInfo on failed request): infer exact route from active rules
  if (match.matched && match.isProxied && !match.isPac) {
    if (assignedProfile) {
      if (activeReserve) {
        return {
          title: t('diag_nav_own_with_reserve_title', 'Сбой основного и резервного прокси: $1 → $2', [assignedProfile.label, cleanDomain]),
          message: t('diag_nav_own_with_reserve_msg',
            'Не удалось открыть «$1» ($2): не ответили ни основной прокси $3, ни резервный $4 ($5).',
            [cleanDomain, ruleLabel, assignedProfile.label, activeReserve.label, cleanError]),
          details: {
            error: cleanError,
            domain: cleanDomain,
            type: 'main_frame',
            routeSource: assignedProfile.kind,
            proxy: assignedProfile.label,
            reserveProxy: activeReserve.label,
            ...(ruleLabel ? { rule: ruleLabel } : {}),
          },
          groupKey: `${cleanError}|${assignedProfile.id}|${activeReserve.id}|${cleanDomain}`,
        };
      }
      return {
        title: t('diag_nav_own_endpoint_title', 'Сбой прокси $1 → $2', [assignedProfile.label, cleanDomain]),
        message: t('diag_nav_assigned_msg',
          'Не удалось открыть «$1» ($2) через прокси $3 ($4). Проверьте доступность прокси во вкладке «Прокси».',
          [cleanDomain, ruleLabel, assignedProfile.label, cleanError]),
        details: {
          error: cleanError,
          domain: cleanDomain,
          type: 'main_frame',
          routeSource: assignedProfile.kind,
          proxy: assignedProfile.label,
          ...(ruleLabel ? { rule: ruleLabel } : {}),
        },
        groupKey: `${cleanError}|${assignedProfile.id}|${cleanDomain}`,
      };
    }

    if (mods?.ifUseLocalTor && /\.onion$/i.test(cleanDomain)) {
      const tor = describeProfileById(BUILTIN_PROXY_IDS.tor, mods);
      return {
        title: t('diag_nav_own_endpoint_title', 'Сбой прокси $1 → $2', [tor.label, cleanDomain]),
        message: t('diag_nav_tor_msg',
          'Не удалось открыть «$1» через $2 ($3). Убедитесь, что локальная служба Tor запущена.',
          [cleanDomain, tor.label, cleanError]),
        details: {
          error: cleanError,
          domain: cleanDomain,
          type: 'main_frame',
          routeSource: 'tor',
          proxy: tor.label,
          ...(ruleLabel ? { rule: ruleLabel } : {}),
        },
        groupKey: `${cleanError}|tor|${cleanDomain}`,
      };
    }

    const poolLabels = summarizeOwnPool(mods);
    if (poolLabels.length) {
      const primaryLabel = poolLabels[0];
      const chainText = poolLabels.join(' → ');
      return {
        title: t('diag_nav_own_endpoint_title', 'Сбой прокси $1 → $2', [primaryLabel, cleanDomain]),
        message: t('diag_nav_pool_msg',
          'Не удалось открыть «$1» ($2) через настроенные прокси: $3 ($4).',
          [cleanDomain, ruleLabel, chainText, cleanError]),
        details: {
          error: cleanError,
          domain: cleanDomain,
          type: 'main_frame',
          routeSource: 'own',
          proxy: chainText,
          ...(activeReserve ? { reserveProxy: activeReserve.label } : {}),
          ...(ruleLabel ? { rule: ruleLabel } : {}),
        },
        groupKey: `${cleanError}|pool|${cleanDomain}`,
      };
    }

    if (mods && !mods.ifUsePacScriptProxies) {
      return {
        title: t('diag_nav_no_own_proxies_title', 'Заблокировано: нет доступных своих прокси → $1', [cleanDomain]),
        message: t('diag_nav_no_own_proxies_msg',
          'Для «$1» ($2) требуется свой прокси, но список доступных прокси пуст ($3).',
          [cleanDomain, ruleLabel, cleanError]),
        details: {
          error: cleanError,
          domain: cleanDomain,
          type: 'main_frame',
          routeSource: 'blocked',
          ...(ruleLabel ? { rule: ruleLabel } : {}),
        },
        groupKey: `no-own-proxies|${cleanDomain}`,
      };
    }
  }

  // 5. Onion domain via automatic local Tor
  if (mods?.ifUseLocalTor && /\.onion$/i.test(cleanDomain)) {
    const tor = describeProfileById(BUILTIN_PROXY_IDS.tor, mods);
    return {
      title: t('diag_nav_own_endpoint_title', 'Сбой прокси $1 → $2', [tor.label, cleanDomain]),
      message: t('diag_nav_tor_msg',
        'Не удалось открыть «$1» через $2 ($3). Убедитесь, что локальная служба Tor запущена.',
        [cleanDomain, tor.label, cleanError]),
      details: {
        error: cleanError,
        domain: cleanDomain,
        type: 'main_frame',
        routeSource: 'tor',
        proxy: tor.label,
      },
      groupKey: `${cleanError}|tor|${cleanDomain}`,
    };
  }

  // 6. Traffic routed by PAC script
  if (pac.label && pac.key !== 'onlyOwnSites') {
    const ownPrepended = !mods?.ifUseOwnProxiesOnlyForOwnSites ? summarizeOwnPool(mods) : [];
    if (ownPrepended.length) {
      const ownChain = ownPrepended.join(' → ');
      return {
        title: t('diag_nav_own_and_pac_title', 'Сбой маршрута (свои прокси + $1) → $2', [pac.label, cleanDomain]),
        message: t('diag_nav_own_and_pac_msg',
          'Не удалось открыть «$1»: не ответили ни свои прокси ($2), ни прокси из $3 ($4).',
          [cleanDomain, ownChain, pac.label, cleanError]),
        details: {
          error: cleanError,
          domain: cleanDomain,
          type: 'main_frame',
          routeSource: 'own+pac',
          proxy: ownChain,
          pacProvider: pac.label,
        },
        groupKey: `${cleanError}|own+pac|${cleanDomain}`,
      };
    }

    return {
      title: t('diag_nav_pac_title', 'Сбой прокси $1 → $2', [pac.label, cleanDomain]),
      message: t('diag_nav_pac_msg',
        'Не удалось выполнить отдельный запрос к «$1» через прокси из $2 ($3). Это не означает, что прокси-сервер PAC недоступен целиком.',
        [cleanDomain, pac.label, cleanError]),
      details: {
        error: cleanError,
        domain: cleanDomain,
        type: 'main_frame',
        routeSource: 'pac',
        pacProvider: pac.label,
        ...(match.isPac && ruleLabel ? { rule: ruleLabel } : {}),
      },
      groupKey: `${cleanError}|${pac.key}|${cleanDomain}|main_frame`,
    };
  }

  // 7. Uninitialized / cold fallback
  return {
    title: cleanDomain ? `${cleanError} → ${cleanDomain}` : cleanError,
    message: t('msg_an_individual_proxy_request_failed_this_does__b7a768af',
      'Не удалось выполнить отдельный запрос через прокси. Это не означает, что прокси-сервер недоступен целиком.'),
    details: {
      error: cleanError,
      domain: cleanDomain,
      type: 'main_frame',
    },
    groupKey: `${cleanError}|${cleanDomain}|main_frame`,
  };
}

function extractEndpointFromFreeText(text = '') {
  if (!text) return null;
  const cleaned = sanitizeLogString(String(text));
  const match = cleaned.match(/(\[[0-9a-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+(?:\.[a-z0-9-]+)+):(\d{1,5})/i);
  if (!match) return null;
  return sanitizeProxyEndpointInfo(`${match[1]}:${match[2]}`);
}

/**
 * Classifies browser-level `chrome.proxy.onProxyError` / `browser.proxy.onError`
 * into concrete PAC-script vs proxy-connection diagnostics without exposing secrets.
 */
export function diagnoseBrowserProxyError({
  safeDetails = {},
  mods = null,
  pacProviderKey = '',
  customPacUrl = '',
} = {}) {
  const errCode = String(safeDetails.error || '').trim();
  const errDetails = String(safeDetails.details || '').trim();
  const pac = describePacSource(pacProviderKey, customPacUrl);
  const isPacScriptIssue = /\bPAC\b|FindProxyForURL|line\s+\d+|syntaxerror|referenceerror|typeerror/i
    .test(`${errCode} ${errDetails}`);

  if (isPacScriptIssue) {
    const pacName = pac.label || 'PAC';
    return {
      category: 'pac',
      title: errCode
        ? t('diag_browser_pac_err_code', 'Ошибка $1: $2', [pacName, errCode])
        : t('diag_browser_pac_err', 'Ошибка выполнения $1', [pacName]),
      message: errDetails || t('diag_browser_pac_msg',
        'Браузер сообщил об ошибке загрузки или выполнения скрипта $1.',
        [pacName]),
      details: {
        ...safeDetails,
        routeSource: 'pac',
        ...(pac.label ? { pacProvider: pac.label } : {}),
      },
    };
  }

  const extracted = extractEndpointFromFreeText(errDetails) || extractEndpointFromFreeText(errCode);
  const matchedEndpoint = extracted ? identifyProxyEndpoint(extracted.display, mods) : null;
  if (matchedEndpoint && matchedEndpoint.kind !== 'sinkhole_assigned' && matchedEndpoint.kind !== 'sinkhole_policy') {
    if (matchedEndpoint.kind === 'pac') {
      const pacName = pac.label || 'PAC';
      return {
        category: 'proxy',
        title: t('diag_browser_pac_proxy_err', 'Сбой прокси $1 ($2): $3',
          [pacName, matchedEndpoint.hostPort, errCode || 'Proxy error']),
        message: errDetails || t('diag_browser_pac_proxy_msg',
          'Браузер сообщил о сбое соединения с прокси из $1 ($2).',
          [pacName, matchedEndpoint.display]),
        details: {
          ...safeDetails,
          routeSource: 'pac',
          ...(pac.label ? { pacProvider: pac.label } : {}),
          proxy: matchedEndpoint.display,
        },
      };
    }

    return {
      category: 'proxy',
      title: t('diag_browser_own_proxy_err', 'Сбой прокси $1: $2',
        [matchedEndpoint.label, errCode || 'Proxy error']),
      message: errDetails || t('diag_browser_own_proxy_msg',
        'Браузер не смог подключиться к прокси $1.',
        [matchedEndpoint.label]),
      details: {
        ...safeDetails,
        routeSource: matchedEndpoint.kind,
        proxy: matchedEndpoint.label,
      },
    };
  }

  // Chromium often omits host:port in onProxyError.details; summarize active route contour.
  const ownProfiles = (mods?.proxyProfiles || [])
    .filter(p => p && (mods?.proxyRoutes ? mods.proxyRoutes[p.id] : p.enabled !== false))
    .map(p => describeProfileById(p.id, mods)?.label)
    .filter(Boolean);
  const ownPool = ownProfiles.length ? ownProfiles : summarizeOwnPool(mods);
  const ownSummary = ownPool.slice(0, 3).join(', ') + (ownPool.length > 3 ? ` (+${ownPool.length - 3})` : '');

  if (pac.key === 'onlyOwnSites' && ownSummary) {
    return {
      category: 'proxy',
      title: t('diag_browser_own_proxy_err', 'Сбой прокси $1: $2', [ownSummary, errCode || 'Proxy error']),
      message: errDetails || t('diag_browser_own_only_msg',
        'Браузер сообщил о сбое соединения с настроенным прокси ($1).',
        [ownSummary]),
      details: {
        ...safeDetails,
        routeSource: 'own',
        proxy: ownSummary,
      },
    };
  }

  if (pac.label && pac.key !== 'onlyOwnSites' && !ownSummary) {
    return {
      category: 'proxy',
      title: t('diag_browser_pac_conn_err', 'Сбой прокси $1: $2', [pac.label, errCode || 'Proxy error']),
      message: errDetails || t('diag_browser_pac_conn_msg',
        'Браузер не смог установить соединение с прокси-сервером из $1.',
        [pac.label]),
      details: {
        ...safeDetails,
        routeSource: 'pac',
        pacProvider: pac.label,
      },
    };
  }

  if (pac.label && ownSummary) {
    return {
      category: 'proxy',
      title: t('diag_browser_mixed_err', 'Сбой прокси ($1 / свои прокси): $2', [pac.label, errCode || 'Proxy error']),
      message: errDetails || t('diag_browser_mixed_msg',
        'Браузер сообщил о сбое прокси-соединения. Активны $1 и свои прокси ($2).',
        [pac.label, ownSummary]),
      details: {
        ...safeDetails,
        routeSource: 'own+pac',
        pacProvider: pac.label,
        proxy: ownSummary,
      },
    };
  }

  return {
    category: 'pac',
    title: errCode || t('msg_pac_proxy_error_7dd6d59c', 'Ошибка PAC / Proxy'),
    message: errDetails || t('msg_the_browser_reported_an_error_in_the_pac_scri_da596bbd',
      'Браузер сообщил об ошибке в PAC-скрипте или прокси-соединении'),
    details: safeDetails,
  };
}
