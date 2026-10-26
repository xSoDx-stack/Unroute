import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(project, '../../..');
const prefix = 'extensions/browser/runet-censorship-bypass';
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const { version } = await readJson(path.join(root, 'package.json'));
assert.match(version, /^\d+\.\d+\.\d+(?:\.\d+)?$/);
const output = path.join(root, 'store-artifacts', `v${version}`);
await fs.mkdir(output, { recursive: true });
const date = new Date('2000-01-01T00:00:00Z');

async function add(zip, absolute, relative) {
  const stat = await fs.lstat(absolute);
  assert.ok(!stat.isSymbolicLink(), `Symlinks are not allowed in submissions: ${relative}`);
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(absolute)).sort()) {
      await add(zip, path.join(absolute, name), `${relative ? `${relative}/` : ''}${name}`);
    }
  } else {
    assert.ok(stat.isFile(), `Not a regular file: ${relative}`);
    assert.ok(!/(^|\/)(?:node_modules|\.git|\.env(?:\..*)?)($|\/)|\.(?:pem|key|p12|pfx)$/i.test(relative),
      `Excluded private or dependency file: ${relative}`);
    zip.file(relative, await fs.readFile(absolute), { date, createFolders: false });
  }
}

async function save(zip, name) {
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  // Reopen and verify CRCs so damaged archives fail before upload.
  await JSZip.loadAsync(data, { checkCRC32: true });
  await fs.writeFile(path.join(output, name), data);
  const hash = createHash('sha256').update(data).digest('hex');
  await fs.writeFile(path.join(output, `${name}.sha256`), `${hash}  ${name}\n`);
  console.log(`${name}: ${data.length} bytes`);
}

for (const target of ['chromium', 'firefox']) {
  const build = path.join(project, 'build', `extension-${target}`);
  const manifest = await readJson(path.join(build, 'manifest.json'));
  assert.equal(manifest.version, version, `Stale ${target} version; run npm run store:package from the repository root`);
  assert.equal(manifest.manifest_version, 3);
  assert.ok(!manifest.key && !manifest.update_url, 'Store packages must not override signing or updates');
  const zip = new JSZip();
  await add(zip, build, '');
  for (const required of ['manifest.json', 'LICENSE', 'PRIVACY.md', 'vendor/acorn.LICENSE', 'vendor/tldts.LICENSE']) {
    assert.ok(zip.file(required), `Missing ${required} in ${target}`);
  }
  await save(zip, `anticheburnet-v${version}-${target}-store.zip`);
}

const source = new JSZip();
// Explicit source inputs: never archive the working directory wholesale.
for (const relative of [
  'package.json', 'README.md', 'PRIVACY.md', 'LICENSE', 'scripts', 'docs',
  `${prefix}/package.json`, `${prefix}/package-lock.json`, `${prefix}/gulpfile.js`,
  `${prefix}/.eslintrc.js`, `${prefix}/src`, `${prefix}/scripts`, `${prefix}/test`,
]) {
  await add(source, path.join(root, relative), relative);
}
await save(source, `anticheburnet-v${version}-sources.zip`);
console.log(`Store submissions prepared in ${output}`);
