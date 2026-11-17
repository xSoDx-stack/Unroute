'use strict';

// Native catalogs choose the browser locale and apply the manifest fallback.
// The source text is a fallback for non-extension contexts such as unit tests.
export function t(key, source, substitutions = []) {
  const values = substitutions.map(value => String(value));
  const translated = globalThis.chrome?.i18n?.getMessage?.(key, values);
  if (translated) return translated;
  return source.replace(/\$(\d+)/g, (match, position) => values[Number(position) - 1] ?? match);
}

export function uiLocale() {
  const language = globalThis.chrome?.i18n?.getMessage?.('uiLanguage') || 'ru';
  const browserLocale = globalThis.chrome?.i18n?.getUILanguage?.() || language;
  // An unsupported UI language falls back to the manifest's default catalog.
  return browserLocale.split('-')[0] === language ? browserLocale : language;
}

export function localizeDocument(root = document) {
  root.documentElement.lang = uiLocale();
  root.documentElement.dir = globalThis.chrome?.i18n?.getMessage?.('@@bidi_dir') || 'ltr';
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n, node.textContent);
  }
  for (const attribute of ['title', 'placeholder', 'aria-label']) {
    for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`), node.getAttribute(attribute) || ''));
    }
  }
}
