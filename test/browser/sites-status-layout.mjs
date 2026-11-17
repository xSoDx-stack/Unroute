import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

// CSS-only fixtures; real editor/routing remains covered by browser smoke.
const built = process.argv.includes('--built');
const root = path.resolve(built ? 'dist/chromium' : 'src/common');
const browser = await puppeteer.launch({ headless: true,
  executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await browser.newPage();
  await page.setJavaScriptEnabled(false);
  await page.setViewport({ width: 1200, height: 1400 });
  await page.goto(pathToFileURL(path.join(root, 'pages/options/index.html')).href);
  const list = await page.evaluate(() => {
    document.querySelectorAll('.tab-content').forEach(p => p.classList.toggle('active', p.id === 'tab-exceptions'));
    const container = document.querySelector('.domain-list-container');
    container.replaceChildren(...Array.from({ length: 30 }, (_, index) => {
      const row = document.createElement('div'); row.className = 'domain-card';
      const domain = document.createElement('span'); domain.className = 'domain-name'; domain.textContent = `site${index}.example.test`;
      const remove = document.createElement('button'); remove.className = 'delete-domain-btn'; remove.textContent = 'Удалить';
      row.append(domain, remove); return row;
    }));
    const rows = [...container.children].map(row => row.getBoundingClientRect());
    const viewport = container.getBoundingClientRect();
    const visible = rows.filter(row => row.top >= viewport.top && row.bottom <= viewport.bottom + 0.1).length;
    const before = container.scrollTop; container.scrollTop = container.scrollHeight;
    return { visible, rowHeight: rows[0].height, viewportHeight: viewport.height, count: rows.length, scrolls: container.scrollTop > before,
      lastReachable: container.lastElementChild.getBoundingClientRect().bottom <= viewport.bottom + 0.1 };
  });
  assert.equal(list.visible, 10, `Tall view must display ten complete site rows: ${JSON.stringify(list)}`);
  assert.equal(list.count, 30, 'Must retain the remaining sites');
  assert.ok(list.scrolls && list.lastReachable, 'All remaining rows must be reachable by scrolling');
  for (const surface of ['options', 'popup']) {
    await page.goto(pathToFileURL(path.join(root, `pages/${surface}/index.html`)).href);
    for (const theme of ['light', 'dark']) {
      let referenceText;
      for (const accent of ['#ff00ff', '#000000', '#ffffff']) {
        for (const state of ['active', 'inactive', 'warning']) {
          const result = await page.evaluate(({ surface, theme, accent, state }) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.setProperty('--accent-text', accent);
            const status = document.querySelector(surface === 'options' ? '#headerStatus' : '#status');
            status.className = `${surface === 'options' ? 'status-pill' : 'status'} ${state}`;
            return { text: getComputedStyle(status).color,
              dot: surface === 'options' ? getComputedStyle(status.querySelector('.status-dot')).backgroundColor : getComputedStyle(status, '::before').backgroundColor };
          }, { surface, theme, accent, state });
          referenceText ??= result.text;
          assert.equal(result.text, referenceText, `${surface}/${theme}: text must not depend on palette or state`);
          assert.equal(result.dot, state === 'active' ? 'rgb(22, 163, 74)' : 'rgb(220, 38, 38)', `${surface}/${theme}/${state}: fixed semantic dot`);
        }
      }
    }
  }
  console.log('PASS: ten visible site rows, 30 retained/scrollable; neutral status text and fixed green/red dots across both surfaces/themes and extreme accents.');
} finally { await browser.close(); }
