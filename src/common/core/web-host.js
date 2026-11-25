export function webHost(url, webSockets = false) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ||
      (webSockets && (protocol === 'ws:' || protocol === 'wss:')) ? hostname : '';
  } catch {
    return '';
  }
}
