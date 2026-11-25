import { copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Mirror the build overlay without requiring or changing a shared dist tree.
const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'unroute-firefox-backend-'));
const core = join(root, 'core');
const backendPath = join(core, 'proxy-backend.js');
let backend;
try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  cpSync(new URL('../src/common/core/', import.meta.url), core, { recursive: true });
  copyFileSync(new URL('../src/firefox/core/proxy-backend.js', import.meta.url), backendPath);
  ({ proxyBackend: backend } = await import(pathToFileURL(backendPath).href));
} finally {
  rmSync(root, { recursive: true, force: true });
}
export { backend as proxyBackend };
