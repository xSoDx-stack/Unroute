# AntiCheburnet — reviewer build and testing notes

This is a GPL-3.0-or-later fork of anticensority/runet-censorship-bypass, with a Manifest V3 architecture, a shared Chromium/Firefox implementation, a Russian settings UI and proxy diagnostics. No account with the extension developer is required. Public PAC/proxy availability depends on the user's network and third-party services.

## Reproduce the submission

Extract the source ZIP. From its root, using Node.js 22.12 or newer and npm 9 or newer:

```sh
npm ci --prefix extensions/browser/runet-censorship-bypass
npm run build:all
```

The complete Firefox extension is in `extensions/browser/runet-censorship-bypass/build/extension-firefox`; Chromium is in `build/extension-chromium` under the same project. Compare the extracted store ZIP's files to the respective directory. ZIP timestamps/compression and Mozilla signature files are not part of the extension-content comparison.

The build copies `src/extension-common` and then overlays `src/extension-firefox` for Firefox. It also copies the root LICENSE and PRIVACY.md. There is no application transpilation, obfuscation or remote build input beyond npm dependencies pinned in package-lock.json. `npm run store:package` creates both store ZIPs and the source ZIP; generated archives are not needed to perform the build.

Bundled libraries are unmodified npm distribution files (line endings can differ): `vendor/acorn.mjs` is `acorn@8.18.0/dist/acorn.mjs`; `vendor/tldts.esm.js` is `tldts@7.4.11/dist/index.esm.min.js`. Their respective licenses are included. Use the npm packages' source and source maps when reviewing these upstream generated files. All application sources are readable in `src`.

## PAC execution and network behavior

PAC scripts are fetched from the selected provider or a user-entered URL, lexically checked using Acorn, and combined with local routing rules. The validator does not evaluate PAC or prove it safe; the browser's native PAC engine executes it. Chromium uses `proxy.settings` with `pacScript.data`. Firefox uses `proxy.settings` with a Blob URL and `autoConfig`. PAC code cannot call extension APIs through this code path. No remote JavaScript is loaded as an extension module or executed using eval/new Function in an extension page. Please review `core/pac-sync.js`, `pac-validator.js`, `pac-kitchen.js` and the platform-specific `proxy-backend.js`.

The selected proxy receives normal routed browser connections; configured proxy credentials are supplied to the matching proxy authentication challenge. Explicit menu commands can open third-party services with a URL/domain. PRIVACY.md documents the receivers, local diagnostics, storage, control and deletion. There are no developer telemetry endpoints. The Firefox data declaration covers browsingActivity and authenticationInfo. Proxy routing is not an analytics feature. The content script runs only on `https://blocklist.rkn.gov.ru/*`, prefills the requested domain, and never solves CAPTCHA or submits the form.

## Functional testing

The dependency audit blocks high/critical advisories. As of 2026-10-26, its only exception is [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv): no patched `node-forge` npm version exists. The exception is limited to `web-ext@10.8.0 -> @devicefarmer/adbkit@3.3.9 -> node-forge@1.4.0`, used by the Android TCP/USB authentication server, which release CI does not run. These development packages are not shipped in extension archives. `scripts/audit-policy.mjs` checks the exact advisory, severity, package versions, locations and forge consumer; any new issue or chain change fails the audit. The former image-size exception was removed because the updated linter uses a patched version. Re-review/remove the exception when upstream releases a fix.

1. Load the extension in a clean profile. For Firefox, allow it to run in private windows in about:addons; Firefox requires this before changing profile-wide proxy settings. Accept the declared data transmission categories during installation.
2. Open the action popup. The PAC tab selects a public provider; apply it and check the update time. A provider failure is shown in the local log.
3. For a test independent of public providers, run a local proxy under your control, add its address in «Прокси», select the own-sites mode and add a test domain in «Сайты». Verify routed traffic reaches your proxy; then select direct routing and verify the bypass.
4. If testing proxy authentication, use credentials for your own test server. Site login challenges must not receive proxy credentials. The extension supports HTTP/HTTPS proxy authentication, not SOCKS username/password authentication.
5. Open a page and invoke the registry command. Only its registrable domain should be prefilled; submit manually if desired. The extension does not bypass CAPTCHA.
6. Trigger a main-frame proxy failure in a private window. No private domain or proxy authentication event should enter the persistent request journal or tab-route statistics. Routing still applies. Manually saved configuration is profile-wide.
7. Select «Отключить» in PAC, close/reopen the popup, and restart the browser. Confirm the selected state persists and the extension releases proxy settings when disabled.

Local checks: `npm test`, `npm run lint`, `npm run lint:firefox`, `npm run test:browser:chrome` (requires installed Chrome Stable or CHROME_BIN). Chrome smoke uses isolated temporary profiles. It is not a Firefox runtime test. Desktop Firefox and Android distribution must be tested in their respective environments before claiming compatibility.

## Firefox tab routing with user-owned proxies

`core/tab-proxy-router.js` registers `proxy.onRequest` only in Firefox. With a configured own proxy/Tor/WARP and an explicit main-site rule, requests carrying a reliable tab ID follow that site's rule. Native PAC remains the fallback for unruled tabs, speculative/unassociated traffic and configurations without own proxies. The listener uses only sanitized configured endpoints; it does not download or evaluate code. Explicit direct returns `null` to override native PAC; proxy chains terminate with `null` to avoid fallback to public PAC proxies. Settings ownership is checked and cached until the next settings-change event. Private-tab main hostnames are memory-only; resource statistics exclude private tabs.

Run `npm run build:all`, then `npm run test:browser:firefox` for the local two-tab integration test (Firefox installed or `FIREFOX_BIN` set). It generates a temporary extension copy with a test bootstrap and scripting permission; neither is included in store builds. The isolated profile is removed afterward. The test checks the same CDN through an own proxy in one tab and directly in another, and verifies native PAC behavior after removing the own proxy.
