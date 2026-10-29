// electron/audio/__tests__/QwenFirstPartialLatency2026_10_30.test.mjs
//
// End-to-end latency gate for the local Qwen3-ASR channel.
//
// This drives the REAL host class (LocalWhisperSTT), the REAL VAD, the REAL
// whisperWorker thread and the REAL transcribe.cpp runtime, feeding a WAV at
// wall-clock pace the way capture does, and measures the time from the first
// audio chunk to the first `transcript` event — i.e. what a user actually
// perceives as "the delay before text appears".
//
// Two profiles run on the same audio in the same process:
//   * current: interval 500ms, minAudio 300ms, no LocalAgreement-2, plus the
//     new "pull the tick forward when a VAD segment opens" nudge.
//   * legacy:  interval 1200ms, minAudio 600ms, LocalAgreement-2 on — the
//     profile that produced the reported 2-3 second delay.
//
// The assertion is relative (current must be at least 30% faster) plus an
// absolute ceiling, so it stays meaningful on slower machines without becoming
// a wall-clock flake.
//
// Gated on the model being present: set NATIVELY_QWEN_TEST_CACHE to the
// whisper-models dir, or have it in the real profile.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Module from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

const QWEN = 'handy-computer/Qwen3-ASR-0.6B-gguf';
const MODEL_REL = 'whisper-models/handy-computer/Qwen3-ASR-0.6B-gguf/Qwen3-ASR-0.6B-Q8_0.gguf';

/** Where the real weights live on this machine (env wins, then the app profile). */
function findModelsDir() {
  const candidates = [
    process.env.NATIVELY_QWEN_TEST_CACHE,
    path.join(os.homedir(), 'Library/Application Support/corespeechd'),
    path.join(os.homedir(), 'Library/Application Support/natively'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, MODEL_REL))) return path.join(c, 'whisper-models');
  }
  return null;
}

const modelsDir = findModelsDir();

// The host resolves models through modelManager.getModelsDir() =
// app.getPath('userData')/whisper-models, so point userData at a temp dir whose
// whisper-models is a symlink to the real one.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-latency-'));
if (modelsDir) fs.symlinkSync(modelsDir, path.join(userData, 'whisper-models'));

const origLoad = Module._load;
Module._load = function patched(request) {
  if (request === 'electron') {
    return { app: { getPath: (k) => (k === 'userData' ? userData : os.tmpdir()), isReady: () => true } };
  }
  return origLoad.apply(this, arguments);
};

const dist = path.join(REPO, 'dist-electron/electron/audio');
const { LocalWhisperSTT } = await import(pathToFileURL(path.join(dist, 'LocalWhisperSTT.js')).href);

/** Minimal 16k mono PCM16 WAV reader (readWave is unavailable under ELECTRON_RUN_AS_NODE). */
function readWavPcm16(file) {
  const buf = fs.readFileSync(file);
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4) };
    else if (id === 'data') return { pcm: buf.subarray(body, body + size), ...fmt };
    off = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Feed `pcm` at wall-clock pace and return the latency of the first partial.
 * `legacy` flips the instance back to the pre-fix profile.
 */
async function measureFirstPartial({ legacy }) {
  const wav = readWavPcm16(path.join(__dirname, '../sherpa/__tests__/fixtures/sense-voice-zh.wav'));
  assert.equal(wav.rate, 16000);

  const lws = new LocalWhisperSTT(QWEN);
  if (legacy) {
    lws['streamingIntervalBaseMs'] = 1200;
    lws['streamingNextDelayMs'] = 1200;
    lws['streamingMinAudioMs'] = 600;
    lws['skipAgreement'] = false;
  }
  lws.setSampleRate(16000); // capture normally reports this; default is 48000
  lws.setChannel(legacy ? 'legacy' : 'current');
  lws.setRecognitionLanguage('chinese');

  const events = [];
  lws.on('transcript', (t) => events.push({ at: performance.now(), ...t }));
  let failure = null;
  lws.on('error', (e) => { failure = e; });

  lws.start();
  try {
    await waitFor(() => lws['workerReady'] || failure, 90_000, 'worker ready');
    assert.equal(failure, null, `worker failed: ${failure?.message}`);

    // 100ms of audio per chunk, paced like a real capture device.
    const chunkSamples = 1600;
    const chunkBytes = chunkSamples * 2;
    const startedAt = performance.now();
    for (let o = 0; o + chunkBytes <= wav.pcm.length; o += chunkBytes) {
      lws.write(wav.pcm.subarray(o, o + chunkBytes));
      await sleep(100);
    }

    const first = events.find((e) => e.isFinal === false);
    const firstFinal = events.find((e) => e.isFinal === true);
    // Give the tail a moment to land so the measurement isn't cut short.
    await waitFor(() => first || firstFinal, 8000, 'any transcript');

    return {
      firstPartialMs: first ? Math.round(first.at - startedAt) : null,
      firstFinalMs: firstFinal ? Math.round(firstFinal.at - startedAt) : null,
      firstText: (first ?? firstFinal)?.text ?? '',
      partials: events.filter((e) => !e.isFinal).map((e) => e.text),
      latency: lws.getLatencyStats(),
    };
  } finally {
    lws.stop();
    // stop() is synchronous but tears the worker down asynchronously; a second
    // instance cannot spawn until the first worker thread is actually gone.
    try {
      await waitFor(() => !lws['worker'], 20_000, 'worker teardown');
    } catch { /* best effort */ }
    await sleep(500);
  }
}

describe('Qwen3-ASR first-partial latency', () => {
  test('current profile beats the legacy 1200ms+agreement profile', { skip: modelsDir ? false : 'Qwen3-ASR model not installed' }, async () => {
    const current = await measureFirstPartial({ legacy: false });
    const legacy = await measureFirstPartial({ legacy: true });

    console.log(
      `[latency] current first-partial=${current.firstPartialMs}ms first-final=${current.firstFinalMs}ms ` +
      `| legacy first-partial=${legacy.firstPartialMs}ms first-final=${legacy.firstFinalMs}ms`,
    );
    console.log(`[latency] current partial sequence:`);
    for (const p of current.partials.slice(0, 8)) console.log(`   ${JSON.stringify(p)}`);

    assert.ok(current.firstPartialMs !== null, 'the current profile must emit a partial');

    // Primary metric: segment-open → first visible text. That is the part this
    // profile controls (the ~700ms before it is VAD onset detection, which is
    // identical for every local model). Measured ~800ms; the legacy profile
    // measured ~2870ms.
    const internal = current.latency.firstPartial.p50;
    assert.ok(internal > 0, 'telemetry must have recorded a first partial');
    assert.ok(internal < 1200, `segment-open → first partial must be under 1.2s, got ${internal}ms`);

    // End-to-end (first audio chunk → first partial) is relative, because the
    // absolute number includes VAD onset and machine speed.
    assert.ok(legacy.firstPartialMs !== null, 'the legacy profile must also emit a partial');
    assert.ok(
      current.firstPartialMs <= legacy.firstPartialMs * 0.7,
      `current profile (${current.firstPartialMs}ms) must be ≥30% faster than legacy (${legacy.firstPartialMs}ms)`,
    );
  });
});
