// Which image the tray / menu-bar icon loads, and whether it needs resizing.
// Pure module: filesystem checks are injected so it runs under test on any OS.
//
// iconTemplate.png is drawn at the tray's exact size (16 px) and ships with an
// iconTemplate@2x.png (32 px) beside it. nativeImage.createFromPath picks the
// @2x file up as a second representation, which is what keeps the menu-bar
// icon sharp on Retina displays — so the template must NOT go through
// .resize(): that returns a single-scale image and would drop the @2x pair.
// The full-size fallback art (icon.png, hundreds of px) still needs resizing.

import path from 'node:path';

import type { DisguiseModeName } from './disguiseAppName';

export interface TrayIconChoice {
  path: string;
  /** macOS template image (drawn by the system in the menu-bar colour). */
  template: boolean;
  /** The file is not drawn at tray size and must be resized to 16 x 16. */
  resizeTo16: boolean;
}

export function resolveTrayIcon(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  exists: (p: string) => boolean;
  /** Defaults to the running platform; injected so both branches are testable. */
  platform?: NodeJS.Platform;
  /** Active disguise mode. 'none' keeps the Natively template art. */
  disguise?: DisguiseModeName;
}): TrayIconChoice {
  const root = opts.isPackaged ? opts.resourcesPath : opts.appPath;

  // A disguised app must not show the Natively logo in the menu bar — that is
  // the surface a proctor reads without clicking anything. The disguise wins
  // over the shipped template, falling through only when its art is missing.
  const disguise = opts.disguise ?? 'none';
  if (disguise !== 'none') {
    const disguised = resolveDisguiseTrayIcon(disguise, opts.platform ?? process.platform, root, opts.exists);
    if (disguised) return disguised;
  }

  const candidates = [
    path.join(root, 'assets', 'iconTemplate.png'),
    // Dev fallback, as before.
    path.join(opts.appPath, 'src/components/iconTemplate.png'),
  ];
  for (const candidate of candidates) {
    if (opts.exists(candidate)) return { path: candidate, template: true, resizeTo16: false };
  }
  const fallback = opts.isPackaged
    ? path.join(opts.resourcesPath, 'assets', 'icon.png')
    : path.join(opts.appPath, 'src/components/icon.png');
  return { path: fallback, template: false, resizeTo16: true };
}

/**
 * The tray art for one disguise mode, or null when neither candidate exists.
 *
 * macOS draws menu-bar items as template images (the system re-tints pure black
 * + alpha for light/dark), so each mode has a purpose-drawn glyph in
 * assets/fakeicon/mac/tray/<mode>Template.png (16 px + a 32 px @2x pair, see
 * scripts/generate-tray-disguise-icons.mjs). Windows tray icons are coloured, so
 * it reuses the mode's app icon, scaled to 16 px — which is also the macOS
 * fallback if the glyph is ever missing.
 */
function resolveDisguiseTrayIcon(
  mode: Exclude<DisguiseModeName, 'none'>,
  platform: NodeJS.Platform,
  root: string,
  exists: (p: string) => boolean,
): TrayIconChoice | null {
  if (platform === 'darwin') {
    const glyph = path.join(root, 'assets', 'fakeicon', 'mac', 'tray', `${mode}Template.png`);
    if (exists(glyph)) return { path: glyph, template: true, resizeTo16: false };
  }
  const icon = path.join(root, 'assets', 'fakeicon', platform === 'win32' ? 'win' : 'mac', `${mode}.png`);
  if (exists(icon)) return { path: icon, template: false, resizeTo16: true };
  return null;
}
