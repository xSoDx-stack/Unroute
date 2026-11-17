import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';

const project = fileURLToPath(new URL('../', import.meta.url));

function generateFixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unroute-icon-test-'));
  try {
    for (const directory of ['scripts', 'assets/branding', 'src/common/icons']) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    fs.symlinkSync(path.join(project, 'node_modules'), path.join(root, 'node_modules'), 'junction');
    fs.copyFileSync(path.join(project, 'scripts/generate-icons.mjs'), path.join(root, 'scripts/generate-icons.mjs'));
    fs.copyFileSync(asset('unroute-icon.svg'), path.join(root, 'assets/branding/unroute-icon.svg'));
    // Intentionally no PNG source: the vector must be the only input.
    execFileSync(process.execPath, [path.join(root, 'scripts/generate-icons.mjs')], { encoding: 'utf8', timeout: 30000 });
    return Object.fromEntries(['assets/branding', 'src/common/icons'].flatMap(directory =>
      fs.readdirSync(path.join(root, directory)).map(name =>
        [`${directory}/${name}`, fs.readFileSync(path.join(root, directory, name))])));
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

const asset = name => new URL(`../assets/branding/${name}`, import.meta.url);
let fixture;
const generated = () => (fixture ||= generateFixture());

// Decode the browser's 8-bit RGBA PNGs without introducing an image dependency.
function pixels(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4, data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= 4 ? data[at - 4] : 0;
      const up = y ? data[at - stride] : 0;
      const diagonal = y && x >= 4 ? data[at - stride - 4] : 0;
      const p = left + up - diagonal;
      const distances = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - diagonal)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : diagonal;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth][filter];
      data[at] = raw[y * (stride + 1) + 1 + x] + predictor;
    }
  }
  return { data, at: (x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] };
}

describe('Fixed mint B / U-exit brand icon', () => {
  it('generates every runtime size and a 512px branding PNG from only the SVG', function () {
    this.timeout(40000);
    const files = generated();
    const expected = [['assets/branding/unroute-icon.png', 512]];
    for (const size of [16, 32, 48, 128]) {
      expected.push([`src/common/icons/default-${size}.png`, size],
        [`src/common/icons/default-grayscale-${size}.png`, size]);
    }
    for (const state of ['pac-error', 'ext-error', 'no-control']) {
      expected.push([`src/common/icons/${state}-128.png`, 128]);
    }
    for (const [name, size] of expected) {
      assert.ok(files[name], `Missing ${name}`);
      assert.equal(files[name].readUInt32BE(16), size, name);
      assert.equal(files[name].readUInt32BE(20), size, name);
      assert.equal(files[name][25], 6, `${name} must retain transparent RGBA corners`);
    }
  });
  it('keeps legacy grayscale filenames byte-identical to fixed mint defaults at every size', function () {
    this.timeout(40000);
    const files = generated();
    for (const size of [16, 32, 48, 128]) {
      const base = files[`src/common/icons/default-${size}.png`];
      assert.deepEqual(files[`src/common/icons/default-grayscale-${size}.png`], base, `${size}px legacy alias must not desaturate the logo`);
      const image = pixels(base);
      assert.deepEqual(image.at(size / 2, size / 2), [32, 37, 39, 255], `${size}px graphite tile`);
      assert.equal(image.at(0, 0)[3], 0, `${size}px transparent corner`);
      const glyph = image.at(Math.floor(size / 4), size / 2);
      assert.ok(glyph[1] > glyph[2] && glyph[2] > glyph[0], `${size}px glyph stays mint`);
      if (size >= 32) assert.deepEqual(glyph, [120, 198, 176, 255]);
    }
  });
  it('limits notification changes to a small bottom-right badge without repainting the glyph', function () {
    this.timeout(40000);
    const files = generated();
    const base = pixels(files['src/common/icons/default-128.png']);
    for (const state of ['pac-error', 'ext-error', 'no-control']) {
      const image = pixels(files[`src/common/icons/${state}-128.png`]);
      let changed = 0;
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
        const original = base.at(x, y), actual = image.at(x, y);
        if (x < 90 || y < 90 || original.join() === '120,198,176,255') {
          assert.deepEqual(actual, original, `${state} must preserve logo pixel ${x},${y}`);
        }
        if (original.join() !== actual.join()) changed++;
      }
      assert.ok(changed > 100 && changed < 1200, `${state} must add only a compact semantic badge`);
      assert.deepEqual(image.at(108, 106), [32, 37, 39, 255], `${state} badge has a graphite exclamation stem`);
      assert.deepEqual(image.at(108, 116), [32, 37, 39, 255], `${state} badge has an exclamation dot`);
    }
  });
  it('keeps the approved draft geometry in a self-contained SVG master', () => {
    assert.ok(fs.existsSync(asset('unroute-icon.svg')), 'SVG master must exist');
    const svg = fs.readFileSync(asset('unroute-icon.svg'), 'utf8');
    for (const fragment of [
      'viewBox="0 0 32 32"', 'x=".5"', 'y=".5"', 'width="31"', 'height="31"',
      'rx="7"', 'fill="#202527"', 'stroke="#48504b"',
      'd="M8 8v10a7 7 0 0 0 14 0V8m-5 4 5-4 4 4"',
      'fill="none"', 'stroke="#78c6b0"', 'stroke-width="3"',
      'stroke-linecap="round"', 'stroke-linejoin="round"',
    ]) assert.ok(svg.includes(fragment), `Missing approved SVG value: ${fragment}`);
    assert.doesNotMatch(svg, /currentColor|var\(|prefers-color-scheme|<image|<script/);
  });
});
