// The menu-bar (tray) icon must follow the active disguise.
//
// Reported: with disguise = terminal, the Dock tile and app name changed to
// Terminal but the menu bar still showed the Natively logo — the one surface a
// proctor reads without clicking anything.
//
// Contract pinned here:
//   * disguise 'none'  → unchanged behaviour (assets/iconTemplate.png, template)
//   * macOS disguise   → the mode's monochrome template glyph
//                        (assets/fakeicon/mac/tray/<mode>Template.png, no resize,
//                         so the 32 px @2x representation survives)
//   * Windows disguise → the mode's coloured app icon, resized to 16
//   * macOS without the glyph (older install) → coloured app icon fallback
//   * missing disguise art entirely → falls back to the undisguised art
//
// Both platform branches are exercised by injecting `platform`, per the repo's
// cross-platform rule: a suite that only runs the host platform branch is not
// enough for shared code containing platform conditions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const { resolveTrayIcon } = require(path.join(repoRoot, 'dist-electron/electron/utils/trayIcon.js'));

const RES = path.join(path.sep, 'res');
const APP = path.join(path.sep, 'app');

/** resolveTrayIcon against a virtual filesystem that contains `files`. */
function resolveWith(files, opts = {}) {
  return resolveTrayIcon({
    isPackaged: true,
    resourcesPath: RES,
    appPath: APP,
    platform: 'darwin',
    disguise: 'none',
    ...opts,
    exists: (p) => files.includes(p),
  });
}

const MAC_GLYPH = (mode) => path.join(RES, 'assets', 'fakeicon', 'mac', 'tray', `${mode}Template.png`);
const MAC_ICON = (mode) => path.join(RES, 'assets', 'fakeicon', 'mac', `${mode}.png`);
const WIN_ICON = (mode) => path.join(RES, 'assets', 'fakeicon', 'win', `${mode}.png`);
const NATIVELY_TPL = path.join(RES, 'assets', 'iconTemplate.png');

test("disguise 'none' keeps the shipped Natively template (unchanged)", () => {
  assert.deepEqual(resolveWith([NATIVELY_TPL, MAC_GLYPH('terminal')]), {
    path: NATIVELY_TPL,
    template: true,
    resizeTo16: false,
  });
});

test('macOS: a disguise loads its monochrome template glyph, unresized', () => {
  for (const mode of ['terminal', 'settings', 'activity']) {
    assert.deepEqual(
      resolveWith([NATIVELY_TPL, MAC_GLYPH(mode)], { disguise: mode }),
      { path: MAC_GLYPH(mode), template: true, resizeTo16: false },
      mode,
    );
  }
});

test('macOS: the glyph wins over the Natively template and over the app icon', () => {
  const choice = resolveWith([NATIVELY_TPL, MAC_ICON('terminal'), MAC_GLYPH('terminal')], { disguise: 'terminal' });
  assert.equal(choice.path, MAC_GLYPH('terminal'));
  assert.equal(choice.template, true);
});

test('macOS: no glyph (older install) falls back to the disguise app icon, resized', () => {
  assert.deepEqual(resolveWith([NATIVELY_TPL, MAC_ICON('settings')], { disguise: 'settings' }), {
    path: MAC_ICON('settings'),
    template: false,
    resizeTo16: true,
  });
});

test('Windows: a disguise loads the coloured app icon, resized to 16, never a template', () => {
  for (const mode of ['terminal', 'settings', 'activity']) {
    assert.deepEqual(
      resolveWith([WIN_ICON(mode), NATIVELY_TPL], { disguise: mode, platform: 'win32' }),
      { path: WIN_ICON(mode), template: false, resizeTo16: true },
      mode,
    );
  }
});

test('Windows: it never reaches for a macOS template glyph', () => {
  const choice = resolveWith([MAC_GLYPH('terminal'), NATIVELY_TPL], { disguise: 'terminal', platform: 'win32' });
  assert.equal(choice.path, NATIVELY_TPL, 'no win32 art present, so the shipped template is the fallback');
});

test('no disguise art at all: the undisguised art is used rather than nothing', () => {
  assert.deepEqual(resolveWith([NATIVELY_TPL], { disguise: 'terminal' }), {
    path: NATIVELY_TPL,
    template: true,
    resizeTo16: false,
  });
});

test('dev (unpackaged) resolves disguise art under the app path', () => {
  const glyph = path.join(APP, 'assets', 'fakeicon', 'mac', 'tray', 'activityTemplate.png');
  assert.deepEqual(
    resolveWith([glyph], { isPackaged: false, disguise: 'activity' }),
    { path: glyph, template: true, resizeTo16: false },
  );
});

// The shipped glyphs themselves: 16 px with a 32 px @2x pair, pure black + alpha
// so macOS can re-tint them for the light and dark menu bar.
function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.readUInt32BE(0), 0x89504e47, `${file} is not a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('every disguise glyph ships at 16 px with a 32 px @2x pair', () => {
  for (const mode of ['terminal', 'settings', 'activity']) {
    const base = path.join(repoRoot, 'assets/fakeicon/mac/tray', `${mode}Template.png`);
    const at2x = path.join(repoRoot, 'assets/fakeicon/mac/tray', `${mode}Template@2x.png`);
    assert.deepEqual(pngSize(base), [16, 16], base);
    assert.deepEqual(pngSize(at2x), [32, 32], at2x);
  }
});

test('the glyphs are monochrome (template images, not coloured art)', () => {
  // A template image must be black + alpha only: any coloured pixel would be
  // drawn as-is in the menu bar and look foreign next to system items.
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  return (async () => {
    for (const mode of ['terminal', 'settings', 'activity']) {
      const file = path.join(repoRoot, 'assets/fakeicon/mac/tray', `${mode}Template@2x.png`);
      const img = await loadImage(file);
      const canvas = createCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      let opaque = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a === 0) continue;
        opaque++;
        assert.ok(r === 0 && g === 0 && b === 0, `${mode}: coloured pixel rgba(${r},${g},${b},${a})`);
      }
      assert.ok(opaque > 40, `${mode}: glyph is (nearly) empty — ${opaque} opaque pixels`);
    }
  })();
});

// Wiring: main.ts must repaint the tray on a disguise change and stop hardcoding
// the product name in the tooltip / menu.
test('main.ts repaints the tray on disguise change and never hardcodes Natively in the tray', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'electron/main.ts'), 'utf8');
  const start = src.indexOf('private _applyDisguise(');
  assert.ok(start > 0, '_applyDisguise not found');
  const body = src.slice(start, src.indexOf('// 5. Update Window Titles.', start));
  assert.ok(body.includes('this.refreshTrayForDisguise();'), 'a disguise change must repaint the menu-bar icon');

  const showTray = src.slice(src.indexOf('public showTray(): void {'), src.indexOf('private resolveTrayIconChoice()'));
  assert.ok(showTray.includes('this.resolveTrayIconChoice()'), 'showTray must go through the disguise-aware resolver');
  assert.ok(showTray.includes('this.trayDisplayName()'), 'showTray must use the disguise name as its tooltip');
  assert.ok(!showTray.includes("setToolTip('Natively')"), "showTray must not hardcode the 'Natively' tooltip");

  const resolver = src.slice(src.indexOf('private resolveTrayIconChoice()'), src.indexOf('private trayDisplayName()'));
  assert.ok(resolver.includes('disguise: this.disguiseMode'), 'the resolver must read the active disguise mode');
  assert.ok(resolver.includes('platform: process.platform'), 'the resolver must pass the platform through');

  const menu = src.slice(src.indexOf('public updateTrayMenu()'), src.indexOf('public hideTray()'));
  assert.ok(!menu.includes("setToolTip('Natively')"), "updateTrayMenu must not hardcode the 'Natively' tooltip");
  assert.ok(!menu.includes("label: 'Show Natively'"), 'the tray menu must not label the product while disguised');
  assert.ok(menu.includes('trayDisplayName()'), 'the tray menu must use the disguise name');
});
