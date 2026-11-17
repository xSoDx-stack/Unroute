'use strict';

import { t } from './i18n.js';
import { sanitizeSiteResourceInheritance } from './site-resource-policy.js';

import { utils } from './utils.js';
import { LOCAL_PROXY_SERVICES } from './local-proxy-services.js';
import { compileProxyRoutes } from './proxy-profiles.js';

export function getDefaultConfigs() {
  return {
    ifProxyHttpsUrlsOnly: {
      dflt: false,
      label: t("msg_proxy_https_sites_only_7d875463", "проксировать только HTTPS-сайты"),
      desc: t("msg_only_proxy_sites_that_use_https_encryption_th_e1bf0a1c", "Проксировать только сайты, доступные по шифрованному протоколу HTTPS. Прокси и провайдер смогут видеть только адреса проксируемых HTTPS-сайтов, но не их содержимое."),
      order: 0,
      category: 'general',
    },
    ifUseSecureProxiesOnly: {
      dflt: false,
      label: t("msg_encrypted_proxy_connections_only_b1fdf1e7", "только шифрованная связь с прокси"),
      desc: t("msg_encrypt_the_connection_to_the_proxy_using_htt_0f438fda", "Шифровать соединение до прокси от провайдера, используя только прокси типа HTTPS или локальный Tor."),
      order: 1,
      category: 'general',
    },
    ifProhibitDns: {
      dflt: false,
      label: t("msg_disable_ip_dns_lookup_1bdeeeef", "запретить определение по IP/DNS"),
      desc: t("msg_prevent_the_pac_script_from_using_dns_to_chec_7d11c748", "Запрещает скрипту использовать DNS в браузере для проверки IP-адресов."),
      order: 2,
      category: 'general',
    },
    ifProxyOrDie: {
      dflt: true,
      ifDfltMods: true,
      label: t("msg_proxy_or_fail_d2da522e", "проксируй или умри!"),
      desc: t("msg_prevent_direct_connections_when_the_proxy_fai_3300e70c", "Запрещает прямое соединение без прокси в случаях, когда прокси отказывает."),
      order: 3,
      category: 'general',
    },
    ifUsePacScriptProxies: {
      dflt: true,
      category: 'ownProxies',
      label: t("msg_use_pac_script_proxies_e9b3b8f2", "использовать прокси PAC-скрипта"),
      desc: t("msg_use_the_official_proxy_servers_provided_by_th_ab2ec876", "Использовать официальные прокси-сервера от авторов PAC-скрипта."),
      order: 4,
    },
    ifUseLocalTor: {
      dflt: false,
      category: 'ownProxies',
      label: t("msg_use_your_local_tor_49b28b01", "использовать СВОЙ локальный Tor"),
      desc: t("msg_use_a_locally_installed_tor_service_socks5_12_c820e89f", "Использовать локально установленный Tor (SOCKS5 127.0.0.1:9150 / 9050) в качестве прокси."),
      order: 5,
    },
    ifUseLocalWarp: {
      dflt: false,
      category: 'ownProxies',
      label: t("msg_use_warp_as_a_proxy_36badc89", "использовать WARP как прокси"),
      desc: t("msg_use_local_cloudflare_warp_socks5_https_localh_fbed5863", "Использовать локальный Cloudflare WARP (SOCKS5 / HTTPS localhost:40000)."),
      order: 5.5,
    },
    exceptions: {
      dflt: null,
      category: 'exceptions',
    },
    ifMindExceptions: {
      dflt: true,
      category: 'exceptions',
      label: t("msg_use_site_exceptions_488925bf", "учитывать исключения"),
      desc: t("msg_apply_manually_added_sites_from_the_proxy_and_46d716c9", "Учитывать сайты, добавленные вручную (списки включений и исключений)."),
      order: 6,
    },
    whitelist: {
      dflt: [],
      category: 'exceptions',
    },
    ifMindWhitelist: {
      dflt: false,
      category: 'exceptions',
      label: t("msg_limit_routing_to_the_allowlist_8078c546", "Ограничиться только белым списком"),
      desc: t("msg_allow_the_extension_to_operate_only_on_allowl_42641c87", "Разрешить расширению работать только с адресами из белого списка."),
      order: 6.5,
    },
    ifUseOwnProxiesOnlyForOwnSites: {
      dflt: false,
      category: 'ownProxies',
      label: t("msg_use_your_proxies_only_for_your_sites_f18edc5b", "использовать СВОИ прокси только для СВОИХ сайтов"),
      desc: t("msg_use_your_proxies_only_for_sites_added_manuall_65e0122a", "Использовать свои прокси только для сайтов, добавленных в список вручную."),
      order: 7,
    },
    customProxyStringRaw: {
      dflt: '',
      category: 'ownProxies',
      order: 8,
    },
    ifProxyMoreDomains: {
      dflt: false,
      category: 'general',
      label: t("msg_also_proxy_onion_i2p_and_opennic_8d72d0f5", "проксировать также .onion, .i2p, OpenNIC"),
      desc: t("msg_proxy_sites_in_alternative_networks_opennic_e_8a99efb5", "Проксировать сайты в зонах альтернативных сетей (OpenNIC, EmerCoin, I2P, Tor)."),
      order: 8.5,
    },
    replaceDirectWith: {
      dflt: '',
      category: 'general',
      label: t("msg_replace_direct_with_5c6a9020", "заменить DIRECT на"),
      desc: t("msg_use_this_directive_instead_of_direct_for_requ_b250260e", "Использовать указанную строку вместо DIRECT для неблокируемых запросов."),
      order: 9,
    },
  };
}

export function getDefaults() {
  const configs = getDefaultConfigs();
  return Object.keys(configs).reduce((acc, key) => {
    acc[key] = configs[key].dflt;
    return acc;
  }, {});
}

export function createPacModifiers(mods = {}) {
  mods = mods || {};
  const configs = getDefaultConfigs();
  const ifNoMods = Object.keys(configs).every((dProp) => {
    const ifDflt = !(dProp in mods && Boolean(configs[dProp].dflt) !== Boolean(mods[dProp]));
    const ifMods = configs[dProp].ifDfltMods;
    return ifDflt ? !ifMods : ifMods;
  });

  const defaults = getDefaults();
  const self = {
    ifProxyHttpsUrlsOnly: mods.ifProxyHttpsUrlsOnly !== undefined ? Boolean(mods.ifProxyHttpsUrlsOnly) : defaults.ifProxyHttpsUrlsOnly,
    ifUseSecureProxiesOnly: mods.ifUseSecureProxiesOnly !== undefined ? Boolean(mods.ifUseSecureProxiesOnly) : defaults.ifUseSecureProxiesOnly,
    ifProhibitDns: mods.ifProhibitDns !== undefined ? Boolean(mods.ifProhibitDns) : defaults.ifProhibitDns,
    ifProxyOrDie: mods.ifProxyOrDie !== undefined ? Boolean(mods.ifProxyOrDie) : defaults.ifProxyOrDie,
    ifUsePacScriptProxies: mods.ifUsePacScriptProxies !== undefined ? Boolean(mods.ifUsePacScriptProxies) : defaults.ifUsePacScriptProxies,
    ifUseLocalTor: Boolean(mods.ifUseLocalTor),
    ifUseLocalWarp: Boolean(mods.ifUseLocalWarp),
    ifMindExceptions: mods.ifMindExceptions !== false,
    ifMindWhitelist: Boolean(mods.ifMindWhitelist),
    ifUseOwnProxiesOnlyForOwnSites: Boolean(mods.ifUseOwnProxiesOnlyForOwnSites),
    customProxyStringRaw: mods.customProxyStringRaw || '',
    ifProxyMoreDomains: Boolean(mods.ifProxyMoreDomains),
    replaceDirectWith: mods.replaceDirectWith || '',
    exceptions: mods.exceptions || {},
    proxyProfiles: mods.proxyProfiles || [],
    defaultProxyId: mods.defaultProxyId || null,
    domainProxyIds: mods.domainProxyIds || {},
    domainLists: mods.domainLists || [],
    pacBypassDomains: mods.pacBypassDomains || [],
    siteResourceInheritance: sanitizeSiteResourceInheritance(mods.siteResourceInheritance),
    proxyRoutes: compileProxyRoutes(mods),
    proxyCatalogRevision: mods._proxyCatalogRevision || 0,
    whitelist: mods.whitelist || [],
    ifNoMods: ifNoMods && !(mods.domainLists || []).some(list => list.enabled && list.domains.length) &&
      !(mods.pacBypassDomains || []).length,
    revision: Number(mods._revision) || 0,
    rulesRevision: Number(mods._rulesRevision ?? mods._revision) || 0,
    ruleMeta: mods.ruleMeta || {},
  };

  let customProxyArray = [];
  if (self.customProxyStringRaw) {
    customProxyArray = self.customProxyStringRaw
      .replace(/#.*$/gm, '')
      .split(/(?:\s*(?:;\r?\n)+\s*|\r?\n+|;\s*)+/g)
      .map((p) => p.trim())
      .filter(Boolean);

    // Catalog growth is validated against the previous snapshot by
    // reconcileProxyProfiles. Cooking must also accept grandfathered lists.

    const unsupportedSocksAuth = customProxyArray.find((pStr) => {
      const parsed = utils.parseProxyScheme(pStr);
      return parsed && parsed.hasAuth && parsed.type.startsWith('SOCKS');
    });
    if (unsupportedSocksAuth) {
      return [new TypeError(t("msg_browser_proxy_apis_do_not_support_socks4_sock_4ce96b9a", "Прокси-API браузера не поддерживает логин и пароль для SOCKS4/SOCKS5 — ни в Chromium, ни в Firefox. Используйте SOCKS без авторизации либо HTTP/HTTPS-прокси."))];
    }

    if (self.ifUseSecureProxiesOnly) {
      customProxyArray = customProxyArray.filter((pStr) => {
        const parsed = utils.parseProxyScheme(pStr);
        return parsed && parsed.type === 'HTTPS';
      });
    }
  }

  if (self.ifUseLocalWarp) {
    self.warpPoints = LOCAL_PROXY_SERVICES.warp.proxies.filter(point => !self.ifUseSecureProxiesOnly || point.startsWith('HTTPS '));
    customProxyArray.push(...self.warpPoints);
  }
  if (self.ifUseLocalTor) {
    self.torPoints = [...LOCAL_PROXY_SERVICES.tor.proxies];
    customProxyArray.push(...self.torPoints);
  }

  // Handle and sanitize protected proxies (strip user:pass@ for PAC compatibility and normalize HTTP -> PROXY)
  customProxyArray = customProxyArray.map((proxyScheme) => {
    const proxy = utils.parseProxyScheme(proxyScheme);
    if (!proxy) return '';
    let proto = proxy.type.toUpperCase();
    if (proto === 'HTTP') proto = 'PROXY';
    else if (proto === 'SOCKS4') proto = 'SOCKS';
    return `${proto} ${proxy.hostname}:${proxy.port}`;
  }).filter(Boolean);

  self.filteredCustomsString = '';
  if (customProxyArray.length) {
    self.customProxyArray = customProxyArray;
    self.filteredCustomsString = customProxyArray.join('; ');
  } else {
    if (!self.ifUsePacScriptProxies) {
      return [new TypeError(t("msg_no_proxies_meet_your_requirements_e83bc752", "Нет ни одного прокси, удовлетворяющего вашим требованиям!"))];
    }
    self.customProxyArray = false;
  }

  self.included = [];
  self.excluded = [];
  if (self.ifProxyMoreDomains) {
    self.moreDomains = [
      'onion', 'i2p',
      'bbs', 'chan', 'dyn', 'free', 'geek', 'gopher', 'indy',
      'libre', 'neo', 'null', 'o', 'oss', 'oz', 'parody', 'pirate',
      'bazar', 'bit', 'coin', 'emc', 'fur', 'ku', 'lib', 'te', 'ti', 'uu'
    ];
  }

  return [null, self];
}
