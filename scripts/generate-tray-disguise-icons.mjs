// Generates the macOS menu-bar (tray) glyph for each disguise mode.
//
// Why this exists: the tray icon used to be the Natively template art no matter
// what disguise was active, so a disguised app still showed its own logo in the
// menu bar — the one surface a proctor reads at a glance. These are drawn as
// macOS *template* images (pure black + alpha), which the system re-tints for
// the light/dark menu bar; a coloured bitmap there looks foreign.
//
// Committed output (assets/fakeicon/mac/tray/):
//   terminalTemplate.png   + @2x    `>_` in a rounded window
//   settingsTemplate.png   + @2x    gear
//   activityTemplate.png   + @2x    ECG trace
// 16 px at 1x with a 32 px @2x pair beside it, matching assets/iconTemplate.png
// (nativeImage.createFromPath picks the @2x up as a second representation, so
// the tray stays sharp on Retina without .resize()).
//
// Run: node scripts/generate-tray-disguise-icons.mjs
// Windows needs nothing here — its tray icons are coloured, and the disguise
// app icon (assets/fakeicon/win/<mode>.png) is resized to 16 instead.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'assets', 'fakeicon', 'mac', 'tray');

/** Draw in a 16x16 user-space grid; `scale` maps it onto the output canvas. */
const GLYPHS = {
  // A terminal window with a prompt chevron and a cursor.
  terminal(ctx) {
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(1.75, 2.75, 12.5, 10.5, 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(4.9, 6.1);
    ctx.lineTo(7.4, 8);
    ctx.lineTo(4.9, 9.9);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(9.1, 10.2);
    ctx.lineTo(11.4, 10.2);
    ctx.stroke();
  },
  // Gear: hub + rim + eight teeth. Reads as "settings" at 16 px where a
  // detailed gear would turn to mush.
  settings(ctx) {
    const cx = 8;
    const cy = 8;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * 5.2, cy + Math.sin(a) * 5.2);
      ctx.lineTo(cx + Math.cos(a) * 6.8, cy + Math.sin(a) * 6.8);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, 4.1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 1.6, 0, Math.PI * 2);
    ctx.fill();
  },
  // ECG trace.
  activity(ctx) {
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(1.4, 8);
    ctx.lineTo(3.9, 8);
    ctx.lineTo(5.4, 4.6);
    ctx.lineTo(7.6, 11.4);
    ctx.lineTo(9.6, 6.4);
    ctx.lineTo(11.2, 8);
    ctx.lineTo(14.6, 8);
    ctx.stroke();
  },
};

function render(mode, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.scale(size / 16, size / 16);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  GLYPHS[mode](ctx);
  return canvas.encodeSync('png');
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const mode of Object.keys(GLYPHS)) {
  for (const [suffix, size] of [['', 16], ['@2x', 32]]) {
    const file = path.join(OUT_DIR, `${mode}Template${suffix}.png`);
    fs.writeFileSync(file, render(mode, size));
    console.log(`${path.relative(process.cwd(), file)}  ${size}x${size}`);
  }
}
