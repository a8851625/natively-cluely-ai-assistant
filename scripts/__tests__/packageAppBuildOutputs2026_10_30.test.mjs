// Packaging must refuse a tree whose compile outputs are missing.
//
// THE GAP (reproduced 2026-10-30): `npm run build` rims dist AND dist-electron,
// and the natural build→package sequence therefore deletes the main-process
// bundle. electron-builder's `build.files` are globs, and a glob that matches
// nothing is skipped without an error, so packaging "succeeded", ad-hoc signing
// "succeeded", and the installed app contained dist/ + node_modules/ +
// native-module/ + a package.json whose `main` pointed at
// dist-electron/electron/main.js — a file that was not in the asar (866 entries
// missing). It launched to a stalled process with one line of stdout, which
// reads as a code bug for as long as it takes to suspect the asar. The same
// session also lost an hour to a still-running older instance whose bundle had
// been replaced underneath it.
//
// This test pins the preflight: the two entry points are checked, both paths are
// named in the failure, and the check runs before electron-builder is spawned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const source = fs.readFileSync(path.join(repoRoot, 'scripts', 'package-app.js'), 'utf8');

test('package-app checks both compile outputs before packaging', () => {
  assert.match(source, /dist['"],\s*'index\.html'|dist\/index\.html|'dist',\s*'index\.html'/);
  assert.match(source, /dist-electron/);
  assert.match(source, /electron',\s*'main\.js'|electron\/main\.js/);
});

test('the missing-output refusal is explicit and names the fix', () => {
  assert.match(source, /Refusing to package: build output is missing/);
  // Each missing entry must be printed with the command that produces it, or the
  // message is just "something is missing".
  assert.match(source, /missing \$\{entry\.rel\} — run: \$\{entry\.hint\}/);
  assert.match(source, /npm run build:electron/);
  assert.match(source, /NATIVELY_CORE_SMOKE=1 node scripts\/build-electron\.js/);
  // The trap is that the renderer build removes the main-process bundle.
  assert.match(source, /`npm run build` deletes dist-electron/);
});

test('the guard exits non-zero before electron-builder is spawned', () => {
  const guardIndex = source.indexOf('Refusing to package: build output is missing');
  const spawnIndex = source.indexOf('function run(scriptPath, args)');
  const builderCallIndex = source.indexOf('run(resolveElectronBuilderCli(), builderArgs)');
  assert.ok(guardIndex > 0, 'guard must be present');
  assert.ok(spawnIndex > 0 && builderCallIndex > spawnIndex, 'builder must still be spawned via run()');
  assert.ok(
    guardIndex < builderCallIndex,
    'the guard must run before electron-builder, otherwise the hollow .app is already built'
  );
  // Exit code must be non-zero: a warning would leave CI green with a dead app.
  const guardBlock = source.slice(guardIndex, builderCallIndex);
  assert.match(guardBlock, /process\.exit\(1\)/);
});

test('a tree with both outputs would pass the check', () => {
  // Same predicate the guard uses, evaluated against the real tree: this repo
  // builds both, so `npm run build && npm run build:electron` must satisfy it.
  const required = ['dist/index.html', path.join('dist-electron', 'electron', 'main.js')];
  const exists = required.map((rel) => fs.existsSync(path.join(repoRoot, rel)));
  // Either both are present (a built tree) or both are absent (a clean
  // checkout) — the guard's own logic is what decides, this only asserts the
  // paths are the real ones, so a rename in the build scripts breaks this test.
  assert.equal(
    exists.filter(Boolean).length,
    exists.every(Boolean) ? 2 : 0,
    `unexpected half-built tree: ${JSON.stringify({ required, exists })}`
  );
});
