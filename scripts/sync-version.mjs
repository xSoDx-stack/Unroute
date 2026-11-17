import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function write(relativePath, content) {
  const absolutePath = path.join(repoRoot, relativePath);
  const current = fs.readFileSync(absolutePath, 'utf8');
  if (current === content) return false;
  if (!checkOnly) fs.writeFileSync(absolutePath, content, 'utf8');
  return true;
}

function updateJson(relativePath, mutate) {
  const data = JSON.parse(read(relativePath));
  const before = JSON.stringify(data);
  mutate(data);
  const changed = before !== JSON.stringify(data);
  if (changed && !checkOnly) {
    fs.writeFileSync(
      path.join(repoRoot, relativePath),
      JSON.stringify(data, null, 2) + '\n',
      'utf8'
    );
  }
  return changed;
}

const canonical = JSON.parse(read('package.json')).version;
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(canonical)) {
  throw new Error(`Некорректная версия в package.json: ${canonical}`);
}

const changed = [];
if (updateJson('package-lock.json', (lock) => {
  lock.version = canonical;
  if (lock.packages?.['']) lock.packages[''].version = canonical;
})) {
  changed.push('package-lock.json');
}
if (updateJson('src/common/manifest.json', (manifest) => {
  manifest.version = canonical;
})) {
  changed.push('src/common/manifest.json');
}
if (updateJson('src/firefox/manifest.json', (manifest) => {
  manifest.version = canonical;
})) {
  changed.push('src/firefox/manifest.json');
}
// Reviewer source archives and clean source trees have no generated build yet.
// Check/update generated manifests when present; the build creates them from src.
for (const target of ['chromium', 'firefox']) {
  const manifestPath = `dist/${target}/manifest.json`;
  if (fs.existsSync(path.join(repoRoot, manifestPath)) && updateJson(manifestPath, (manifest) => {
    manifest.version = canonical;
  })) {
    changed.push(manifestPath);
  }
}

const readmePath = 'README.md';
const readme = read(readmePath);
const updatedReadme = readme.replace(
  /^Версия: \*\*\d+\.\d+\.\d+(?:\.\d+)?\*\*/m,
  `Версия: **${canonical}**`
);
if (updatedReadme === readme && !readme.includes(`Версия: **${canonical}**`)) {
  throw new Error('В README.md не найдена строка версии');
}
if (write(readmePath, updatedReadme)) changed.push(readmePath);

if (changed.length && checkOnly) {
  console.error(`Рассинхрон версии ${canonical}:`);
  changed.forEach((file) => console.error(`- ${file}`));
  console.error('Исправление: npm run version:sync');
  process.exit(1);
}

console.log(changed.length
  ? `Версия ${canonical} синхронизирована: ${changed.join(', ')}`
  : `Версия ${canonical}: все файлы синхронизированы`);
