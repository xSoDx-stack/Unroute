import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Browser, detectBrowserPlatform, resolveBuildId, install } from '@puppeteer/browsers';

const browser = Browser.FIREFOX;
const platform = detectBrowserPlatform();
if (!platform) throw new Error('Unsupported browser test platform');
const buildId = await resolveBuildId(browser, platform, 'stable');
const installed = await install({ browser, platform, buildId,
  cacheDir: path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'unroute-test-browsers') });
console.log(`Firefox ${buildId}: ${installed.executablePath}`);
if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `FIREFOX_BIN=${installed.executablePath}\n`);
