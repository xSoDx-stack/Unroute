import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(project, '../../..');
const extension = path.join(project, 'build/extension-chromium');
const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
const output = path.join(root, 'store-artifacts', `v${manifest.version}`, 'images');
const candidates = process.env.CHROME_BIN ? [process.env.CHROME_BIN] : [
  ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter(Boolean).map((dir) => path.join(dir, 'Google/Chrome/Application/chrome.exe')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
];
const executablePath = candidates.find((candidate) => existsSync(candidate));
assert.ok(executablePath, 'Install Chrome Stable or set CHROME_BIN');
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'anticheburnet-store-'));
let browser;
async function launch() {
  return puppeteer.launch({
    executablePath,
    headless: true,
    enableExtensions: true,
    userDataDir: profile,
    args: [
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--disable-default-apps', '--no-first-run', '--no-default-browser-check',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
}
try {
  browser = await launch();
  const initialId = await browser.installExtension(extension);
  const target = await browser.waitForTarget((candidate) => candidate.type() === 'service_worker' &&
    candidate.url() === `chrome-extension://${initialId}/service-worker.js`);
  const worker = await target.worker();
  await worker.evaluate(() => chrome.storage.local.set({ antiCensorRu: {
    currentPacProviderKey: 'none', customPacUrl: '', lastPacUpdateStamp: 0,
    providerUpdateStamps: {}, rawPacData: '',
  } }));
  await browser.close();
  browser = await launch();
  const id = await browser.installExtension(extension);
  await browser.waitForTarget(
    (candidate) => candidate.type() === 'service_worker' &&
      candidate.url() === `chrome-extension://${id}/service-worker.js`
  );
  const page = await browser.newPage();
  await page.bringToFront();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.goto(`chrome-extension://${id}/pages/options/index.html`);
  // Use the same message API as the UI, showing an honest disabled state.
  const cleared = await page.evaluate(() => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'CLEAR_PAC' }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  }));
  assert.equal(cleared?.success, true, 'Could not disable PAC in screenshot profile');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('extVersion')?.textContent.trim(), { polling: 100 });
  for (const [tab, name] of [['exceptions', '01-sites'], ['pac', '02-pac'], ['proxies', '03-proxies']]) {
    await page.evaluate((name) => document.querySelector(`.nav-tab-btn[data-tab="${name}"]`).click(), tab);
    await page.waitForSelector(`#tab-${tab}.active`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, `${name}-1280x800.png`) });
  }
  const icon = await fs.readFile(path.join(extension, 'icons/default-128.png'));
  await fs.writeFile(path.join(output, 'icon-128.png'), icon);
  const promo = await browser.newPage();
  await promo.setViewport({ width: 440, height: 280, deviceScaleFactor: 1 });
  await promo.setContent(`<!doctype html><html lang="ru"><meta charset="utf-8">
    <style>
      * { box-sizing: border-box; } body { margin: 0; width: 440px; height: 280px;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        background: radial-gradient(ellipse at top, #1e3a5f, #0f172a 75%); color: #f8fafc;
        font-family: "Segoe UI", sans-serif; }
      img { width: 112px; height: 112px; } h1 { font-size: 32px; margin: 16px 0 8px; }
      p { font-size: 17px; color: #cbd5e1; margin: 0; }
    </style><img alt="" src="data:image/png;base64,${icon.toString('base64')}">
    <h1>АнтиЧебурнет</h1><p>Сайты · PAC · Прокси</p></html>`);
  await promo.evaluate(() => document.fonts.ready);
  await promo.screenshot({ path: path.join(output, 'promo-440x280.png') });
  console.log(`Store images saved to ${output}`);
} finally {
  if (browser) await browser.close();
  const temp = path.resolve(os.tmpdir());
  assert.equal(path.dirname(profile), temp);
  assert.ok(path.basename(profile).startsWith('anticheburnet-store-'));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
