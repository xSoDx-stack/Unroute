import assert from 'node:assert/strict';
import { httpLib } from '../src/common/core/http-lib.js';

const url = 'https://provider.test/pac';

describe('HTTP PAC download cleanup', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  for (const [name, status, bytes, options] of [
    ['failed URL validation', 200, null, { validateFinalUrl: () => false }],
    ['bad HTTP status', 503, null, {}],
    ['oversize content length', 200, 1024, { maxBytes: 10 }],
  ]) {
    it(`cancels the unread body after ${name}`, async () => {
      let cancelled = false;
      const stream = new ReadableStream({ cancel() { cancelled = true; } });
      globalThis.fetch = async () => new Response(stream, { status, headers: bytes ? { 'content-length': String(bytes) } : {} });
      await assert.rejects(httpLib.get(url, options));
      assert.equal(cancelled, true);
    });
  }

  it('cancels and unlocks the reader after a decoding error', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(Uint8Array.of(255)); },
      cancel() { cancelled = true; },
    });
    globalThis.fetch = async () => new Response(stream);
    await assert.rejects(httpLib.get(url), /UTF-8/);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  });

  it('preserves the caller cancellation reason instead of reporting a timeout', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Caller cancelled', 'AbortError');
    globalThis.fetch = async (_, { signal }) => signal.throwIfAborted();
    controller.abort(reason);
    await assert.rejects(httpLib.get(url, { signal: controller.signal }), error => error === reason);
  });
});
