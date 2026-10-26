'use strict';

(() => {
  const fragmentKey = 'anticheburnet-search';
  const params = new URLSearchParams(window.location.hash.slice(1));
  const lookupDomain = params.get(fragmentKey)?.trim().toLowerCase();
  if (!lookupDomain) return;

  try {
    const parsed = new URL(`https://${lookupDomain}`);
    if (parsed.username || parsed.password || parsed.port ||
        parsed.pathname !== '/' || parsed.search || parsed.hash ||
        parsed.host !== lookupDomain) {
      return;
    }
  } catch {
    return;
  }

  const input = document.querySelector('#inputMsg[name="searchstring"], input[name="searchstring"]');
  if (!input) return;

  input.value = lookupDomain;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.focus();

  // The fragment is never sent in the HTTP request. Remove it after filling
  // the form so the checked address does not remain in the browser history.
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
})();
