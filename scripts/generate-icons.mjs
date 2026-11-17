import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(project, 'assets/branding/unroute-icon.svg'), 'utf8');
const candidates = process.env.CHROME_BIN ? [process.env.CHROME_BIN] : [
  ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter(Boolean).map(directory => path.join(directory, 'Google/Chrome/Application/chrome.exe')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
];
const executablePath = candidates.find(candidate => existsSync(candidate));
assert.ok(executablePath, 'Install Chrome or set CHROME_BIN to export icon assets');
const temporaryDirectory = path.resolve(process.env.TMPDIR || os.tmpdir());
const profile = await fs.mkdtemp(path.join(temporaryDirectory, 'unroute-icons-'));
let browser;
try {
  browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  const page = await browser.newPage();
  const files = await page.evaluate(async data => {
    const svg = new DOMParser().parseFromString(data, 'image/svg+xml').documentElement;
    const output = {};
    async function render(size, badge = '') {
      // Give the vector its target viewport before decoding; never shrink a raster master.
      svg.setAttribute('width', size);
      svg.setAttribute('height', size);
      const image = new Image(size, size);
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, size, size);
      if (badge) {
        // Badge stays clear of the U and arrow; geometry avoids platform font rendering.
        context.beginPath(); context.arc(108, 108, 16, 0, Math.PI * 2);
        context.fillStyle = badge; context.fill();
        context.lineWidth = 4; context.strokeStyle = '#202527'; context.stroke();
        context.fillStyle = '#202527';
        context.fillRect(106, 98, 4, 13);
        context.beginPath(); context.arc(108, 116, 2, 0, Math.PI * 2); context.fill();
      }
      return canvas.toDataURL('image/png').split(',')[1];
    }
    for (const size of [16, 32, 48, 128]) {
      output[`default-${size}.png`] = await render(size);
      // Legacy runtime paths are aliases, not a different brand palette.
      output[`default-grayscale-${size}.png`] = output[`default-${size}.png`];
    }
    output['pac-error-128.png'] = await render(128, '#f2c27b');
    output['ext-error-128.png'] = await render(128, '#f3a4b9');
    output['no-control-128.png'] = await render(128, '#f2c27b');
    output['branding'] = await render(512);
    return output;
  }, source);
  await fs.writeFile(path.join(project, 'assets/branding/unroute-icon.png'), Buffer.from(files.branding, 'base64'));
  delete files.branding;
  for (const [name, data] of Object.entries(files)) {
    await fs.writeFile(path.join(project, 'src/common/icons', name), Buffer.from(data, 'base64'));
  }
  console.log(`Exported ${Object.keys(files).length} icons and 512px branding PNG from assets/branding/unroute-icon.svg`);
} finally {
  if (browser) await browser.close();
  assert.equal(path.dirname(profile), temporaryDirectory);
  assert.ok(path.basename(profile).startsWith('unroute-icons-'));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
