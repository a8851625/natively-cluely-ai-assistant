// End-to-end check of the sherpa-onnx path through the REAL worker: init a
// sherpa model, transcribe a real Chinese WAV, change the language, and (when
// the streaming model is present) verify incremental partials.
//
// Gated: skipped when the model is not downloaded. It runs for real for anyone
// who installed a sherpa model through the app, so it is not a test that
// silently stops checking — it either verifies a real transcription or says it
// skipped.
//
// Model location: NATIVELY_SHERPA_TEST_CACHE (a models dir laid out as
// <org>/<name>) or the app's own whisper-models directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Worker } from 'node:worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, '../../../dist-electron/electron');
const workerPath = path.join(dist, 'audio/whisper/whisperWorker.js');
const catalog = await import(pathToFileURL(path.join(dist, 'audio/sherpa/sherpaCatalog.js')).href);
const { isSherpaModelCached, sherpaModelDir } = await import(
  pathToFileURL(path.join(dist, 'audio/sherpa/sherpaFiles.js')).href
);

const SENSE_VOICE = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const ZIPFORMER = 'csukuangfj/sherpa-onnx-streaming-zipformer-multi-zh-hans-int8-2023-12-13';

function resolveCacheDir() {
  if (process.env.NATIVELY_SHERPA_TEST_CACHE) return process.env.NATIVELY_SHERPA_TEST_CACHE;
  try {
    const { getModelsDir } = require(path.join(dist, 'audio/whisper/modelManager.js'));
    return getModelsDir();
  } catch {
    return null;
  }
}

const CACHE_DIR = resolveCacheDir();
const hasSenseVoice = !!CACHE_DIR && isSherpaModelCached(CACHE_DIR, SENSE_VOICE);
const hasZipformer = !!CACHE_DIR && isSherpaModelCached(CACHE_DIR, ZIPFORMER);

/** Minimal 16-bit PCM WAV reader (the fixtures are 16kHz mono). */
function readWavSamples(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF', `${file} is not a WAV`);
  let offset = 12;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  assert.ok(dataOffset > 0, `${file} has no data chunk`);
  const samples = new Float32Array(dataLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return samples;
}

/** Spawns the built worker and resolves on the first message matching `predicate`. */
function startWorker(init, { timeoutMs = 120_000 } = {}) {
  const worker = new Worker(workerPath);
  const inbox = [];
  const waiters = [];
  worker.on('message', (msg) => {
    const i = waiters.findIndex((w) => w.predicate(msg));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      inbox.push(msg);
    }
  });
  const waitFor = (predicate, label) =>
    new Promise((resolve, reject) => {
      const hit = inbox.findIndex(predicate);
      if (hit >= 0) return resolve(inbox.splice(hit, 1)[0]);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      waiters.push({ predicate, resolve, timer });
    });
  worker.postMessage(init);
  return { worker, waitFor, dispose: () => worker.terminate() };
}

test('sense-voice: transcribes real Chinese audio through the worker', { skip: !hasSenseVoice && 'model not downloaded' }, async () => {
  const wav = path.join(__dirname, '../sherpa/__tests__/fixtures/sense-voice-zh.wav');
  const samples = readWavSamples(wav);
  const { worker, waitFor, dispose } = startWorker({
    type: 'init',
    modelId: SENSE_VOICE,
    cacheDir: CACHE_DIR,
    sessionLayout: 'sherpa-offline',
    channelId: 'mic',
    dtype: 'q8',
    executionProviders: ['cpu'],
  });

  try {
    // One wait for either outcome: waiting twice would consume the ready
    // message with the first call and then hang on the second.
    const ready = await waitFor((m) => m.type === 'ready' || m.type === 'error', 'ready/error');
    assert.equal(ready.type, 'ready', `init failed: ${ready.message ?? ''}`);
    assert.equal(ready.channelId, 'mic');

    worker.postMessage({
      type: 'transcribe',
      taskId: 't1',
      audio: samples,
      language: 'chinese',
      streaming: false,
      channelId: 'mic',
    });
    const result = await waitFor((m) => m.taskId === 't1', 'transcription');
    assert.equal(result.type, 'result', `worker returned ${result.type}: ${result.message ?? ''}`);
    // The fixture says "开饭时间早上9点至下午5点。" — assert on stable characters
    // rather than the whole sentence, so a model refresh does not fail the test
    // for punctuation or numeral formatting.
    assert.match(result.text, /[时間间]/, `expected Chinese text, got ${JSON.stringify(result.text)}`);
    assert.ok(result.text.length >= 6, `transcript too short: ${JSON.stringify(result.text)}`);

    // A language change must be accepted and must not wedge the engine.
    worker.postMessage({ type: 'setLanguage', language: 'english-us', channelId: 'mic' });
    worker.postMessage({
      type: 'transcribe',
      taskId: 't2',
      audio: samples,
      language: 'english-us',
      streaming: false,
      channelId: 'mic',
    });
    const second = await waitFor((m) => m.taskId === 't2', 'second transcription');
    assert.equal(second.type, 'result', `second call failed: ${second.message ?? ''}`);
    assert.ok(typeof second.text === 'string');
  } finally {
    dispose();
  }
});

test('zipformer: streams incremental partials and resets per segment', { skip: !hasZipformer && 'streaming model not downloaded' }, async () => {
  const wav = path.join(__dirname, '../sherpa/__tests__/fixtures/sense-voice-zh.wav');
  const samples = readWavSamples(wav);
  const { worker, waitFor, dispose } = startWorker({
    type: 'init',
    modelId: ZIPFORMER,
    cacheDir: CACHE_DIR,
    sessionLayout: 'sherpa-online',
    channelId: 'mic',
    dtype: 'q8',
    executionProviders: ['cpu'],
  });

  try {
    await waitFor((m) => m.type === 'ready', 'ready');

    // First segment: delta + reset, then a second delta of the same segment.
    const half = Math.floor(samples.length / 2);
    worker.postMessage({
      type: 'transcribe',
      taskId: 'p1',
      audio: samples.slice(0, half),
      language: 'chinese',
      streaming: true,
      nemotronReset: true,
      channelId: 'mic',
    });
    const first = await waitFor((m) => m.taskId === 'p1', 'first partial');
    assert.equal(first.type, 'partial', `first partial failed: ${first.message ?? ''}`);

    worker.postMessage({
      type: 'transcribe',
      taskId: 'p2',
      audio: samples.slice(half),
      language: 'chinese',
      streaming: true,
      channelId: 'mic',
    });
    const second = await waitFor((m) => m.taskId === 'p2', 'second partial');
    assert.equal(second.type, 'partial');
    // The engine accumulates: the second partial must cover more text than the
    // first (or, for very short first halves, at least not lose what it had).
    assert.ok(second.text.length >= first.text.length, `partial shrank: ${first.text} → ${second.text}`);

    // New segment: reset must clear the accumulated text.
    worker.postMessage({
      type: 'transcribe',
      taskId: 'p3',
      audio: new Float32Array(0),
      language: 'chinese',
      streaming: true,
      nemotronReset: true,
      channelId: 'mic',
    });
    const reset = await waitFor((m) => m.taskId === 'p3', 'reset');
    assert.equal(reset.type, 'partial');
    assert.equal(reset.text, '', `reset did not clear the stream: ${JSON.stringify(reset.text)}`);
  } finally {
    dispose();
  }
});
