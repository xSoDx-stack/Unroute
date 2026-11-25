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
  const alignment = await page.evaluate(() => {
    const container = document.querySelector('.domain-list-container');
    const samples = [
      ['ab.chatgpt.com', 'общий', 'Для сайта'],
      ['accounts.google.com', 'gemeni_proxy', 'Вручную'],
      ['ajax.googleapis.com', 'gemeni_proxy', 'Автоматически'],
      ['cdn.very-long-subdomain-example.org', 'общий', 'Ранее сохранено'],
    ];
    container.replaceChildren(...samples.map(([host, proxyName, sourceText]) => {
      const card = document.createElement('div'); card.className = 'domain-card';
      const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'domain-select';
      const domain = document.createElement('span'); domain.className = 'domain-name'; domain.textContent = host;
      const select = document.createElement('select'); select.className = 'domain-proxy-select'; select.add(new Option(proxyName, proxyName));
      const source = document.createElement('small'); source.className = 'rule-source'; source.textContent = sourceText;
      const remove = document.createElement('button'); remove.className = 'delete-domain-btn'; remove.textContent = '✕';
      card.append(check, domain, select, source, remove);
      return card;
    }));
    const containerBox = container.getBoundingClientRect();
    return [...container.children].map(card => {
      const sel = card.querySelector('.domain-proxy-select').getBoundingClientRect();
      const src = card.querySelector('.rule-source').getBoundingClientRect();
      const del = card.querySelector('.delete-domain-btn').getBoundingClientRect();
      return {
        selectLeft: Math.round(sel.left),
        selectWidth: Math.round(sel.width),
        selectCenterOffset: Math.abs((sel.left + sel.width / 2) - (containerBox.left + containerBox.width / 2)),
        sourceCenter: Math.round(src.left + src.width / 2),
        deleteLeft: Math.round(del.left),
      };
    });
  });
  for (const row of alignment) {
    assert.equal(row.selectLeft, alignment[0].selectLeft, 'Proxy selects must align in one vertical column');
    assert.equal(row.selectWidth, alignment[0].selectWidth, 'Proxy selects must have identical width');
    assert.ok(row.selectCenterOffset < 32, `Proxy select column should sit near horizontal center: ${JSON.stringify(row)}`);
    assert.ok(Math.abs(row.sourceCenter - alignment[0].sourceCenter) <= 1, 'Rule source labels must center along the same axis');
    assert.equal(row.deleteLeft, alignment[0].deleteLeft, 'Delete buttons must align vertically');
  }
  const expectedStatus = {
    light: {
      active: { bg: 'rgb(22, 163, 74)', border: 'rgb(22, 163, 74)' },
      inactive: { bg: 'rgba(0, 0, 0, 0)', border: 'rgb(100, 116, 139)' },
      warning: { bg: 'rgb(217, 119, 6)', border: 'rgb(217, 119, 6)' },
      error: { bg: 'rgb(220, 38, 38)', border: 'rgb(220, 38, 38)' },
    },
    dark: {
      active: { bg: 'rgb(34, 197, 94)', border: 'rgb(34, 197, 94)' },
      inactive: { bg: 'rgba(0, 0, 0, 0)', border: 'rgb(148, 163, 184)' },
      warning: { bg: 'rgb(245, 158, 11)', border: 'rgb(245, 158, 11)' },
      error: { bg: 'rgb(239, 68, 68)', border: 'rgb(239, 68, 68)' },
    },
  };
  for (const surface of ['options', 'popup']) {
    await page.goto(pathToFileURL(path.join(root, `pages/${surface}/index.html`)).href);
    for (const theme of ['light', 'dark']) {
      let referenceText;
      for (const accent of ['#ff00ff', '#000000', '#ffffff']) {
        for (const state of ['active', 'inactive', 'warning', 'error']) {
          const result = await page.evaluate(({ surface, theme, accent, state }) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.setProperty('--accent-text', accent);
            document.documentElement.style.setProperty('--accent-primary', accent);
            const status = document.querySelector(surface === 'options' ? '#headerStatus' : '#status');
            status.className = `${surface === 'options' ? 'status-pill' : 'status'} ${state}`;
            const dotStyle = surface === 'options'
              ? getComputedStyle(status.querySelector('.status-dot'))
              : getComputedStyle(status, '::before');
            return { text: getComputedStyle(status).color,
              bg: dotStyle.backgroundColor, border: dotStyle.borderTopColor };
          }, { surface, theme, accent, state });
          referenceText ??= result.text;
          assert.equal(result.text, referenceText, `${surface}/${theme}: text must not depend on palette or state`);
          assert.deepEqual({ bg: result.bg, border: result.border }, expectedStatus[theme][state],
            `${surface}/${theme}/${state}: fixed semantic status indicator`);
        }
      }
    }
  }
  console.log('PASS: ten visible site rows, 30 retained/scrollable; neutral status text and fixed 4-state indicator across both surfaces/themes and extreme accents.');
} finally { await browser.close(); }
