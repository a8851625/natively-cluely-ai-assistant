// Device enumeration when the native audio module is absent.
//
// Capture already works through the Chromium fallback in that state (Windows
// without the VC++ runtime; a macOS dev build forced with
// NATIVELY_FORCE_RENDERER_AUDIO=1), but ENUMERATION did not: getInputDevices()
// returned [] because the Rust module owns it, so Settings › Audio and the
// transcript panel said "No microphones found." while the mic was perfectly
// usable. That reads as "the microphone is broken".
//
// AudioDevices.getInputDevicesWithFallback() asks the capture page instead. The
// synchronous getInputDevices() is deliberately untouched: main.ts's device
// ladders treat an empty list as "unverifiable" and keep the current device,
// and that behaviour must survive.
//
// The seam is captureHost()'s globalThis symbol, not a module path: esbuild
// bundles each entry separately, so AudioDevices.js carries its OWN inlined copy
// of captureHost.ts and seeding require.cache would prove nothing. Both copies
// read the same Symbol.for('natively.audioFallback.captureHost') key, which is
// also what keeps mic and system audio on one capture window in the real app.
//
// Run: node scripts/build-electron.js && node --test electron/audio/__tests__/AudioDeviceEnumerationFallback2026_10_29.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const distDir = path.join(repoRoot, 'dist-electron/electron/audio');

// ── stubs ──────────────────────────────────────────────────────────────
// AudioDevices loads the native module at import time and asks Electron for
// isPackaged at call time, so both are stubbed before the module is required.
let nativeDevices = [];
let electronStub = { app: { isPackaged: false, getPath: () => os.tmpdir() } };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.apply(this, arguments);
};

// The native module cannot be faked here (nativeModuleLoader is inlined into the
// same bundle and dlopen's a real .node), so every case below runs with it
// absent — which is the state this fallback exists for.
const HOST_KEY = Symbol.for('natively.audioFallback.captureHost');
let captureHostCalls = 0;
let captureHostDevices = [];
let captureHostFails = null;
const fakeHost = {
  async listInputDevices() {
    captureHostCalls += 1;
    if (captureHostFails) throw captureHostFails;
    return captureHostDevices;
  },
};

const { AudioDevices } = require(path.join(distDir, 'AudioDevices.js'));

/** Sets (or clears) the dev override fallbackPolicy.ts reads, returning a restorer. */
function withEnv(value) {
  const prev = process.env.NATIVELY_FORCE_RENDERER_AUDIO;
  if (value === undefined) delete process.env.NATIVELY_FORCE_RENDERER_AUDIO;
  else process.env.NATIVELY_FORCE_RENDERER_AUDIO = value;
  return () => {
    if (prev === undefined) delete process.env.NATIVELY_FORCE_RENDERER_AUDIO;
    else process.env.NATIVELY_FORCE_RENDERER_AUDIO = prev;
  };
}

test.beforeEach(() => {
  globalThis[HOST_KEY] = fakeHost;
  captureHostDevices = [];
  captureHostCalls = 0;
  captureHostFails = null;
  electronStub = { app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => repoRoot } };
});

test.afterEach(() => {
  delete globalThis[HOST_KEY];
});

test('macOS dev build with the forced fallback asks the capture page', async () => {
  // Unpackaged + NATIVELY_FORCE_RENDERER_AUDIO=1 is the documented dev override
  // for macOS (fallbackPolicy.ts): exactly the setup where the mic picker was
  // empty while capture worked.
  const restore = withEnv('1');
  captureHostDevices = [
    { id: '8dde66', name: 'MacBook Pro麦克风 (Built-in)' },
    { id: 'a1b2c3', name: 'AirPods Pro' },
  ];
  try {
    const devices = await AudioDevices.getInputDevicesWithFallback();
    assert.equal(captureHostCalls, 1);
    assert.deepEqual(
      devices.map((d) => d.name),
      ['MacBook Pro麦克风 (Built-in)', 'AirPods Pro'],
    );
  } finally {
    restore();
  }
});

test('packaged macOS never asks the capture page, even without the native module', async () => {
  // fallbackPolicy.ts: "macOS: never in a shipped build". Enumeration must not
  // quietly create a hidden capture window there either.
  electronStub = { app: { isPackaged: true, getPath: () => os.tmpdir(), getAppPath: () => repoRoot } };
  const restore = withEnv('1');
  captureHostDevices = [{ id: 'x', name: 'Whatever' }];
  try {
    assert.deepEqual(await AudioDevices.getInputDevicesWithFallback(), []);
    assert.equal(captureHostCalls, 0);
  } finally {
    restore();
  }
});

test('Windows without the native module asks the capture page (the documented fallback case)', async () => {
  // Same code path as macOS-dev: the policy differs, the wiring must not.
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  electronStub = { app: { isPackaged: true, getPath: () => os.tmpdir(), getAppPath: () => repoRoot } };
  captureHostDevices = [{ id: 'wasapi:1', name: 'Microphone Array (Realtek)' }];
  try {
    const devices = await AudioDevices.getInputDevicesWithFallback();
    assert.deepEqual(devices, [{ id: 'wasapi:1', name: 'Microphone Array (Realtek)' }]);
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
});

test('the internal system-audio tap is filtered out of the fallback list', async () => {
  const restore = withEnv('1');
  captureHostDevices = [
    { id: 'tap', name: 'NativelySystemAudioTap' },
    { id: 'real', name: 'MacBook Pro Microphone' },
  ];
  try {
    const devices = await AudioDevices.getInputDevicesWithFallback();
    assert.deepEqual(devices.map((d) => d.id), ['real']);
  } finally {
    restore();
  }
});

test('a failing capture page degrades to the empty list, not a throw', async () => {
  const restore = withEnv('1');
  captureHostFails = new Error('the capture page did not load');
  try {
    assert.deepEqual(await AudioDevices.getInputDevicesWithFallback(), []);
  } finally {
    restore();
  }
});

test('getInputDevices() stays synchronous and empty — main.ts ladders depend on that', () => {
  const restore = withEnv('1');
  try {
    // Not a call into the capture page: reconfigureAudio's device ladder reads
    // this and treats [] as "unverifiable", keeping the current device.
    assert.deepEqual(AudioDevices.getInputDevices(), []);
    assert.equal(captureHostCalls, 0);
  } finally {
    restore();
  }
});
