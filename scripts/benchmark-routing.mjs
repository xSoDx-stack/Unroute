import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { cookPac } from '../src/common/core/pac-script.js';
import { createPacModifiers } from '../src/common/core/pac-modifiers.js';
import { pacKitchen } from '../src/common/core/pac-kitchen.js';
import { migrateSettings, recordRuleChange } from '../src/common/core/settings-schema.js';
import { encodeSettings } from '../src/common/core/settings-codec.js';

// Local JS microbenchmark, not a measurement of the browser's native PAC
// resolver, real proxy latency, or the user's complete browsing workload.
const calls = 200;
for (const count of [100, 10000, 33000]) {
  const exceptions = Object.fromEntries(Array.from({ length: count }, (_, index) => [`site-${index}.example.test`, true]));
  const [, mods] = createPacModifiers({ exceptions, customProxyStringRaw: 'HTTPS own.test:443' });
  const cookStarted = performance.now();
  const source = cookPac('function FindProxyForURL(){return "DIRECT";}', mods);
  const cookMs = performance.now() - cookStarted;
  const context = vm.createContext({});
  const initStarted = performance.now();
  vm.runInContext(source, context);
  const initMs = performance.now() - initStarted;
  const workloads = {
    miss: Array.from({ length: calls }, (_, index) => `missing-${index}.test`),
    exact: Array.from({ length: calls }, (_, index) => `site-${index % count}.example.test`),
    descendant: Array.from({ length: calls }, (_, index) => `images.site-${index % count}.example.test`),
  };
  for (const [kind, hosts] of Object.entries(workloads)) {
    const run = () => {
      const started = performance.now();
      for (const host of hosts) context.FindProxyForURL(`https://${host}/resource`, host);
      return performance.now() - started;
    };
    run();
    const samples = Array.from({ length: 5 }, run).sort((a, b) => a - b);
    console.log(JSON.stringify({ rules: count, kind, calls, cookMs: +cookMs.toFixed(2),
      initMs: +initMs.toFixed(2), medianRoutingMs: +samples[2].toFixed(2) }));
  }
}

// Model storage's structured copies too: real cold reads cross a process
// boundary and include history/metadata, not just the routing dictionary.
const previousChrome = globalThis.chrome;
let stored = {};
let reads = 0;
globalThis.chrome = { runtime: {}, storage: { local: {
  get: (key, callback) => {
    reads++;
    setTimeout(() => callback(structuredClone({ [key]: stored[key] })), 0);
  },
  set: (items, callback) => { stored = { ...stored, ...structuredClone(items) }; callback(); },
  remove: (_keys, callback) => callback(),
} } };
try {
  const exceptions = Object.fromEntries(Array.from({ length: 33000 }, (_, index) => [`domain-${index}.example.com`, true]));
  const empty = migrateSettings({ exceptions: {}, whitelist: [] });
  const fixture = recordRuleChange(empty, { ...empty, exceptions }, { source: 'import' });
  // Legacy storage restores independent objects even when metadata was shared
  // in the writer. Materialize that old wire representation before timing it.
  const legacy = JSON.parse(JSON.stringify(fixture));
  const compact = encodeSettings(fixture);
  for (const [format, snapshot] of [['legacy', legacy], ['compact', compact]]) {
    const timings = [];
    for (let sample = 0; sample < 7; sample++) {
      const start = performance.now();
      migrateSettings(structuredClone(snapshot));
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    console.log(JSON.stringify({ rules: 33000, format,
      snapshotMiB: +(Buffer.byteLength(JSON.stringify(snapshot)) / 1024 / 1024).toFixed(2),
      medianRestoreMs: +timings[3].toFixed(2) }));
  }
  await pacKitchen.savePacMods({ exceptions });
  const snapshotMiB = Buffer.byteLength(JSON.stringify(stored['pac-kitchen-mods'])) / 1024 / 1024;
  pacKitchen.invalidateCache();
  reads = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: 10 }, () => pacKitchen.getPacMods()));
  console.log(JSON.stringify({ rules: 33000, concurrentReads: 10, storageReads: reads,
    snapshotMiB: +snapshotMiB.toFixed(2), coldLoadMs: +(performance.now() - started).toFixed(2) }));
  const previous = await pacKitchen.getRawPacMods();
  const editStarted = performance.now();
  await pacKitchen.updatePacMods(current => ({ ...current,
    exceptions: { ...current.exceptions, 'new.cdn.test': true },
  }), { copyOnWrite: true });
  const edited = await pacKitchen.getRawPacMods();
  console.log(JSON.stringify({ rules: 33001, singleEditMs: +(performance.now() - editStarted).toFixed(2),
    retainedHistory: edited.ruleHistory[1] === previous.ruleHistory[0],
    retainedMetadata: edited.ruleMeta['exception:domain-0.example.com'] === previous.ruleMeta['exception:domain-0.example.com'] }));
} finally {
  pacKitchen.invalidateCache();
  globalThis.chrome = previousChrome;
}
