export function isTrustedRpcSender(sender, runtime) {
  const id = runtime?.id;
  if (typeof id !== 'string' || !id || sender?.id !== id ||
      typeof sender.url !== 'string' || typeof runtime.getURL !== 'function') return false;
  // Firefox's extension URL host is a UUID, not runtime.id. Use the browser's
  // root URL (including the trailing slash) for both browser families.
  const root = runtime.getURL('');
  return typeof root === 'string' && root.endsWith('/') && sender.url.startsWith(root) &&
    (sender.origin === undefined || sender.origin === root.slice(0, -1));
}
