'use strict';

import { t } from './i18n.js';

const MAX_TRUSTED_PAC_BYTES = 25 * 1024 * 1024;

export const PAC_PROVIDERS = {
  Антизапрет: {
    distinctKey: 'Antizapret',
    label: t('Antizapret', 'Антизапрет'),
    desc: t('pac_provider_antizapret_description', 'PAC-скрипт проекта «Антизапрет».'),
    order: 0,
    maxBytes: MAX_TRUSTED_PAC_BYTES,
    timeoutMs: 45000,
    allowedFinalHosts: [
      'e.cen.rodeo',
      'antizapret.prostovpn.org',
      '.ipfs.dweb.link',
    ],
    pacUrls: [
      'https://e.cen.rodeo:8443/proxy.pac',
      'https://antizapret.prostovpn.org:8443/proxy.pac',
      'https://antizapret.prostovpn.org:18443/proxy.pac',
      'https://antizapret.prostovpn.org/proxy.pac',
    ],
  },
  Антицензорити: {
    distinctKey: 'Anticensority',
    label: t('Anticensority', 'Антицензорити'),
    desc: t('pac_provider_anticensority_description', 'PAC-скрипт проекта «Антицензорити».'),
    order: 1,
    maxBytes: MAX_TRUSTED_PAC_BYTES,
    timeoutMs: 45000,
    allowedFinalHosts: [
      'anticensority.github.io',
      'raw.githubusercontent.com',
    ],
    pacUrls: [
      'https://anticensority.github.io/generated-pac-scripts/anticensority.pac',
      'https://raw.githubusercontent.com/anticensority/generated-pac-scripts/master/anticensority.pac',
    ],
  },
  onlyOwnSites: {
    distinctKey: 'onlyOwnSites',
    label: t("msg_only_your_sites_tor_custom_proxies_d3781c05", "Только свои сайты (Tor / Свои прокси)"),
    desc: t("msg_only_manually_added_sites_are_routed_through__6e0c474c", "Проксируются только вручную добавленные сайты через ваши прокси или локальный Tor."),
    order: 2,
    pacUrls: [
      'data:application/x-ns-proxy-autoconfig,' + encodeURIComponent('function FindProxyForURL(url, host){ return "DIRECT"; }'),
    ],
  },
  customPacUrl: {
    distinctKey: 'customPacUrl',
    label: t("msg_custom_pac_url_5933ecf2", "Свой PAC (по ссылке)"),
    desc: t("msg_a_ready_to_use_pac_script_at_your_own_direct__ca526c8e", "Готовый PAC-скрипт по собственной прямой ссылке (HTTPS или HTTP на этом компьютере)."),
    order: 3,
    pacUrls: [],
  },
};
