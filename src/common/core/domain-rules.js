'use strict';

import { t } from './i18n.js';

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validIpv4(host) {
  return IPV4_RE.test(host) && host.split('.').every((part) => Number(part) <= 255);
}

export function normalizeDomainRule(input, { allowWildcard = true } = {}) {
  if (typeof input !== 'string') return { valid: false, error: t("msg_the_domain_must_be_a_string_3e214b59", "Домен должен быть строкой") };
  let value = input.trim().toLowerCase();
  if (!value) return { valid: false, error: t("msg_enter_a_domain_56988bdc", "Введите домен") };
  if (value.startsWith('include:')) return {
    valid: false, code: 'UNSUPPORTED_INCLUDE',
    error: t('dlUnsupportedInclude', 'include: — неподдерживаемая ссылка geosite. Укажите явные домены; ссылки не разворачиваются.'),
  };

  const wildcard = allowWildcard && (value.startsWith('*.') || value.startsWith('.'));
  value = value.replace(/^\*\./, '').replace(/^\./, '');
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'https://' + value;
    const parsed = new URL(withScheme);
    if (parsed.username || parsed.password) {
      return { valid: false, error: t("msg_the_domain_must_not_contain_a_username_or_pas_12188e49", "Домен не должен содержать логин или пароль") };
    }
    value = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch {
    return { valid: false, error: t("msg_invalid_domain_5dc91a45", "Некорректный домен") };
  }

  if (!value || value === 'localhost' || (!validIpv4(value) && !HOST_RE.test(value))) {
    return { valid: false, error: t("msg_invalid_domain_or_ip_address_87a58d07", "Некорректный домен или IP-адрес") };
  }
  return { valid: true, domain: wildcard ? '*.' + value : value };
}

export function toggleWildcardDomain(input, removePrefix) {
  const normalized = normalizeDomainRule(input);
  if (!normalized.valid) return { valid: false, domain: String(input || ''), changed: false };
  const bare = normalized.domain.replace(/^\*\./, '');
  const canWildcard = !validIpv4(bare) && !bare.includes(':') && HOST_RE.test(bare);
  const shouldRemove = removePrefix !== undefined ? Boolean(removePrefix) : normalized.domain.startsWith('*.');
  if (shouldRemove) {
    return { valid: true, domain: bare, changed: bare !== normalized.domain };
  }
  if (!canWildcard) {
    return { valid: true, domain: bare, changed: bare !== normalized.domain, skippedIp: true };
  }
  const next = '*.' + bare;
  return { valid: true, domain: next, changed: next !== normalized.domain };
}

export function toggleWildcardLines(text, selectionStart = 0, selectionEnd = selectionStart) {
  const source = String(text ?? '');
  const start = Math.max(0, Math.min(selectionStart, source.length));
  let end = Math.max(start, Math.min(selectionEnd, source.length));
  const lineStart = start === 0 ? 0 : source.lastIndexOf('\n', start - 1) + 1;
  if (end > start && source[end - 1] === '\n') {
    end -= 1;
    if (end > start && source[end - 1] === '\r') end -= 1;
  }
  const nextNl = source.indexOf('\n', end);
  const lineEnd = nextNl === -1 ? source.length : (nextNl > 0 && source[nextNl - 1] === '\r' ? nextNl - 1 : nextNl);
  const block = source.slice(lineStart, lineEnd);
  const eol = block.includes('\r\n') ? '\r\n' : '\n';
  const entries = block.split(/\r?\n/).map((raw) => {
    const trimmed = raw.replace(/^[\s\u00A0\u200B-\u200D\uFEFF\u3000]+|[\s\u00A0\u200B-\u200D\uFEFF\u3000]+$/g, '');
    if (!trimmed || /^(?:#|\/\/|;|!|--|=+$)/.test(trimmed)) return { raw, ignorable: true };
    const match = raw.match(/^([\s\u00A0]*)(.*?)((?:\s+(?:#|\/\/|;|!).*|\s*)?)$/);
    const indent = match ? match[1] : '';
    const token = (match ? match[2] : trimmed).trim();
    const suffix = match ? (match[3] || '') : '';
    const norm = normalizeDomainRule(token);
    if (!norm.valid) return { raw, ignorable: true };
    const bare = norm.domain.replace(/^\*\./, '');
    const canWildcard = !validIpv4(bare) && !bare.includes(':') && HOST_RE.test(bare);
    if (!canWildcard && !norm.domain.startsWith('*.')) return { raw, ignorable: true };
    return { raw, ignorable: false, indent, suffix, domain: norm.domain, bare, canWildcard };
  });

  const actionable = entries.filter((entry) => !entry.ignorable);
  if (!actionable.length) {
    return { changed: false, text: source, selectionStart: start, selectionEnd: Math.max(start, Math.min(selectionEnd, source.length)) };
  }
  const removePrefix = actionable.every((entry) => entry.domain.startsWith('*.'));
  const replaced = entries.map((entry) => {
    if (entry.ignorable) return entry.raw;
    const nextDomain = removePrefix || !entry.canWildcard ? entry.bare : '*.' + entry.bare;
    return `${entry.indent}${nextDomain}${entry.suffix}`;
  }).join(eol);

  if (replaced === block) {
    return { changed: false, text: source, selectionStart: start, selectionEnd: Math.max(start, Math.min(selectionEnd, source.length)) };
  }
  const nextText = source.slice(0, lineStart) + replaced + source.slice(lineEnd);
  const collapsed = selectionStart === selectionEnd;
  const nextSelStart = collapsed
    ? Math.min(lineStart + replaced.length, Math.max(lineStart, start + (replaced.length - block.length)))
    : lineStart;
  const nextSelEnd = collapsed ? nextSelStart : lineStart + replaced.length;
  return { changed: true, text: nextText, selectionStart: nextSelStart, selectionEnd: nextSelEnd };
}

export function parseDomainRuleLines(lines) {
  const values = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  const domains = new Set();
  const errors = [];
  values.forEach((line, index) => {
    let clean = String(line).replace(/^[\s\u00A0\u200B-\u200D\uFEFF\u3000]+|[\s\u00A0\u200B-\u200D\uFEFF\u3000]+$/g, '');
    if (!clean || /^(?:#|\/\/|;|!|--|=+$)/.test(clean)) return;
    clean = clean.replace(/\s+(?:#|\/\/|;|!).*$/, '').trim();
    if (!clean) return;
    const result = normalizeDomainRule(clean);
    if (result.valid) domains.add(result.domain);
    else errors.push({ line: index + 1, value: clean, error: result.error, ...(result.code ? {code:result.code} : {}) });
  });
  return { validDomains: [...domains], skippedCount: errors.length, errors };
}

export function sanitizeRuleCollections(exceptions = {}, whitelist = []) {
  const safeExceptions = {};
  if (exceptions && typeof exceptions === 'object' && !Array.isArray(exceptions)) {
    for (const [key, value] of Object.entries(exceptions)) {
      const normalized = normalizeDomainRule(key);
      if (normalized.valid && (value === true || value === false)) {
        safeExceptions[normalized.domain] = value;
      }
    }
  }
  const safeWhitelist = parseDomainRuleLines(Array.isArray(whitelist) ? whitelist : []).validDomains;
  return { exceptions: safeExceptions, whitelist: safeWhitelist };
}
