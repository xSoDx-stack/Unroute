import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkProxyFailover } from './proxy-failover-checks.js';
import { sendChromeMessage } from './chrome-rpc.js';

export async function createFailoverFixtures() {
  const received = [];
  const create = async target => {
    const server = http.createServer((req, res) => {
      received.push({ target, url: req.url.startsWith('http:') ? req.url : `http://${req.headers.host}${req.url}` });
      req.resume();
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Content-Type': 'text/plain', Connection: 'close' });
      res.end(target);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server;
  };
  const servers = await Promise.all(['origin-direct', 'reserve-proxy', 'healthy-proxy'].map(create));
  // Allocate then close a local endpoint: the browser must observe TCP refusal.
  // All healthy fixture listeners are already allocated before closing it.
  const refused = net.createServer();
  await new Promise(resolve => refused.listen(0, '127.0.0.1', resolve));
  const refusedPort = refused.address().port;
  await new Promise(resolve => refused.close(resolve));
  return {
    received,
    config: { port: servers[0].address().port, proxyPort: servers[1].address().port, secondProxyPort: servers[2].address().port, refusedPort },
    close: () => Promise.all(servers.map(server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); })),
  };
}

export async function saveFailoverEvidence(name, proofs, received, version, error) {
  const output = path.resolve(`artifacts/browser/${name}-proxy-failover.json`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const failures = error ? [error] : [];
  const checks = proofs.map(proof => {
    const targets = received.filter(item => item.url === proof.url).map(item => item.target);
    const browserPassed = proof.expected === 'blocked' ? Boolean(proof.error) && !proof.body : !proof.error && proof.body === proof.expected;
    const httpPassed = proof.expected === 'blocked' ? targets.length === 0 : targets.length > 0 && targets.every(target => target === proof.expected);
    if (!browserPassed || !httpPassed) failures.push(`${proof.label}: browser=${browserPassed}; native HTTP targets=${JSON.stringify(targets)}`);
    return { ...proof, targets, browserPassed, httpPassed };
  });
  if (proofs.length !== 9) failures.push(`Expected 9 probes, received ${proofs.length}`);
  await fs.writeFile(output, JSON.stringify({ version, proofs: checks, received, failures }, null, 2));
  assert.equal(failures.length, 0, failures.join('\n'));
  console.log(`${name} native proxy failover: ${proofs.length} checks passed; evidence ${output}`);
}

export async function verifyProxyFailover(browser, page) {
  const fixture = await createFailoverFixtures();
  const proofs = [];
  let error;
  try {
    await page.goto(new URL('index.html#proxies', page.url()).href);
    await page.reload();
    await page.waitForSelector('#proxyFailoverSelect');
    await checkProxyFailover({ proofs, ...fixture.config, suffix: 'example.test',
      send: message => sendChromeMessage(page, message),
      select: async value => {
        await page.reload();
        if (value === 'direct') page.once('dialog', dialog => dialog.accept());
        const optionsDeadline = Date.now() + 15000;
        while (!await page.evaluate(value => [...document.querySelector('#proxyFailoverSelect').options].some(option => option.value === value), value)) {
          if (Date.now() > optionsDeadline) throw new Error('Failover option missing: ' + value + ': ' + await page.$eval('#proxyFailoverSelect', node => node.outerHTML));
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        await page.select('#proxyFailoverSelect', value);
        const deadline = Date.now() + 15000;
        let latest;
        do {
          latest = (await sendChromeMessage(page, { action: 'GET_STATE' })).data;
          const mods = latest.pacMods;
          if ((mods.fallbackProxyId || null) === (['block', 'direct'].includes(value) ? null : value) && mods.ownProxyOrDie === (value !== 'direct') && !latest.settingsState.pending) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        throw new Error('Failover choice not applied: ' + value + ': ' + JSON.stringify({ fallbackProxyId: latest.pacMods.fallbackProxyId, ownProxyOrDie: latest.pacMods.ownProxyOrDie, pending: latest.settingsState.pending }));
      },
      probe: async url => {
        const tab = await browser.newPage();
        try {
          const response = await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          return { body: await response.text(), error: null };
        } catch (error) { return { body: null, error: error.message }; }
        finally { await tab.close(); }
      },
    });
  } catch (cause) { error = cause.stack || cause.message; }
  finally { await fixture.close(); }
  await saveFailoverEvidence('chrome', proofs, fixture.received, await browser.version(), error);
}
