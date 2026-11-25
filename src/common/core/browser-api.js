// Only for callback-based extension APIs: lastError is scoped to the callback.
export function callBrowserMethod(receiver, method, args, unsupportedMessage) {
  return new Promise((resolve, reject) => {
    if (typeof receiver?.[method] !== 'function') {
      reject(new Error(unsupportedMessage()));
      return;
    }
    receiver[method](...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

export function addBrowserListener(event, listener) {
  if (typeof event?.addListener !== 'function') return false;
  if (typeof event.hasListener !== 'function' || !event.hasListener(listener)) {
    event.addListener(listener);
  }
  return true;
}
