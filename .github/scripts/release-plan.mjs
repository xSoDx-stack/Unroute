import { readFile, appendFile } from 'node:fs/promises';

// Existing versions are immutable: an ordinary development push only verifies
// the code. AMO signing and publication run once for a new version.
export async function resolveReleasePlan({ version, ref, event, repository, token, fetcher = fetch }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
  const tag = `v${version}`;
  if (ref.startsWith('refs/tags/') && ref !== `refs/tags/${tag}`) throw new Error(`Tag does not match ${tag}`);
  if (event === 'pull_request' || !(ref === 'refs/heads/development' || ref === `refs/tags/${tag}`)) {
    return { version, tag, publish: false };
  }
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (response.status !== 200 && response.status !== 404) throw new Error(`Release lookup failed: HTTP ${response.status}`);
  return { version, tag, publish: response.status === 404 };
}

if (process.env.GITHUB_OUTPUT && process.argv[1]?.endsWith('release-plan.mjs')) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const plan = await resolveReleasePlan({ version, ref: process.env.GITHUB_REF, event: process.env.GITHUB_EVENT_NAME,
    repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN });
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(plan).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(`${plan.tag}: ${plan.publish ? 'new release' : 'verification only (no publication)'}`);
}
