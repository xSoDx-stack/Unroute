// Setup helper only: production UI sends its own captured revision. Never repair
// an explicitly supplied (including intentionally stale) revision in a test.
export async function sendChromeMessage(page, message) {
  return page.evaluate(async payload => {
    const send = value => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chrome RPC timed out: ${value.action}`)), 20000);
      chrome.runtime.sendMessage(value, response => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
    if (payload.action === 'SAVE_MODS' && payload.expectedRevision === undefined &&
        ['exceptions', 'whitelist'].some(key => Object.hasOwn(payload.mods || {}, key))) {
      const snapshot = await send({ action: 'GET_EXCEPTIONS' });
      if (!snapshot?.success) throw new Error('Cannot read setup rules revision');
      payload = { ...payload, expectedRevision: snapshot.data.revision };
    }
    return send(payload);
  }, message);
}
